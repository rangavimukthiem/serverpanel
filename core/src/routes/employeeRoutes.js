const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');

// All routes are prefixed with /api/employees
router.get('/', employeeController.getAllEmployees);
router.post('/', employeeController.createEmployee);
router.put('/:id', employeeController.updateEmployee);
router.delete('/:id', employeeController.deleteEmployee);

module.exports = router;
