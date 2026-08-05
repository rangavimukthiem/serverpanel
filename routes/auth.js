const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  register, login, me, logout, googleStatus, googleStart, googleCallback
} = require('../controllers/authController');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again later.' }
});

router.post('/register', register);
router.post('/login', loginLimiter, login);
router.get('/google/status', googleStatus);
router.get('/google', loginLimiter, googleStart);
router.get('/google/callback', googleCallback);
router.get('/me', authenticateToken, me);
router.post('/logout', logout);

module.exports = router;
