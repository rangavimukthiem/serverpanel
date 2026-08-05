'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { findProjectById } = require('../models/projectModel');
const { getAllProjectEnvsAsObject } = require('../models/projectEnvModel');
const { createLog } = require('../models/logModel');
const backupModel = require('../models/backupModel');
const { AppError } = require('../errors/AppError');

const BACKUP_ROOT = path.resolve(process.env.BACKUP_ROOT || path.join(__dirname, '..', 'backups'));
const PROJECTS_ROOT = path.resolve(process.env.PROJECTS_ROOT || '/srv');
const activeProjects = new Set();
let schedulerTimer;

function bool(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

function assertProjectPath(projectPath) {
  const resolved = path.resolve(projectPath);
  if (resolved === PROJECTS_ROOT || !resolved.startsWith(`${PROJECTS_ROOT}${path.sep}`)) {
    throw new AppError('Project path is outside PROJECTS_ROOT.', 400, 'BACKUP_PATH_UNSAFE');
  }
  return resolved;
}

function nextRun(rule, from = new Date()) {
  if (!rule.enabled || rule.frequency === 'manual') return null;
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setHours(rule.runHour, rule.runMinute, 0, 0);
  if (rule.frequency === 'daily') {
    if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
  } else {
    const days = (rule.runWeekday - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + days);
    if (candidate <= from) candidate.setDate(candidate.getDate() + 7);
  }
  return candidate;
}

function normalizeRule(body = {}) {
  const frequency = ['manual', 'daily', 'weekly'].includes(body.frequency) ? body.frequency : 'manual';
  const runHour = Number(body.runHour);
  const runMinute = Number(body.runMinute);
  const runWeekday = Number(body.runWeekday);
  const localRetention = Number(body.localRetention);
  const rule = {
    enabled: bool(body.enabled), frequency,
    runHour: Number.isInteger(runHour) && runHour >= 0 && runHour <= 23 ? runHour : 2,
    runMinute: Number.isInteger(runMinute) && runMinute >= 0 && runMinute <= 59 ? runMinute : 0,
    runWeekday: Number.isInteger(runWeekday) && runWeekday >= 0 && runWeekday <= 6 ? runWeekday : 0,
    includeFiles: bool(body.includeFiles, true),
    includeDatabase: bool(body.includeDatabase, true),
    localRetention: Number.isInteger(localRetention) && localRetention >= 1 && localRetention <= 100 ? localRetention : 7,
    googleDriveEnabled: bool(body.googleDriveEnabled)
  };
  if (!rule.includeFiles && !rule.includeDatabase) {
    throw new AppError('Select files, database, or both.', 400, 'BACKUP_EMPTY_RULE');
  }
  if (rule.googleDriveEnabled && !process.env.GOOGLE_DRIVE_REMOTE) {
    throw new AppError('GOOGLE_DRIVE_REMOTE is not configured.', 400, 'GOOGLE_DRIVE_NOT_CONFIGURED');
  }
  rule.nextRunAt = nextRun(rule);
  return rule;
}

function spawnWithFile(command, args, filePath, mode, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stream = mode === 'write' ? fs.createWriteStream(filePath, { mode: 0o600 }) : fs.createReadStream(filePath);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    if (mode === 'write') child.stdout.pipe(stream);
    else stream.pipe(child.stdin);
    child.on('error', reject);
    stream.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

function dbArgs(envs) {
  return ['--host', envs.DB_HOST || '127.0.0.1', '--port', String(envs.DB_PORT || 3306),
    '--user', envs.DB_USER, envs.DB_NAME];
}

async function createDatabaseDump(projectId, outputPath) {
  const envs = await getAllProjectEnvsAsObject(projectId);
  if (!envs.DB_USER || !envs.DB_PASSWORD || !envs.DB_NAME) {
    throw new Error('Project database credentials are not provisioned');
  }
  await spawnWithFile(process.env.MARIADB_DUMP_BIN || 'mariadb-dump',
    ['--single-transaction', '--routines', '--triggers', ...dbArgs(envs)], outputPath, 'write',
    { ...process.env, MYSQL_PWD: envs.DB_PASSWORD });
}

async function restoreDatabase(projectId, inputPath) {
  const envs = await getAllProjectEnvsAsObject(projectId);
  if (!envs.DB_USER || !envs.DB_PASSWORD || !envs.DB_NAME) throw new Error('Project database is not provisioned');
  await spawnWithFile(process.env.MARIADB_BIN || 'mariadb', dbArgs(envs), inputPath, 'read',
    { ...process.env, MYSQL_PWD: envs.DB_PASSWORD });
}

async function enforceRetention(projectId, keep) {
  const runs = await backupModel.retainedRuns(projectId);
  for (const run of runs.slice(keep)) {
    if (run.archive_path && path.resolve(run.archive_path).startsWith(`${BACKUP_ROOT}${path.sep}`)) {
      await fsp.unlink(run.archive_path).catch(() => {});
    }
    if (run.google_drive_path && process.env.GOOGLE_DRIVE_REMOTE) {
      await execFileAsync('rclone', ['deletefile', run.google_drive_path]).catch(() => {});
    }
    await backupModel.deleteBackupRun(run.id);
  }
}

async function performBackup(project, rule, triggerType, createdBy = null) {
  if (activeProjects.has(project.id)) throw new AppError('A backup or restore is already running.', 409, 'BACKUP_BUSY');
  activeProjects.add(project.id);
  let runId;
  let tempDir;
  try {
    const projectPath = assertProjectPath(project.path);
    await fsp.mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 });
    const projectBackupDir = path.join(BACKUP_ROOT, project.slug);
    await fsp.mkdir(projectBackupDir, { recursive: true, mode: 0o700 });
    tempDir = await fsp.mkdtemp(path.join(BACKUP_ROOT, '.tmp-'));
    runId = await backupModel.createBackupRun({ projectId: project.id, triggerType,
      includeFiles: rule.includeFiles, includeDatabase: rule.includeDatabase, createdBy });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `${project.slug}-${timestamp}-${crypto.randomBytes(3).toString('hex')}.tar.gz`;
    const archivePath = path.join(projectBackupDir, archiveName);

    if (rule.includeFiles) {
      await fsp.cp(projectPath, path.join(tempDir, 'files'), { recursive: true,
        filter: (source) => !['node_modules', '.git', 'backups'].includes(path.basename(source)) });
    }
    if (rule.includeDatabase) await createDatabaseDump(project.id, path.join(tempDir, 'database.sql'));
    await fsp.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify({ version: 1,
      projectId: project.id, projectSlug: project.slug, createdAt: new Date().toISOString(),
      includesFiles: rule.includeFiles, includesDatabase: rule.includeDatabase }, null, 2), { mode: 0o600 });
    await execFileAsync('tar', ['-czf', archivePath, '-C', tempDir, '.'], { maxBuffer: 1024 * 1024 });
    await fsp.chmod(archivePath, 0o600);

    let googleDrivePath = null;
    if (rule.googleDriveEnabled) {
      googleDrivePath = `${process.env.GOOGLE_DRIVE_REMOTE.replace(/\/$/, '')}/${project.slug}/${archiveName}`;
      await execFileAsync('rclone', ['copyto', archivePath, googleDrivePath], { timeout: 60 * 60 * 1000 });
    }
    const stat = await fsp.stat(archivePath);
    await backupModel.completeBackupRun(runId, { archiveName, archivePath, sizeBytes: stat.size, googleDrivePath });
    await backupModel.markRuleRun(project.id, nextRun(rule));
    await enforceRetention(project.id, rule.localRetention);
    return backupModel.getBackupRun(runId);
  } catch (error) {
    if (runId) await backupModel.failBackupRun(runId, error.message).catch(() => {});
    throw error;
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    activeProjects.delete(project.id);
  }
}

