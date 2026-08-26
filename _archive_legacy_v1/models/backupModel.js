'use strict';

const { query } = require('../config/db');

async function ensureBackupSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS backup_rules (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id INT UNSIGNED NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      frequency ENUM('manual','daily','weekly') NOT NULL DEFAULT 'manual',
      run_hour TINYINT UNSIGNED NOT NULL DEFAULT 2,
      run_minute TINYINT UNSIGNED NOT NULL DEFAULT 0,
      run_weekday TINYINT UNSIGNED NOT NULL DEFAULT 0,
      include_files TINYINT(1) NOT NULL DEFAULT 1,
      include_database TINYINT(1) NOT NULL DEFAULT 1,
      local_retention SMALLINT UNSIGNED NOT NULL DEFAULT 7,
      google_drive_enabled TINYINT(1) NOT NULL DEFAULT 0,
      last_run_at DATETIME NULL,
      next_run_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY backup_rules_project_unique (project_id),
      CONSTRAINT backup_rules_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS backup_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id INT UNSIGNED NOT NULL,
      trigger_type ENUM('manual','scheduled','pre_restore') NOT NULL,
      status ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
      archive_name VARCHAR(255) NULL,
      archive_path VARCHAR(1024) NULL,
      size_bytes BIGINT UNSIGNED NULL,
      google_drive_path VARCHAR(1024) NULL,
      includes_files TINYINT(1) NOT NULL DEFAULT 0,
      includes_database TINYINT(1) NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      created_by INT UNSIGNED NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      PRIMARY KEY (id),
      KEY backup_runs_project_created (project_id, started_at),
      CONSTRAINT backup_runs_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT backup_runs_user_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
}

async function listBackupRules() {
  return query(`
    SELECT r.id, p.id AS project_id, r.enabled, r.frequency, r.run_hour, r.run_minute,
      r.run_weekday, r.include_files, r.include_database, r.local_retention,
      r.google_drive_enabled, r.last_run_at, r.next_run_at, r.created_at, r.updated_at,
      p.name AS project_name, p.slug AS project_slug, p.path AS project_path
    FROM projects p LEFT JOIN backup_rules r ON r.project_id = p.id
    ORDER BY p.name
  `);
}

async function getBackupRule(projectId) {
  const rows = await query('SELECT * FROM backup_rules WHERE project_id = ? LIMIT 1', [projectId]);
  return rows[0] || null;
}

async function saveBackupRule(projectId, rule) {
  await query(`
    INSERT INTO backup_rules
      (project_id, enabled, frequency, run_hour, run_minute, run_weekday,
       include_files, include_database, local_retention, google_drive_enabled, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), frequency=VALUES(frequency),
      run_hour=VALUES(run_hour), run_minute=VALUES(run_minute), run_weekday=VALUES(run_weekday),
      include_files=VALUES(include_files), include_database=VALUES(include_database),
      local_retention=VALUES(local_retention), google_drive_enabled=VALUES(google_drive_enabled),
      next_run_at=VALUES(next_run_at)
  `, [projectId, rule.enabled, rule.frequency, rule.runHour, rule.runMinute, rule.runWeekday,
    rule.includeFiles, rule.includeDatabase, rule.localRetention, rule.googleDriveEnabled, rule.nextRunAt]);
  return getBackupRule(projectId);
}

async function listBackupRuns(limit = 100) {
  return query(`
    SELECT CAST(b.id AS CHAR) AS id, b.project_id, b.trigger_type, b.status,
      b.archive_name, b.archive_path, CAST(b.size_bytes AS CHAR) AS size_bytes,
      b.google_drive_path, b.includes_files, b.includes_database, b.error_message,
      b.created_by, b.started_at, b.completed_at,
      p.name AS project_name, p.slug AS project_slug, u.username AS created_by_username
    FROM backup_runs b JOIN projects p ON p.id=b.project_id
    LEFT JOIN users u ON u.id=b.created_by
    ORDER BY b.started_at DESC LIMIT ?
  `, [limit]);
}

async function getBackupRun(id) {
  const rows = await query(`SELECT CAST(id AS CHAR) AS id, project_id, trigger_type, status,
    archive_name, archive_path, CAST(size_bytes AS CHAR) AS size_bytes, google_drive_path,
    includes_files, includes_database, error_message, created_by, started_at, completed_at
    FROM backup_runs WHERE id=? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function createBackupRun(data) {
  const result = await query(`
    INSERT INTO backup_runs
      (project_id, trigger_type, includes_files, includes_database, created_by)
    VALUES (?, ?, ?, ?, ?)
  `, [data.projectId, data.triggerType, data.includeFiles, data.includeDatabase, data.createdBy || null]);
  return Number(result.insertId);
}

async function completeBackupRun(id, data) {
  await query(`UPDATE backup_runs SET status='completed', archive_name=?, archive_path=?, size_bytes=?,
    google_drive_path=?, completed_at=NOW() WHERE id=?`,
  [data.archiveName, data.archivePath, data.sizeBytes, data.googleDrivePath || null, id]);
}

async function failBackupRun(id, message) {
  await query("UPDATE backup_runs SET status='failed', error_message=?, completed_at=NOW() WHERE id=?",
    [String(message).slice(0, 4000), id]);
}

async function markRuleRun(projectId, nextRunAt) {
  await query('UPDATE backup_rules SET last_run_at=NOW(), next_run_at=? WHERE project_id=?',
    [nextRunAt, projectId]);
}

async function dueBackupRules() {
  return query(`SELECT r.*, p.name AS project_name, p.slug AS project_slug, p.path AS project_path
    FROM backup_rules r JOIN projects p ON p.id=r.project_id
    WHERE r.enabled=1 AND r.frequency <> 'manual' AND r.next_run_at <= NOW()`);
}

async function retainedRuns(projectId) {
  return query(`SELECT CAST(id AS CHAR) AS id, project_id, trigger_type, status,
    archive_name, archive_path, CAST(size_bytes AS CHAR) AS size_bytes, google_drive_path,
    includes_files, includes_database, error_message, created_by, started_at, completed_at
    FROM backup_runs WHERE project_id=? AND status='completed'
    ORDER BY started_at DESC`, [projectId]);
}

async function deleteBackupRun(id) {
  await query('DELETE FROM backup_runs WHERE id=?', [id]);
}

module.exports = { ensureBackupSchema, listBackupRules, getBackupRule, saveBackupRule,
  listBackupRuns, getBackupRun, createBackupRun, completeBackupRun, failBackupRun,
  markRuleRun, dueBackupRules, retainedRuns, deleteBackupRun };
