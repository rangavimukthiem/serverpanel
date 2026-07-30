const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../config/db');
const { createLog } = require('../models/logModel');

const execFileAsync = promisify(execFile);
const UPDATE_BRANCH_PATTERN = /^[A-Za-z0-9._\/-]{1,128}$/;
let updateInProgress = false;
let restartInProgress = false;

function managerGitArgs(appRoot, args) {
  return ['-c', `safe.directory=${appRoot}`, ...args];
}

function scheduleManagerRestart(serviceName) {
  const restartTimer = setTimeout(() => {
    execFile('sudo', ['-n', 'systemctl', 'restart', serviceName], (error) => {
      if (error) {
        restartInProgress = false;
        console.error(`Unable to restart ${serviceName}:`, error.message);
      }
    });
  }, 1000);
  restartTimer.unref();
}

function snapshotCpu() {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => {
    const values = Object.values(cpu.times);
    return sum + values.reduce((innerSum, value) => innerSum + value, 0);
  }, 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);

  return { idle, total };
}

async function getCpuUsage() {
  const start = snapshotCpu();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const end = snapshotCpu();
  const idle = end.idle - start.idle;
  const total = end.total - start.total;

  if (total <= 0) return 0;
  return Number((((total - idle) / total) * 100).toFixed(1));
}

async function getDiskUsage() {
  if (process.platform === 'win32') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('df', ['-Pk', '/'], { timeout: 1500 });
    const lines = stdout.trim().split('\n');
    const parts = lines[1]?.split(/\s+/);
    if (!parts || parts.length < 6) return null;

    const percent = Number(parts[4].replace('%', ''));
    const kilobytes = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number * 1024 : null;
    };

    return {
      filesystem: parts[0],
      size: kilobytes(parts[1]),
      used: kilobytes(parts[2]),
      available: kilobytes(parts[3]),
      percent,
      mount: parts[5]
    };
  } catch (_error) {
    return null;
  }
}

function getServerIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  Object.entries(interfaces).forEach(([name, entries = []]) => {
    entries
      .filter((entry) => !entry.internal)
      .forEach((entry) => {
        addresses.push({
          name,
          address: entry.address,
          family: entry.family,
          mac: entry.mac
        });
      });
  });

  return addresses;
}

