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
const path = require('path');
const multer = require('multer');
const readExcelFile = require('read-excel-file/node');

const { findProjectById, getProjectMembership } = require('../models/projectModel');
const { upsertProjectEnv, getAllProjectEnvsAsObject, writeProjectEnvFile } = require('../models/projectEnvModel');
const { query, adminQuery } = require('../config/db');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

const LOCAL_DB_HOST = '127.0.0.1';
const LOCAL_DB_ACCOUNT_HOSTS = ['localhost', '127.0.0.1'];
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;
const EXCEL_IMPORT_MAX_BYTES = readPositiveIntegerEnv('EXCEL_IMPORT_MAX_BYTES', 10 * 1024 * 1024);
const EXCEL_IMPORT_MAX_ROWS = readPositiveIntegerEnv('EXCEL_IMPORT_MAX_ROWS', 5000);
const EXCEL_IMPORT_SAMPLE_ROWS = 5;
const EXCEL_IMPORT_BATCH_SIZE = 200;

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

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

// Excel import helpers

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: EXCEL_IMPORT_MAX_BYTES
  },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.xlsx') {
      return cb(new AppError(
        'Only .xlsx Excel files are allowed. Save older .xls files as .xlsx before importing.',
        400,
        'DB_IMPORT_FILE_TYPE'
      ));
    }
    return cb(null, true);
  }
});

