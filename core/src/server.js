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

// Customer Tenant Portal Home
app.get('/', async (req, res) => {
  try {
    let employeeCount = 0;
    let quotationCount = 0;

    try {
      const [empRows] = await req.db.query('SELECT COUNT(*) as c FROM employees');
      const [qRows] = await req.db.query('SELECT COUNT(*) as c FROM quotations');
      employeeCount = empRows[0].c;
      quotationCount = qRows[0].c;
    } catch (_) {}

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${req.tenant.name} - Tenant Portal</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Inter', -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
          .card { background: #111827; padding: 3rem 2.5rem; border-radius: 1.25rem; border: 1px solid #1f2937; max-width: 540px; width: 100%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6); text-align: center; }
          .avatar { width: 56px; height: 56px; border-radius: 1rem; background: linear-gradient(135deg, #38bdf8, #818cf8); display: flex; align-items: center; justify-content: center; font-size: 1.5rem; font-weight: 800; color: #fff; margin: 0 auto 1.5rem; }
          h1 { font-size: 1.75rem; font-weight: 800; color: #fff; margin-bottom: 0.5rem; }
          p { color: #9ca3af; font-size: 0.9rem; line-height: 1.5; margin-bottom: 1.75rem; }
          .badge { display: inline-block; padding: 0.35rem 0.85rem; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border-radius: 9999px; font-size: 0.8rem; font-weight: 700; margin-bottom: 2rem; border: 1px solid rgba(56, 189, 248, 0.3); }
          .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
          .stat-box { background: #030712; padding: 1.25rem 1rem; border-radius: 0.75rem; border: 1px solid #1f2937; text-align: left; }
          .stat-label { font-size: 0.75rem; color: #6b7280; font-weight: 600; text-transform: uppercase; margin-bottom: 0.25rem; }
          .stat-val { font-size: 1.25rem; font-weight: 800; color: #fff; }
          .links { display: flex; gap: 0.75rem; justify-content: center; }
          .btn { display: inline-block; padding: 0.65rem 1.25rem; background: #2563eb; color: #fff; border-radius: 0.5rem; text-decoration: none; font-size: 0.85rem; font-weight: 600; }
          .btn-sec { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="avatar">${req.tenant.name.charAt(0).toUpperCase()}</div>
          <h1>${req.tenant.name}</h1>
          <p>Customer SaaS Application Workspace</p>
          <span class="badge">● Plan: ${req.tenant.plan_type.toUpperCase()} | Subdomain: ${req.tenant.subdomain}</span>

          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-label">Employees</div>
              <div class="stat-val">${employeeCount}</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Quotations</div>
              <div class="stat-val">${quotationCount}</div>
            </div>
          </div>

          <div class="links">
            <a href="/api/health" class="btn">Tenant Health</a>
            <a href="/api/employees" class="btn btn-sec">API Employees</a>
            <a href="/api/quotations" class="btn btn-sec">API Quotations</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tenant portal' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    tenant: req.tenant.name,
    subdomain: req.tenant.subdomain,
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
