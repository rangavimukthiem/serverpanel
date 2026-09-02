const os = require('os');
const mysql = require('mysql2/promise');
const http = require('http');

const getMasterConnection = async () => {
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'mariadb',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'ekafy_admin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ekafy_master'
  });
};

exports.getSystemStats = async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePct = Math.round((usedMem / totalMem) * 100);

    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const uptimeSec = os.uptime();

    // Check Master DB stats
    let tenantCount = 0;
    let projectCount = 0;
    let userCount = 0;
    let dbStatus = 'healthy';

    try {
      const conn = await getMasterConnection();
      const [tenants] = await conn.query('SELECT COUNT(*) as c FROM tenants');
      const [projects] = await conn.query('SELECT COUNT(*) as c FROM projects');
      const [users] = await conn.query('SELECT COUNT(*) as c FROM users');
      tenantCount = tenants[0].c;
      projectCount = projects[0].c;
      userCount = users[0].c;
      await conn.end();
    } catch (dbErr) {
      dbStatus = 'degraded';
    }

    res.json({
      success: true,
      data: {
        server: {
          hostname: os.hostname(),
          platform: `${os.type()} ${os.release()} (${os.arch()})`,
          uptime: uptimeSec,
          nodeVersion: process.version
        },
        metrics: {
          cpuCount: cpus.length,
          cpuModel: cpus[0] ? cpus[0].model : 'Virtual CPU',
          loadAverage: loadAvg,
          memory: {
            totalBytes: totalMem,
            usedBytes: usedMem,
            freeBytes: freeMem,
            usagePercentage: memUsagePct
          }
        },
        cluster: {
          database: dbStatus,
          tenants: tenantCount,
          projects: projectCount,
          users: userCount,
          managerDomain: process.env.MANAGER_DOMAIN || 'dashboard.ekafy.com',
          coreDomain: process.env.CORE_DOMAIN || 'ekafy.com',
          webminDomain: process.env.WEBMIN_DOMAIN || 'panel.ekafy.com',
          sslEmail: process.env.SSL_EMAIL || 'admin@ekafy.com'
        }
      }
    });
  } catch (error) {
    console.error('System stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch system stats' });
  }
};
