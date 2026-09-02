const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const mysql = require('mysql2/promise');

const getMasterConnection = async () => {
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'mariadb',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'ekafy_admin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ekafy_master'
  });
};

const getAdminConnection = async (targetDb = 'ekafy_master') => {
  const isRoot = Boolean(process.env.DB_ROOT_PASSWORD);
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'mariadb',
    port: process.env.DB_PORT || 3306,
    user: isRoot ? 'root' : (process.env.DB_USER || 'ekafy_admin'),
    password: isRoot ? process.env.DB_ROOT_PASSWORD : process.env.DB_PASSWORD,
    database: targetDb,
    multipleStatements: true
  });
};

/**
 * List all projects with active routing and metadata
 */
exports.getAllProjects = async (req, res) => {
  try {
    const conn = await getMasterConnection();
    const [projects] = await conn.query('SELECT * FROM projects ORDER BY created_at DESC');
    await conn.end();

    res.json({ success: true, data: projects });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch projects' });
  }
};

/**
 * Automatically detects the application entrypoint from package.json and project files
 */
function detectNodeEntrypoint(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.start) {
        return 'CMD ["npm", "start"]';
      }
      if (pkg.main && fs.existsSync(path.join(projectDir, pkg.main))) {
        return `CMD ["node", "${pkg.main}"]`;
      }
    } catch (_) {}
  }

  // Scan file system in priority order
  const candidates = [
    'server.js',
    'app.js',
    'index.js',
    'main.js',
    'src/server.js',
    'src/app.js',
    'src/index.js',
    'dist/server.js',
    'dist/index.js'
  ];

  for (const file of candidates) {
    if (fs.existsSync(path.join(projectDir, file))) {
      return `CMD ["node", "${file}"]`;
    }
  }

  return 'CMD ["npm", "start"]';
}

/**
 * Automated Project Creation, Git Cloner, Container Builder & Traefik Deployer
 */