async function list(req, res, next) {
  try {
    const [rules, runs] = await Promise.all([backupModel.listBackupRules(), backupModel.listBackupRuns()]);
    return res.json({ backupRoot: BACKUP_ROOT, googleDriveConfigured: Boolean(process.env.GOOGLE_DRIVE_REMOTE), rules, runs });
  } catch (error) { return next(error); }
}

async function saveRule(req, res, next) {
  try {
    const project = await findProjectById(Number(req.params.projectId));
    if (!project) return res.status(404).json({ message: 'Project not found' });
    const rule = await backupModel.saveBackupRule(project.id, normalizeRule(req.body));
    await createLog({ userId: req.user.id, action: `updated backup rule for ${project.name}` });
    return res.json({ rule });
  } catch (error) { return next(error); }
}

async function runNow(req, res, next) {
  try {
    const project = await findProjectById(Number(req.params.projectId));
    if (!project) return res.status(404).json({ message: 'Project not found' });
    const stored = await backupModel.getBackupRule(project.id);
    const rule = stored ? normalizeRule({ enabled: Boolean(stored.enabled), frequency: stored.frequency,
      runHour: stored.run_hour, runMinute: stored.run_minute, runWeekday: stored.run_weekday,
      includeFiles: Boolean(stored.include_files), includeDatabase: Boolean(stored.include_database),
      localRetention: stored.local_retention, googleDriveEnabled: Boolean(stored.google_drive_enabled) })
      : normalizeRule({ includeFiles: true, includeDatabase: false, localRetention: 7 });
    const run = await performBackup(project, rule, 'manual', req.user.id);
    await createLog({ userId: req.user.id, action: `created backup for ${project.name}` });
    return res.status(201).json({ run });
  } catch (error) { return next(error); }
}

