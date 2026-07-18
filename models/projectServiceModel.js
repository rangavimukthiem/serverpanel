'use strict';

/**
 * projectServiceModel.js
 *
 * Links named systemd services to projects. A project can own multiple services
 * (e.g. "my-app", "my-app-worker"). Each linked service is controllable via
 * the project-scoped service API endpoints.
 */

const { query } = require('../config/db');

/**
 * Register a systemd service name under a project.
 * @param {{ projectId: number, serviceName: string, label: string }}
 */
async function addProjectService({ projectId, serviceName, label }) {
  await query(
    `INSERT INTO project_services (project_id, service_name, label)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE label = VALUES(label)`,
    [projectId, serviceName, label]
  );
}

/**
 * Unlink a service from a project.
 * @param {{ projectId: number, serviceName: string }}
 * @returns {boolean}
 */
async function removeProjectService({ projectId, serviceName }) {
  const result = await query(
    'DELETE FROM project_services WHERE project_id = ? AND service_name = ?',
    [projectId, serviceName]
  );
  return Number(result.affectedRows || 0) > 0;
}

/**
 * List all services linked to a project.
 * @param {number} projectId
 * @returns {{ id: number, service_name: string, label: string, created_at: Date }[]}
 */
async function listProjectServices(projectId) {
  const rows = await query(
    'SELECT id, service_name, label, created_at FROM project_services WHERE project_id = ? ORDER BY service_name ASC',
    [projectId]
  );
  return rows;
}

/**
 * List every project-linked service with its owning project.
 * Used by the top-level Services page to show EKAFY-managed units separately.
 */
async function listAllProjectServices() {
  return query(`
    SELECT
      ps.id, ps.project_id, ps.service_name, ps.label, ps.created_at,
      p.name AS project_name, p.slug AS project_slug, p.status AS project_status
    FROM project_services ps
    INNER JOIN projects p ON p.id = ps.project_id
    ORDER BY p.name ASC, ps.service_name ASC
  `);
}

/**
 * Find a project-linked service by its systemd unit name.
 * @param {string} serviceName
 */
async function findProjectServiceByName(serviceName) {
  const rows = await query(`
    SELECT
      ps.id, ps.project_id, ps.service_name, ps.label, ps.created_at,
      p.name AS project_name, p.slug AS project_slug, p.status AS project_status
    FROM project_services ps
    INNER JOIN projects p ON p.id = ps.project_id
    WHERE ps.service_name = ?
    LIMIT 1
  `, [serviceName]);

  return rows[0] || null;
}

/**
 * Check whether a service name is linked to a specific project.
 * Used to validate service control requests.
 * @param {number} projectId
 * @param {string} serviceName
 * @returns {boolean}
 */
async function isServiceLinkedToProject(projectId, serviceName) {
  const rows = await query(
    'SELECT 1 FROM project_services WHERE project_id = ? AND service_name = ? LIMIT 1',
    [projectId, serviceName]
  );
  return rows.length > 0;
}

module.exports = {
  addProjectService,
  removeProjectService,
  listProjectServices,
  listAllProjectServices,
  findProjectServiceByName,
  isServiceLinkedToProject
};