exports.deployProject = async (req, res) => {
  let conn;
  try {
    const { 
      name, 
      slug, 
      domain, 
      git_repo_url, 
      git_branch = 'main',
      runtime_type = 'node_express',
      port = 3000,
      create_database = true,
      env_vars = ''
    } = req.body;

    if (!name || !slug || !domain) {
      return res.status(400).json({ success: false, error: 'Project name, slug, and domain are required' });
    }

    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const cleanDomain = domain.toLowerCase().trim();
    const appPort = parseInt(port, 10) || 3000;
    const dbName = `db_tenant_${cleanSlug.replace(/-/g, '_')}`;
    const projectDir = path.join('/app', 'projects', cleanSlug);
    const dynamicDir = path.join('/app', 'dynamic');

    // 1. Provision Dedicated Database if requested
    if (create_database) {
      const adminConn = await getAdminConnection('ekafy_master');
      try {
        await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        await adminConn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${process.env.DB_USER || 'ekafy_admin'}'@'%'`);
        await adminConn.query('FLUSH PRIVILEGES');

        // Provision blueprint tables
        const tenantConn = await getAdminConnection(dbName);
        const blueprintSql = `
          CREATE TABLE IF NOT EXISTS employees (
            id INT AUTO_INCREMENT PRIMARY KEY,
            first_name VARCHAR(100) NOT NULL,
            last_name VARCHAR(100) NOT NULL,
            email VARCHAR(320) UNIQUE,
            role VARCHAR(100) DEFAULT 'Employee',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS quotations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            client_name VARCHAR(150) NOT NULL,
            total_amount DECIMAL(12,2) DEFAULT 0.00,
            status VARCHAR(50) DEFAULT 'Draft',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `;
        await tenantConn.query(blueprintSql);
        await tenantConn.end();
      } catch (dbErr) {
        console.warn(`Database creation note for ${dbName}:`, dbErr.message);
      } finally {
        await adminConn.end();
      }
    }

    // 2. Clone or Update Git Repository
    if (!fs.existsSync('/app/projects')) {
      fs.mkdirSync('/app/projects', { recursive: true });
    }

    if (git_repo_url) {
      if (!fs.existsSync(projectDir)) {
        console.log(`Cloning repository ${git_repo_url} into ${projectDir}...`);
        await execPromise(`git clone -b ${git_branch} ${git_repo_url} ${projectDir}`);
      } else {
        console.log(`Updating existing repository in ${projectDir}...`);
        try {
          await execPromise(`cd ${projectDir} && git pull origin ${git_branch}`);
        } catch (_) {}
      }
    } else {
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }
    }

    // 3. Smart Entrypoint Detection & Dockerfile Generation
    const dockerfilePath = path.join(projectDir, 'Dockerfile');
    if (runtime_type === 'static') {
      const staticDockerfile = `
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`.trim();
      fs.writeFileSync(dockerfilePath, staticDockerfile);
    } else {
      const detectedCmd = detectNodeEntrypoint(projectDir);
      console.log(`[Auto-Detector] Detected entrypoint for ${cleanSlug}: ${detectedCmd}`);

      const nodeDockerfile = `
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE ${appPort}
${detectedCmd}
`.trim();
      fs.writeFileSync(dockerfilePath, nodeDockerfile);
    }

    // 4. Write Application .env File
    const appEnvPath = path.join(projectDir, '.env');
    const autoEnv = `
PORT=${appPort}
NODE_ENV=production
DB_HOST=mariadb
DB_PORT=3306
DB_USER=${process.env.DB_USER || 'ekafy_admin'}
DB_PASSWORD=${process.env.DB_PASSWORD || ''}
DB_NAME=${dbName}
MYSQL_HOST=mariadb
MYSQL_PORT=3306
MYSQL_USER=${process.env.DB_USER || 'ekafy_admin'}
MYSQL_PASSWORD=${process.env.DB_PASSWORD || ''}
MYSQL_DATABASE=${dbName}
DATABASE_HOST=mariadb
DATABASE_NAME=${dbName}
REDIS_HOST=redis
${env_vars}
`.trim();
    fs.writeFileSync(appEnvPath, autoEnv);

    // 5. Generate Dynamic Traefik Routing Configuration
    if (!fs.existsSync(dynamicDir)) {
      fs.mkdirSync(dynamicDir, { recursive: true });
    }

    const containerName = `ekafy-project-${cleanSlug}`;
    const dynamicConfigPath = path.join(dynamicDir, `project_${cleanSlug}.yml`);
    const dynamicYaml = `
http:
  routers:
    project-${cleanSlug}:
      rule: "Host(\`${cleanDomain}\`) || Host(\`www.${cleanDomain}\`)"
      entryPoints:
        - websecure
      tls:
        certResolver: myresolver
      priority: 100
      service: project-${cleanSlug}-svc
  services:
    project-${cleanSlug}-svc:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${appPort}"
`.trim();
    fs.writeFileSync(dynamicConfigPath, dynamicYaml);

    // 6. Build and Launch Container via Docker CLI on ekafy-net with Environment Variables
    try {
      console.log(`Building container ${containerName}...`);
      await execPromise(`docker build -t ${containerName}:latest ${projectDir}`);
      // Remove any existing container with same name
      await execPromise(`docker rm -f ${containerName} || true`);
      // Run container on ekafy-net with loaded environment file
      await execPromise(`docker run -d --name ${containerName} --restart unless-stopped --network ekafy-net --env-file ${appEnvPath} ${containerName}:latest`);
      console.log(`Container ${containerName} started successfully.`);
    } catch (dockerErr) {
      console.warn(`Docker launch note: ${dockerErr.message}`);
    }

    // 7. Save / Update Record in Master Database
    conn = await getMasterConnection();
    await conn.query(
      `INSERT INTO projects (name, slug, domain, project_type, git_repo_url, port, db_name, status, assigned_admin_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 'deployed', ?)
       ON DUPLICATE KEY UPDATE domain = VALUES(domain), git_repo_url = VALUES(git_repo_url), status = 'deployed'`,
      [name, cleanSlug, cleanDomain, runtime_type, git_repo_url || cleanDomain, appPort, create_database ? dbName : null, req.user ? req.user.id : null]
    );

    res.status(201).json({
      success: true,
      message: `Project "${name}" deployed successfully!`,
      data: {
        name,
        slug: cleanSlug,
        domain: cleanDomain,
        url: `https://${cleanDomain}`,
        container: containerName,
        database: create_database ? dbName : null,
        port: appPort
      }
    });

  } catch (error) {
    console.error('Error deploying project:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to deploy project' });
  } finally {
    if (conn) await conn.end();
  }
};

/**
 * Start a Project Container (Bring UP)
 */
