const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/authMiddleware');

router.get('/status', authController.getAuthStatus);
router.post('/google', authController.googleLogin);
router.get('/me', verifyToken, authController.getMe);

module.exports = router;
