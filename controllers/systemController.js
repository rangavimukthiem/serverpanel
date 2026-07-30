const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../config/db');
const { createLog } = require('../models/logModel');

const execFileAsync = promisify(execFile);

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
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const appRoot = process.env.APP_DIR || path.resolve(__dirname, '..');
    const branch = (req.body?.branch || 'main').toString().trim() || 'main';
    const serviceName = process.env.SERVICE_NAME || 'ekafy';

    const output = [];

    const gitCheck = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: appRoot,
      timeout: 15000
    }).catch((error) => ({ stdout: '', stderr: error.message, ok: false }));

    if (!gitCheck.stdout || gitCheck.stdout.trim() !== 'true') {
      return res.status(400).json({
        message: 'The dashboard directory is not a Git repository.',
        code: 'NOT_A_GIT_REPOSITORY',
        details: gitCheck.stderr || null
      });
    }

    const fetchResult = await execFileAsync('git', ['fetch', 'origin', branch], {
      cwd: appRoot,
      timeout: 120000
    });
    output.push(fetchResult.stdout.trim(), fetchResult.stderr.trim());

    const pullResult = await execFileAsync('git', ['pull', '--ff-only', 'origin', branch], {
      cwd: appRoot,
      timeout: 120000
    });
    output.push(pullResult.stdout.trim(), pullResult.stderr.trim());

    const installResult = await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appRoot,
      timeout: 900000
    });
    output.push(installResult.stdout.trim(), installResult.stderr.trim());

    if (process.env.ENABLE_SERVICE_CONTROL !== 'false' && process.platform !== 'win32') {
      try {
        const restartResult = await execFileAsync('systemctl', ['restart', serviceName], {
          timeout: 30000
        });
        output.push(restartResult.stdout.trim(), restartResult.stderr.trim());
      } catch (_error) {
        output.push(`Service restart skipped or failed for ${serviceName}`);
      }
    }

    await createLog({
      userId: req.user.id,
      action: `updated dashboard app from GitHub on branch ${branch}`
    });

    return res.json({
      ok: true,
      message: 'Dashboard updated successfully. Existing databases and app data were preserved.',
      output: output.filter(Boolean).join('\n')
    });
  } catch (error) {
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
  updateDashboardFromGit
};
