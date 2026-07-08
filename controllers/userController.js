const bcrypt = require('bcrypt');
const {
  createUser,
  findUserById,
  findUserByUsername,
  listUsersWithProjects,
  updateUserRole,
  deleteUserById
} = require('../models/userModel');
const { createLog } = require('../models/logModel');

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const GLOBAL_ROLES = new Set(['admin', 'user']);

async function listUsers(_req, res, next) {
  try {
    const users = await listUsersWithProjects();
    return res.json({ users });
  } catch (error) {
    return next(error);
  }
}

async function createManagedUser(req, res, next) {
  try {
    const { username, password, role = 'user' } = req.body;

    if (!USERNAME_PATTERN.test(username || '')) {
      return res.status(400).json({ message: 'Username must be 3-32 letters, numbers, underscores, or dashes' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    if (!GLOBAL_ROLES.has(role)) {
      return res.status(400).json({ message: 'Invalid global role' });
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser({ username, passwordHash, role });
    await createLog({ userId: req.user.id, action: `created ${role} user ${username}` });

    return res.status(201).json({ user });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Username already exists' });
    }

    return next(error);
  }
}

async function changeUserRole(req, res, next) {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    if (!GLOBAL_ROLES.has(role)) {
      return res.status(400).json({ message: 'Invalid global role' });
    }

    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const updatedUser = await updateUserRole(userId, role);
    await createLog({ userId: req.user.id, action: `changed ${user.username} global role to ${role}` });

    return res.json({ user: updatedUser });
  } catch (error) {
    return next(error);
  }
}

async function deleteManagedUser(req, res, next) {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    if (req.user.id === userId) {
      return res.status(400).json({ message: 'You cannot delete your own account while signed in' });
    }

    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const deleted = await deleteUserById(userId);
    if (!deleted) {
      return res.status(404).json({ message: 'User not found' });
    }

    await createLog({ userId: req.user.id, action: `deleted user ${user.username}` });

    return res.json({ message: 'User deleted' });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listUsers,
  createManagedUser,
  changeUserRole,
  deleteManagedUser
};
