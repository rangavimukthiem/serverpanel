'use strict';

/**
 * projectSetupController.js
 *
 * Three-phase project infrastructure setup:
 *   Phase 1 — Folder scaffold  (pure Node fs, no shell)
 *   Phase 2 — Nginx config     (template → write → nginx reload via execFile)
 *   Phase 3 — SSL certificate  (certbot, optional self-signed fallback)
 *
 * All operations are idempotent and gated by ENABLE_SERVICE_CONTROL=true on Linux.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { findProjectById, updateProjectFields, updateProjectConfig } = require('../models/projectModel');
const { writeProjectEnvFile, upsertProjectEnv, deleteProjectEnv } = require('../models/projectEnvModel');
const { getProjectMembership } = require('../models/projectModel');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

const execFileAsync = promisify(execFile);

// Sub-directories created inside each project root
const SCAFFOLD_DIRS = ['public', 'logs', 'releases', 'shared', 'config'];

const NGINX_SITES_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_SITES_ENABLED   = '/etc/nginx/sites-enabled';
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PROJECT_RUNTIME_SET = new Set(['static-site', 'node-app', 'python-api', 'php-site', 'wordpress-site', 'static-api']);
const PORT_RUNTIME_SET = new Set(['node-app', 'python-api', 'static-api']);
const PHP_RUNTIME_SET = new Set(['php-site', 'wordpress-site']);
const PHP_FPM_SOCKET_PATTERN = /^\/run\/php\/php\d+\.\d+-fpm\.sock$/;
const DEFAULT_PHP_FPM_SOCKET = process.env.PHP_FPM_SOCKET || '/run/php/php8.1-fpm.sock';

// ─── Access guards ────────────────────────────────────────────────────────────

async function canManage(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

function requireLinux(res) {
  if (process.platform === 'win32') {
    res.status(503).json({ message: 'Shell operations are only available on Linux hosts.' });
    return false;
  }
  return true;
}

function requireServiceControl(res) {
  if (process.env.ENABLE_SERVICE_CONTROL !== 'true') {
    res.status(503).json({ message: 'ENABLE_SERVICE_CONTROL is not enabled. Set it to true in .env.' });
    return false;
  }
  return true;
}

function validateDomainName(domain) {
  return DOMAIN_PATTERN.test(domain);
}

function normalizeRuntime(value, fallbackRuntime, legacyType) {
  if (legacyType === 'static') return 'static-site';
  if (legacyType === 'proxy') return 'node-app';

  const runtime = (value || fallbackRuntime || 'static-site').trim();
  return PROJECT_RUNTIME_SET.has(runtime) ? runtime : null;
}

function validatePort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function kindForRuntime(runtime, fallbackKind = 'static') {
  if (runtime === 'wordpress-site') return 'database';
  if (runtime === 'static-api') return 'api';
  if (runtime === 'node-app' || runtime === 'python-api') return 'api';
  return fallbackKind || 'static';
}

function normalizePhpFpmSocket(value) {
  const socket = (value || DEFAULT_PHP_FPM_SOCKET).trim();
  return PHP_FPM_SOCKET_PATTERN.test(socket) ? socket : null;
}

function rootCommand(command, args = []) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { file: 'sudo', args: ['-n', command, ...args] };
  }

  return { file: command, args };
}

function runRootCommand(command, args, options) {
  const cmd = rootCommand(command, args);
  return execFileAsync(cmd.file, cmd.args, options);
}

function allowSelfSignedSslFallback() {
  return process.env.ALLOW_SELF_SIGNED_SSL === 'true';
}

function commandErrorDetails(error) {
  return {
    stdout: (error.stdout || '').trim(),
    stderr: (error.stderr || '').trim(),
    message: error.message
  };
}

function nginxSetupError(error) {
  const stderr = error.stderr || '';
  const missingCertMatch = findMissingCertificate(error);
  const rollbackWarnings = Array.isArray(error.rollbackWarnings) ? error.rollbackWarnings : [];

  if (missingCertMatch) {
    return new AppError(
      `Nginx has an enabled SSL site with a missing certificate: ${missingCertMatch[1]}. Reissue that certificate with certbot or disable the stale Nginx site, then run Nginx setup again.`,
      503,
      'NGINX_MISSING_CERTIFICATE',
      { stderr: stderr.trim(), certificatePath: missingCertMatch[1], rollbackWarnings }
    );
  }

  return new AppError(
    `Nginx setup failed: ${error.message}`,
    503,
    'NGINX_SETUP_FAILED',
    { stderr, rollbackWarnings }
  );
}

function findMissingCertificate(error) {
  const text = [
    error?.stderr,
    error?.stdout,
    error?.message,
    error?.details?.stderr,
    error?.details?.stdout
  ].filter(Boolean).join('\n');

  return text.match(/cannot load certificate "([^"]+)"/);
}

function missingCertificateError(error, action) {
  const missingCertMatch = findMissingCertificate(error);
  if (!missingCertMatch) return null;

  return new AppError(
    `Cannot ${action} because Nginx has an enabled SSL site with a missing certificate: ${missingCertMatch[1]}. Reissue that certificate with certbot or disable the stale Nginx site, then try again.`,
    503,
    'NGINX_MISSING_CERTIFICATE',
    { ...commandErrorDetails(error), certificatePath: missingCertMatch[1] }
  );
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readLinkIfExists(filePath) {
  try {
    return await fs.readlink(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function restoreNginxConfig(configPath, enabledPath, previousConfig, previousEnabledTarget) {
  const warnings = [];

  try {
    await unlinkIfExists(enabledPath);
    if (previousEnabledTarget) {
      await fs.symlink(previousEnabledTarget, enabledPath);
    }
  } catch (error) {
    warnings.push(`restore enabled link: ${error.message}`);
  }

  try {
    if (previousConfig === null) {
      await unlinkIfExists(configPath);
    } else {
      await fs.writeFile(configPath, previousConfig, 'utf8');
    }
  } catch (error) {
    warnings.push(`restore config: ${error.message}`);
  }

  return warnings;
}

// ─── Phase 1: Folder scaffold ─────────────────────────────────────────────────

/**
 * POST /api/projects/:id/setup/scaffold
 *
 * Creates the standard folder tree under the project path and writes an initial
 * .env file from the project_envs table. Safe to re-run at any time.
 */
