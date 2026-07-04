const { query } = require('../config/db');

async function createLog({ userId = null, action }) {
  try {
    await query('INSERT INTO logs (user_id, action) VALUES (?, ?)', [userId, action]);
  } catch (error) {
    console.warn('Activity log write failed:', error.message);
  }
}

module.exports = {
  createLog
};
