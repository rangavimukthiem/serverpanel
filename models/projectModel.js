const { query } = require('../config/db');

const DEFAULT_PROJECT_CONFIG = {
  kind: 'static',
  database: {
    enabled: false,
    provider: 'mariadb',
    host: '127.0.0.1',
    port: 3306,
    databaseName: '',
    username: '',
    charset: 'utf8mb4'
  },
  api: {
    enabled: false,
    baseUrl: '',
    endpoints: []
  },
  queryPresets: [],
  notes: ''
};

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
}

function parseProjectConfig(rawConfig) {
  if (!rawConfig) {
    return cloneDefaultConfig();
  }

  try {
    const parsed = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    const defaults = cloneDefaultConfig();

    return {
      ...defaults,
      ...parsed,
      database: {
        ...defaults.database,
        ...(parsed.database || {})
      },
      api: {
        ...defaults.api,
        ...(parsed.api || {}),
        endpoints: Array.isArray(parsed.api?.endpoints) ? parsed.api.endpoints : []
      },
      queryPresets: Array.isArray(parsed.queryPresets) ? parsed.queryPresets : [],
      notes: typeof parsed.notes === 'string' ? parsed.notes : ''
    };
  } catch (_error) {
    return cloneDefaultConfig();
  }
}

function serializeProjectConfig(config) {
  return JSON.stringify(parseProjectConfig(config));
}

async function ensureProjectSchema() {
  const rows = await query(`
    SELECT COUNT(*) AS total
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'projects'
      AND COLUMN_NAME = 'config_json'
  `);

  if (Number(rows[0]?.total || 0) === 0) {
    await query('ALTER TABLE projects ADD COLUMN config_json LONGTEXT NULL AFTER status');
  }
}

async function listProjectsForUser(user) {
  const params = [];
  let where = '';

  if (user.role !== 'admin') {
    where = 'WHERE pm_current.user_id = ?';
    params.push(user.id);
  }

  const rows = await query(`
    SELECT
      p.id,
      p.name,
      p.slug,
      p.path,
      p.status,
      p.config_json,
      p.created_at,
      pm.user_id,
      pm.role AS project_role,
      u.username,
      u.role AS global_role,
      pm_current.role AS current_user_project_role
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id
    LEFT JOIN users u ON u.id = pm.user_id
    LEFT JOIN project_members pm_current
      ON pm_current.project_id = p.id
      AND pm_current.user_id = ?
    ${where}
    ORDER BY p.name ASC, u.username ASC
  `, [user.id, ...params]);

  return groupProjectRows(rows, user);
}

async function findProjectById(id) {
  const rows = await query(
    'SELECT id, name, slug, path, status, config_json, created_at FROM projects WHERE id = ? LIMIT 1',
    [id]
  );

  if (!rows[0]) {
    return null;
  }

  return {
    ...rows[0],
    config: parseProjectConfig(rows[0].config_json)
  };
}

async function createProject({ name, slug, path, status = 'active', config = null }) {
  const result = await query(
    'INSERT INTO projects (name, slug, path, status, config_json) VALUES (?, ?, ?, ?, ?)',
    [name, slug, path, status, serializeProjectConfig(config)]
  );

  return findProjectById(Number(result.insertId));
}

async function updateProjectConfig(id, config) {
  await query('UPDATE projects SET config_json = ? WHERE id = ?', [serializeProjectConfig(config), id]);
  return findProjectById(id);
}

async function getProjectMembership(projectId, userId) {
  const rows = await query(
    'SELECT project_id, user_id, role FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1',
    [projectId, userId]
  );

  return rows[0] || null;
}

async function upsertProjectMember({ projectId, userId, role }) {
  await query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [projectId, userId, role]
  );
}

async function removeProjectMember({ projectId, userId }) {
  await query(
    'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, userId]
  );
}

function groupProjectRows(rows, user) {
  const projects = new Map();

  rows.forEach((row) => {
    const id = Number(row.id);

    if (!projects.has(id)) {
      projects.set(id, {
        id,
        name: row.name,
        slug: row.slug,
        path: row.path,
        status: row.status,
        config: parseProjectConfig(row.config_json),
        created_at: row.created_at,
        current_user_role: user.role === 'admin' ? 'admin' : row.current_user_project_role,
        members: []
      });
    }

    if (row.user_id) {
      projects.get(id).members.push({
        id: Number(row.user_id),
        username: row.username,
        global_role: row.global_role,
        project_role: row.project_role
      });
    }
  });

  return Array.from(projects.values());
}

module.exports = {
  ensureProjectSchema,
  listProjectsForUser,
  findProjectById,
  createProject,
  updateProjectConfig,
  getProjectMembership,
  upsertProjectMember,
  removeProjectMember,
  parseProjectConfig
};
