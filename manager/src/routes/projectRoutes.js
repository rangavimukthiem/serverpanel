const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

router.get('/', verifyToken, projectController.getAllProjects);
router.post('/deploy', verifyToken, requireAdmin, projectController.deployProject);
router.post('/:id/start', verifyToken, requireAdmin, projectController.startProject);
router.post('/:id/stop', verifyToken, requireAdmin, projectController.stopProject);
router.post('/:id/restart', verifyToken, requireAdmin, projectController.restartProject);
router.delete('/:id', verifyToken, requireAdmin, projectController.deleteProject);

module.exports = router;
