const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');

// All routes are prefixed with /api/tenants
router.get('/', tenantController.getAllTenants);
router.post('/', tenantController.provisionTenant);
router.put('/:id/status', tenantController.updateTenantStatus);

module.exports = router;
