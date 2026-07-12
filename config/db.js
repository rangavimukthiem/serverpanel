const mariadb = require('mariadb');

function createPoolFromEnv({
  host,
  port,
  user,
  password,
  database
}) {
  return mariadb.createPool({
    host: host || '127.0.0.1',
    port: Number(port || 3306),
    user: user || 'root',
    password: password || '',
    database: database || 'ekafy',
    connectionLimit: 5,
    acquireTimeout: 5000
  });
}

const pool = createPoolFromEnv({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ekafy',
  port: process.env.DB_PORT || 3306
});

const adminPool = createPoolFromEnv({
  host: process.env.DB_ADMIN_HOST || process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_ADMIN_PORT || process.env.DB_PORT || 3306,
  user: process.env.DB_ADMIN_USER || process.env.DB_USER || 'root',
  password: process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.DB_ADMIN_NAME || process.env.DB_NAME || 'ekafy'
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

async function adminQuery(sql, params = []) {
  let connection;

  try {
    connection = await adminPool.getConnection();
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
  adminQuery,
  testConnection
};
