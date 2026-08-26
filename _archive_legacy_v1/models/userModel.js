const { query } = require('../config/db');

async function ensureUserAuthSchema() {
  const columns = [
    { name: 'google_sub', def: 'VARCHAR(255) NULL' },
    { name: 'email', def: 'VARCHAR(320) NULL' }
  ];

  for (const column of columns) {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = ?`,
      [column.name]
    );
    if (Number(rows[0]?.total || 0) === 0) {
      await query(`ALTER TABLE users ADD COLUMN ${column.name} ${column.def}`);
    }
  }

  const indexes = await query(
    `SELECT COUNT(*) AS total
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND INDEX_NAME = 'users_google_sub_unique'`
  );
  if (Number(indexes[0]?.total || 0) === 0) {
    await query('ALTER TABLE users ADD UNIQUE KEY users_google_sub_unique (google_sub)');
  }
}

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

async function findUserByGoogleSub(googleSub) {
  const rows = await query(
    'SELECT id, username, password, role, email, google_sub, created_at FROM users WHERE google_sub = ? LIMIT 1',
    [googleSub]
  );
  return rows[0] || null;
}

async function createGoogleUser({ username, passwordHash, email, googleSub, role = 'user' }) {
  const result = await query(
    'INSERT INTO users (username, password, role, email, google_sub) VALUES (?, ?, ?, ?, ?)',
    [username, passwordHash, role, email, googleSub]
  );
  return { id: Number(result.insertId), username, role, email, google_sub: googleSub };
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

async function deleteUserById(id) {
  const result = await query('DELETE FROM users WHERE id = ?', [id]);
  return Number(result.affectedRows || 0) > 0;
}

module.exports = {
  ensureUserAuthSchema,
  createUser,
  createGoogleUser,
  listUsersWithProjects,
  findUserByUsername,
  findUserByGoogleSub,
  findUserById,
  countUsers,
  updateUserRole,
  deleteUserById
};
