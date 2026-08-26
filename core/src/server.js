require('dotenv').config();
const express = require('express');
const cors = require('cors');
const tenantResolver = require('./middleware/tenantResolver');

// Import modular business logic routes
const employeeRoutes = require('./routes/employeeRoutes');
const quotationRoutes = require('./routes/quotationRoutes');

const app = express();
app.use(cors());
app.use(express.json());

// Apply the Tenant Resolver middleware globally to all routes
// so that req.db is always available for the specific customer.
app.use(tenantResolver);

// ---------------------------------------------------------
// SaaS Application Routes
// ---------------------------------------------------------

// Core Modules
app.use('/api/employees', employeeRoutes);
app.use('/api/quotations', quotationRoutes);

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    tenant: req.tenant.name,
    database_connected: req.tenant.db_name
  });
});

app.get('/api/demo', async (req, res) => {
  try {
    // We are querying the specific TENANT database, not the master!
    // Using req.db which was dynamically assigned by the middleware.
    
    // As a test, let's just query the current timestamp from the tenant DB.
    const [rows] = await req.db.query('SELECT NOW() as db_time');
    
    res.json({
      message: `Welcome to the SaaS application for ${req.tenant.name}!`,
      db_time: rows[0].db_time
    });
  } catch (error) {
    console.error('Database query failed:', error);
    res.status(500).json({ error: 'Failed to query tenant database' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`EKAFY Core SaaS running on port ${PORT}`);
});
