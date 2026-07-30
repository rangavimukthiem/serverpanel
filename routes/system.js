const express = require('express');
const { status, updateDashboardFromGit } = require('../controllers/systemController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/status', status);
router.post('/update', requireAdmin, updateDashboardFromGit);

module.exports = router;
