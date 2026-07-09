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
const { addProjectService, removeProjectService, listProjectServices, isServiceLinkedToProject } = require('../models/projectServiceModel');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

const execFileAsync = promisify(execFile);

// ─── Global service whitelist ─────────────────────────────────────────────────

const GLOBAL_SERVICE_MAP = Object.freeze({
  nginx:   { name: 'nginx',   label: 'Nginx' },
  mysql:   { name: 'mysql',   label: 'MySQL' },
  mariadb: { name: 'mariadb', label: 'MariaDB' },
  apache2: { name: 'apache2', label: 'Apache2' }
});

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

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

async function getServiceActiveStatus(serviceName) {
  if (!isServiceControlEnabled() || process.platform === 'win32') return null;

  try {
    const cmd = systemctlCommand(['is-active', '--quiet', serviceName]);
    await execFileAsync(cmd.file, cmd.args, { timeout: 2500 });
    return true;
  } catch (_) {
    return false;
  }
}

async function runServiceCommand(serviceName, action) {
  const cmd = systemctlCommand([action, serviceName]);
  await execFileAsync(cmd.file, cmd.args, { timeout: 10000 });
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
      scope:  'global'
    })));
    return res.json({ services: statuses });
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
      return res.json({ service: service.name, label: service.label, active: null, message: 'Status unavailable in this environment' });
    }

    const active = await getServiceActiveStatus(service.name);
    return res.json({ service: service.name, label: service.label, active });
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

    if (!service)                return res.status(400).json({ message: 'Service is not allowed' });
    if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ message: 'Action is not allowed' });
    if (!isServiceControlEnabled())   return res.status(503).json({ message: 'Service control is disabled. Set ENABLE_SERVICE_CONTROL=true on the Linux VPS.' });
    if (process.platform === 'win32') return res.status(503).json({ message: 'systemctl is available only on Linux hosts' });

    await runServiceCommand(service.name, action);
    await createLog({ userId: req.user.id, action: `${action} global service ${service.name}` });

    return res.json({ message: `${service.name} ${action} command completed` });
  } catch (error) {
    return next(new AppError('Service command failed', 503, 'SERVICE_COMMAND_FAILED', {
      service: req.params.name,
      action:  req.params.action
    }));
  }
}

// ─── Project-linked services ──────────────────────────────────────────────────

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
 * Body: { serviceName, label }
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

    if (!serviceName || !/^[a-zA-Z0-9_.-]{1,128}$/.test(serviceName)) {
      return res.status(400).json({ message: 'Invalid service name (letters, numbers, dots, dashes, underscores)' });
    }

    await addProjectService({ projectId, serviceName, label });
    await createLog({ userId: req.user.id, action: `linked service ${serviceName} to project ${project.name}` });

    return res.status(201).json({ message: 'Service linked to project', serviceName, label });
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
      action:  req.params.action
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
  serviceStatus,
  controlService,
  listLinkedServices,
  addLinkedService,
  removeLinkedService,
  controlLinkedService,
  linkedServiceStatus
};
