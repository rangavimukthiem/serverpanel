const express = require('express');
const { listUsers, createManagedUser, changeUserRole } = require('../controllers/userController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', requireAdmin, listUsers);
router.post('/', requireAdmin, createManagedUser);
router.patch('/:id/role', requireAdmin, changeUserRole);

module.exports = router;
