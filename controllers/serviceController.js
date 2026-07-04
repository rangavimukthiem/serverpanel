const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLog } = require('../models/logModel');

const execFileAsync = promisify(execFile);

const SERVICE_MAP = Object.freeze({
  nginx: 'nginx',
  mysql: 'mysql',
  mariadb: 'mariadb',
  apache2: 'apache2'
});

const ACTIONS = new Set(['start', 'stop', 'restart']);

function isServiceControlEnabled() {
  return process.env.ENABLE_SERVICE_CONTROL === 'true';
}

async function controlService(req, res, next) {
  try {
    const { name, action } = req.params;
    const service = SERVICE_MAP[name];

    if (!service) {
      return res.status(400).json({ message: 'Service is not allowed' });
    }

    if (!ACTIONS.has(action)) {
      return res.status(400).json({ message: 'Action is not allowed' });
    }

    if (!isServiceControlEnabled()) {
      return res.status(503).json({
        message: 'Service control is disabled. Set ENABLE_SERVICE_CONTROL=true on the Linux VPS.'
      });
    }

    if (process.platform === 'win32') {
      return res.status(503).json({ message: 'systemctl is available only on Linux hosts' });
    }

    await execFileAsync('systemctl', [action, service], { timeout: 10000 });
    await createLog({ userId: req.user.id, action: `${action} service ${service}` });

    return res.json({ message: `${service} ${action} command completed` });
  } catch (error) {
    error.publicMessage = 'Service command failed';
    return next(error);
  }
}

async function serviceStatus(req, res, next) {
  try {
    const { name } = req.params;
    const service = SERVICE_MAP[name];

    if (!service) {
      return res.status(400).json({ message: 'Service is not allowed' });
    }

    if (!isServiceControlEnabled() || process.platform === 'win32') {
      return res.json({ service, active: null, message: 'Status unavailable in this environment' });
    }

    try {
      await execFileAsync('systemctl', ['is-active', '--quiet', service], { timeout: 2500 });
      return res.json({ service, active: true });
    } catch (_error) {
      return res.json({ service, active: false });
    }
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  controlService,
  serviceStatus
};
