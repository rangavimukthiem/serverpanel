const express = require('express');
const { status, updateDashboardFromGit, restartServerManager } = require('../controllers/systemController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/status', status);
router.post('/update', requireAdmin, updateDashboardFromGit);
router.post('/restart', requireAdmin, restartServerManager);

module.exports = router;
