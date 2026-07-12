'use strict';

/**
 * projectDatabaseController.js
 *
 * Database wizard for individual projects:
 *   provision  — Create a MariaDB database + user with an auto-generated password
 *   listTables — List all tables in the project's database
 *   runQuery   — Execute whitelisted SQL via the project's own DB credentials
 *   getPresets — Return reusable SQL template snippets
 *
 * Credentials are stored in `project_envs` and NEVER returned in API responses.
 */

const mariadb = require('mariadb');
const crypto  = require('crypto');

const { findProjectById, getProjectMembership } = require('../models/projectModel');
const { upsertProjectEnv, getAllProjectEnvsAsObject, writeProjectEnvFile } = require('../models/projectEnvModel');
const { query, adminQuery } = require('../config/db');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

const LOCAL_DB_HOST = '127.0.0.1';
const LOCAL_DB_ACCOUNT_HOSTS = ['localhost', '127.0.0.1'];

// ─── SQL statement allowlist ───────────────────────────────────────────────────

const ALLOWED_STATEMENT_PREFIXES = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'TRUNCATE'
]);

const BLOCKED_PATTERNS = [
  /DROP\s+DATABASE/i,
  /DROP\s+USER/i,
  /GRANT\b/i,
  /REVOKE\b/i,
  /FLUSH\b/i,
  /LOAD\s+DATA/i,
  /INTO\s+OUTFILE/i,
  /INTO\s+DUMPFILE/i,
  /EXECUTE\b/i,
  /CALL\b/i
];

function validateSql(sql) {
  const trimmed = sql.trim();
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();

  if (!ALLOWED_STATEMENT_PREFIXES.has(firstWord)) {
    return `SQL statement starting with "${firstWord}" is not allowed.`;
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `SQL contains a blocked keyword or pattern.`;
    }
  }

  return null;
}

// ─── Access ───────────────────────────────────────────────────────────────────

