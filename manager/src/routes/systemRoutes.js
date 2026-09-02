const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

router.get('/stats', verifyToken, systemController.getSystemStats);
router.get('/services', verifyToken, systemController.getServices);
router.get('/logs', verifyToken, systemController.getSystemLogs);
router.get('/databases', verifyToken, requireAdmin, systemController.getDatabases);
router.post('/databases/query', verifyToken, requireAdmin, systemController.runDatabaseQuery);
router.get('/users', verifyToken, requireAdmin, systemController.getUsers);
router.get('/backups', verifyToken, requireAdmin, systemController.getBackups);

module.exports = router;
