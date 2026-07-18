const {
  listProjectsForUser,
  findProjectById,
  createProject,
  updateProjectConfig,
  updateProjectFields,
  deleteProjectById,
  getProjectMembership,
  upsertProjectMember,
  removeProjectMember
} = require('../models/projectModel');
const { getAllProjectEnvsAsObject } = require('../models/projectEnvModel');
const { listProjectServices } = require('../models/projectServiceModel');
const { findUserById } = require('../models/userModel');
const { createLog } = require('../models/logModel');
const { query, adminQuery } = require('../config/db');
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PROJECT_ROLE_SET = new Set(['manager', 'user']);
const PROJECT_KIND_SET = new Set(['static', 'database', 'api', 'full']);
const PROJECT_STATUS_SET = new Set(['active', 'inactive']);
const PROJECT_RUNTIME_SET = new Set(['static-site', 'node-app', 'python-api', 'php-site', 'wordpress-site', 'static-api']);
const DATABASE_RUNTIME_SET = new Set(['wordpress-site']);
const API_RUNTIME_SET = new Set(['node-app', 'python-api', 'static-api']);
const HTTP_METHOD_SET = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DATABASE_PRESET_SET = new Set(['create-database', 'grant-access', 'create-schema', 'seed-baseline']);
const API_PRESET_SET = new Set(['health', 'auth', 'resources', 'custom-crud']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PHP_FPM_SOCKET_PATTERN = /^\/run\/php\/php\d+\.\d+-fpm\.sock$/;
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/srv';
const NGINX_SITES_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_SITES_ENABLED = '/etc/nginx/sites-enabled';
const SYSTEMD_SYSTEM_DIR = '/etc/systemd/system';

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProjectKind(kind) {
  const value = (trimText(kind) || 'static').toLowerCase();
  return PROJECT_KIND_SET.has(value) ? value : null;
}

function normalizeProjectRuntime(runtime) {
  const value = (trimText(runtime) || 'static-site').toLowerCase();
  return PROJECT_RUNTIME_SET.has(value) ? value : null;
}

function deriveKindFromRuntime(runtime, requestedKind) {
  if (DATABASE_RUNTIME_SET.has(runtime)) return 'database';
  if (API_RUNTIME_SET.has(runtime)) return 'api';
  return requestedKind && PROJECT_KIND_SET.has(requestedKind) ? requestedKind : 'static';
}

function normalizeProjectPath(projectPath) {
  const value = trimText(projectPath);
  if (!value || !value.startsWith('/') || value.length > 255) return null;

  const normalized = path.posix.normalize(value);
  const root = path.posix.normalize(PROJECTS_ROOT);
  if (normalized === root || !normalized.startsWith(`${root}/`)) return null;
  if (normalized.includes('/../')) return null;

  return normalized;
}

function validateDomainName(domain) {
  return !domain || DOMAIN_PATTERN.test(domain);
}

function normalizeDatabaseConfig(database = {}) {
  const port = Number(database.port || 3306);
  return {
    enabled: Boolean(database.enabled),
    provider: (trimText(database.provider) || 'mariadb').toLowerCase(),
    host: trimText(database.host) || '127.0.0.1',
    port: Number.isFinite(port) && port > 0 ? port : 3306,
    databaseName: trimText(database.databaseName),
    username: trimText(database.username),
    charset: trimText(database.charset) || 'utf8mb4'
  };
}

function normalizeApiEndpoints(endpoints = []) {
  if (!Array.isArray(endpoints)) return [];

  return endpoints
    .map((endpoint) => ({
      name: trimText(endpoint?.name),
      method: trimText(endpoint?.method).toUpperCase(),
      path: trimText(endpoint?.path),
      description: trimText(endpoint?.description)
    }))
    .filter((endpoint) => endpoint.name && endpoint.path.startsWith('/') && HTTP_METHOD_SET.has(endpoint.method));
}

function normalizeApiConfig(api = {}) {
  return {
    enabled: Boolean(api.enabled),
    baseUrl: trimText(api.baseUrl),
    endpoints: normalizeApiEndpoints(api.endpoints)
  };
}

function normalizeQueryPresets(queryPresets = []) {
  if (!Array.isArray(queryPresets)) return [];
  return [...new Set(queryPresets.map((preset) => trimText(preset)).filter((preset) => DATABASE_PRESET_SET.has(preset)))];
}

function buildProjectConfig(input = {}) {
  const runtime = normalizeProjectRuntime(input.runtime || input.deploymentType || input.type);
  if (!runtime) {
    return null;
  }

  const requestedKind = normalizeProjectKind(input.kind);
  const kind = deriveKindFromRuntime(runtime, requestedKind);
  if (!kind) {
    return null;
  }

  const config = {
    kind,
    runtime,
    php: {
      fpmSocket: trimText(input.php?.fpmSocket) || '/run/php/php8.1-fpm.sock'
    },
    database: normalizeDatabaseConfig(input.database),
    api: normalizeApiConfig(input.api),
    queryPresets: normalizeQueryPresets(input.queryPresets),
    notes: trimText(input.notes)
  };

  if (kind === 'static') {
    config.database.enabled = false;
    config.api.enabled = false;
  }

  if (kind === 'database') {
    config.database.enabled = true;
  }

  if (kind === 'api') {
    config.api.enabled = true;
  }

  if (kind === 'full') {
    config.database.enabled = true;
    config.api.enabled = true;
  }

  if (runtime === 'wordpress-site') {
    config.database.enabled = true;
  }

  if (runtime === 'node-app' || runtime === 'python-api') {
    config.api.enabled = true;
  }

  if (runtime === 'static-api') {
    config.api.enabled = true;
  }

  return config;
}

function buildDatabaseWizard(config) {
  const database = config?.database || {};
  if (!database.enabled) return null;

  const databaseName = database.databaseName || '<DATABASE_NAME>';
  const username = database.username || '<DB_USER>';
  const host = database.host || 'localhost';
  const charset = database.charset || 'utf8mb4';

  return {
    summary: {
      provider: database.provider || 'mariadb',
      host,
      port: database.port || 3306,
      databaseName,
      username,
      charset
    },
    sql: [
      `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET ${charset} COLLATE ${charset}_unicode_ci;`,
      `CREATE USER IF NOT EXISTS '${username}'@'${host}' IDENTIFIED BY '<PASSWORD>';`,
      `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${username}'@'${host}';`,
      'FLUSH PRIVILEGES;'
    ],
    presets: [
      { key: 'create-database', label: 'Create database', sql: `CREATE DATABASE IF NOT EXISTS \`${databaseName}\`;` },
      { key: 'grant-access', label: 'Grant access', sql: `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${username}'@'${host}';` },
      { key: 'create-schema', label: 'Create schema', sql: `USE \`${databaseName}\`;\n-- add table definitions here` },
      { key: 'seed-baseline', label: 'Seed baseline', sql: `USE \`${databaseName}\`;\n-- add seed inserts here` }
    ].filter((preset) => DATABASE_PRESET_SET.has(preset.key))
  };
}

function buildApiWizard(config) {
  const api = config?.api || {};
  if (!api.enabled) return null;

  return {
    summary: {
      baseUrl: api.baseUrl || '',
      endpoints: Array.isArray(api.endpoints) ? api.endpoints : []
    },
    presets: [
      { key: 'health', label: 'Health endpoint', value: { name: 'Health', method: 'GET', path: '/health', description: 'Service health check' } },
      { key: 'auth', label: 'Auth endpoint', value: { name: 'Auth', method: 'POST', path: '/auth/login', description: 'Login or token exchange' } },
      { key: 'resources', label: 'Resource list', value: { name: 'Resources', method: 'GET', path: '/resources', description: 'List resources' } },
      { key: 'custom-crud', label: 'CRUD template', value: { name: 'CRUD', method: 'POST', path: '/items', description: 'Replace with your resource path' } }
    ].filter((preset) => API_PRESET_SET.has(preset.key))
  };
}

function validateProjectConfig(projectConfig) {
  if (!projectConfig) {
    return 'Invalid project wizard configuration';
  }

  const { kind, runtime, database, api } = projectConfig;

  if (!PROJECT_RUNTIME_SET.has(runtime)) {
    return 'Invalid project runtime';
  }

  if ((runtime === 'php-site' || runtime === 'wordpress-site') && !PHP_FPM_SOCKET_PATTERN.test(projectConfig.php?.fpmSocket || '')) {
    return 'PHP-FPM socket must look like /run/php/php8.1-fpm.sock';
  }

  if ((kind === 'database' || kind === 'full') && (!database.databaseName || !database.username)) {
    return 'Database-backed projects require a database name and database user';
  }

  return null;
}

async function listProjects(req, res, next) {
  try {
    const projects = await listProjectsForUser(req.user);
    return res.json({ projects });
  } catch (error) {
    return next(error);
  }
}

async function createManagedProject(req, res, next) {
  try {
    const { name, slug, status = 'active', domain, port, gitRepoUrl, gitBranch = 'main' } = req.body;
    const projectConfig = buildProjectConfig(req.body.config || req.body);

    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
      return res.status(400).json({ message: 'Project name must be 2-120 characters' });
    }

    if (!SLUG_PATTERN.test(slug || '')) {
      return res.status(400).json({ message: 'Slug must be lowercase letters, numbers, and dashes' });
    }

    const projectPath = normalizeProjectPath(req.body.path);
    if (!projectPath) {
      return res.status(400).json({ message: `Project path must be inside ${PROJECTS_ROOT}` });
    }

    const normalizedDomain = domain ? String(domain).trim().toLowerCase() : null;
    if (!validateDomainName(normalizedDomain)) {
      return res.status(400).json({ message: 'Project domain must be a valid hostname' });
    }

    const configError = validateProjectConfig(projectConfig);
    if (configError) {
      return res.status(400).json({ message: configError });
    }

    const runtimeRequiresPort = projectConfig.runtime === 'node-app' || projectConfig.runtime === 'python-api' || projectConfig.runtime === 'static-api';
    const submittedPort = port ? Number(port) : null;
    const normalizedPort = runtimeRequiresPort ? submittedPort : null;
    if (submittedPort && (!Number.isInteger(submittedPort) || submittedPort < 1024 || submittedPort > 65535)) {
      return res.status(400).json({ message: 'Project port must be between 1024 and 65535' });
    }

    if (runtimeRequiresPort && !normalizedPort) {
      return res.status(400).json({ message: 'This runtime requires a private app/API port' });
    }

    const project = await createProject({
      name: name.trim(),
      slug,
      path: projectPath,
      status,
      config: projectConfig,
      domain:     normalizedDomain,
      port:       normalizedPort,
      gitRepoUrl: gitRepoUrl ? String(gitRepoUrl).trim() : null,
      gitBranch:  gitBranch  ? String(gitBranch).trim()  : 'main'
    });

    await createLog({
      userId: req.user.id,
      action: `created project ${project.name} with ${projectConfig.kind} wizard`
    });

    return res.status(201).json({
      project,
      wizard: {
        database: buildDatabaseWizard(project.config),
        api: buildApiWizard(project.config)
      }
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Project slug already exists' });
    }

    return next(error);
  }
}

async function updateProjectWizardConfig(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const canManage = await canManageProjectConfigAccess(req.user, projectId);
    if (!canManage) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const projectConfig = buildProjectConfig(req.body.config || req.body);
    const configError = validateProjectConfig(projectConfig);
    if (configError) {
      return res.status(400).json({ message: configError });
    }

    const updatedProject = await updateProjectConfig(projectId, projectConfig);
    await createLog({
      userId: req.user.id,
      action: `updated wizard config for project ${project.name}`
    });

    return res.json({
      project: updatedProject,
      wizard: {
        database: buildDatabaseWizard(updatedProject.config),
        api: buildApiWizard(updatedProject.config)
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function updateProjectStatus(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required to change project status' });
    }

    const status = trimText(req.body.status).toLowerCase();
    if (!PROJECT_STATUS_SET.has(status)) {
      return res.status(400).json({ message: 'Project status must be active or inactive' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const updatedProject = await updateProjectFields(projectId, { status });
    await createLog({
      userId: req.user.id,
      action: `set project ${project.name} status to ${status}`
    });

    return res.json({ project: updatedProject });
  } catch (error) {
    return next(error);
  }
}

async function getProjectWizard(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const canView = await canViewProjectConfigAccess(req.user, projectId);
    if (!canView) {
      return res.status(403).json({ message: 'Project access required' });
    }

    return res.json({
      project,
      wizard: {
        database: buildDatabaseWizard(project.config),
        api: buildApiWizard(project.config)
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function setProjectMember(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const { userId, role = 'user' } = req.body;
    const memberUserId = Number(userId);

    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(memberUserId) || memberUserId <= 0) {
      return res.status(400).json({ message: 'Invalid project or user id' });
    }

    if (!PROJECT_ROLE_SET.has(role)) {
      return res.status(400).json({ message: 'Invalid project role' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const targetUser = await findUserById(memberUserId);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const canManage = await canManageProjectMembers(req.user, projectId, role);
    if (!canManage) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    await upsertProjectMember({ projectId, userId: memberUserId, role });
    await createLog({
      userId: req.user.id,
      action: `set ${targetUser.username} as ${role} on project ${project.name}`
    });

    return res.json({ message: 'Project member saved' });
  } catch (error) {
    return next(error);
  }
}

async function deleteProjectMember(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const memberUserId = Number(req.params.userId);

    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(memberUserId) || memberUserId <= 0) {
      return res.status(400).json({ message: 'Invalid project or user id' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const canManage = await canManageProjectMembers(req.user, projectId, 'user');
    if (!canManage) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    await removeProjectMember({ projectId, userId: memberUserId });
    await createLog({ userId: req.user.id, action: `removed user ${memberUserId} from project ${project.name}` });

    return res.json({ message: 'Project member removed' });
  } catch (error) {
    return next(error);
  }
}

function canUseShellCleanup() {
  return process.platform !== 'win32';
}

function rootCommand(args) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { file: 'sudo', args: ['-n', ...args] };
  }
  return { file: args[0], args: args.slice(1) };
}

function systemctlCommand(args) {
  return rootCommand(args);
}

async function reloadNginxIfPossible() {
  if (!canUseShellCleanup()) {
    return;
  }

  const command = systemctlCommand(['systemctl', 'reload', 'nginx']);
  await execFileAsync(command.file, command.args, { timeout: 8000 });
}

async function runSystemctl(args, timeout = 10000) {
  const command = systemctlCommand(['systemctl', ...args]);
  await execFileAsync(command.file, command.args, { timeout });
}

function normalizeInsideRoot(targetPath, rootPath) {
  const value = trimText(targetPath);
  if (!value || !value.startsWith('/')) return null;

  const normalized = path.posix.normalize(value);
  const root = path.posix.normalize(rootPath);

  if (normalized === root || !normalized.startsWith(`${root}/`)) return null;
  return normalized;
}

function isSafeSqlIdentifier(value) {
  return /^[A-Za-z0-9_]{1,64}$/.test(trimText(value));
}

function isSafeSqlAccountHost(value) {
  return /^[A-Za-z0-9_.:%-]{1,253}$/.test(trimText(value));
}

function isSafeSystemdServiceName(value) {
  return /^[A-Za-z0-9_.@-]{1,128}(?:\.service)?$/.test(trimText(value));
}

function serviceUnitFilePath(serviceName) {
  const value = trimText(serviceName);
  if (!isSafeSystemdServiceName(value)) return null;

  const unitName = value.endsWith('.service') ? value : `${value}.service`;
  return path.posix.join(SYSTEMD_SYSTEM_DIR, unitName);
}

async function removePathIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function removeFileIfExists(filePath, warningLabel, warnings) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(`${warningLabel}: ${error.message}`);
    }
  }
}

async function cleanupProjectDatabase(project, envs) {
  const databaseConfig = project.config?.database || {};
  const databaseName = trimText(envs.DB_NAME || databaseConfig.databaseName);
  const databaseUser = trimText(envs.DB_USER || databaseConfig.username);
  const databaseHost = trimText(envs.DB_HOST || databaseConfig.host || '127.0.0.1');

  if (!databaseName && !databaseUser) {
    return null;
  }

  if (databaseName) {
    if (!isSafeSqlIdentifier(databaseName)) {
      throw new Error(`Unsafe database name "${databaseName}"`);
    }

    await adminQuery(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  }

  if (databaseUser) {
    if (!isSafeSqlIdentifier(databaseUser)) {
      throw new Error(`Unsafe database user "${databaseUser}"`);
    }

    if (!isSafeSqlAccountHost(databaseHost)) {
      throw new Error(`Unsafe database host "${databaseHost}"`);
    }

    const accountHosts = new Set([databaseHost]);
    if (databaseHost === 'localhost' || databaseHost === '127.0.0.1') {
      accountHosts.add('localhost');
      accountHosts.add('127.0.0.1');
    }

    for (const accountHost of accountHosts) {
      await adminQuery(`DROP USER IF EXISTS '${databaseUser}'@'${accountHost}'`);
    }
  }

  await adminQuery('FLUSH PRIVILEGES');
  return { databaseName, databaseUser, databaseHost };
}

async function cleanupProjectNginx(project, warnings) {
  const configPath =
    normalizeInsideRoot(project.nginx_config_path, NGINX_SITES_AVAILABLE) ||
    path.posix.join(NGINX_SITES_AVAILABLE, project.slug);
  const enabledPaths = new Set([
    path.posix.join(NGINX_SITES_ENABLED, project.slug),
    path.posix.join(NGINX_SITES_ENABLED, path.posix.basename(configPath))
  ]);

  for (const enabledPath of enabledPaths) {
    await removeFileIfExists(enabledPath, 'Nginx enabled link', warnings);
  }

  await removeFileIfExists(configPath, 'Nginx config', warnings);

  if (canUseShellCleanup()) {
    try {
      await reloadNginxIfPossible();
    } catch (error) {
      warnings.push(`Nginx reload: ${error.message}`);
    }
  }
}

async function cleanupProjectSsl(project, warnings) {
  if (!project.ssl_enabled) {
    return;
  }

  if (!canUseShellCleanup()) {
    warnings.push('SSL certificate cleanup skipped on non-Linux host');
    return;
  }

  const domain = project.domain || '';
  if (!domain) {
    return;
  }

  try {
    const command = rootCommand(['certbot', 'delete', '--cert-name', domain, '--non-interactive']);
    await execFileAsync(command.file, command.args, { timeout: 60000 });
  } catch (error) {
    warnings.push(`SSL certificate cleanup: ${error.message}`);
  }
}

async function cleanupProjectServices(projectId, warnings) {
  if (!canUseShellCleanup()) {
    warnings.push('Project service cleanup skipped on non-Linux host');
    return;
  }

  const services = await listProjectServices(projectId);
  for (const service of services) {
    const serviceName = trimText(service.service_name);
    try {
      await runSystemctl(['stop', serviceName]);
    } catch (error) {
      warnings.push(`Project service stop (${serviceName}): ${error.message}`);
    }

    try {
      await runSystemctl(['disable', serviceName]);
    } catch (error) {
      warnings.push(`Project service disable (${serviceName}): ${error.message}`);
    }

    try {
      await runSystemctl(['reset-failed', serviceName]);
    } catch (error) {
      warnings.push(`Project service reset (${serviceName}): ${error.message}`);
    }

    const unitPath = serviceUnitFilePath(serviceName);
    if (!unitPath) {
      warnings.push(`Project service unit skipped (${serviceName}): unsafe service name`);
      continue;
    }

    await removeFileIfExists(unitPath, `Project service unit (${serviceName})`, warnings);

    try {
      await fs.rm(`${unitPath}.d`, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`Project service drop-ins (${serviceName}): ${error.message}`);
    }
  }

  try {
    await runSystemctl(['daemon-reload']);
  } catch (error) {
    warnings.push(`Systemd daemon reload: ${error.message}`);
  }
}

async function cleanupProjectFilesystem(project, warnings) {
  const projectPath = normalizeProjectPath(project.path);
  if (!projectPath) {
    warnings.push(`Project files skipped: path is outside ${PROJECTS_ROOT}`);
    return;
  }

  try {
    await removePathIfExists(projectPath);
  } catch (error) {
    warnings.push(`Project files: ${error.message}`);
  }
}

async function deleteProject(req, res, next) {
  const warnings = [];

  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required to delete a project' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const envs = await getAllProjectEnvsAsObject(projectId);

    await cleanupProjectDatabase(project, envs).catch((error) => {
      warnings.push(`Database cleanup: ${error.message}`);
    });

    await cleanupProjectNginx(project, warnings);
    await cleanupProjectSsl(project, warnings);
    await cleanupProjectServices(projectId, warnings);
    await cleanupProjectFilesystem(project, warnings);

    const deleted = await deleteProjectById(projectId);
    if (!deleted) {
      return res.status(404).json({ message: 'Project not found' });
    }

    await createLog({
      userId: req.user.id,
      action: `deleted project ${project.name} and removed project resources`
    }).catch(() => {});

    return res.json({
      message: 'Project deleted',
      projectId,
      warnings
    });
  } catch (error) {
    return next(error);
  }
}

async function canManageProjectMembers(user, projectId, assignedRole) {
  if (user.role === 'admin') {
    return true;
  }

  const membership = await getProjectMembership(projectId, user.id);

  if (membership?.role !== 'manager') {
    return false;
  }

  return assignedRole === 'user';
}

async function canManageProjectConfigAccess(user, projectId) {
  if (user.role === 'admin') {
    return true;
  }

  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

async function canViewProjectConfigAccess(user, projectId) {
  if (user.role === 'admin') {
    return true;
  }

  const membership = await getProjectMembership(projectId, user.id);
  return Boolean(membership);
}

module.exports = {
  listProjects,
  createManagedProject,
  updateProjectWizardConfig,
  updateProjectStatus,
  getProjectWizard,
  setProjectMember,
  deleteProjectMember,
  deleteProject
};
