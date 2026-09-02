const mysql = require('mysql2/promise');

const getDbCredentials = () => {
  return {
    host: process.env.MASTER_DB_HOST || process.env.DB_HOST || 'mariadb',
    port: process.env.MASTER_DB_PORT || process.env.DB_PORT || 3306,
    user: process.env.MASTER_DB_USER || process.env.DB_USER || 'ekafy_admin',
    password: process.env.MASTER_DB_PASSWORD || process.env.DB_PASSWORD || process.env.DB_ADMIN_PASSWORD || process.env.DB_ROOT_PASSWORD
  };
};

// 1. Connection Pool for the Master Database
const masterPool = mysql.createPool({
  ...getDbCredentials(),
  database: process.env.DB_NAME || 'ekafy_master',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 2. Cache of Tenant Database Pools
const tenantPools = new Map();

/**
 * Get or create a connection pool for a specific tenant database.
 * @param {string} tenantDbName 
 */
async function getTenantPool(tenantDbName) {
  if (tenantPools.has(tenantDbName)) {
    return tenantPools.get(tenantDbName);
  }

  console.log(`[DB] Creating connection pool for tenant database: ${tenantDbName}`);
  const pool = mysql.createPool({
    ...getDbCredentials(),
    database: tenantDbName,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });

  tenantPools.set(tenantDbName, pool);
  return pool;
}

module.exports = {
  masterPool,
  getTenantPool
};
