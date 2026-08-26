require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

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

// Initialize Database Schema on Boot
async function initDB() {
  try {
    console.log('Connecting to Master Database...');
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
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`EKAFY Server Manager running on port ${PORT}`);
  });
});
