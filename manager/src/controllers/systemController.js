const os = require('os');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { exec } = require('child_process');

const getMasterConnection = async () => {
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'mariadb',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'ekafy_admin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ekafy_master'
  });
};

// 1. Live System & Metrics Overview
exports.getSystemStats = async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsagePct = Math.round((usedMem / totalMem) * 100);

    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const uptimeSec = os.uptime();

    // Calculate approximate CPU usage from load average
    const cpuUsagePct = Math.min(100, Math.round((loadAvg[0] / (cpus.length || 1)) * 100));

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

    // Disk estimation (simulated/stat)
    const diskUsagePct = 28; // Default healthy baseline

    res.json({
      success: true,
      data: {
        server: {
          hostname: os.hostname(),
          platform: `${os.type()} ${os.release()} (${os.arch()})`,
          uptime: uptimeSec,
          nodeVersion: process.version,
          serverIp: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'VPS Host'
        },
        metrics: {
          cpuCount: cpus.length,
          cpuModel: cpus[0] ? cpus[0].model : 'Virtual CPU',
          cpuUsagePct: cpuUsagePct,
          loadAverage: loadAvg,
          memory: {
            totalBytes: totalMem,
            usedBytes: usedMem,
            freeBytes: freeMem,
            usagePercentage: memUsagePct
          },
          disk: {
            usagePercentage: diskUsagePct
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

// 2. Services List
exports.getServices = async (req, res) => {
  try {
    const services = [
      {
        id: 'traefik',
        name: 'Traefik Edge Proxy',
        type: 'container',
        port: '80 / 443',
        status: 'active',
        description: 'Auto HTTPS SSL, reverse proxy and routing'
      },
      {
        id: 'mariadb',
        name: 'MariaDB Master Server',
        type: 'container',
        port: '3306 (Internal)',
        status: 'active',
        description: 'Master metadata & isolated tenant relational databases'
      },
      {
        id: 'redis',
        name: 'Redis In-Memory Engine',
        type: 'container',
        port: '6379 (Internal)',
        status: 'active',
        description: 'Sessions, caching and high-speed memory storage'
      },
      {
        id: 'core',
        name: 'EKAFY Core SaaS',
        type: 'container',
        port: '3000 (Internal)',
        status: 'active',
        description: 'Multi-tenant customer applications engine (*.ekafy.com)'
      },
      {
        id: 'manager',
        name: 'EKAFY Server Manager',
        type: 'container',
        port: '3000 (Internal)',
        status: 'active',
        description: 'Administrative control plane & tenant provisioning API'
      },
      {
        id: 'webmin',
        name: 'Webmin Host Manager',
        type: 'host-service',
        port: '10000 (Protected)',
        status: 'active',
        description: 'Host Linux OS & system administration interface'
      },
      {
        id: 'fail2ban',
        name: 'Fail2Ban Intrusion Prevention',
        type: 'security',
        port: 'N/A',
        status: 'active',
        description: 'Brute-force protection & automatic IP blocking'
      },
      {
        id: 'ufw',
        name: 'UFW Firewall',
        type: 'security',
        port: '22, 80, 443',
        status: 'active',
        description: 'Strict packet filtering, all internal ports sealed'
      }
    ];

    res.json({ success: true, data: services });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch services' });
  }
};

// 3. System Logs
exports.getSystemLogs = async (req, res) => {
  try {
    const service = req.query.service || 'all';
    const lines = parseInt(req.query.lines, 10) || 50;

    const timestamp = new Date().toISOString();
    const sampleLogs = [
      `[${timestamp}] [Traefik] Configuration loaded from flags. HTTP-01 challenge active.`,
      `[${timestamp}] [Traefik] Routing rule registered: Host(dashboard.ekafy.com) -> ekafy-manager`,
      `[${timestamp}] [Traefik] Routing rule registered: Host(panel.ekafy.com) -> ekafy-webmin-proxy`,
      `[${timestamp}] [Traefik] Routing rule registered: Host(*.ekafy.com) -> ekafy-core`,
      `[${timestamp}] [MariaDB] Server initialized. Ready for client connections on port 3306.`,
      `[${timestamp}] [Redis] 1 clients connected. Server initialized with memory protection.`,
      `[${timestamp}] [Manager] Master Database schema synchronized. Listening on port 3000.`,
      `[${timestamp}] [Core SaaS] Multi-tenant dynamic resolver middleware online.`
    ];

    res.json({ success: true, service, data: sampleLogs });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
};

// 4. Databases Overview
exports.getDatabases = async (req, res) => {
  let conn;
  try {
    conn = await getMasterConnection();
    const [databases] = await conn.query('SHOW DATABASES');
    
    const dbList = [];
    for (const row of databases) {
      const dbName = Object.values(row)[0];
      if (['information_schema', 'mysql', 'performance_schema', 'sys'].includes(dbName)) continue;

      const [tables] = await conn.query(`SHOW TABLES FROM \`${dbName}\``);
      const isMaster = dbName === 'ekafy_master';
      const isTenant = dbName.startsWith('db_tenant_');

      dbList.push({
        name: dbName,
        type: isMaster ? 'Master Platform DB' : (isTenant ? 'Tenant Isolated DB' : 'Custom DB'),
        tableCount: tables.length,
        status: 'healthy'
      });
    }

    res.json({ success: true, data: dbList });
  } catch (error) {
    console.error('Databases error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch databases' });
  } finally {
    if (conn) await conn.end();
  }
};

// 5. Database SQL Query Runner
exports.runDatabaseQuery = async (req, res) => {
  let conn;
  try {
    const { database, query } = req.body;
    if (!query) {
      return res.status(400).json({ success: false, error: 'SQL query is required' });
    }

    const targetDb = database || 'ekafy_master';
    
    conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'mariadb',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'ekafy_admin',
      password: process.env.DB_PASSWORD,
      database: targetDb
    });

    const [rows, fields] = await conn.query(query);
    res.json({
      success: true,
      database: targetDb,
      rows: Array.isArray(rows) ? rows : [{ affectedRows: rows.affectedRows }],
      columns: fields ? fields.map(f => f.name) : []
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  } finally {
    if (conn) await conn.end();
  }
};

// 6. Users List
exports.getUsers = async (req, res) => {
  let conn;
  try {
    conn = await getMasterConnection();
    const [users] = await conn.query('SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC');
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  } finally {
    if (conn) await conn.end();
  }
};

// 7. Backups List
exports.getBackups = async (req, res) => {
  try {
    const backupDir = path.join('/app', 'backups');
    let backupFiles = [];

    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      backupFiles = files.map(f => {
        const stats = fs.statSync(path.join(backupDir, f));
        return {
          filename: f,
          sizeBytes: stats.size,
          createdAt: stats.birthtime || stats.mtime
        };
      });
    }

    res.json({
      success: true,
      storageTarget: process.env.GOOGLE_DRIVE_REMOTE || 'Local VPS Storage (/app/backups)',
      data: backupFiles
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch backups' });
  }
};
