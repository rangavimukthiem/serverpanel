const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createUser, findUserByUsername, countUsers } = require('../models/userModel');
const { createLog } = require('../models/logModel');

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const ALLOWED_ROLES = new Set(['admin', 'user']);

function sanitizeUser(user) {
  return {
    id: Number(user.id),
    username: user.username,
    role: user.role
  };
}

function signToken(user) {
  return jwt.sign(
    {
      sub: Number(user.id),
      username: user.username,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

async function register(req, res, next) {
  try {
    const existingUserCount = await countUsers();
    const registrationEnabled = process.env.ALLOW_REGISTRATION === 'true';

    if (existingUserCount > 0 && !registrationEnabled) {
      return res.status(403).json({ message: 'Registration is disabled' });
    }

    const { username, password, role = 'user' } = req.body;

    if (!USERNAME_PATTERN.test(username || '')) {
      return res.status(400).json({ message: 'Username must be 3-32 letters, numbers, underscores, or dashes' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const requestedRole = existingUserCount === 0 ? 'admin' : role;

    if (!ALLOWED_ROLES.has(requestedRole)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser({ username, passwordHash, role: requestedRole });
    const token = signToken(user);

    await createLog({ userId: user.id, action: `registered ${requestedRole} user ${username}` });

    return res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Username already exists' });
    }

    return next(error);
  }
}

async function login(req, res, next) {
  try {
    const { username, password } = req.body;

    if (!USERNAME_PATTERN.test(username || '') || typeof password !== 'string') {
      return res.status(400).json({ message: 'Invalid username or password' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const token = signToken(user);
    await createLog({ userId: user.id, action: `logged in as ${username}` });

    return res.json({ token, user: sanitizeUser(user) });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  register,
  login
};
