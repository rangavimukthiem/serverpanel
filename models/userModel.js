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

module.exports = {
  createUser,
  findUserByUsername,
  findUserById
};
