'use strict';

/**
 * projectNpmController.js
 *
 * Runs npm install for a project.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const { findProjectById, getProjectMembership } = require('../models/projectModel');
const { createLog } = require('../models/logModel');

const execFileAsync = promisify(execFile);

// Wait up to 5 minutes for npm install
const NPM_TIMEOUT = 300000;

async function canManage(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

function requireLinux(res) {
  if (process.platform === 'win32') {
    res.status(503).json({ message: 'NPM shell operations are only available on Linux hosts.' });
    return false;
  }
  return true;
}

/**
 * POST /api/projects/:id/npm/install
 */
async function install(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    // Determine the npm bin to use, fallback to 'npm'
    const npmBin = process.env.PROJECT_SERVICE_NPM_BIN || 'npm';
    const appUser = process.env.PROJECT_SERVICE_USER;
    
    // Command setup
    let cmd = npmBin;
    let args = ['install'];

    // If running as root but the project belongs to a specific user, use sudo
    // This assumes the panel runs as root or has sudo privileges.
    if (appUser && typeof process.getuid === 'function' && process.getuid() === 0) {
      cmd = 'sudo';
      args = ['-u', appUser, npmBin, 'install'];
    }

    try {
      const result = await execFileAsync(cmd, args, { cwd: project.path, timeout: NPM_TIMEOUT });
      await createLog({ userId: req.user.id, action: `npm install on project ${project.name}` });
      return res.json({
        message: 'NPM install complete',
        ok: true,
        output: [result.stdout, result.stderr].filter(Boolean).join('\n')
      });
    } catch (error) {
      const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
      return res.json({
        message: 'NPM install encountered errors',
        ok: false,
        output
      });
    }
  } catch (error) {
    return next(error);
  }
}

module.exports = { install };