async function getProjectSummary() {
  const rows = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'active') AS active,
      SUM(status = 'inactive') AS inactive,
      SUM(status = 'provisioned') AS provisioned,
      SUM(JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.kind')) = 'api') AS api,
      SUM(JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.kind')) = 'static') AS static,
      SUM(JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.kind')) = 'database') AS database_count,
      SUM(JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.kind')) = 'full') AS full_count
    FROM projects
  `);

  const row = rows[0] || {};
  return {
    total: Number(row.total || 0),
    active: Number(row.active || 0),
    inactive: Number(row.inactive || 0),
    provisioned: Number(row.provisioned || 0),
    byKind: {
      api: Number(row.api || 0),
      static: Number(row.static || 0),
      database: Number(row.database_count || 0),
      full: Number(row.full_count || 0)
    }
  };
}

async function updateDashboardFromGit(req, res, next) {
  if (updateInProgress) {
    return res.status(409).json({
      message: 'A server manager update is already running.',
      code: 'UPDATE_IN_PROGRESS'
    });
  }

  updateInProgress = true;
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const configuredRoot = process.env.APP_DIR || path.resolve(__dirname, '..');
    const appRoot = path.resolve(configuredRoot);
    const branch = (req.body?.branch || 'main').toString().trim() || 'main';
    const serviceName = process.env.SERVICE_NAME || 'ekafy';

    if (appRoot === path.parse(appRoot).root) {
      return res.status(500).json({
        message: 'Refusing to update from the filesystem root. Check APP_DIR in .env.',
        code: 'INVALID_APP_ROOT'
      });
    }

    if (!UPDATE_BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.startsWith('-')) {
      return res.status(400).json({ message: 'Invalid update branch.', code: 'INVALID_BRANCH' });
    }

    const output = [];

    const envPath = path.join(appRoot, '.env');
    if (fs.existsSync(envPath)) {
      const envBackupPath = path.join(appRoot, '.env.update-backup');
      fs.copyFileSync(envPath, envBackupPath);
      fs.chmodSync(envBackupPath, 0o600);
      output.push(`Configuration backup: ${envBackupPath}`);
    }

    const gitCheck = await execFileAsync('git', managerGitArgs(appRoot, ['rev-parse', '--show-toplevel']), {
      cwd: appRoot,
      timeout: 15000
    }).catch((error) => ({ stdout: '', stderr: error.message, ok: false }));

    const repositoryRoot = gitCheck.stdout ? path.resolve(gitCheck.stdout.trim()) : null;
    if (!repositoryRoot || repositoryRoot !== appRoot) {
      return res.status(400).json({
        message: 'The EKAFY app directory is not its own Git repository. Run the one-time GitHub update command to install repository metadata.',
        code: 'NOT_A_GIT_REPOSITORY',
        details: gitCheck.stderr || null
      });
    }

    const fetchResult = await execFileAsync('git', managerGitArgs(appRoot, ['fetch', 'origin', branch]), {
      cwd: appRoot,
      timeout: 120000
    });
    output.push(fetchResult.stdout.trim(), fetchResult.stderr.trim());

    const pullResult = await execFileAsync('git', managerGitArgs(appRoot, ['pull', '--ff-only', 'origin', branch]), {
      cwd: appRoot,
      timeout: 120000
    });
    output.push(pullResult.stdout.trim(), pullResult.stderr.trim());

    const installArgs = fs.existsSync(path.join(appRoot, 'package-lock.json'))
      ? ['ci', '--omit=dev', '--no-audit', '--no-fund']
      : ['install', '--omit=dev', '--no-audit', '--no-fund'];
    const installResult = await execFileAsync('npm', installArgs, {
      cwd: appRoot,
      timeout: 900000
    });
    output.push(installResult.stdout.trim(), installResult.stderr.trim());

    await createLog({
      userId: req.user.id,
      action: `updated dashboard app from GitHub on branch ${branch}`
    });

    const shouldRestart = process.env.ENABLE_SERVICE_CONTROL !== 'false' && process.platform !== 'win32';
    const response = res.json({
      ok: true,
      message: 'Server manager updated. Configuration, databases, projects, and app data were preserved.',
      restarting: shouldRestart,
      output: output.filter(Boolean).join('\n')
    });

    // Restart only after the HTTP response has been sent, otherwise the update
    // request is terminated by its own service restart.
    if (shouldRestart) {
      restartInProgress = true;
      scheduleManagerRestart(serviceName);
    }

    return response;
  } catch (error) {
    return next(error);
  } finally {
    updateInProgress = false;
  }
}

async function restartServerManager(req, res, next) {
  try {
    if (process.platform === 'win32' || process.env.ENABLE_SERVICE_CONTROL === 'false') {
      return res.status(503).json({
        message: 'Server manager restart control is disabled.',
        code: 'SERVICE_CONTROL_DISABLED'
      });
    }

    if (updateInProgress) {
      return res.status(409).json({
        message: 'Wait for the server manager update to finish before restarting.',
        code: 'UPDATE_IN_PROGRESS'
      });
    }

    if (restartInProgress) {
      return res.status(409).json({
        message: 'A server manager restart is already scheduled.',
        code: 'RESTART_IN_PROGRESS'
      });
    }

    const serviceName = process.env.SERVICE_NAME || 'ekafy';
    if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(serviceName)) {
      return res.status(500).json({ message: 'Invalid configured service name.', code: 'INVALID_SERVICE_NAME' });
    }

    await createLog({
      userId: req.user.id,
      action: `restarted server manager service ${serviceName}`
    });

    restartInProgress = true;
    const response = res.json({
      ok: true,
      restarting: true,
      message: `Server manager restart scheduled for ${serviceName}.`
    });
    scheduleManagerRestart(serviceName);
    return response;
  } catch (error) {
    restartInProgress = false;
    return next(error);
  }
}

async function status(req, res, next) {
  try {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const ram = Number(((usedMemory / totalMemory) * 100).toFixed(1));
    const [cpu, diskDetails, projects] = await Promise.all([
      getCpuUsage(),
      getDiskUsage(),
      getProjectSummary().catch(() => null)
    ]);
    const serverIps = getServerIps();
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    return res.json({
      cpu,
      ram,
      uptime: Math.floor(os.uptime()),
      disk: diskDetails?.percent ?? null,
      diskDetails,
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        percent: ram
      },
      server: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpuModel: os.cpus()[0]?.model || null,
        cpuCount: os.cpus().length,
        loadAverage: os.loadavg(),
        primaryIp: process.env.SERVER_IP || serverIps.find((item) => item.family === 'IPv4')?.address || serverIps[0]?.address || null,
        ips: serverIps,
        panelHost: req.get('host') || null,
        nodeVersion: process.version,
        timezone
      },
      serverTime: {
        iso: now.toISOString(),
        epochMs: now.getTime(),
        timezone,
        offsetMinutes: -now.getTimezoneOffset()
      },
      projects
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  status,
  updateDashboardFromGit,
  restartServerManager
};
