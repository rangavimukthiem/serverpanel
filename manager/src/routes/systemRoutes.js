const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const { verifyToken } = require('../middleware/authMiddleware');

router.get('/stats', verifyToken, systemController.getSystemStats);

module.exports = router;