exports.startProject = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT * FROM projects WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Project not found' });

    const project = rows[0];
    const cleanSlug = project.slug || project.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const containerName = `ekafy-project-${cleanSlug}`;
    const dynamicDir = path.join('/app', 'dynamic');
    const dynamicConfigPath = path.join(dynamicDir, `project_${cleanSlug}.yml`);

    // Restore Traefik routing configuration if missing
    if (project.domain && !fs.existsSync(dynamicConfigPath)) {
      const dynamicYaml = `
http:
  routers:
    project-${cleanSlug}:
      rule: "Host(\`${project.domain}\`) || Host(\`www.${project.domain}\`)"
      entryPoints:
        - websecure
      tls:
        certResolver: myresolver
      priority: 100
      service: project-${cleanSlug}-svc
  services:
    project-${cleanSlug}-svc:
      loadBalancer:
        servers:
          - url: "http://${containerName}:${project.port || 3000}"
`.trim();
      fs.writeFileSync(dynamicConfigPath, dynamicYaml);
    }

    await execPromise(`docker start ${containerName}`);
    await conn.query('UPDATE projects SET status = "deployed" WHERE id = ?', [id]);

    res.json({ success: true, message: `Project ${project.name} started successfully!` });
  } catch (error) {
    console.error('Error starting project:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to start project container' });
  } finally {
    if (conn) await conn.end();
  }
};

/**
 * Stop a Project Container (Bring DOWN)
 */
exports.stopProject = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT * FROM projects WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Project not found' });

    const project = rows[0];
    const cleanSlug = project.slug || project.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const containerName = `ekafy-project-${cleanSlug}`;
    const dynamicConfigPath = path.join('/app', 'dynamic', `project_${cleanSlug}.yml`);

    // Stop container
    await execPromise(`docker stop ${containerName} || true`);

    // Temporarily remove Traefik route so it doesn't 502
    if (fs.existsSync(dynamicConfigPath)) {
      fs.unlinkSync(dynamicConfigPath);
    }

    await conn.query('UPDATE projects SET status = "stopped" WHERE id = ?', [id]);

    res.json({ success: true, message: `Project ${project.name} stopped successfully!` });
  } catch (error) {
    console.error('Error stopping project:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to stop project container' });
  } finally {
    if (conn) await conn.end();
  }
};

/**
 * Restart a Project Container
 */
exports.restartProject = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT * FROM projects WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Project not found' });

    const project = rows[0];
    const cleanSlug = project.slug || project.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const containerName = `ekafy-project-${cleanSlug}`;

    await execPromise(`docker restart ${containerName}`);
    await conn.query('UPDATE projects SET status = "deployed" WHERE id = ?', [id]);

    res.json({ success: true, message: `Project ${project.name} restarted successfully!` });
  } catch (error) {
    console.error('Error restarting project:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to restart project container' });
  } finally {
    if (conn) await conn.end();
  }
};

/**
 * Delete a Project (Stops container, removes routing, drops DB & files)
 */
exports.deleteProject = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { drop_db = 'true', delete_files = 'false' } = req.query;

    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT * FROM projects WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Project not found' });

    const project = rows[0];
    const cleanSlug = project.slug || project.name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const containerName = `ekafy-project-${cleanSlug}`;
    const dynamicConfigPath = path.join('/app', 'dynamic', `project_${cleanSlug}.yml`);
    const projectDir = path.join('/app', 'projects', cleanSlug);

    // 1. Remove Docker container
    try {
      await execPromise(`docker rm -f ${containerName} || true`);
    } catch (_) {}

    // 2. Remove Traefik dynamic routing file
    if (fs.existsSync(dynamicConfigPath)) {
      try { fs.unlinkSync(dynamicConfigPath); } catch (_) {}
    }

    // 3. Drop dedicated database if requested
    if (drop_db === 'true' && project.db_name) {
      const adminConn = await getAdminConnection('ekafy_master');
      try {
        await adminConn.query(`DROP DATABASE IF EXISTS \`${project.db_name}\``);
      } catch (dbErr) {
        console.warn(`Drop DB note: ${dbErr.message}`);
      } finally {
        await adminConn.end();
      }
    }

    // 4. Delete files if requested
    if (delete_files === 'true' && fs.existsSync(projectDir)) {
      try {
        fs.rmSync(projectDir, { recursive: true, force: true });
      } catch (_) {}
    }

    // 5. Delete record from master database
    await conn.query('DELETE FROM projects WHERE id = ?', [id]);

    res.json({ success: true, message: `Project ${project.name} has been completely deleted!` });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete project' });
  } finally {
    if (conn) await conn.end();
  }
};
