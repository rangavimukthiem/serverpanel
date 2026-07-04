const express = require('express');
const { controlService, serviceStatus } = require('../controllers/serviceController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/:name/status', serviceStatus);
router.post('/:name/:action', requireAdmin, controlService);

module.exports = router;
