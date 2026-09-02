const { masterPool, getTenantPool } = require('../config/db');

/**
 * Tenant Resolver Middleware
 * Extracts the subdomain from the request Host header, looks up the tenant in the 
 * Master Database, and attaches the specific Tenant Database connection pool to `req.db`.
 */
async function tenantResolver(req, res, next) {
  try {
    // 1. Extract hostname (e.g. annexlk.ekafy.com or ekafyweb.ekafy.com)
    const rawHost = req.get('host');
    if (!rawHost) {
      return res.status(400).send('No Host header provided');
    }

    const host = rawHost.split(':')[0].toLowerCase();
    const coreDomain = (process.env.CORE_DOMAIN || 'ekafy.com').toLowerCase();

    // 2. Identify Subdomain vs Root Domain
    let subdomain = null;
    if (host.endsWith('.' + coreDomain)) {
      subdomain = host.slice(0, -(coreDomain.length + 1));
      if (subdomain === 'www' || subdomain === '') {
        subdomain = null;
      }
    } else if (host !== coreDomain && host !== 'localhost') {
      // Fallback for custom domains or localhost testing (e.g. annexlk.localhost)
      const parts = host.split('.');
      if (parts.length > 1 && parts[0] !== 'www') {
        subdomain = parts[0];
      }
    }

    // 3. Handle Root Domain (ekafy.com)
    if (!subdomain) {
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

    // 4. Lookup Tenant in Master Database
    const [rows] = await masterPool.execute(
      'SELECT id, name, subdomain, db_name, plan_type, status FROM tenants WHERE subdomain = ?',
      [subdomain]
    );

    if (rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Tenant Not Found - EKAFY</title>
          <style>
            body { font-family: sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
            .card { background: #111827; padding: 2.5rem; border-radius: 1rem; border: 1px solid #1f2937; max-width: 440px; }
            h1 { color: #f87171; font-size: 1.5rem; margin-bottom: 0.5rem; }
            p { color: #9ca3af; font-size: 0.9rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Organization Not Found</h1>
            <p>Subdomain "<strong>${subdomain}</strong>" is not registered on EKAFY SaaS.</p>
          </div>
        </body>
        </html>
      `);
    }

    const tenant = rows[0];

    if (tenant.status !== 'active') {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Tenant Suspended - EKAFY</title>
          <style>
            body { font-family: sans-serif; background: #0b0f19; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
            .card { background: #111827; padding: 2.5rem; border-radius: 1rem; border: 1px solid #1f2937; max-width: 440px; }
            h1 { color: #fbbf24; font-size: 1.5rem; margin-bottom: 0.5rem; }
            p { color: #9ca3af; font-size: 0.9rem; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Tenant Inactive</h1>
            <p>This tenant account (${tenant.name}) is currently suspended or inactive.</p>
          </div>
        </body>
        </html>
      `);
    }

    // 5. Attach Tenant Metadata and Database Pool to Request
    req.tenant = tenant;
    req.db = await getTenantPool(tenant.db_name);

    next();
  } catch (error) {
    console.error('[Tenant Resolver Error]:', error);
    res.status(500).send(`Internal Server Error while resolving tenant database: ${error.message}`);
  }
}

module.exports = tenantResolver;