async function scaffold(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const created = [];
    for (const dir of SCAFFOLD_DIRS) {
      const fullPath = path.join(project.path, dir);
      await fs.mkdir(fullPath, { recursive: true });
      created.push(fullPath);
    }

    const runtime = normalizeRuntime(null, project.config?.runtime);

    // Seed initial env vars (runtime, port, slug, etc.) if not already set
    await upsertProjectEnv(projectId, 'PROJECT_SLUG', project.slug);
    if (runtime) await upsertProjectEnv(projectId, 'PROJECT_RUNTIME', runtime);
    if (project.domain) await upsertProjectEnv(projectId, 'PROJECT_DOMAIN', project.domain);
    if (runtime && PORT_RUNTIME_SET.has(runtime) && project.port) {
      await upsertProjectEnv(projectId, 'PORT', String(project.port));
    } else {
      await deleteProjectEnv(projectId, 'PORT');
    }

    if (runtime && PHP_RUNTIME_SET.has(runtime)) {
      await upsertProjectEnv(projectId, 'PHP_FPM_SOCKET', project.config?.php?.fpmSocket || DEFAULT_PHP_FPM_SOCKET);
    } else {
      await deleteProjectEnv(projectId, 'PHP_FPM_SOCKET');
    }

    // Write .env file to disk
    await writeProjectEnvFile(projectId, project.path);

    await updateProjectFields(projectId, { status: 'provisioned' });
    await createLog({ userId: req.user.id, action: `scaffolded project ${project.name}` });

    return res.json({
      message: 'Folder structure created',
      directories: created,
      envFile: path.join(project.path, '.env')
    });
  } catch (error) {
    if (error.code === 'EACCES') {
      return next(new AppError(
        `Permission denied creating project directory. Run: sudo mkdir -p ${error.path || '<project-path>'} && sudo chown $(whoami) ${error.path || '<project-path>'}`,
        500,
        'EACCES'
      ));
    }
    return next(error);
  }
}

