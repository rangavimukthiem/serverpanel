const express = require('express');
const router = express.Router();
const quotationController = require('../controllers/quotationController');

// All routes are prefixed with /api/quotations
router.get('/', quotationController.getAllQuotations);
router.post('/', quotationController.createQuotation);
router.get('/:id', quotationController.getQuotationById);
router.put('/:id/status', quotationController.updateQuotationStatus);

module.exports = router;
