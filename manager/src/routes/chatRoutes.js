const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { verifyToken } = require('../middleware/authMiddleware');

// Chat routes are accessible by BOTH Admins and Clients
// The security is handled inside the controller based on req.user.role
router.use(verifyToken);

router.get('/:projectId', chatController.getProjectChat);
router.post('/:projectId', chatController.sendMessage);

module.exports = router;
