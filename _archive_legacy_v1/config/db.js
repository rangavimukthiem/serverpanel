const mariadb = require('mariadb');
const fs = require('fs');

function createPoolFromEnv({
  host,
  port,
  user,
  password,
  database,
  socketPath
}) {
  const options = {
    host: host || '127.0.0.1',
    port: Number(port || 3306),
    user: user || 'root',
    password: password || '',
    database: database || 'ekafy',
    connectionLimit: 5,
    acquireTimeout: 5000
  };

  if (socketPath) {
    options.socketPath = socketPath;
  }

  return mariadb.createPool(options);
}

const pool = createPoolFromEnv({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ekafy',
  port: process.env.DB_PORT || 3306
});

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function socketExists(socketPath) {
  if (!socketPath || process.platform === 'win32') return false;

  try {
    return fs.existsSync(socketPath);
  } catch (_error) {
    return false;
  }
}

function addCandidate(candidates, seen, candidate) {
  const key = candidate.socketPath
    ? `socket:${candidate.socketPath}:${candidate.user}:${candidate.database}`
    : `tcp:${candidate.host}:${candidate.port}:${candidate.user}:${candidate.database}`;

  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

function addSocketCandidate(candidates, seen, socketPath, user, password, database) {
  if (!socketExists(socketPath)) return;

  addCandidate(candidates, seen, {
    socketPath,
    user,
    password,
    database
  });
}

function getAdminConnectionCandidates() {
  const candidates = [];
  const seen = new Set();
  const adminHost = process.env.DB_ADMIN_HOST || process.env.DB_HOST || '127.0.0.1';
  const adminPort = process.env.DB_ADMIN_PORT || process.env.DB_PORT || 3306;
  const adminDatabase = process.env.DB_ADMIN_NAME || process.env.DB_NAME || 'ekafy';
  const adminUser = process.env.DB_ADMIN_USER || 'root';
  const adminPassword = process.env.DB_ADMIN_PASSWORD || '';
  const adminSocket = process.env.DB_ADMIN_SOCKET || process.env.MARIADB_SOCKET || '';
  const explicitAdmin =
    process.env.DB_ADMIN_USER ||
    process.env.DB_ADMIN_PASSWORD ||
    process.env.DB_ADMIN_HOST ||
    process.env.DB_ADMIN_PORT ||
    process.env.DB_ADMIN_NAME ||
    process.env.DB_ADMIN_SOCKET;

  if (explicitAdmin) {
    addSocketCandidate(candidates, seen, adminSocket, adminUser, adminPassword, adminDatabase);
    addCandidate(candidates, seen, {
      host: adminHost,
      port: Number(adminPort),
      user: adminUser,
      password: adminPassword,
      database: adminDatabase
    });
  } else {
    if (hasValue(process.env.DB_USER)) {
      addCandidate(candidates, seen, {
        host: adminHost,
        port: Number(adminPort),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD || '',
        database: adminDatabase
      });
    }

    addCandidate(candidates, seen, {
      host: adminHost,
      port: Number(adminPort),
      user: 'root',
      password: '',
      database: adminDatabase
    });

    if (process.platform !== 'win32') {
      const socketCandidates = [
        process.env.DB_ADMIN_SOCKET,
        process.env.MARIADB_SOCKET,
        '/tmp/mysql.sock',
        '/var/run/mysql/mysql.sock',
        '/var/run/mysqld/mysqld.sock',
        '/run/mysqld/mysqld.sock',
        '/var/run/mariadb/mariadb.sock',
        '/run/mariadb/mariadb.sock',
        '/var/lib/mysql/mysql.sock',
        '/usr/local/var/mysql/mysql.sock'
      ].filter(Boolean);

      for (const socketPath of socketCandidates) {
        addSocketCandidate(candidates, seen, socketPath, 'root', '', adminDatabase);
      }
    }
  }

  return candidates;
}

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
  let lastError;

  for (const candidate of getAdminConnectionCandidates()) {
    let connection;

    try {
      connection = await mariadb.createConnection(candidate);
      const result = await connection.query(sql, params);
      return result;
    } catch (error) {
      lastError = error;
    } finally {
      if (connection) {
        await connection.end().catch(() => {});
      }
    }
  }

  throw lastError;
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
