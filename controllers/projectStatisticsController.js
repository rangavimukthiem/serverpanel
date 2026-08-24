'use strict';

/**
 * projectStatisticsController.js
 *
 * Provides aggregated statistics for a given project,
 * such as disk usage, API endpoints count, and linked services state.
 */

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { findProjectById, getProjectMembership } = require('../models/projectModel');
const { query } = require('../config/db');

const execFileAsync = promisify(execFile);

async function canView(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return Boolean(membership);
}

/**
 * Get folder size on Linux
 */
async function getDiskUsage(folderPath) {
  if (process.platform === 'win32') {
    return { error: 'Disk usage not supported on Windows' };
  }
  
  try {
    const { stdout } = await execFileAsync('du', ['-sh', folderPath]);
    const size = stdout.split('\t')[0];
    return { size: size.trim(), path: folderPath };
  } catch (error) {
    return { error: 'Failed to read disk usage' };
  }
}

/**
 * GET /api/projects/:id/statistics
 */
async function getStatistics(req, res, next) {
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

    // 1. Disk Usage
    let diskUsage = { size: 'Unknown' };
    if (project.path) {
      diskUsage = await getDiskUsage(project.path);
    }

    // 2. API Endpoints Count
    const endpointsCount = Array.isArray(project.config?.api?.endpoints) 
      ? project.config.api.endpoints.length 
      : 0;

    // 3. Database Info (if enabled)
    let databaseStats = null;
    if (project.config?.database?.enabled && project.config.database.databaseName) {
      databaseStats = {
        name: project.config.database.databaseName,
        status: 'Enabled'
      };
      // Try to get actual size if it's mariadb and we have privileges
      try {
        const rows = await query(`
          SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS mb
          FROM information_schema.tables
          WHERE table_schema = ?
        `, [project.config.database.databaseName]);
        if (rows && rows.length > 0 && rows[0].mb !== null) {
          databaseStats.sizeMB = rows[0].mb;
        }
      } catch (dbErr) {
        // Silently fail DB size fetch
      }
    }

    // 4. Linked Services
    let servicesCount = 0;
    try {
      const rows = await query('SELECT COUNT(*) AS total FROM project_services WHERE project_id = ?', [projectId]);
      servicesCount = Number(rows[0].total) || 0;
    } catch (e) {}

    return res.json({
      project: project.name,
      statistics: {
        diskUsage,
        endpointsCount,
        database: databaseStats,
        servicesCount
      }
    });

  } catch (error) {
    return next(error);
  }
}

module.exports = { getStatistics };