async function canManage(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

async function canView(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return Boolean(membership);
}

// ─── Project DB connection ────────────────────────────────────────────────────

async function getProjectDbConnection(projectId) {
  const envs = await getAllProjectEnvsAsObject(projectId);

  const configuredHost = envs.DB_HOST || LOCAL_DB_HOST;
  if (!LOCAL_DB_ACCOUNT_HOSTS.includes(configuredHost)) {
    throw new AppError(
      'Project database host must be localhost or 127.0.0.1.',
      400,
      'DB_HOST_UNSUPPORTED'
    );
  }

  const host     = LOCAL_DB_HOST;
  const port     = Number(envs.DB_PORT || 3306);
  const user     = envs.DB_USER;
  const password = envs.DB_PASSWORD;
  const database = envs.DB_NAME;

  if (!user || !password || !database) {
    throw new AppError(
      'Project database credentials are not provisioned yet. Run the DB provision step first.',
      400,
      'DB_NOT_PROVISIONED'
    );
  }

  return mariadb.createConnection({ host, port, user, password, database });
}

// ─── Presets ──────────────────────────────────────────────────────────────────

const SQL_PRESETS = [
  {
    key: 'create-table',
    label: 'Create table',
    sql: `CREATE TABLE IF NOT EXISTS \`example\` (
  id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name  VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  },
  {
    key: 'add-column',
    label: 'Add column',
    sql: `ALTER TABLE \`example\`
  ADD COLUMN \`new_column\` VARCHAR(255) NULL AFTER \`name\`;`
  },
  {
    key: 'add-index',
    label: 'Add index',
    sql: `ALTER TABLE \`example\`
  ADD INDEX idx_name (\`name\`);`
  },
  {
    key: 'select-all',
    label: 'SELECT all',
    sql: 'SELECT * FROM `example` LIMIT 100;'
  },
  {
    key: 'count-rows',
    label: 'Count rows',
    sql: 'SELECT COUNT(*) AS total FROM `example`;'
  },
  {
    key: 'drop-table',
    label: 'Drop table',
    sql: 'DROP TABLE IF EXISTS `example`;'
  },
  {
    key: 'seed-baseline',
    label: 'Seed data',
    sql: `INSERT INTO \`example\` (name) VALUES
  ('First record'),
  ('Second record');`
  }
];

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * POST /api/projects/:id/database/provision
 *
 * Body: { databaseName, dbUser, provider? }
 *
 * Creates the MariaDB database and user using the EKAFY admin connection.
 * Saves credentials to project_envs and writes .env to disk.
 */
function isAdminPrivilegeError(error) {
  const privilegeErrorCodes = new Set([
    'ER_ACCESS_DENIED_ERROR',
    'ER_DBACCESS_DENIED_ERROR',
    'ER_SPECIFIC_ACCESS_DENIED_ERROR',
    'ER_TABLEACCESS_DENIED_ERROR',
    'ER_COLUMNACCESS_DENIED_ERROR',
    'ER_PROCACCESS_DENIED_ERROR'
  ]);
  const privilegeErrnos = new Set([1044, 1045, 1142, 1143, 1227, 1370]);

  return privilegeErrorCodes.has(error?.code) || privilegeErrnos.has(Number(error?.errno));
}

function isMissingSocketError(error) {
  return error?.code === 'ENOENT' && /\.sock\b/.test(error?.message || '');
}

async function provision(req, res, next) {
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

    const databaseName = (req.body.databaseName || '').trim().replace(/[^a-zA-Z0-9_]/g, '_');
    const dbUser       = (req.body.dbUser || '').trim().replace(/[^a-zA-Z0-9_]/g, '_');

    if (!databaseName || databaseName.length < 2) {
      return res.status(400).json({ message: 'A valid database name is required (letters, numbers, underscores)' });
    }
    if (!dbUser || dbUser.length < 2) {
      return res.status(400).json({ message: 'A valid database username is required' });
    }

    // Auto-generate a secure 24-char password
    const dbPassword = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x');
    const dbHost = LOCAL_DB_HOST;
    const dbPort = String(process.env.DB_PORT || 3306);

    // Run setup using the EKAFY admin DB connection
    await adminQuery(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    for (const accountHost of LOCAL_DB_ACCOUNT_HOSTS) {
      await adminQuery(`CREATE USER IF NOT EXISTS '${dbUser}'@'${accountHost}' IDENTIFIED BY '${dbPassword}'`);
      await adminQuery(`ALTER USER '${dbUser}'@'${accountHost}' IDENTIFIED BY '${dbPassword}'`);
      await adminQuery(`GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${dbUser}'@'${accountHost}'`);
    }
    await adminQuery('FLUSH PRIVILEGES');

    // Save credentials to project_envs
    await upsertProjectEnv(projectId, 'DB_HOST', dbHost);
    await upsertProjectEnv(projectId, 'DB_PORT', dbPort);
    await upsertProjectEnv(projectId, 'DB_NAME', databaseName);
    await upsertProjectEnv(projectId, 'DB_USER', dbUser);
    await upsertProjectEnv(projectId, 'DB_PASSWORD', dbPassword);

    // Write .env to disk
    await writeProjectEnvFile(projectId, project.path);

    await createLog({
      userId: req.user.id,
      action: `provisioned database ${databaseName} for project ${project.name}`
    });

    return res.status(201).json({
      message: 'Database provisioned. Credentials saved to project .env',
      databaseName,
      dbUser,
      dbHost
      // Password intentionally NOT returned — it is in the .env file
    });
  } catch (error) {
    if (isMissingSocketError(error)) {
      return next(new AppError(
        'Database provisioning could not find the configured MariaDB socket. Remove stale DB_ADMIN_SOCKET/MARIADB_SOCKET values from .env or set DB_ADMIN_HOST, DB_ADMIN_PORT, DB_ADMIN_USER, and DB_ADMIN_PASSWORD.',
        500,
        'DB_ADMIN_SOCKET_NOT_FOUND'
      ));
    }
    if (isAdminPrivilegeError(error)) {
      return next(new AppError(
        'Database provisioning could not use a privileged MariaDB account. Set DB_ADMIN_USER and DB_ADMIN_PASSWORD in .env to an account with CREATE, CREATE USER, and GRANT OPTION privileges, then restart EKAFY.',
        500,
        'DB_ADMIN_PRIVILEGE_REQUIRED'
      ));
    }
    return next(new AppError(
      `Database provisioning failed: ${error.message}`,
      500,
      'DB_PROVISION_FAILED'
    ));
  }
}

/**
 * GET /api/projects/:id/database/tables
 *
 * Lists all tables in the project's database using the project's own credentials.
 */
async function listTables(req, res, next) {
  let conn;
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canView(req.user, projectId))) {
      return res.status(403).json({ message: 'Project access required' });
    }

    conn = await getProjectDbConnection(projectId);
    const rows = await conn.query('SHOW TABLES');

    const tables = rows.map((row) => Object.values(row)[0]);
    return res.json({ tables });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(error.message, 500, 'DB_QUERY_FAILED'));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * POST /api/projects/:id/database/query
 *
 * Body: { sql }
 *
 * Executes a whitelisted SQL statement against the project's database.
 * Returns { columns, rows, affectedRows } depending on statement type.
 */
async function runQuery(req, res, next) {
  let conn;
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

    const sql = (req.body.sql || '').trim();
    if (!sql) return res.status(400).json({ message: 'SQL statement is required' });

    const validationError = validateSql(sql);
    if (validationError) return res.status(400).json({ message: validationError });

    conn = await getProjectDbConnection(projectId);

    // mariadb driver returns an array with an OkPacket for DML or an array of rows for SELECT
    const result = await conn.query({ sql, rowsAsArray: false });

    await createLog({ userId: req.user.id, action: `ran SQL on project ${project.name}` });

    if (Array.isArray(result)) {
      const columns = result.length > 0 ? Object.keys(result[0]) : [];
      return res.json({
        type: 'select',
        columns,
        rows: result.map((row) => Object.values(row)),
        rowCount: result.length
      });
    }

    return res.json({
      type: 'dml',
      affectedRows: Number(result.affectedRows || 0),
      insertId: result.insertId ? Number(result.insertId) : null
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(
      `Query failed: ${error.message}`,
      400,
      'DB_QUERY_FAILED'
    ));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * GET /api/projects/:id/database/presets
 *
 * Returns the list of SQL template presets for the DB query editor.
 */
async function getPresets(_req, res) {
  return res.json({ presets: SQL_PRESETS });
}

module.exports = { provision, listTables, runQuery, getPresets };
