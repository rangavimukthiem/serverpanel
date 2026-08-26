const mysql = require('mysql2/promise');

// 1. Connection Pool for the Master Database
const masterPool = mysql.createPool({
  host: process.env.MASTER_DB_HOST || 'mariadb',
  port: process.env.MASTER_DB_PORT || 3306,
  user: process.env.MASTER_DB_USER || 'root',
  password: process.env.MASTER_DB_PASSWORD,
  database: 'ekafy_master',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 2. Cache of Tenant Database Pools
// To prevent creating a new connection pool on every single request, we cache them in memory.
const tenantPools = new Map();

/**
 * Get or create a connection pool for a specific tenant database.
 * @param {string} tenantDbName 
 */
async function getTenantPool(tenantDbName) {
  if (tenantPools.has(tenantDbName)) {
    return tenantPools.get(tenantDbName);
  }

  console.log(`[DB] Creating new connection pool for tenant database: ${tenantDbName}`);
  const pool = mysql.createPool({
    host: process.env.MASTER_DB_HOST || 'mariadb',
    port: process.env.MASTER_DB_PORT || 3306,
    user: process.env.MASTER_DB_USER || 'root',
    password: process.env.MASTER_DB_PASSWORD,
    database: tenantDbName,
    waitForConnections: true,
    connectionLimit: 5, // Lower limit per tenant to avoid exhausting global connections
    queueLimit: 0
  });

  tenantPools.set(tenantDbName, pool);
  return pool;
}

module.exports = {
  masterPool,
  getTenantPool
};
