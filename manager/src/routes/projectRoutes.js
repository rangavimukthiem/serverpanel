const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

router.get('/', verifyToken, projectController.getAllProjects);
router.post('/deploy', verifyToken, requireAdmin, projectController.deployProject);

module.exports = router;