// ─── Phase 2: Nginx configuration ─────────────────────────────────────────────

/**
 * Returns the appropriate nginx server block template.
 * @param {'proxy'|'static'} type
 * @param {{ slug, domain, port, path }} opts
 */
function buildNginxConfig(type, { slug, domain, port, projectPath }) {
  const logDir = projectPath + '/logs';

  if (type === 'static') {
    return `# EKAFY — ${slug} (static)
server {
    listen 80;
    server_name ${domain};

    root ${projectPath}/public;
    index index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }

    access_log ${logDir}/access.log;
    error_log  ${logDir}/error.log;
}
`;
  }

  // Default: reverse-proxy to a Node/any process on localhost:<port>
  return `# EKAFY — ${slug} (reverse-proxy → 127.0.0.1:${port})
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    access_log ${logDir}/access.log;
    error_log  ${logDir}/error.log;
}
`;
}

function buildSecurityLocations() {
  return String.raw`
    location ~ /\.(?!well-known/) {
        deny all;
        access_log off;
        log_not_found off;
    }

    location ~* (^|/)(\.env|\.git|\.svn|\.hg|composer\.(json|lock)|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|secrets?\.(json|ya?ml)|config\.(json|ya?ml|php)|.*\.(sql|bak|old|save|swp|dist))$ {
        deny all;
        access_log off;
        log_not_found off;
    }
`;
}

function buildProxyLocation(pathPrefix, port) {
  return `
    location ${pathPrefix} {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
`;
}

function buildStaticRootLocations(projectPath, spaFallback = true) {
  const fallback = spaFallback ? '/index.html' : '=404';
  return `
    root ${projectPath}/public;
    index index.html index.htm;

    location / {
        try_files $uri $uri/ ${fallback};
    }
`;
}

function buildPhpLocations(runtime, projectPath, phpFpmSocket) {
  const frontController = runtime === 'wordpress-site' ? '/index.php?$args' : '/index.php?$query_string';
  return String.raw`
    root ${projectPath}/public;
    index index.php index.html index.htm;

    location / {
        try_files $uri $uri/ ${frontController};
    }

    location ~* /(?:uploads|files)/.*\.php$ {
        deny all;
    }

    location ~ \.php$ {
        try_files $uri =404;
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpFpmSocket};
    }
`;
}

function buildRuntimeNginxConfig(runtime, { slug, domain, port, projectPath, phpFpmSocket }) {
  const logDir = projectPath + '/logs';
  const securityLocations = buildSecurityLocations();

  if (runtime === 'static-site') {
    return `# EKAFY - ${slug} (static-site)
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 10m;
${buildStaticRootLocations(projectPath)}
${securityLocations}

    access_log ${logDir}/access.log;
    error_log  ${logDir}/error.log;
}
`;
  }

  if (runtime === 'static-api') {
    return `# EKAFY - ${slug} (static frontend + API proxy -> 127.0.0.1:${port})
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 25m;
${securityLocations}
${buildProxyLocation('/api/', port)}
${buildStaticRootLocations(projectPath)}

    access_log ${logDir}/access.log;
    error_log  ${logDir}/error.log;
}
`;
  }

  if (PHP_RUNTIME_SET.has(runtime)) {
    return `# EKAFY - ${slug} (${runtime} -> PHP-FPM)
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 64m;
${securityLocations}
${buildPhpLocations(runtime, projectPath, phpFpmSocket)}

    access_log ${logDir}/access.log;
    error_log  ${logDir}/error.log;
}
`;
  }

  return `# EKAFY - ${slug} (${runtime} proxy -> 127.0.0.1:${port})
server {
    listen 80;
    server_name ${domain};

    client_max_body_size 25m;
${securityLocations}
${buildProxyLocation('/', port)}

    access_log ${logDir}/access.log;
    error_log  ${logDir}/error.log;
}
`;
}

