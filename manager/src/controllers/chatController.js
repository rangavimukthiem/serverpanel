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
 * Fetch all chat messages for a specific project
 */
exports.getProjectChat = async (req, res) => {
  try {
    const { projectId } = req.params;
    const conn = await getMasterConnection();

    // Security check: If the user is a client, ensure they own the project
    if (req.user.role === 'client') {
      const [projects] = await conn.query('SELECT client_id FROM projects WHERE id = ?', [projectId]);
      if (projects.length === 0 || projects[0].client_id !== req.user.id) {
        await conn.end();
        return res.status(403).json({ success: false, error: 'Unauthorized to view this project chat' });
      }
    }

    const [messages] = await conn.query(
      'SELECT * FROM chat_messages WHERE project_id = ? ORDER BY created_at ASC',
      [projectId]
    );
    await conn.end();

    res.json({ success: true, data: messages });
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch chat messages' });
  }
};

/**
 * Send a message to a project chat
 */
exports.sendMessage = async (req, res) => {
  let conn;
  try {
    const { projectId } = req.params;
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty' });
    }

    conn = await getMasterConnection();

    // Security check for clients
    if (req.user.role === 'client') {
      const [projects] = await conn.query('SELECT client_id FROM projects WHERE id = ?', [projectId]);
      if (projects.length === 0 || projects[0].client_id !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Unauthorized to post to this project' });
      }
    }

    const [result] = await conn.query(
      `INSERT INTO chat_messages (project_id, sender_type, sender_id, message) 
       VALUES (?, ?, ?, ?)`,
      [projectId, req.user.role, req.user.id, message]
    );

    res.status(201).json({ 
      success: true, 
      message: 'Message sent',
      data: { id: result.insertId }
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  } finally {
    if (conn) await conn.end();
  }
};
