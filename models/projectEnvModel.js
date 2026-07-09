'use strict';

/**
 * projectEnvModel.js
 *
 * Manages per-project environment variables stored in the `project_envs` table.
 * Values are stored as plain text in the DB and written to the project's `.env`
 * file on disk whenever they change. The list endpoint intentionally omits values
 * so sensitive data is never broadcast unnecessarily.
 */

const fs = require('fs').promises;
const path = require('path');
const { query } = require('../config/db');

/**
 * Insert or update a single env variable for a project.
 * @param {number} projectId
 * @param {string} key   - Must be a valid env key (UPPER_SNAKE_CASE recommended).
 * @param {string} value
 */
async function upsertProjectEnv(projectId, key, value) {
  await query(
    `INSERT INTO project_envs (project_id, env_key, env_value)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE env_value = VALUES(env_value)`,
    [projectId, key, String(value)]
  );
}

/**
 * Delete a single env variable for a project.
 * @param {number} projectId
 * @param {string} key
 * @returns {boolean} true if a row was deleted
 */
async function deleteProjectEnv(projectId, key) {
  const result = await query(
    'DELETE FROM project_envs WHERE project_id = ? AND env_key = ?',
    [projectId, key]
  );
  return Number(result.affectedRows || 0) > 0;
}

/**
 * List all env keys for a project (values are NOT returned).
 * @param {number} projectId
 * @returns {{ id: number, env_key: string, updated_at: Date }[]}
 */
async function listProjectEnvKeys(projectId) {
  const rows = await query(
    'SELECT id, env_key, updated_at FROM project_envs WHERE project_id = ? ORDER BY env_key ASC',
    [projectId]
  );
  return rows;
}

/**
 * Get all env variables as a plain object (key → value).
 * Used internally for writing the .env file.
 * @param {number} projectId
 * @returns {Record<string, string>}
 */
async function getAllProjectEnvsAsObject(projectId) {
  const rows = await query(
    'SELECT env_key, env_value FROM project_envs WHERE project_id = ?',
    [projectId]
  );
  return Object.fromEntries(rows.map((row) => [row.env_key, row.env_value]));
}

/**
 * Write all project env variables to `<projectPath>/.env`.
 * Safe to call multiple times — the file is always overwritten with the current DB state.
 * @param {number} projectId
 * @param {string} projectPath - Absolute path to the project root on disk.
 */
async function writeProjectEnvFile(projectId, projectPath) {
  const envs = await getAllProjectEnvsAsObject(projectId);
  const lines = Object.entries(envs)
    .map(([key, value]) => {
      // Quote values that contain spaces or special chars
      const needsQuotes = /[\s"'`#]/.test(value);
      const safeValue = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
      return `${key}=${safeValue}`;
    })
    .join('\n');

  const envFilePath = path.join(projectPath, '.env');
  await fs.writeFile(envFilePath, lines + '\n', 'utf8');
}

module.exports = {
  upsertProjectEnv,
  deleteProjectEnv,
  listProjectEnvKeys,
  getAllProjectEnvsAsObject,
  writeProjectEnvFile
};
