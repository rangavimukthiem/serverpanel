const express = require('express');
const { listProjects } = require('../controllers/projectController');

const router = express.Router();

router.get('/', listProjects);

module.exports = router;
