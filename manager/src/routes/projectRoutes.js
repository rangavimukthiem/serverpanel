const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const { verifyToken, requireAdmin } = require('../middleware/authMiddleware');

// Projects can only be managed by admins in the Server Manager
router.use(verifyToken, requireAdmin);

router.get('/', projectController.getAllProjects);
router.post('/', projectController.createProject);
router.put('/:id/approve', projectController.approveProject);

module.exports = router;
