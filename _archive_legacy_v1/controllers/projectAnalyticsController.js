'use strict';

/**
 * projectAnalyticsController.js
 *
 * Reads and parses project-specific Nginx access logs
 * to provide insights like unique visitors and status codes.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { findProjectById, getProjectMembership } = require('../models/projectModel');

const execFileAsync = promisify(execFile);

// Standard Nginx Combined Log Format Regex
const NGINX_LOG_REGEX = /^(\S+) - \S+ \[(.+?)\] "(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) (\S+) \S+" (\d+) \d+ "[^"]*" "([^"]*)"/;

async function canView(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return Boolean(membership);
}

/**
 * GET /api/projects/:id/analytics
 */
async function getAnalytics(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canView(req.user, projectId))) {
      return res.status(403).json({ message: 'Project access required' });
    }

    if (process.platform === 'win32') {
      return res.status(503).json({ message: 'Log parsing is only supported on Linux' });
    }

    const logPath = path.join(project.path, 'logs', 'access.log');
    let logOutput = '';

    try {
      const { stdout } = await execFileAsync('tail', ['-n', '5000', logPath], { timeout: 5000 });
      logOutput = stdout;
    } catch (error) {
      // If file doesn't exist, just return empty stats
      if (error.message.includes('No such file') || error.code === 'ENOENT') {
         return res.json({
           totalRequests: 0,
           uniqueVisitors: 0,
           statusCodes: {},
           topPaths: {}
         });
      }
      return res.status(500).json({ message: 'Failed to read access log', error: error.message });
    }

    const lines = logOutput.split('\n').filter(Boolean);
    const uniqueIps = new Set();
    const statusCodes = {};
    const paths = {};

    lines.forEach(line => {
      const match = line.match(NGINX_LOG_REGEX);
      if (match) {
        const ip = match[1];
        const reqPath = match[4];
        const status = match[5];

        uniqueIps.add(ip);

        if (!statusCodes[status]) statusCodes[status] = 0;
        statusCodes[status]++;

        if (!paths[reqPath]) paths[reqPath] = 0;
        paths[reqPath]++;
      }
    });

    // Sort paths by frequency (desc) and take top 10
    const topPaths = Object.fromEntries(
      Object.entries(paths)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
    );

    return res.json({
      totalRequests: lines.length,
      uniqueVisitors: uniqueIps.size,
      statusCodes,
      topPaths
    });

  } catch (error) {
    return next(error);
  }
}

module.exports = { getAnalytics };
