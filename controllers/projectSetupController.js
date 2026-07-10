'use strict';

/**
 * projectSetupController.js
 *
 * Three-phase project infrastructure setup:
 *   Phase 1 — Folder scaffold  (pure Node fs, no shell)
 *   Phase 2 — Nginx config     (template → write → nginx reload via execFile)
 *   Phase 3 — SSL certificate  (certbot, falls back to self-signed openssl)
 *
 * All operations are idempotent and gated by ENABLE_SERVICE_CONTROL=true on Linux.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { findProjectById, updateProjectFields } = require('../models/projectModel');
const { writeProjectEnvFile, upsertProjectEnv } = require('../models/projectEnvModel');
const { getProjectMembership } = require('../models/projectModel');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

const execFileAsync = promisify(execFile);

// Sub-directories created inside each project root
const SCAFFOLD_DIRS = ['public', 'logs', 'releases', 'shared', 'config'];

const NGINX_SITES_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_SITES_ENABLED   = '/etc/nginx/sites-enabled';

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

    // Seed initial env vars (port, slug, etc.) if not already set
    await upsertProjectEnv(projectId, 'PROJECT_SLUG', project.slug);
    if (project.domain) await upsertProjectEnv(projectId, 'PROJECT_DOMAIN', project.domain);
    if (project.port)   await upsertProjectEnv(projectId, 'PORT', String(project.port));

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

/**
 * POST /api/projects/:id/setup/nginx
 *
 * Body: { domain?, port?, type? ('proxy'|'static') }
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

    const domain = (req.body.domain || project.domain || '').trim();
    const port   = Number(req.body.port || project.port || 3000);
    const type   = req.body.type === 'static' || project.config?.kind === 'static' ? 'static' : 'proxy';

    if (!domain) {
      return res.status(400).json({ message: 'A domain name is required to generate nginx config' });
    }

    const configContent = buildNginxConfig(type, {
      slug: project.slug,
      domain,
      port,
      projectPath: project.path
    });

    const configPath  = path.join(NGINX_SITES_AVAILABLE, project.slug);
    const enabledPath = path.join(NGINX_SITES_ENABLED, project.slug);

    await fs.writeFile(configPath, configContent, 'utf8');

    // Symlink to sites-enabled (remove stale link if exists)
    try { await fs.unlink(enabledPath); } catch (_) { /* ok if missing */ }
    await fs.symlink(configPath, enabledPath);

    // Test and reload nginx
    await execFileAsync('sudo', ['-n', 'nginx', '-t'], { timeout: 5000 });
    await execFileAsync('sudo', ['-n', 'systemctl', 'reload', 'nginx'], { timeout: 8000 });

    // Persist domain + port on the project record
    await updateProjectFields(projectId, { domain, port, nginx_config_path: configPath });
    await upsertProjectEnv(projectId, 'PROJECT_DOMAIN', domain);
    await upsertProjectEnv(projectId, 'PORT', String(port));
    await writeProjectEnvFile(projectId, project.path);

    await createLog({ userId: req.user.id, action: `generated nginx config for project ${project.name} (${domain})` });

    return res.json({
      message: 'Nginx config written and nginx reloaded',
      configPath,
      domain,
      type
    });
  } catch (error) {
    return next(new AppError(
      `Nginx setup failed: ${error.message}`,
      503,
      'NGINX_SETUP_FAILED',
      { stderr: error.stderr }
    ));
  }
}

// ─── Phase 3: SSL certificate ─────────────────────────────────────────────────

/**
 * POST /api/projects/:id/setup/ssl
 *
 * Attempts Let's Encrypt via certbot --nginx.
 * Falls back to a self-signed certificate if certbot fails or is unavailable.
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

    const email = process.env.SSL_EMAIL || process.env.ADMIN_EMAIL || '';
    let method = 'certbot';
    let output = '';

    try {
      // Attempt Let's Encrypt
      const args = ['--nginx', '-d', domain, '--non-interactive', '--agree-tos'];
      if (email) args.push('-m', email);
      const result = await execFileAsync('certbot', args, { timeout: 60000 });
      output = result.stdout;
    } catch (certbotError) {
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
