'use strict';

/**
 * routes/projects.js
 *
 * All project-scoped API routes.
 * Base path: /api/projects  (mounted in server.js with authenticateToken applied)
 */

const express = require('express');

const {
  listProjects,
  createManagedProject,
  updateProjectWizardConfig,
  getProjectWizard,
  setProjectMember,
  deleteProjectMember
} = require('../controllers/projectController');

const { scaffold, generateNginx, provisionSsl } = require('../controllers/projectSetupController');
const { provision, listTables, runQuery, getPresets } = require('../controllers/projectDatabaseController');
const { status: gitStatus, init: gitInit, clone: gitClone, pull: gitPull, push: gitPush } = require('../controllers/projectGitController');
const { list: listEndpoints, add: addEndpoint, update: updateEndpoint, remove: removeEndpoint } = require('../controllers/projectEndpointController');
const { list: listEnvKeys, upsert: upsertEnv, remove: removeEnv } = require('../controllers/projectEnvController');
const {
  listLinkedServices,
  addLinkedService,
  removeLinkedService,
  controlLinkedService,
  linkedServiceStatus
} = require('../controllers/serviceController');

const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// ── Core project CRUD ────────────────────────────────────────────────────────
router.get('/',    listProjects);
router.post('/',   requireAdmin, createManagedProject);

// ── Wizard config ────────────────────────────────────────────────────────────
router.get('/:id/wizard',  getProjectWizard);
router.patch('/:id/config', updateProjectWizardConfig);

// ── Members ───────────────────────────────────────────────────────────────────
router.put('/:id/members',            setProjectMember);
router.delete('/:id/members/:userId', deleteProjectMember);

// ── Setup (scaffold / nginx / ssl) ───────────────────────────────────────────
router.post('/:id/setup/scaffold', scaffold);
router.post('/:id/setup/nginx',    generateNginx);
router.post('/:id/setup/ssl',      provisionSsl);

// ── Database wizard ───────────────────────────────────────────────────────────
router.post('/:id/database/provision', provision);
router.get('/:id/database/tables',     listTables);
router.post('/:id/database/query',     runQuery);
router.get('/:id/database/presets',    getPresets);

// ── Git operations ────────────────────────────────────────────────────────────
router.get('/:id/git/status',  gitStatus);
router.post('/:id/git/init',   gitInit);
router.post('/:id/git/clone',  gitClone);
router.post('/:id/git/pull',   gitPull);
router.post('/:id/git/push',   gitPush);

// ── API endpoint management ───────────────────────────────────────────────────
router.get('/:id/endpoints',         listEndpoints);
router.post('/:id/endpoints',        addEndpoint);
router.put('/:id/endpoints/:idx',    updateEndpoint);
router.delete('/:id/endpoints/:idx', removeEndpoint);

// ── Per-project environment variables ─────────────────────────────────────────
router.get('/:id/env',        listEnvKeys);
router.put('/:id/env',        upsertEnv);
router.delete('/:id/env/:key', removeEnv);

// ── Project-linked systemd services ──────────────────────────────────────────
router.get('/:id/services',                    listLinkedServices);
router.post('/:id/services',                   requireAdmin, addLinkedService);
router.delete('/:id/services/:name',           requireAdmin, removeLinkedService);
router.get('/:id/services/:name/status',       linkedServiceStatus);
router.post('/:id/services/:name/:action',     controlLinkedService);

module.exports = router;
