const express = require('express');
const { listUsers, createManagedUser, changeUserRole, deleteManagedUser } = require('../controllers/userController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', requireAdmin, listUsers);
router.post('/', requireAdmin, createManagedUser);
router.patch('/:id/role', requireAdmin, changeUserRole);
router.delete('/:id', requireAdmin, deleteManagedUser);

module.exports = router;
