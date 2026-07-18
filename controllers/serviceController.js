'use strict';

/**
 * serviceController.js
 *
 * Controls whitelisted global systemd services AND project-linked services.
 *
 * Global services:  GET /api/services
 *                   GET /api/services/:name/status
 *                   POST /api/services/:name/:action    (admin only)
 *
 * Project services: GET  /api/projects/:id/services
 *                   POST /api/projects/:id/services
 *                   DELETE /api/projects/:id/services/:name
 *                   POST /api/projects/:id/services/:name/:action
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const { findProjectById, getProjectMembership } = require('../models/projectModel');
const {
  addProjectService,
  removeProjectService,
  listProjectServices,
  listAllProjectServices,
  findProjectServiceByName,
  isServiceLinkedToProject
} = require('../models/projectServiceModel');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');
const {
  createOrUpdateProjectServiceUnit,
  defaultExecStart,
  removeProjectServiceUnit,
  unitNameForService
} = require('../utils/projectSystemd');

const execFileAsync = promisify(execFile);

// ─── Global service whitelist ─────────────────────────────────────────────────

const GLOBAL_SERVICE_MAP = Object.freeze({
  nginx:   { name: 'nginx',   label: 'Nginx' },
  mysql:   { name: 'mysql',   label: 'MySQL' },
  mariadb: { name: 'mariadb', label: 'MariaDB' },
  apache2: { name: 'apache2', label: 'Apache2' }
});

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);
const ALLOWED_GLOBAL_ACTIONS = new Set(['start', 'stop', 'restart', 'reload']);
const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9_.@-]{1,128}(?:\.service)?$/;
const SYSTEMD_DETAIL_PROPERTIES = [
  'Id',
  'Description',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'FragmentPath',
  'MainPID',
  'ExecMainPID',
  'ExecMainStatus',
  'MemoryCurrent',
  'MemoryMax',
  'CPUUsageNSec',
  'CPUQuotaPerSecUSec',
  'TasksCurrent',
  'TasksMax',
  'NRestarts'
];

function isServiceControlEnabled() {
  return process.env.ENABLE_SERVICE_CONTROL === 'true';
}

function systemctlCommand(args) {
  if (process.platform === 'win32') return { file: 'systemctl', args };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { file: 'sudo', args: ['-n', 'systemctl', ...args] };
  }
  return { file: 'systemctl', args };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function commandDetails(error) {
  return {
    stdout: (error?.stdout || '').trim(),
    stderr: (error?.stderr || '').trim(),
    message: error?.message || 'Command failed'
  };
}

async function runSystemctl(args, options = {}) {
  const cmd = systemctlCommand(args);
  return execFileAsync(cmd.file, cmd.args, { timeout: 10000, ...options });
}

async function readSystemctl(args, options = {}) {
  return execFileAsync('systemctl', args, { timeout: 3500, ...options });
}

function parseSystemctlShow(stdout = '') {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((fields, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) return fields;
      fields[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
      return fields;
    }, {});
}

function nullableSystemdValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === '[not set]' || text.toLowerCase() === 'n/a') return null;
  return text;
}

function bodyBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === '1' || value === 1;
}

function numberOrNull(value) {
  const text = nullableSystemdValue(value);
  if (text === null || text === 'infinity' || text === '18446744073709551615') return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function limitValue(value) {
  const text = nullableSystemdValue(value);
  if (text === null || text === '18446744073709551615') return null;
  return text;
}

function buildServiceDetails(fields) {
  return {
    available: true,
    description: nullableSystemdValue(fields.Description),
    loadState: nullableSystemdValue(fields.LoadState),
    activeState: nullableSystemdValue(fields.ActiveState),
    subState: nullableSystemdValue(fields.SubState),
    unitFileState: nullableSystemdValue(fields.UnitFileState),
    fragmentPath: nullableSystemdValue(fields.FragmentPath),
    mainPid: numberOrNull(fields.MainPID) || numberOrNull(fields.ExecMainPID),
    execMainStatus: numberOrNull(fields.ExecMainStatus),
    restarts: numberOrNull(fields.NRestarts),
    resources: {
      memoryCurrent: numberOrNull(fields.MemoryCurrent),
      memoryMax: limitValue(fields.MemoryMax),
      cpuUsageNSec: numberOrNull(fields.CPUUsageNSec),
      cpuQuotaPerSecUSec: limitValue(fields.CPUQuotaPerSecUSec),
      tasksCurrent: numberOrNull(fields.TasksCurrent),
      tasksMax: limitValue(fields.TasksMax)
    }
  };
}

async function getServiceDetails(serviceName) {
  if (!isServiceControlEnabled()) {
    return { available: false, message: 'Service control is disabled' };
  }

  if (process.platform === 'win32') {
    return { available: false, message: 'systemctl is available only on Linux hosts' };
  }

  try {
    const propertyArgs = SYSTEMD_DETAIL_PROPERTIES.flatMap((property) => ['--property', property]);
    const { stdout } = await readSystemctl(['show', '--no-page', ...propertyArgs, serviceName]);
    return buildServiceDetails(parseSystemctlShow(stdout));
  } catch (error) {
    return {
      available: false,
      message: (error.stderr || error.message || 'Unable to read service details').trim()
    };
  }
}

async function getServiceActiveStatus(serviceName) {
  if (!isServiceControlEnabled() || process.platform === 'win32') return null;

  try {
    await runSystemctl(['is-active', '--quiet', serviceName], { timeout: 2500 });
    return true;
  } catch (_) {
    return false;
  }
}

async function runServiceCommand(serviceName, action) {
  await runSystemctl([action, serviceName], { timeout: 10000 });
}

function normalizeGlobalServiceAction(serviceName, action) {
  if (!ALLOWED_GLOBAL_ACTIONS.has(action)) return null;
  if (action === 'reload' && serviceName !== 'nginx') return null;

  // Restarting Nginx from a request proxied by Nginx can drop the response.
  // Reload applies config changes without interrupting the control panel.
  if (serviceName === 'nginx' && action === 'restart') return 'reload';
  return action;
}

function normalizeUnlimited(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return !text || text === 'none' || text === 'unlimited' || text === 'infinity';
}

function parsePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new AppError(`${label} must be greater than zero`, 400, 'INVALID_RESOURCE_LIMIT');
  }
  return number;
}

function normalizeCpuQuota(value) {
  if (normalizeUnlimited(value)) return '';

  const text = String(value).trim();
  const match = text.match(/^(\d+(?:\.\d+)?)%$/);
  if (!match) {
    throw new AppError('CPU quota must be a percentage like 50% or infinity', 400, 'INVALID_RESOURCE_LIMIT');
  }

  const number = parsePositiveNumber(match[1], 'CPU quota');
  if (number > 10000) {
    throw new AppError('CPU quota cannot be greater than 10000%', 400, 'INVALID_RESOURCE_LIMIT');
  }

  return `${number}%`;
}

function normalizeMemoryMax(value) {
  if (normalizeUnlimited(value)) return 'infinity';

  const text = String(value).trim().replace(/\s+/g, '').toUpperCase();
  const match = text.match(/^(\d+(?:\.\d+)?)([KMGTPE]?B?)?$/);
  if (!match) {
    throw new AppError('Memory limit must look like 512M, 1G, a byte count, or infinity', 400, 'INVALID_RESOURCE_LIMIT');
  }

  parsePositiveNumber(match[1], 'Memory limit');
  return `${match[1]}${match[2] || ''}`;
}

function normalizeTasksMax(value) {
  if (normalizeUnlimited(value)) return 'infinity';

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new AppError('Tasks limit must be a whole number or infinity', 400, 'INVALID_RESOURCE_LIMIT');
  }

  const number = parsePositiveNumber(text, 'Tasks limit');
  if (number > 1000000) {
    throw new AppError('Tasks limit cannot be greater than 1000000', 400, 'INVALID_RESOURCE_LIMIT');
  }

  return String(number);
}

function normalizeLimitUpdates(body) {
  const updates = [];
  if (Object.prototype.hasOwnProperty.call(body, 'cpuQuota')) {
    updates.push(['CPUQuota', normalizeCpuQuota(body.cpuQuota)]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'memoryMax')) {
    updates.push(['MemoryMax', normalizeMemoryMax(body.memoryMax)]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tasksMax')) {
    updates.push(['TasksMax', normalizeTasksMax(body.tasksMax)]);
  }
  return updates;
}

// ─── Global services ──────────────────────────────────────────────────────────

/**
 * GET /api/services
 * Returns all globally whitelisted services with their current active status.
 */