async function restore(req, res, next) {
  let tempDir;
  let project;
  try {
    const run = await backupModel.getBackupRun(Number(req.params.runId));
    if (!run || run.status !== 'completed') return res.status(404).json({ message: 'Completed backup not found' });
    project = await findProjectById(Number(run.project_id));
    if (!project) return res.status(404).json({ message: 'Project not found' });
    const archivePath = path.resolve(run.archive_path || '');
    if (!archivePath.startsWith(`${BACKUP_ROOT}${path.sep}`)) throw new AppError('Backup path is unsafe.', 400, 'BACKUP_PATH_UNSAFE');
    await fsp.access(archivePath);

    const rule = normalizeRule({ includeFiles: Boolean(run.includes_files), includeDatabase: Boolean(run.includes_database), localRetention: 7 });
    await performBackup(project, rule, 'pre_restore', req.user.id);
    activeProjects.add(project.id);
    tempDir = await fsp.mkdtemp(path.join(BACKUP_ROOT, '.restore-'));
    const { stdout } = await execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 10 * 1024 * 1024 });
    if (stdout.split(/\r?\n/).some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
      throw new AppError('Backup archive contains unsafe paths.', 400, 'BACKUP_ARCHIVE_UNSAFE');
    }
    await execFileAsync('tar', ['-xzf', archivePath, '-C', tempDir]);
    const manifest = JSON.parse(await fsp.readFile(path.join(tempDir, 'manifest.json'), 'utf8'));
    if (Number(manifest.projectId) !== project.id) throw new AppError('Backup belongs to another project.', 400, 'BACKUP_PROJECT_MISMATCH');
    if (bool(req.body.restoreFiles, true) && manifest.includesFiles) {
      await fsp.cp(path.join(tempDir, 'files'), assertProjectPath(project.path), { recursive: true, force: true });
    }
    if (bool(req.body.restoreDatabase, true) && manifest.includesDatabase) {
      await restoreDatabase(project.id, path.join(tempDir, 'database.sql'));
    }
    await createLog({ userId: req.user.id, action: `restored backup ${run.archive_name} for ${project.name}` });
    return res.json({ message: `Restored ${project.name} from ${run.archive_name}.` });
  } catch (error) { return next(error); }
  finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (project) activeProjects.delete(project.id);
  }
}

async function schedulerTick() {
  for (const rule of await backupModel.dueBackupRules()) {
    if (activeProjects.has(Number(rule.project_id))) continue;
    const project = await findProjectById(Number(rule.project_id));
    if (!project) continue;
    const normalized = normalizeRule({ enabled: true, frequency: rule.frequency, runHour: rule.run_hour,
      runMinute: rule.run_minute, runWeekday: rule.run_weekday, includeFiles: Boolean(rule.include_files),
      includeDatabase: Boolean(rule.include_database), localRetention: rule.local_retention,
      googleDriveEnabled: Boolean(rule.google_drive_enabled) });
    performBackup(project, normalized, 'scheduled').catch((error) => console.error(`Backup failed for ${project.name}:`, error.message));
  }
}

function startBackupScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => schedulerTick().catch((error) => console.error('Backup scheduler:', error.message)), 60 * 1000);
  schedulerTimer.unref();
  setTimeout(() => schedulerTick().catch(() => {}), 5000).unref();
}

module.exports = { list, saveRule, runNow, restore, startBackupScheduler };
