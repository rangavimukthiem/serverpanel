const {
  listProjectsForUser,
  findProjectById,
  createProject,
  updateProjectConfig,
  getProjectMembership,
  upsertProjectMember,
  removeProjectMember
} = require('../models/projectModel');
const { findUserById } = require('../models/userModel');
const { createLog } = require('../models/logModel');

const PROJECT_ROLE_SET = new Set(['manager', 'user']);
const PROJECT_KIND_SET = new Set(['static', 'database', 'api', 'full']);
const HTTP_METHOD_SET = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DATABASE_PRESET_SET = new Set(['create-database', 'grant-access', 'create-schema', 'seed-baseline']);
const API_PRESET_SET = new Set(['health', 'auth', 'resources', 'custom-crud']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProjectKind(kind) {
  const value = (trimText(kind) || 'static').toLowerCase();
  return PROJECT_KIND_SET.has(value) ? value : null;
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
  const kind = normalizeProjectKind(input.kind);
  if (!kind) {
    return null;
  }

  const config = {
    kind,
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

  const { kind, database, api } = projectConfig;

  if ((kind === 'database' || kind === 'full') && (!database.databaseName || !database.username)) {
    return 'Database-backed projects require a database name and database user';
  }

  if ((kind === 'api' || kind === 'full') && (!api.baseUrl || !Array.isArray(api.endpoints) || api.endpoints.length === 0)) {
    return 'API-backed projects require a base URL and at least one endpoint';
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
    const { name, slug, path, status = 'active', domain, port, gitRepoUrl, gitBranch = 'main' } = req.body;
    const projectConfig = buildProjectConfig(req.body.config || req.body);

    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
      return res.status(400).json({ message: 'Project name must be 2-120 characters' });
    }

    if (!SLUG_PATTERN.test(slug || '')) {
      return res.status(400).json({ message: 'Slug must be lowercase letters, numbers, and dashes' });
    }

    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 255) {
      return res.status(400).json({ message: 'Project path must be an absolute path (starting with /)' });
    }

    const configError = validateProjectConfig(projectConfig);
    if (configError) {
      return res.status(400).json({ message: configError });
    }

    const project = await createProject({
      name: name.trim(),
      slug,
      path,
      status,
      config: projectConfig,
      domain:     domain     ? String(domain).trim()     : null,
      port:       port       ? Number(port)              : null,
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
  getProjectWizard,
  setProjectMember,
  deleteProjectMember
};
