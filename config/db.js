const mariadb = require('mariadb');

const pool = mariadb.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ekafy',
  connectionLimit: 5,
  acquireTimeout: 5000
});

async function query(sql, params = []) {
  let connection;

  try {
    connection = await pool.getConnection();
    return await connection.query(sql, params);
  } finally {
    if (connection) connection.release();
  }
}

async function testConnection() {
  try {
    await query('SELECT 1 AS ok');
    console.log('MariaDB connection ready');
  } catch (error) {
    console.warn('MariaDB connection failed:', error.message);
    console.warn('Start MariaDB and update .env before using auth/database features.');
  }
}

module.exports = {
  pool,
  query,
  testConnection
};