/**
 * POST /api/projects/:id/setup/nginx
 *
 * Body: { domain?, port?, runtime?, phpFpmSocket? }
 *
 * Generates the nginx server block, writes it to sites-available, creates the
 * symlink in sites-enabled, tests the config, and reloads nginx.
 */
async function generateNginx(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    if (!requireLinux(res) || !requireServiceControl(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const domain = (req.body.domain || project.domain || '').trim().toLowerCase();
    const runtime = normalizeRuntime(req.body.runtime, project.config?.runtime, req.body.type);
    const port = Number(req.body.port || project.port || 0);
    const phpFpmSocket = normalizePhpFpmSocket(req.body.phpFpmSocket || project.config?.php?.fpmSocket);

    if (!domain) {
      return res.status(400).json({ message: 'A domain name is required to generate nginx config' });
    }

    if (!validateDomainName(domain)) {
      return res.status(400).json({ message: 'A valid domain name is required for nginx config' });
    }

    if (!runtime) {
      return res.status(400).json({ message: 'A valid project runtime is required' });
    }

    if (PORT_RUNTIME_SET.has(runtime) && !validatePort(port)) {
      return res.status(400).json({ message: 'This runtime requires an app/API port between 1024 and 65535' });
    }

    if (PHP_RUNTIME_SET.has(runtime) && !phpFpmSocket) {
      return res.status(400).json({ message: 'PHP-FPM socket must look like /run/php/php8.1-fpm.sock' });
    }

    await fs.mkdir(path.join(project.path, 'public'), { recursive: true });
    await fs.mkdir(path.join(project.path, 'logs'), { recursive: true });

    const configContent = buildRuntimeNginxConfig(runtime, {
      slug: project.slug,
      domain,
      port,
      projectPath: project.path,
      phpFpmSocket
    });

    const configPath  = path.join(NGINX_SITES_AVAILABLE, project.slug);
    const enabledPath = path.join(NGINX_SITES_ENABLED, project.slug);
    const previousConfig = await readTextIfExists(configPath);
    const previousEnabledTarget = await readLinkIfExists(enabledPath);

    await fs.writeFile(configPath, configContent, 'utf8');

    // Symlink to sites-enabled (remove stale link if exists)
    await unlinkIfExists(enabledPath);
    await fs.symlink(configPath, enabledPath);

    try {
      // Test and reload nginx
      await runRootCommand('nginx', ['-t'], { timeout: 5000 });
      await runRootCommand('systemctl', ['reload', 'nginx'], { timeout: 8000 });
    } catch (error) {
      error.rollbackWarnings = await restoreNginxConfig(configPath, enabledPath, previousConfig, previousEnabledTarget);
      throw error;
    }

    // Persist domain + port on the project record
    await updateProjectFields(projectId, {
      domain,
      port: PORT_RUNTIME_SET.has(runtime) ? port : null,
      nginx_config_path: configPath
    });
    await updateProjectConfig(projectId, {
      ...project.config,
      kind: kindForRuntime(runtime, project.config?.kind),
      runtime,
      php: {
        ...(project.config?.php || {}),
        fpmSocket: phpFpmSocket || project.config?.php?.fpmSocket || DEFAULT_PHP_FPM_SOCKET
      }
    });
    await upsertProjectEnv(projectId, 'PROJECT_DOMAIN', domain);
    await upsertProjectEnv(projectId, 'PROJECT_RUNTIME', runtime);
    if (PORT_RUNTIME_SET.has(runtime)) await upsertProjectEnv(projectId, 'PORT', String(port));
    else await deleteProjectEnv(projectId, 'PORT');
    if (PHP_RUNTIME_SET.has(runtime)) await upsertProjectEnv(projectId, 'PHP_FPM_SOCKET', phpFpmSocket);
    else await deleteProjectEnv(projectId, 'PHP_FPM_SOCKET');
    await writeProjectEnvFile(projectId, project.path);

    await createLog({ userId: req.user.id, action: `generated nginx config for project ${project.name} (${domain})` });

    return res.json({
      message: 'Nginx config written and nginx reloaded',
      configPath,
      domain,
      runtime
    });
  } catch (error) {
    return next(nginxSetupError(error));
  }
}

// ─── Phase 3: SSL certificate ─────────────────────────────────────────────────

/**
 * POST /api/projects/:id/setup/ssl
 *
 * Attempts Let's Encrypt via certbot --nginx.
 * Falls back to a self-signed certificate only when ALLOW_SELF_SIGNED_SSL=true.
 */
async function provisionSsl(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    if (!requireLinux(res) || !requireServiceControl(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const domain = project.domain || (req.body.domain || '').trim();
    if (!domain) {
      return res.status(400).json({ message: 'Domain must be set before provisioning SSL. Run nginx setup first.' });
    }

    if (!validateDomainName(domain)) {
      return res.status(400).json({ message: 'A valid domain name is required for SSL provisioning' });
    }

const email = process.env.SSL_EMAIL || process.env.ADMIN_EMAIL || '';
    let method = 'certbot';
    let output = '';

    try {
      // Attempt Let's Encrypt
      const args = ['--nginx', '-d', domain, '--non-interactive', '--agree-tos', '--redirect'];
      if (email) args.push('-m', email);
      else args.push('--register-unsafely-without-email');

      const result = await runRootCommand('certbot', args, { timeout: 120000 });
      output = result.stdout;
    } catch (certbotError) {
      if (!allowSelfSignedSslFallback()) {
        await updateProjectFields(projectId, { ssl_enabled: 0 });

        const missingCertError = missingCertificateError(certbotError, 'provision SSL');
        if (missingCertError) {
          return next(missingCertError);
        }

        return next(new AppError(
          'Let\'s Encrypt SSL provisioning failed. No self-signed certificate was installed because Cloudflare Full (strict) requires a trusted origin certificate.',
          503,
          'CERTBOT_FAILED',
          commandErrorDetails(certbotError)
        ));
      }

      // Fall back to self-signed using openssl
      method = 'self-signed';
      const sslDir  = path.join(project.path, 'ssl');
      await fs.mkdir(sslDir, { recursive: true });

      const keyFile  = path.join(sslDir, 'server.key');
      const certFile = path.join(sslDir, 'server.crt');

      const { stdout: sslOut } = await execFileAsync('openssl', [
        'req', '-x509', '-nodes', '-days', '365', '-newkey', 'rsa:2048',
        '-keyout', keyFile,
        '-out', certFile,
        '-subj', `/CN=${domain}`
      ], { timeout: 20000 });

      output = `certbot failed (${certbotError.message}). Self-signed cert generated at ${certFile}`;
    }

    await updateProjectFields(projectId, { ssl_enabled: 1 });
    await createLog({ userId: req.user.id, action: `provisioned SSL (${method}) for project ${project.name}` });

    return res.json({ message: 'SSL provisioned', method, output });
  } catch (error) {
    return next(new AppError(
      `SSL provisioning failed: ${error.message}`,
      503,
      'SSL_PROVISIONING_FAILED'
    ));
  }
}

module.exports = { scaffold, generateNginx, provisionSsl };
