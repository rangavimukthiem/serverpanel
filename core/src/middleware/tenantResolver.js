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

    // 2. Handle Root Domain (e.g. ekafy.com) or localhost without tenant subdomain
    const coreDomain = process.env.CORE_DOMAIN || 'ekafy.com';
    const isRootDomain = host === coreDomain || host === `www.${coreDomain}` || host === 'localhost' || parts.length < 3;

    if (isRootDomain) {
      if (req.path === '/api/health') {
        return res.json({ status: 'ok', service: 'ekafy-core-engine' });
      }
      return res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>EKAFY SaaS Platform</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
            .card { background: #1e293b; padding: 3rem 2rem; border-radius: 1rem; border: 1px solid #334155; max-width: 500px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
            h1 { font-size: 2rem; color: #38bdf8; margin-bottom: 0.75rem; }
            p { color: #94a3b8; font-size: 1rem; line-height: 1.5; margin-bottom: 1.5rem; }
            .badge { display: inline-block; padding: 0.35rem 0.75rem; background: #0369a1; color: #e0f2fe; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>EKAFY SaaS Engine</h1>
            <p>The core multi-tenant cluster is online and active. Access tenant apps via their respective subdomains.</p>
            <span class="badge">● Engine Operational</span>
          </div>
        </body>
        </html>
      `);
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
