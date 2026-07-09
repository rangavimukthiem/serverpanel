const express = require('express');
const {
  listProjects,
  createManagedProject,
  updateProjectWizardConfig,
  getProjectWizard,
  setProjectMember,
  deleteProjectMember
} = require('../controllers/projectController');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', listProjects);
router.post('/', requireAdmin, createManagedProject);
router.get('/:id/wizard', getProjectWizard);
router.patch('/:id/config', updateProjectWizardConfig);
router.put('/:id/members', setProjectMember);
router.delete('/:id/members/:userId', deleteProjectMember);

module.exports = router;
