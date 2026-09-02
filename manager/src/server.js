require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const tenantRoutes = require('./routes/tenantRoutes');
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { verifyToken, requireAdmin } = require('./middleware/authMiddleware');

// Database Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mariadb',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'ekafy_admin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'ekafy_master',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Basic Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'ekafy-manager' });
});

// Root Manager Welcome / Status Interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>EKAFY Server Manager</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
        .card { background: #111827; padding: 3rem 2.5rem; border-radius: 1rem; border: 1px solid #1f2937; max-width: 540px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.6); }
        h1 { font-size: 2rem; color: #60a5fa; margin-bottom: 0.5rem; }
        p { color: #9ca3af; font-size: 0.95rem; line-height: 1.6; margin-bottom: 1.5rem; }
        .badge { display: inline-block; padding: 0.35rem 0.85rem; background: #1e3a8a; color: #93c5fd; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; margin-bottom: 1.5rem; }
        .endpoints { background: #030712; border-radius: 0.5rem; padding: 1rem; text-align: left; font-family: monospace; font-size: 0.85rem; color: #34d399; }
        .endpoints div { margin: 0.25rem 0; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>EKAFY Server Manager</h1>
        <p>Admin Control Plane and API Gateway are active and secure.</p>
        <span class="badge">● Server Manager Online</span>
        <div class="endpoints">
          <div>POST /api/auth/login</div>
          <div>POST /api/auth/register</div>
          <div>GET  /api/health</div>
          <div>GET  /api/tenants</div>
          <div>GET  /api/projects</div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Authentication Routes (Public)
app.use('/api/auth', authRoutes);

// Admin Routes (Protected by JWT and Admin Role)
app.use('/api/tenants', verifyToken, requireAdmin, tenantRoutes);
app.use('/api/projects', projectRoutes);

// Client & Admin Routes (Protected by JWT, role checked in controller)
app.use('/api/chat', chatRoutes);

// Initialize Database Schema on Boot with Retry Logic
async function initDB(retries = 15, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Connecting to Master Database (attempt ${attempt}/${retries})...`);
      const connection = await pool.getConnection();
      console.log('Database connected successfully.');

      // In production, you would run migrations. For now, we load the schema file.
      const schemaPath = path.join(__dirname, 'config', 'schema.sql');
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        // Splitting by semicolon is basic; works for simple schemas without triggers/functions
        const statements = sql.split(';').filter(stmt => stmt.trim() !== '');
        for (const stmt of statements) {
          await connection.query(stmt);
        }
        console.log('Master Database schema synchronized.');
      }
      
      connection.release();
      return;
    } catch (err) {
      console.warn(`Database connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) {
        console.error('Max database connection retries reached. Exiting.');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`EKAFY Server Manager running on port ${PORT}`);
  });
});
