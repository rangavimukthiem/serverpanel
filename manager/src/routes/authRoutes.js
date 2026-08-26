const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// All routes are prefixed with /api/auth
router.post('/google', authController.googleLogin);

module.exports = router;
