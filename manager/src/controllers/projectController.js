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

    // 3. Ensure a Dockerfile exists and uses npm start
    const dockerfilePath = path.join(projectDir, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
      let defaultDockerfile = `
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE ${appPort}
CMD ["npm", "start"]
`;
      if (runtime_type === 'static') {
        defaultDockerfile = `
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
      }
      fs.writeFileSync(dockerfilePath, defaultDockerfile.trim());
    } else {
      // If an existing Dockerfile has hardcoded src/server.js, update it to npm start
      try {
        let existingContent = fs.readFileSync(dockerfilePath, 'utf8');
        if (existingContent.includes('src/server.js')) {
          existingContent = existingContent.replace('node src/server.js', 'npm start').replace('["node", "src/server.js"]', '["npm", "start"]');
          fs.writeFileSync(dockerfilePath, existingContent);
        }
      } catch (_) {}
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

    // 6. Build and Launch Container via Docker CLI on ekafy-net
    try {
      console.log(`Building container ${containerName}...`);
      await execPromise(`docker build -t ${containerName}:latest ${projectDir}`);
      // Remove any existing container with same name
      await execPromise(`docker rm -f ${containerName} || true`);
      // Run container on ekafy-net
      await execPromise(`docker run -d --name ${containerName} --restart unless-stopped --network ekafy-net ${containerName}:latest`);
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
