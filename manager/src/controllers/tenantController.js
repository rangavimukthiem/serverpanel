const mysql = require('mysql2/promise');

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

exports.getAllTenants = async (req, res) => {
  let conn;
  try {
    conn = await getAdminConnection('ekafy_master');
    const [tenants] = await conn.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.json({ success: true, data: tenants });
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tenants' });
  } finally {
    if (conn) await conn.end();
  }
};

exports.provisionTenant = async (req, res) => {
  let conn;
  let tenantConn;
  try {
    const { name, subdomain, plan_type } = req.body;
    
    if (!name || !subdomain) {
      return res.status(400).json({ success: false, error: 'Name and subdomain are required' });
    }

    const sanitizedSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!sanitizedSubdomain) {
      return res.status(400).json({ success: false, error: 'Invalid subdomain format' });
    }

    const dbName = `db_tenant_${sanitizedSubdomain.replace(/-/g, '_')}`;

    conn = await getAdminConnection('ekafy_master');
    await conn.beginTransaction();

    // 1. Insert into Master DB
    const [result] = await conn.query(
      `INSERT INTO tenants (name, subdomain, db_name, plan_type, status) VALUES (?, ?, ?, ?, ?)`,
      [name, sanitizedSubdomain, dbName, plan_type || 'basic', 'active']
    );
    const tenantId = result.insertId;

    // 2. Create the dedicated Database for the new tenant
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);

    // 3. Grant privileges to ekafy_admin on the new tenant database
    try {
      await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${process.env.DB_USER || 'ekafy_admin'}'@'%'`);
      await conn.query(`FLUSH PRIVILEGES`);
    } catch (_) {}

    // 4. Connect to new database to provision blueprint tables
    tenantConn = await getAdminConnection(dbName);
    const blueprintSql = `
      CREATE TABLE IF NOT EXISTS employees (
        id INT AUTO_INCREMENT PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        email VARCHAR(320) UNIQUE,
        phone VARCHAR(20),
        role VARCHAR(100) DEFAULT 'Employee',
        salary DECIMAL(10,2) DEFAULT 0.00,
        hire_date DATE,
        status ENUM('Active', 'On Leave', 'Terminated') DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        record_date DATE NOT NULL,
        clock_in TIME,
        clock_out TIME,
        status ENUM('Present', 'Absent', 'Half-Day', 'Leave') DEFAULT 'Present',
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quotations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_name VARCHAR(150) NOT NULL,
        client_email VARCHAR(320),
        client_phone VARCHAR(20),
        total_amount DECIMAL(12,2) DEFAULT 0.00,
        status ENUM('Draft', 'Sent', 'Accepted', 'Rejected') DEFAULT 'Draft',
        valid_until DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS quotation_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        quotation_id INT NOT NULL,
        description VARCHAR(255) NOT NULL,
        quantity INT DEFAULT 1,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
      );
    `;

    await tenantConn.query(blueprintSql);
    await tenantConn.end();
    tenantConn = null;

    await conn.commit();

    res.status(201).json({ 
      success: true, 
      message: `Tenant ${name} provisioned successfully!`,
      data: { id: tenantId, db_name: dbName }
    });

  } catch (error) {
    console.error('Error provisioning tenant:', error);
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, error: 'Subdomain already exists' });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to provision tenant' });
  } finally {
    if (tenantConn) await tenantConn.end();
    if (conn) await conn.end();
  }
};

exports.updateTenantStatus = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['active', 'suspended', 'deleted'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    conn = await getAdminConnection('ekafy_master');
    const [result] = await conn.query('UPDATE tenants SET status = ? WHERE id = ?', [status, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    res.json({ success: true, message: `Tenant status updated to ${status}` });
  } catch (error) {
    console.error('Error updating tenant status:', error);
    res.status(500).json({ success: false, error: 'Failed to update tenant status' });
  } finally {
    if (conn) await conn.end();
  }
};
