'use strict';

/**
 * projectModel.js
 *
 * Core data access for the `projects` and `project_members` tables.
 * Config is stored as JSON in `config_json` and parsed/serialised transparently.
 * New columns added since v0.1.0 are migrated at boot by ensureProjectSchema().
 */

const { query } = require('../config/db');

// ─── Default config shape ─────────────────────────────────────────────────────

const DEFAULT_PROJECT_CONFIG = {
  kind: 'static',
  runtime: 'static-site',
  php: {
    fpmSocket: '/run/php/php8.1-fpm.sock'
  },
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
  if (!rawConfig) return cloneDefaultConfig();

  try {
    const parsed = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    const defaults = cloneDefaultConfig();

    return {
      ...defaults,
      ...parsed,
      php: { ...defaults.php, ...(parsed.php || {}) },
      database: { ...defaults.database, ...(parsed.database || {}) },
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

// ─── Schema migration ─────────────────────────────────────────────────────────

/**
 * Idempotent boot-time schema migration.
 * Adds any missing columns to the `projects` table and creates the new
 * `project_envs` and `project_services` tables if they do not exist.
 */
async function ensureProjectSchema() {
  // New columns on `projects` table (added since the initial schema)
  const newColumns = [
    { name: 'config_json',       def: 'LONGTEXT NULL',                        after: 'status' },
    { name: 'domain',            def: 'VARCHAR(253) NULL',                     after: 'config_json' },
    { name: 'port',              def: 'SMALLINT UNSIGNED NULL',                after: 'domain' },
    { name: 'git_repo_url',      def: 'VARCHAR(512) NULL',                     after: 'port' },
    { name: 'git_branch',        def: "VARCHAR(120) NOT NULL DEFAULT 'main'",  after: 'git_repo_url' },
    { name: 'ssl_enabled',       def: 'TINYINT(1) NOT NULL DEFAULT 0',         after: 'git_branch' },
    { name: 'nginx_config_path', def: 'VARCHAR(512) NULL',                     after: 'ssl_enabled' }
  ];

  for (const col of newColumns) {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'projects'
         AND COLUMN_NAME  = ?`,
      [col.name]
    );

    if (Number(rows[0]?.total || 0) === 0) {
      await query(
        `ALTER TABLE projects ADD COLUMN ${col.name} ${col.def} AFTER ${col.after}`
      );
    }
  }

  // project_envs table
  await query(`
    CREATE TABLE IF NOT EXISTS project_envs (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id  INT UNSIGNED NOT NULL,
      env_key     VARCHAR(128) NOT NULL,
      env_value   TEXT         NOT NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY project_envs_unique (project_id, env_key),
      CONSTRAINT project_envs_project_fk
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // project_services table
  await query(`
    CREATE TABLE IF NOT EXISTS project_services (
      id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id   INT UNSIGNED NOT NULL,
      service_name VARCHAR(128) NOT NULL,
      label        VARCHAR(255) NOT NULL,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY project_services_unique (project_id, service_name),
      CONSTRAINT project_services_project_fk
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
}

// ─── Project queries ──────────────────────────────────────────────────────────

/**
 * Build a full project object from a DB row, parsing config_json.
 * @param {object} row
 */
function hydrateProject(row) {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    path: row.path,
    domain: row.domain || null,
    port: row.port ? Number(row.port) : null,
    status: row.status,
    config: parseProjectConfig(row.config_json),
    git_repo_url: row.git_repo_url || null,
    git_branch: row.git_branch || 'main',
    ssl_enabled: Boolean(row.ssl_enabled),
    nginx_config_path: row.nginx_config_path || null,
    created_at: row.created_at
  };
}

/**
 * List projects visible to the given user.
 * Admins see all projects; regular users see only those they are members of.
 * Each project includes a `members` array and the caller's `current_user_role`.
 */
async function listProjectsForUser(user) {
  const params = [];
  let where = '';

  if (user.role !== 'admin') {
    where = 'WHERE pm_current.user_id = ?';
    params.push(user.id);
  }

  const rows = await query(`
    SELECT
      p.id, p.name, p.slug, p.path, p.domain, p.port,
      p.status, p.config_json, p.git_repo_url, p.git_branch,
      p.ssl_enabled, p.nginx_config_path, p.created_at,
      pm.user_id,
      pm.role            AS project_role,
      u.username,
      u.role             AS global_role,
      pm_current.role    AS current_user_project_role
    FROM projects p
    LEFT JOIN project_members pm         ON pm.project_id = p.id
    LEFT JOIN users u                    ON u.id = pm.user_id
    LEFT JOIN project_members pm_current ON pm_current.project_id = p.id
                                        AND pm_current.user_id = ?
    ${where}
    ORDER BY p.name ASC, u.username ASC
  `, [user.id, ...params]);

  return groupProjectRows(rows, user);
}

/**
 * Find a single project by its numeric ID.
 * Returns null if not found.
 */
async function findProjectById(id) {
  const rows = await query(
    `SELECT id, name, slug, path, domain, port, status, config_json,
            git_repo_url, git_branch, ssl_enabled, nginx_config_path, created_at
     FROM projects WHERE id = ? LIMIT 1`,
    [id]
  );

  if (!rows[0]) return null;
  return hydrateProject(rows[0]);
}

/**
 * Create a new project record.
 */
async function createProject({ name, slug, path, domain = null, port = null, status = 'active', config = null, gitRepoUrl = null, gitBranch = 'main' }) {
  const result = await query(
    `INSERT INTO projects (name, slug, path, domain, port, status, config_json, git_repo_url, git_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, slug, path, domain, port, status, serializeProjectConfig(config), gitRepoUrl, gitBranch]
  );
  return findProjectById(Number(result.insertId));
}

/**
 * Partial update of scalar project fields.
 * Pass only the fields you want to change in `fields`.
 * @param {number} id
 * @param {object} fields - Any subset of: domain, port, status, git_repo_url, git_branch, ssl_enabled, nginx_config_path
 */
async function updateProjectFields(id, fields) {
  const ALLOWED = ['domain', 'port', 'status', 'git_repo_url', 'git_branch', 'ssl_enabled', 'nginx_config_path'];
  const entries = Object.entries(fields).filter(([key]) => ALLOWED.includes(key));
  if (!entries.length) return findProjectById(id);

  const setClauses = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, val]) => val);

  await query(`UPDATE projects SET ${setClauses} WHERE id = ?`, [...values, id]);
  return findProjectById(id);
}

/**
 * Update only the config_json of a project.
 */
async function updateProjectConfig(id, config) {
  await query('UPDATE projects SET config_json = ? WHERE id = ?', [serializeProjectConfig(config), id]);
  return findProjectById(id);
}

/**
 * Permanently delete a project record.
 * Child records in project_members, project_envs, and project_services
 * cascade automatically through foreign keys.
 */
async function deleteProjectById(id) {
  const result = await query('DELETE FROM projects WHERE id = ?', [id]);
  return Number(result.affectedRows || 0) > 0;
}

// ─── Project membership ───────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupProjectRows(rows, user) {
  const projects = new Map();

  rows.forEach((row) => {
    const id = Number(row.id);

    if (!projects.has(id)) {
      projects.set(id, {
        ...hydrateProject(row),
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
  updateProjectFields,
  deleteProjectById,
  getProjectMembership,
  upsertProjectMember,
  removeProjectMember,
  parseProjectConfig
};
