'use strict';

/**
 * routes/services.js
 *
 * Global (non-project) systemd service routes.
 * Base path: /api/services  (mounted in server.js with authenticateToken applied)
 *
 * Project-linked service routes live in routes/projects.js under /:id/services/*
 */

const express = require('express');
const { listServices, serviceStatus, controlService } = require('../controllers/serviceController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// List all globally whitelisted services with their active status
router.get('/', listServices);

// Status and control for a single global service
router.get('/:name/status',  serviceStatus);
router.post('/:name/:action', requireAdmin, controlService);

module.exports = router;
