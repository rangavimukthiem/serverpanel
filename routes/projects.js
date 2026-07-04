const express = require('express');
const {
  listProjects,
  createManagedProject,
  setProjectMember,
  deleteProjectMember
} = require('../controllers/projectController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', listProjects);
router.post('/', requireAdmin, createManagedProject);
router.put('/:id/members', setProjectMember);
router.delete('/:id/members/:userId', deleteProjectMember);

module.exports = router;