async function listServices(_req, res, next) {
  try {
    const entries = Object.values(GLOBAL_SERVICE_MAP);
    const statuses = await Promise.all(entries.map(async (svc) => ({
      name:   svc.name,
      label:  svc.label,
      active: await getServiceActiveStatus(svc.name),
      details: await getServiceDetails(svc.name),
      scope:  'global'
    })));
    return res.json({ services: statuses });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/services/ekafy
 * Returns all project-linked services, separated from global host services.
 */
async function listEkafyServices(_req, res, next) {
  try {
    const linkedServices = await listAllProjectServices();
    const services = await Promise.all(linkedServices.map(async (svc) => ({
      id: Number(svc.id),
      name: svc.service_name,
      label: svc.label || svc.service_name,
      active: await getServiceActiveStatus(svc.service_name),
      details: await getServiceDetails(svc.service_name),
      scope: 'ekafy',
      project: {
        id: Number(svc.project_id),
        name: svc.project_name,
        slug: svc.project_slug,
        status: svc.project_status
      },
      createdAt: svc.created_at
    })));

    return res.json({ services });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/services/:name/status
 */
async function serviceStatus(req, res, next) {
  try {
    const { name } = req.params;
    const service = GLOBAL_SERVICE_MAP[name];
    if (!service) return res.status(400).json({ message: 'Service is not allowed' });

    if (!isServiceControlEnabled() || process.platform === 'win32') {
      return res.json({
        service: service.name,
        label: service.label,
        active: null,
        details: await getServiceDetails(service.name),
        message: 'Status unavailable in this environment'
      });
    }

    const active = await getServiceActiveStatus(service.name);
    const details = await getServiceDetails(service.name);
    return res.json({ service: service.name, label: service.label, active, details });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/services/:name/:action   (admin only)
 */
async function controlService(req, res, next) {
  try {
    const { name, action } = req.params;
    const service = GLOBAL_SERVICE_MAP[name];
    const commandAction = service ? normalizeGlobalServiceAction(service.name, action) : null;

    if (!service)                return res.status(400).json({ message: 'Service is not allowed' });
    if (!commandAction) return res.status(400).json({ message: 'Action is not allowed' });
    if (!isServiceControlEnabled())   return res.status(503).json({ message: 'Service control is disabled. Set ENABLE_SERVICE_CONTROL=true on the Linux VPS.' });
    if (process.platform === 'win32') return res.status(503).json({ message: 'systemctl is available only on Linux hosts' });

    await runServiceCommand(service.name, commandAction);
    await createLog({ userId: req.user.id, action: `${commandAction} global service ${service.name}` });

    return res.json({ message: `${service.name} ${commandAction} command completed` });
  } catch (error) {
    return next(new AppError('Service command failed', 503, 'SERVICE_COMMAND_FAILED', {
      service: req.params.name,
      action:  req.params.action,
      command: commandDetails(error)
    }));
  }
}

// ─── Project-linked services ──────────────────────────────────────────────────

/**
 * PATCH /api/services/ekafy/:name/limits
 *
 * Body: { cpuQuota?, memoryMax?, tasksMax? }
 */
async function updateEkafyServiceLimits(req, res, next) {
  try {
    const serviceName = (req.params.name || '').trim();
    if (!SERVICE_NAME_PATTERN.test(serviceName)) {
      return res.status(400).json({ message: 'Invalid service name' });
    }
    if (!isServiceControlEnabled()) {
      return res.status(503).json({ message: 'Service control is disabled. Set ENABLE_SERVICE_CONTROL=true on the Linux VPS.' });
    }
    if (process.platform === 'win32') {
      return res.status(503).json({ message: 'systemctl is available only on Linux hosts' });
    }

    const linkedService = await findProjectServiceByName(serviceName);
    if (!linkedService) {
      return res.status(404).json({ message: 'Service is not linked to an EKAFY project' });
    }

    const updates = normalizeLimitUpdates(req.body || {});
    if (!updates.length) {
      return res.status(400).json({ message: 'Provide at least one limit to update' });
    }

    for (const [property, value] of updates) {
      await runSystemctl(['set-property', serviceName, `${property}=${value}`], { timeout: 10000 });
    }

    await createLog({
      userId: req.user.id,
      action: `updated resource limits for project service ${serviceName}`
    });

    return res.json({
      message: `${serviceName} resource limits updated`,
      service: {
        name: serviceName,
        active: await getServiceActiveStatus(serviceName),
        details: await getServiceDetails(serviceName)
      }
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError('Service limit update failed', 503, 'SERVICE_LIMIT_UPDATE_FAILED', {
      service: req.params.name,
      ...commandDetails(error)
    }));
  }
}

async function canManageProject(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

/**
 * GET /api/projects/:id/services
 */
async function listLinkedServices(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const canView = req.user.role === 'admin' || Boolean(await getProjectMembership(projectId, req.user.id));
    if (!canView) return res.status(403).json({ message: 'Project access required' });

    const services = await listProjectServices(projectId);

    // Enrich with live status
    const enriched = await Promise.all(services.map(async (svc) => ({
      ...svc,
      active: await getServiceActiveStatus(svc.service_name)
    })));

    return res.json({ services: enriched });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/services
 *
 * Body: { serviceName, label, createUnit?, execStart?, serviceUser?, serviceGroup?, enable?, start? }
 */
async function addLinkedService(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManageProject(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const serviceName = (req.body.serviceName || '').trim();
    const label       = (req.body.label || serviceName).trim();
    const createUnit  = bodyBoolean(req.body.createUnit, false);

    if (!serviceName || !SERVICE_NAME_PATTERN.test(serviceName)) {
      return res.status(400).json({ message: 'Invalid service name (letters, numbers, dots, dashes, underscores, @)' });
    }

    const existingOwner = await findProjectServiceByName(serviceName);
    if (existingOwner && Number(existingOwner.project_id) !== projectId) {
      return res.status(409).json({
        message: `Service is already linked to project ${existingOwner.project_name || existingOwner.project_slug || existingOwner.project_id}`
      });
    }

    let unit = null;
    if (createUnit) {
      unit = await createOrUpdateProjectServiceUnit(project, {
        serviceName,
        label,
        runtime: req.body.runtime || project.config?.runtime,
        execStart: req.body.execStart,
        serviceUser: req.body.serviceUser,
        serviceGroup: req.body.serviceGroup,
        enable: bodyBoolean(req.body.enable, true),
        start: bodyBoolean(req.body.start, false)
      });
    }

    await addProjectService({ projectId, serviceName, label });
    await createLog({
      userId: req.user.id,
      action: createUnit
        ? `created systemd unit and linked service ${serviceName} to project ${project.name}`
        : `linked service ${serviceName} to project ${project.name}`
    });

    return res.status(201).json({
      message: createUnit ? 'Service linked and unit created' : 'Service linked to project',
      serviceName,
      label,
      unit
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/services/:name/unit
 *
 * Create or update the systemd unit file for an already-linked service.
 */
async function createLinkedServiceUnit(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const serviceName = (req.params.name || '').trim();

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    if (!serviceName || !SERVICE_NAME_PATTERN.test(serviceName)) {
      return res.status(400).json({ message: 'Invalid service name' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManageProject(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const linked = await isServiceLinkedToProject(projectId, serviceName);
    if (!linked) return res.status(400).json({ message: 'Service is not linked to this project' });

    const unit = await createOrUpdateProjectServiceUnit(project, {
      serviceName,
      label: req.body.label || serviceName,
      runtime: req.body.runtime || project.config?.runtime,
      execStart: req.body.execStart,
      serviceUser: req.body.serviceUser,
      serviceGroup: req.body.serviceGroup,
      enable: bodyBoolean(req.body.enable, true),
      start: bodyBoolean(req.body.start, false)
    });

    await createLog({ userId: req.user.id, action: `updated systemd unit ${serviceName} for project ${project.name}` });

    return res.json({
      message: `${unitNameForService(serviceName)} written`,
      serviceName,
      defaultExecStart: defaultExecStart(project.config?.runtime),
      unit
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/projects/:id/services/:name/unit
 *
 * Stop, disable, and remove the systemd unit file for a linked service.
 * Pass ?unlink=true to also remove the project service link.
 */
async function deleteLinkedServiceUnit(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const serviceName = (req.params.name || '').trim();

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    if (!serviceName || !SERVICE_NAME_PATTERN.test(serviceName)) {
      return res.status(400).json({ message: 'Invalid service name' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManageProject(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const linked = await isServiceLinkedToProject(projectId, serviceName);
    if (!linked) return res.status(400).json({ message: 'Service is not linked to this project' });

    const unit = await removeProjectServiceUnit(serviceName);
    const unlink = bodyBoolean(req.query.unlink ?? req.body.unlink, false);
    let unlinked = false;

    if (unlink) {
      unlinked = await removeProjectService({ projectId, serviceName });
    }

    await createLog({
      userId: req.user.id,
      action: `${unlinked ? 'deleted and unlinked' : 'deleted unit for'} project service ${serviceName} on ${project.name}`
    });

    return res.json({
      message: unlinked ? 'Service unit deleted and service unlinked' : 'Service unit deleted',
      serviceName,
      unlinked,
      unit
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/projects/:id/services/:name
 */
async function removeLinkedService(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManageProject(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const serviceName = req.params.name;
    const removed = await removeProjectService({ projectId, serviceName });

    if (!removed) return res.status(404).json({ message: 'Service not linked to this project' });

    await createLog({ userId: req.user.id, action: `unlinked service ${serviceName} from project ${project.name}` });
    return res.json({ message: 'Service unlinked from project' });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/services/:name/:action
 * Controls a project-linked service (must be in project_services table).
 */
async function controlLinkedService(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const { name: serviceName, action } = req.params;

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ message: 'Action is not allowed' });
    if (!isServiceControlEnabled())   return res.status(503).json({ message: 'Service control is disabled.' });
    if (process.platform === 'win32') return res.status(503).json({ message: 'systemctl is available only on Linux hosts' });

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManageProject(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const linked = await isServiceLinkedToProject(projectId, serviceName);
    if (!linked) return res.status(400).json({ message: 'Service is not linked to this project' });

    await runServiceCommand(serviceName, action);
    await createLog({ userId: req.user.id, action: `${action} project service ${serviceName} on ${project.name}` });

    return res.json({ message: `${serviceName} ${action} command completed` });
  } catch (error) {
    return next(new AppError('Service command failed', 503, 'SERVICE_COMMAND_FAILED', {
      service: req.params.name,
      action:  req.params.action,
      command: commandDetails(error)
    }));
  }
}

/**
 * GET /api/projects/:id/services/:name/status
 */
async function linkedServiceStatus(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const serviceName = req.params.name;

    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const canView = req.user.role === 'admin' || Boolean(await getProjectMembership(projectId, req.user.id));
    if (!canView) return res.status(403).json({ message: 'Project access required' });

    const linked = await isServiceLinkedToProject(projectId, serviceName);
    if (!linked) return res.status(400).json({ message: 'Service is not linked to this project' });

    const active = await getServiceActiveStatus(serviceName);
    return res.json({ service: serviceName, active });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listServices,
  listEkafyServices,
  serviceStatus,
  controlService,
  updateEkafyServiceLimits,
  listLinkedServices,
  addLinkedService,
  createLinkedServiceUnit,
  deleteLinkedServiceUnit,
  removeLinkedService,
  controlLinkedService,
  linkedServiceStatus
};
