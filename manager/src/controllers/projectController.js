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

/**
 * List all projects, with filtering by status or client
 */
exports.getAllProjects = async (req, res) => {
  try {
    const conn = await getMasterConnection();
    // Using a JOIN to pull client details along with the project
    const query = `
      SELECT p.*, c.name as client_name, c.email as client_email, t.subdomain 
      FROM projects p
      LEFT JOIN clients c ON p.client_id = c.id
      LEFT JOIN tenants t ON p.tenant_id = t.id
      ORDER BY p.created_at DESC
    `;
    const [projects] = await conn.query(query);
    await conn.end();

    res.json({ success: true, data: projects });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch projects' });
  }
};

/**
 * Initialize a new Project from a Lead/Client Request
 */
exports.createProject = async (req, res) => {
  let conn;
  try {
    const { client_id, name, project_type, git_repo_url } = req.body;
    
    if (!client_id || !name || !project_type) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (project_type !== 'prebuilt' && project_type !== 'custom') {
      return res.status(400).json({ success: false, error: 'Invalid project type' });
    }

    conn = await getMasterConnection();

    // Verify client exists
    const [clients] = await conn.query('SELECT id FROM clients WHERE id = ?', [client_id]);
    if (clients.length === 0) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Insert the Project
    const [result] = await conn.query(
      `INSERT INTO projects (client_id, name, project_type, git_repo_url, status, assigned_admin_id) 
       VALUES (?, ?, ?, ?, 'pending_approval', ?)`,
      [client_id, name, project_type, git_repo_url || null, req.user.id]
    );

    await conn.end();

    res.status(201).json({ 
      success: true, 
      message: 'Project created successfully',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('Error creating project:', error);
    if (conn) await conn.end();
    res.status(500).json({ success: false, error: 'Failed to create project' });
  }
};

/**
 * Approve a project (Link a Tenant DB to it if Prebuilt)
 */
exports.approveProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id } = req.body; // For prebuilt products

    const conn = await getMasterConnection();
    const [result] = await conn.query(
      'UPDATE projects SET status = "in_development", tenant_id = COALESCE(?, tenant_id) WHERE id = ?',
      [tenant_id || null, id]
    );
    await conn.end();

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    res.json({ success: true, message: 'Project approved and moved to development' });
  } catch (error) {
    console.error('Error approving project:', error);
    res.status(500).json({ success: false, error: 'Failed to approve project' });
  }
};
