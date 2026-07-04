const { query } = require('../config/db');

async function createUser({ username, passwordHash, role = 'user' }) {
  const result = await query(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
    [username, passwordHash, role]
  );

  return {
    id: Number(result.insertId),
    username,
    role
  };
}

async function listUsersWithProjects() {
  const rows = await query(`
    SELECT
      u.id,
      u.username,
      u.role,
      u.created_at,
      pm.project_id,
      pm.role AS project_role,
      p.name AS project_name
    FROM users u
    LEFT JOIN project_members pm ON pm.user_id = u.id
    LEFT JOIN projects p ON p.id = pm.project_id
    ORDER BY u.username ASC, p.name ASC
  `);

  const users = new Map();

  rows.forEach((row) => {
    const id = Number(row.id);

    if (!users.has(id)) {
      users.set(id, {
        id,
        username: row.username,
        role: row.role,
        created_at: row.created_at,
        projects: []
      });
    }

    if (row.project_id) {
      users.get(id).projects.push({
        id: Number(row.project_id),
        name: row.project_name,
        role: row.project_role
      });
    }
  });

  return Array.from(users.values());
}

async function findUserByUsername(username) {
  const rows = await query(
    'SELECT id, username, password, role, created_at FROM users WHERE username = ? LIMIT 1',
    [username]
  );

  return rows[0] || null;
}

async function findUserById(id) {
  const rows = await query(
    'SELECT id, username, role, created_at FROM users WHERE id = ? LIMIT 1',
    [id]
  );

  return rows[0] || null;
}

async function countUsers() {
  const rows = await query('SELECT COUNT(*) AS total FROM users');
  return Number(rows[0]?.total || 0);
}

async function updateUserRole(id, role) {
  await query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  return findUserById(id);
}

module.exports = {
  createUser,
  listUsersWithProjects,
  findUserByUsername,
  findUserById,
  countUsers,
  updateUserRole
};
