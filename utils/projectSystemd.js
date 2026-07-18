'use strict';

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { AppError } = require('../errors/AppError');

const execFileAsync = promisify(execFile);

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/srv';
const SYSTEMD_SYSTEM_DIR = '/etc/systemd/system';
const SERVICE_RUNTIME_SET = new Set(['node-app', 'python-api', 'static-api']);
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.@-]{1,128}(?:\.service)?$/;
const ACCOUNT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}\$?$/;

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canUseProjectSystemd() {
  return process.platform !== 'win32' && process.env.ENABLE_SERVICE_CONTROL === 'true';
}

function projectNeedsSystemdService(runtimeOrConfig) {
  const runtime = typeof runtimeOrConfig === 'string'
    ? runtimeOrConfig
    : runtimeOrConfig?.runtime;
  return SERVICE_RUNTIME_SET.has(runtime);
}

function isSafeServiceName(value) {
  return SERVICE_NAME_PATTERN.test(trimText(value));
}

function normalizeServiceName(value) {
  const serviceName = trimText(value);
  if (!isSafeServiceName(serviceName)) return null;
  return serviceName;
}

function unitNameForService(serviceName) {
  const value = normalizeServiceName(serviceName);
  if (!value) return null;
  return value.endsWith('.service') ? value : `${value}.service`;
}

function unitPathForService(serviceName) {
  const unitName = unitNameForService(serviceName);
  if (!unitName) return null;
  return path.posix.join(SYSTEMD_SYSTEM_DIR, unitName);
}

function normalizeInsideProjectsRoot(targetPath) {
  const value = trimText(targetPath);
  if (!value || !value.startsWith('/')) return null;

  const normalized = path.posix.normalize(value);
  const root = path.posix.normalize(PROJECTS_ROOT);
  if (normalized === root || !normalized.startsWith(`${root}/`)) return null;
  return normalized;
}

function normalizeAccountName(value, fallback) {
  const account = trimText(value || fallback);
  return ACCOUNT_NAME_PATTERN.test(account) ? account : null;
}

function normalizeExecStart(value, runtime) {
  const raw = trimText(value);
  if (!raw) return defaultExecStart(runtime);
  if (raw.includes('\n') || raw.includes('\r')) return null;
  if (raw.startsWith('/')) return raw;

  const npmBin = process.env.PROJECT_SERVICE_NPM_BIN || '/usr/bin/npm';
  const nodeBin = process.env.PROJECT_SERVICE_NODE_BIN || '/usr/bin/node';
  const pythonBin = process.env.PROJECT_SERVICE_PYTHON_BIN || '/usr/bin/python3';

  if (raw === 'npm' || raw.startsWith('npm ')) return `${npmBin}${raw.slice(3)}`;
  if (raw === 'node' || raw.startsWith('node ')) return `${nodeBin}${raw.slice(4)}`;
  if (raw === 'python3' || raw.startsWith('python3 ')) return `${pythonBin}${raw.slice(7)}`;
  if (raw === 'python' || raw.startsWith('python ')) return `${pythonBin}${raw.slice(6)}`;

  return null;
}

function defaultExecStart(runtime) {
  if (runtime === 'python-api') {
    return `${process.env.PROJECT_SERVICE_PYTHON_BIN || '/usr/bin/python3'} app.py`;
  }
  return `${process.env.PROJECT_SERVICE_NPM_BIN || '/usr/bin/npm'} start`;
}

function escapeUnitText(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultServiceUser() {
  return process.env.PROJECT_SERVICE_USER || process.env.USER || 'www-data';
}

function defaultServiceGroup() {
  return process.env.PROJECT_SERVICE_GROUP || defaultServiceUser();
}

function rootCommand(command, args = []) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { file: 'sudo', args: ['-n', command, ...args] };
  }
  return { file: command, args };
}

async function runRootCommand(command, args, options = {}) {
  const cmd = rootCommand(command, args);
  return execFileAsync(cmd.file, cmd.args, { timeout: 10000, ...options });
}

async function runSystemctl(args, options = {}) {
  return runRootCommand('systemctl', args, options);
}