function uploadDatabaseImport(req, res, next) {
  uploadExcel.single('file')(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(
        `Excel file is too large. Maximum size is ${formatBytes(EXCEL_IMPORT_MAX_BYTES)}.`,
        413,
        'DB_IMPORT_FILE_TOO_LARGE'
      ));
    }

    if (error instanceof AppError) return next(error);

    return next(new AppError(
      `Excel upload failed: ${error.message}`,
      400,
      'DB_IMPORT_UPLOAD_FAILED'
    ));
  });
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function quoteIdentifier(identifier) {
  if (!SAFE_IDENTIFIER_RE.test(identifier)) {
    throw new AppError(
      'Table and column names may contain only letters, numbers, and underscores.',
      400,
      'DB_IMPORT_INVALID_IDENTIFIER'
    );
  }
  return `\`${identifier}\``;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function plainCellValue(cellOrValue) {
  const value = cellOrValue && typeof cellOrValue === 'object' && 'value' in cellOrValue
    ? cellOrValue.value
    : cellOrValue;

  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value.toString('base64');

  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'formula')) {
      return Object.prototype.hasOwnProperty.call(value, 'result')
        ? plainCellValue(value.result)
        : null;
    }
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || '').join('');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'text')) {
      return plainCellValue(value.text);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'result')) {
      return plainCellValue(value.result);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'error')) {
      return null;
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function cellText(cellOrValue) {
  const value = plainCellValue(cellOrValue);
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isEmptyCellValue(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isRequiredColumn(column) {
  return Boolean(
    column &&
    column.importable &&
    !column.nullable &&
    column.defaultValue === null
  );
}

async function readWorkbook(file) {
  try {
    const sheets = await readExcelFile(file.buffer);
    if (!Array.isArray(sheets) || !sheets.length) {
      throw new Error('No worksheets found');
    }
    return sheets.map((sheet) => ({
      name: sheet.sheet,
      rows: Array.isArray(sheet.data) ? sheet.data : []
    }));
  } catch (_error) {
    throw new AppError(
      'Excel file could not be read. Upload a valid .xlsx workbook.',
      400,
      'DB_IMPORT_PARSE_FAILED'
    );
  }
}

function selectWorksheet(sheets, sheetName) {
  if (!sheets.length) {
    throw new AppError('Excel workbook does not contain any worksheets.', 400, 'DB_IMPORT_EMPTY_WORKBOOK');
  }

  if (!sheetName) return sheets[0];

  const worksheet = sheets.find((sheet) => sheet.name === sheetName);
  if (!worksheet) {
    throw new AppError(`Worksheet "${sheetName}" was not found in the workbook.`, 400, 'DB_IMPORT_SHEET_NOT_FOUND');
  }
  return worksheet;
}

function getSheetList(sheets) {
  return sheets.map((worksheet) => ({
    name: worksheet.name,
    rowCount: worksheet.rows.length
  }));
}

function readHeaders(worksheet, headerRowNumber) {
  const row = worksheet.rows[headerRowNumber - 1] || [];
  const headers = [];
  const seen = new Map();
  const warnings = [];

  for (let index = 0; index < row.length; index += 1) {
    const name = cellText(row[index]).trim();
    if (!name) continue;

    const normalized = normalizeName(name);
    if (normalized && seen.has(normalized)) {
      warnings.push(`Duplicate Excel header "${name}" was found. Only mapped columns will be imported.`);
    }
    seen.set(normalized, true);
    headers.push({ index: index + 1, name, normalized });
  }

  if (!headers.length) {
    throw new AppError(
      `No headers were found on Excel row ${headerRowNumber}.`,
      400,
      'DB_IMPORT_NO_HEADERS'
    );
  }

  return { headers, warnings };
}

async function getBaseTables(conn) {
  const rows = await conn.query('SHOW FULL TABLES');
  return rows.map((row) => {
    const values = Object.values(row);
    return {
      name: String(values[0] || ''),
      type: String(values[1] || '')
    };
  });
}

async function getTargetColumns(conn, tableName) {
  const rows = await conn.query(`SHOW COLUMNS FROM ${quoteIdentifier(tableName)}`);
  return rows.map((row) => {
    const extra = row.Extra || '';
    return {
      name: row.Field,
      type: row.Type,
      nullable: row.Null === 'YES',
      key: row.Key || '',
      defaultValue: row.Default ?? null,
      extra,
      importable: !/auto_increment|generated/i.test(extra)
    };
  });
}

function buildSuggestedMapping(headers, targetColumns) {
  const normalizedColumns = new Map();
  for (const column of targetColumns) {
    if (!column.importable) continue;
    const key = normalizeName(column.name);
    if (key && !normalizedColumns.has(key)) normalizedColumns.set(key, column);
  }

  const usedColumns = new Set();
  const mapping = [];
  for (const header of headers) {
    const column = normalizedColumns.get(header.normalized);
    if (!column || usedColumns.has(column.name)) continue;
    usedColumns.add(column.name);
    mapping.push({
      headerIndex: header.index,
      header: header.name,
      column: column.name,
      type: column.type
    });
  }
  return mapping;
}

function parseMapping(rawMapping) {
  if (!rawMapping) return null;
  if (Array.isArray(rawMapping) || typeof rawMapping === 'object') return rawMapping;

  try {
    return JSON.parse(rawMapping);
  } catch (_error) {
    throw new AppError('Import column mapping is not valid JSON.', 400, 'DB_IMPORT_INVALID_MAPPING');
  }
}

function validateMapping(rawMapping, headers, targetColumns) {
  const parsed = parseMapping(rawMapping);
  if (!parsed) return buildSuggestedMapping(headers, targetColumns);

  const headerByIndex = new Map(headers.map((header) => [String(header.index), header]));
  const headerByName = new Map(headers.map((header) => [header.name, header]));
  const columnsByName = new Map(targetColumns.filter((column) => column.importable).map((column) => [column.name, column]));
  const columnsByNormalized = new Map(
    targetColumns
      .filter((column) => column.importable)
      .map((column) => [normalizeName(column.name), column])
  );

  const entries = Array.isArray(parsed)
    ? parsed.map((entry) => ({
      headerIndex: entry.headerIndex ?? entry.index,
      headerName: entry.header,
      column: entry.column ?? entry.dbColumn
    }))
    : Object.entries(parsed).map(([headerKey, column]) => ({
      headerIndex: /^\d+$/.test(headerKey) ? headerKey : null,
      headerName: /^\d+$/.test(headerKey) ? null : headerKey,
      column
    }));

  const usedColumns = new Set();
  const mapping = [];

  for (const entry of entries) {
    const header = headerByIndex.get(String(entry.headerIndex || '')) || headerByName.get(String(entry.headerName || ''));
    const columnName = String(entry.column || '').trim();
    const column = columnsByName.get(columnName) || columnsByNormalized.get(normalizeName(columnName));

    if (!header || !column) continue;
    if (usedColumns.has(column.name)) {
      throw new AppError(`Column "${column.name}" is mapped more than once.`, 400, 'DB_IMPORT_DUPLICATE_MAPPING');
    }

    usedColumns.add(column.name);
    mapping.push({
      headerIndex: header.index,
      header: header.name,
      column: column.name,
      type: column.type
    });
  }

  return mapping;
}

function getUnmappedRequiredColumns(mapping, targetColumns) {
  const mappedColumns = new Set(mapping.map((item) => item.column));
  return targetColumns
    .filter(isRequiredColumn)
    .filter((column) => !mappedColumns.has(column.name))
    .map((column) => column.name);
}

function getRequiredMappingItems(mapping, targetColumns) {
  const columnsByName = new Map(targetColumns.map((column) => [column.name, column]));
  return mapping
    .map((item, index) => ({ ...item, valueIndex: index, columnMeta: columnsByName.get(item.column) }))
    .filter((item) => isRequiredColumn(item.columnMeta));
}

function collectSampleRows(worksheet, headerRowNumber, mapping) {
  const rows = [];
  for (let rowIndex = headerRowNumber; rowIndex < worksheet.rows.length; rowIndex += 1) {
    const row = worksheet.rows[rowIndex] || [];
    const values = {};
    let hasValue = false;

    for (const item of mapping) {
      const value = plainCellValue(row[item.headerIndex - 1]);
      values[item.column] = value instanceof Date ? value.toISOString() : value;
      if (!isEmptyCellValue(value)) hasValue = true;
    }

    if (!hasValue) continue;
    rows.push({ sourceRow: rowIndex + 1, values });
    if (rows.length >= EXCEL_IMPORT_SAMPLE_ROWS) break;
  }
  return rows;
}

function collectImportRows(worksheet, headerRowNumber, mapping, targetColumns) {
  const rows = [];
  let skippedRows = 0;
  const invalidRows = [];
  const requiredItems = getRequiredMappingItems(mapping, targetColumns);

  for (let rowIndex = headerRowNumber; rowIndex < worksheet.rows.length; rowIndex += 1) {
    const row = worksheet.rows[rowIndex] || [];
    const values = mapping.map((item) => plainCellValue(row[item.headerIndex - 1]));

    if (values.every(isEmptyCellValue)) {
      skippedRows += 1;
      continue;
    }

    const missingColumns = requiredItems
      .filter((item) => isEmptyCellValue(values[item.valueIndex]))
      .map((item) => item.column);
    if (missingColumns.length) {
      invalidRows.push({ sourceRow: rowIndex + 1, missingColumns });
      continue;
    }

    rows.push({ sourceRow: rowIndex + 1, values });
    if (rows.length > EXCEL_IMPORT_MAX_ROWS) {
      throw new AppError(
        `Excel import has more than ${EXCEL_IMPORT_MAX_ROWS} data rows. Split the file or raise EXCEL_IMPORT_MAX_ROWS.`,
        400,
        'DB_IMPORT_TOO_MANY_ROWS',
        { maxRows: EXCEL_IMPORT_MAX_ROWS }
      );
    }
  }

  if (invalidRows.length) {
    const examples = invalidRows
      .slice(0, 8)
      .map((row) => `row ${row.sourceRow}: ${row.missingColumns.join(', ')}`)
      .join('; ');
    const suffix = invalidRows.length > 8 ? `; plus ${invalidRows.length - 8} more row(s)` : '';
    throw new AppError(
      `Excel import found ${invalidRows.length} row(s) missing required values (${examples}${suffix}).`,
      400,
      'DB_IMPORT_REQUIRED_VALUE_MISSING',
      {
        invalidRows: invalidRows.slice(0, 20),
        totalInvalidRows: invalidRows.length,
        requiredColumns: requiredItems.map((item) => item.column)
      }
    );
  }

  return { rows, skippedRows };
}

async function insertImportRows(conn, tableName, mapping, rows) {
  if (!rows.length) return 0;

  const tableSql = quoteIdentifier(tableName);
  const columnsSql = mapping.map((item) => quoteIdentifier(item.column)).join(', ');
  const rowPlaceholder = `(${mapping.map(() => '?').join(', ')})`;
  let insertedRows = 0;

  for (let index = 0; index < rows.length; index += EXCEL_IMPORT_BATCH_SIZE) {
    const batch = rows.slice(index, index + EXCEL_IMPORT_BATCH_SIZE);
    const placeholders = batch.map(() => rowPlaceholder).join(', ');
    const params = batch.flatMap((row) => row.values);
    const result = await conn.query(
      `INSERT INTO ${tableSql} (${columnsSql}) VALUES ${placeholders}`,
      params
    );
    insertedRows += Number(result.affectedRows || batch.length);
  }

  return insertedRows;
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
 * POST /api/projects/:id/database/import
 *
 * Multipart form fields:
 *   file       - .xlsx workbook
 *   mode       - preview | import
 *   tableName  - existing project database table
 *   sheetName  - optional worksheet name
 *   headerRow  - header row number, defaults to 1
 *   mapping    - optional JSON mapping from Excel headers to DB columns
 */
async function importSpreadsheet(req, res, next) {
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

    const mode = req.body.mode === 'import' ? 'import' : 'preview';
    const tableName = String(req.body.tableName || '').trim();
    const sheetName = String(req.body.sheetName || '').trim();
    const headerRowNumber = Number.parseInt(req.body.headerRow || '1', 10);

    if (!req.file) {
      throw new AppError('Excel .xlsx file is required.', 400, 'DB_IMPORT_FILE_REQUIRED');
    }
    if (!SAFE_IDENTIFIER_RE.test(tableName)) {
      throw new AppError(
        'Select a valid database table before importing.',
        400,
        'DB_IMPORT_INVALID_TABLE'
      );
    }
    if (!Number.isInteger(headerRowNumber) || headerRowNumber < 1 || headerRowNumber > 1000) {
      throw new AppError('Header row must be a number between 1 and 1000.', 400, 'DB_IMPORT_INVALID_HEADER_ROW');
    }

    conn = await getProjectDbConnection(projectId);

    const baseTables = await getBaseTables(conn);
    const selectedTable = baseTables.find((table) => table.name === tableName);
    if (!selectedTable || selectedTable.type.toUpperCase() !== 'BASE TABLE') {
      throw new AppError(
        `Table "${tableName}" was not found as an importable base table.`,
        404,
        'DB_IMPORT_TABLE_NOT_FOUND'
      );
    }

    const targetColumns = await getTargetColumns(conn, tableName);
    const sheets = await readWorkbook(req.file);
    const worksheet = selectWorksheet(sheets, sheetName);
    const { headers, warnings: headerWarnings } = readHeaders(worksheet, headerRowNumber);
    const mapping = validateMapping(req.body.mapping, headers, targetColumns);
    const mappedHeaderIndexes = new Set(mapping.map((item) => item.headerIndex));
    const unmappedHeaders = headers
      .filter((header) => !mappedHeaderIndexes.has(header.index))
      .map((header) => header.name);
    const unmappedRequiredColumns = getUnmappedRequiredColumns(mapping, targetColumns);
    const ignoredColumns = targetColumns
      .filter((column) => !column.importable)
      .map((column) => column.name);
    const warnings = [
      ...headerWarnings,
      ...unmappedRequiredColumns.map((column) => `Required table column "${column}" is not mapped from Excel.`),
      ...ignoredColumns.map((column) => `Column "${column}" is generated or auto-increment and was not importable.`)
    ];

    const previewPayload = {
      mode: 'preview',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      tableName,
      selectedSheet: worksheet.name,
      sheets: getSheetList(sheets),
      headerRow: headerRowNumber,
      maxRows: EXCEL_IMPORT_MAX_ROWS,
      targetColumns,
      suggestedMapping: mapping,
      unmappedRequiredColumns,
      unmappedHeaders,
      sampleRows: collectSampleRows(worksheet, headerRowNumber, mapping),
      warnings
    };

    if (mode === 'preview') {
      return res.json(previewPayload);
    }

    if (!mapping.length) {
      throw new AppError(
        'No Excel headers matched importable table columns. Rename Excel headers or adjust the table columns first.',
        400,
        'DB_IMPORT_NO_MAPPING'
      );
    }

    if (unmappedRequiredColumns.length) {
      throw new AppError(
        `Required table column(s) are not mapped: ${unmappedRequiredColumns.join(', ')}.`,
        400,
        'DB_IMPORT_REQUIRED_COLUMN_UNMAPPED',
        { unmappedRequiredColumns }
      );
    }

    const { rows, skippedRows } = collectImportRows(worksheet, headerRowNumber, mapping, targetColumns);
    if (!rows.length) {
      throw new AppError('No data rows were found below the header row.', 400, 'DB_IMPORT_NO_ROWS');
    }

    let insertedRows = 0;
    await conn.beginTransaction();
    try {
      insertedRows = await insertImportRows(conn, tableName, mapping, rows);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    }

    await createLog({
      userId: req.user.id,
      action: `imported ${insertedRows} Excel row(s) into ${tableName} for project ${project.name}`
    });

    return res.status(201).json({
      mode: 'import',
      message: `Imported ${insertedRows} row(s) into ${tableName}.`,
      insertedRows,
      skippedRows,
      sourceRows: rows.length,
      tableName,
      selectedSheet: worksheet.name,
      columns: mapping.map((item) => item.column),
      warnings
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(
      `Excel import failed: ${error.message}`,
      400,
      'DB_IMPORT_FAILED'
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

module.exports = { provision, listTables, runQuery, uploadDatabaseImport, importSpreadsheet, getPresets };
