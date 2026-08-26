const { masterPool, getTenantPool } = require('../config/db');

/**
 * Tenant Resolver Middleware
 * Extracts the subdomain from the request Host header, looks up the tenant in the 
 * Master Database, and attaches the specific Tenant Database connection pool to `req.db`.
 */
async function tenantResolver(req, res, next) {
  try {
    // 1. Extract hostname (e.g. restaurant-a.ekafy.com)
    const host = req.get('host');
    if (!host) {
      return res.status(400).send('No Host header provided');
    }

    // 2. Extract Subdomain (e.g. 'restaurant-a')
    // We assume the host is always in the format subdomain.domain.tld
    // In local dev, it might be localhost:3000, so handle accordingly.
    const parts = host.split('.');
    
    // Fallback for local testing if hitting localhost directly
    if (parts[0] === 'localhost' || parts.length < 3) {
      req.tenant = { name: 'Local Dev', subdomain: 'localhost', db_name: 'db_tenant_demo' };
      req.db = await getTenantPool('db_tenant_demo');
      return next();
    }

    const subdomain = parts[0];

    // 3. Lookup Tenant in Master Database
    const [rows] = await masterPool.execute(
      'SELECT id, name, subdomain, db_name, plan_type, status FROM tenants WHERE subdomain = ?',
      [subdomain]
    );

    if (rows.length === 0) {
      return res.status(404).send('Tenant not found');
    }

    const tenant = rows[0];

    if (tenant.status !== 'active') {
      return res.status(403).send('This tenant account is suspended or inactive.');
    }

    // 4. Attach Tenant Metadata and Database Pool to Request
    req.tenant = tenant;
    req.db = await getTenantPool(tenant.db_name);

    next();
  } catch (error) {
    console.error('[Tenant Resolver Error]:', error);
    res.status(500).send('Internal Server Error while resolving tenant database.');
  }
}

module.exports = tenantResolver;