function buildUnitFile(project, options) {
  const runtime = options.runtime || project.config?.runtime || 'node-app';
  const execStart = normalizeExecStart(options.execStart, runtime);
  const serviceUser = normalizeAccountName(options.serviceUser, defaultServiceUser());
  const serviceGroup = normalizeAccountName(options.serviceGroup, options.serviceUser || defaultServiceGroup());

  if (!execStart) {
    throw new AppError(
      'ExecStart must start with an absolute command path, or one of: npm, node, python, python3',
      400,
      'INVALID_SERVICE_EXEC'
    );
  }

  if (!serviceUser || !serviceGroup) {
    throw new AppError('Invalid service user or group', 400, 'INVALID_SERVICE_ACCOUNT');
  }

  const description = escapeUnitText(options.description || `${project.name} service`);

  return `[Unit]
Description=EKAFY Project - ${description}
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=${serviceUser}
Group=${serviceGroup}
WorkingDirectory=${project.path}
Environment=NODE_ENV=production
EnvironmentFile=-${project.path}/.env
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

async function createOrUpdateProjectServiceUnit(project, options = {}) {
  if (!canUseProjectSystemd()) {
    throw new AppError(
      'Project systemd service creation is available only on Linux with ENABLE_SERVICE_CONTROL=true.',
      503,
      'SERVICE_CONTROL_DISABLED'
    );
  }

  const projectPath = normalizeInsideProjectsRoot(project.path);
  if (!projectPath) {
    throw new AppError(`Project path must stay inside ${PROJECTS_ROOT}`, 400, 'INVALID_PROJECT_PATH');
  }

  const serviceName = normalizeServiceName(options.serviceName || project.slug);
  if (!serviceName) {
    throw new AppError('Invalid service name', 400, 'INVALID_SERVICE_NAME');
  }

  const unitName = unitNameForService(serviceName);
  const unitPath = unitPathForService(serviceName);
  const runtime = options.runtime || project.config?.runtime || 'node-app';
  const unitContent = buildUnitFile({ ...project, path: projectPath }, { ...options, runtime });
  const configDir = path.posix.join(projectPath, 'config');
  const logsDir = path.posix.join(projectPath, 'logs');
  const tempUnitPath = path.posix.join(configDir, unitName);

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(tempUnitPath, unitContent, 'utf8');

  try {
    await runRootCommand('/usr/bin/install', ['-o', 'root', '-g', 'root', '-m', '0644', tempUnitPath, unitPath]);
    await runSystemctl(['daemon-reload'], { timeout: 10000 });

    if (options.enable !== false) {
      await runSystemctl(['enable', unitName], { timeout: 10000 });
    }

    if (options.start === true) {
      await runSystemctl(['restart', unitName], { timeout: 15000 });
    }
  } catch (error) {
    throw new AppError('Project service unit setup failed', 503, 'PROJECT_SERVICE_UNIT_FAILED', {
      service: serviceName,
      unitName,
      unitPath,
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || '').trim(),
      message: error.message
    });
  }

  return {
    serviceName,
    unitName,
    unitPath,
    tempUnitPath,
    enabled: options.enable !== false,
    started: options.start === true,
    execStart: normalizeExecStart(options.execStart, runtime)
  };
}

async function removeProjectServiceUnit(serviceName) {
  if (!canUseProjectSystemd()) return { removed: false, skipped: true };

  const unitName = unitNameForService(serviceName);
  const unitPath = unitPathForService(serviceName);
  if (!unitName || !unitPath) {
    throw new AppError('Invalid service name', 400, 'INVALID_SERVICE_NAME');
  }

  const warnings = [];
  for (const args of [
    ['stop', unitName],
    ['disable', unitName],
    ['reset-failed', unitName]
  ]) {
    try {
      await runSystemctl(args, { timeout: 10000 });
    } catch (error) {
      warnings.push(`${args[0]} ${unitName}: ${(error.stderr || error.message || '').trim()}`);
    }
  }

  await runRootCommand('/usr/bin/rm', ['-f', unitPath], { timeout: 10000 });
  await runRootCommand('/usr/bin/rm', ['-rf', `${unitPath}.d`], { timeout: 10000 });
  await runSystemctl(['daemon-reload'], { timeout: 10000 });
  return { removed: true, unitName, unitPath, warnings };
}

module.exports = {
  canUseProjectSystemd,
  projectNeedsSystemdService,
  normalizeServiceName,
  unitNameForService,
  unitPathForService,
  defaultExecStart,
  createOrUpdateProjectServiceUnit,
  removeProjectServiceUnit
};
