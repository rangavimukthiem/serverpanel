'use strict';

/**
 * projectEndpointController.js
 *
 * CRUD for per-project API endpoints stored in config_json.api.endpoints[].
 * Endpoints are indexed by their position in the array; the array is always
 * re-written atomically to the DB on every mutation.
 */

const { findProjectById, updateProjectConfig, getProjectMembership } = require('../models/projectModel');
const { createLog } = require('../models/logModel');

const HTTP_METHOD_SET = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateEndpoint(endpoint) {
  const method = trimText(endpoint?.method).toUpperCase();
  const path   = trimText(endpoint?.path);
  const name   = trimText(endpoint?.name);

  if (!name)                            return 'Endpoint name is required';
  if (!HTTP_METHOD_SET.has(method))     return `Method must be one of: ${[...HTTP_METHOD_SET].join(', ')}`;
  if (!path.startsWith('/'))            return 'Endpoint path must start with /';

  return null;
}

function normalizeEndpoint(endpoint) {
  return {
    name:        trimText(endpoint.name),
    method:      trimText(endpoint.method).toUpperCase(),
    path:        trimText(endpoint.path),
    description: trimText(endpoint.description)
  };
}

// ─── Access ───────────────────────────────────────────────────────────────────

async function canManage(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

async function canView(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return Boolean(membership);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveProject(req, res) {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    res.status(400).json({ message: 'Invalid project id' });
    return null;
  }
  const project = await findProjectById(projectId);
  if (!project) {
    res.status(404).json({ message: 'Project not found' });
    return null;
  }
  return project;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /api/projects/:id/endpoints
 */
async function list(req, res, next) {
  try {
    const project = await resolveProject(req, res);
    if (!project) return;

    if (!(await canView(req.user, project.id))) {
      return res.status(403).json({ message: 'Project access required' });
    }

    const endpoints = project.config?.api?.endpoints || [];
    return res.json({ endpoints: endpoints.map((ep, idx) => ({ ...ep, _idx: idx })) });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/endpoints
 *
 * Body: { name, method, path, description? }
 */
async function add(req, res, next) {
  try {
    const project = await resolveProject(req, res);
    if (!project) return;

    if (!(await canManage(req.user, project.id))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const error = validateEndpoint(req.body);
    if (error) return res.status(400).json({ message: error });

    const config    = project.config;
    const endpoints = Array.isArray(config.api?.endpoints) ? [...config.api.endpoints] : [];
    const newEndpoint = normalizeEndpoint(req.body);
    endpoints.push(newEndpoint);

    config.api.endpoints = endpoints;
    const updated = await updateProjectConfig(project.id, config);

    await createLog({ userId: req.user.id, action: `added endpoint ${newEndpoint.method} ${newEndpoint.path} to project ${project.name}` });

    const newIdx = endpoints.length - 1;
    return res.status(201).json({ endpoint: { ...newEndpoint, _idx: newIdx }, endpoints: updated.config.api.endpoints });
  } catch (error) {
    return next(error);
  }
}

/**
 * PUT /api/projects/:id/endpoints/:idx
 *
 * Body: { name, method, path, description? }
 */
async function update(req, res, next) {
  try {
    const project = await resolveProject(req, res);
    if (!project) return;

    if (!(await canManage(req.user, project.id))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({ message: 'Invalid endpoint index' });
    }

    const error = validateEndpoint(req.body);
    if (error) return res.status(400).json({ message: error });

    const config    = project.config;
    const endpoints = Array.isArray(config.api?.endpoints) ? [...config.api.endpoints] : [];

    if (idx >= endpoints.length) {
      return res.status(404).json({ message: 'Endpoint not found at that index' });
    }

    endpoints[idx] = normalizeEndpoint(req.body);
    config.api.endpoints = endpoints;
    const updated = await updateProjectConfig(project.id, config);

    await createLog({ userId: req.user.id, action: `updated endpoint at index ${idx} on project ${project.name}` });

    return res.json({ endpoint: { ...endpoints[idx], _idx: idx }, endpoints: updated.config.api.endpoints });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/projects/:id/endpoints/:idx
 */
async function remove(req, res, next) {
  try {
    const project = await resolveProject(req, res);
    if (!project) return;

    if (!(await canManage(req.user, project.id))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({ message: 'Invalid endpoint index' });
    }

    const config    = project.config;
    const endpoints = Array.isArray(config.api?.endpoints) ? [...config.api.endpoints] : [];

    if (idx >= endpoints.length) {
      return res.status(404).json({ message: 'Endpoint not found at that index' });
    }

    const removed = endpoints.splice(idx, 1)[0];
    config.api.endpoints = endpoints;
    const updated = await updateProjectConfig(project.id, config);

    await createLog({ userId: req.user.id, action: `removed endpoint ${removed.method} ${removed.path} from project ${project.name}` });

    return res.json({ message: 'Endpoint removed', endpoints: updated.config.api.endpoints });
  } catch (error) {
    return next(error);
  }
}

module.exports = { list, add, update, remove };
