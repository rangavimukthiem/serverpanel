'use strict';

/**
 * projectEnvController.js
 *
 * CRUD for per-project environment variables stored in `project_envs`.
 * The list endpoint returns keys only (no values) for security.
 * Values are only written to the .env file on disk.
 */

const { findProjectById, getProjectMembership } = require('../models/projectModel');
const { upsertProjectEnv, deleteProjectEnv, listProjectEnvKeys, writeProjectEnvFile } = require('../models/projectEnvModel');
const { createLog } = require('../models/logModel');

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

async function canManage(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

/**
 * GET /api/projects/:id/env
 * Returns env key names and timestamps (no values).
 */
async function list(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const keys = await listProjectEnvKeys(projectId);
    return res.json({ envKeys: keys });
  } catch (error) {
    return next(error);
  }
}

/**
 * PUT /api/projects/:id/env
 *
 * Body: { key, value }
 * Upserts a single env variable and rewrites the .env file.
 */
async function upsert(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const key   = (req.body.key   || '').trim();
    const value = (req.body.value !== undefined) ? String(req.body.value) : '';

    if (!ENV_KEY_PATTERN.test(key)) {
      return res.status(400).json({
        message: 'Env key must be uppercase letters, numbers, and underscores (e.g. MY_VAR)'
      });
    }

    await upsertProjectEnv(projectId, key, value);
    await writeProjectEnvFile(projectId, project.path);
    await createLog({ userId: req.user.id, action: `set env ${key} on project ${project.name}` });

    return res.json({ message: 'Environment variable saved', key });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/projects/:id/env/:key
 * Removes a single env variable and rewrites the .env file.
 */
async function remove(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const key = (req.params.key || '').trim();
    const deleted = await deleteProjectEnv(projectId, key);

    if (!deleted) return res.status(404).json({ message: 'Env key not found' });

    await writeProjectEnvFile(projectId, project.path);
    await createLog({ userId: req.user.id, action: `removed env ${key} from project ${project.name}` });

    return res.json({ message: 'Environment variable removed', key });
  } catch (error) {
    return next(error);
  }
}

module.exports = { list, upsert, remove };
