const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

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

function systemctlCommand(args) {
  if (process.platform === 'win32') {
    return { file: 'systemctl', args };
  }

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { file: 'sudo', args: ['-n', 'systemctl', ...args] };
  }

  return { file: 'systemctl', args };
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

    const command = systemctlCommand([action, service]);
    await execFileAsync(command.file, command.args, { timeout: 10000 });
    await createLog({ userId: req.user.id, action: `${action} service ${service}` });

    return res.json({ message: `${service} ${action} command completed` });
  } catch (error) {
    return next(new AppError('Service command failed', 503, 'SERVICE_COMMAND_FAILED', {
      service: req.params.name,
      action: req.params.action
    }));
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
      const command = systemctlCommand(['is-active', '--quiet', service]);
      await execFileAsync(command.file, command.args, { timeout: 2500 });
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
