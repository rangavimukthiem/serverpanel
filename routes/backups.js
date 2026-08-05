'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/authMiddleware');
const { list, saveRule, runNow, restore } = require('../controllers/backupController');

const router = express.Router();
router.use(requireAdmin);
router.get('/', list);
router.put('/rules/:projectId', saveRule);
router.post('/projects/:projectId/run', runNow);
router.post('/runs/:runId/restore', restore);

module.exports = router;
