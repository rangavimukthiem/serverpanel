require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const systemRoutes = require('./routes/systemRoutes');
const tenantRoutes = require('./routes/tenantRoutes');
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { verifyToken, requireAdmin } = require('./middleware/authMiddleware');

// Serve Static Frontend Dashboard Assets
app.use(express.static(path.join(__dirname, '..', 'public')));

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

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/tenants', verifyToken, requireAdmin, tenantRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/chat', chatRoutes);

// SPA Frontend Routing Fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

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
          try {
            await connection.query(stmt);
          } catch (_) {}
        }
        
        // Ensure users columns exist if table already existed
        try { await connection.query('ALTER TABLE users ADD COLUMN username VARCHAR(100) UNIQUE AFTER id'); } catch (_) {}
        try { await connection.query('ALTER TABLE users ADD COLUMN google_sub VARCHAR(255) UNIQUE AFTER email'); } catch (_) {}
        
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
