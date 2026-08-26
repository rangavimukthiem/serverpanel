const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const {
  createUser,
  createGoogleUser,
  findUserByUsername,
  findUserByGoogleSub,
  countUsers
} = require('../models/userModel');
const { createLog } = require('../models/logModel');

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const ALLOWED_ROLES = new Set(['admin', 'user']);
const AUTH_COOKIE_NAME = 'ekafy_token';
const GOOGLE_STATE_COOKIE = 'ekafy_google_state';
const GOOGLE_NONCE_COOKIE = 'ekafy_google_nonce';
const GOOGLE_COOKIE_MAX_AGE = 10 * 60 * 1000;

function parseDurationMs(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const match = value.trim().match(/^(\d+)([smhd])$/);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return amount * multipliers[unit];
}

function getAuthCookieOptions() {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  };

  const maxAge = parseDurationMs(process.env.JWT_EXPIRES_IN || '8h');
  if (maxAge) {
    cookieOptions.maxAge = maxAge;
  }

  return cookieOptions;
}

function isSecureRequest(req) {
  return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
}

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

function setAuthCookie(req, res, token) {
  const cookieOptions = getAuthCookieOptions();

  if (isSecureRequest(req)) {
    cookieOptions.secure = true;
  }

  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions);
}

function clearAuthCookie(req, res) {
  const cookieOptions = {
    path: '/',
    sameSite: 'lax'
  };

  if (isSecureRequest(req)) {
    cookieOptions.secure = true;
  }

  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions);
}

function getCookie(req, name) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

function getGoogleConfig(req) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${isSecureRequest(req) ? 'https' : 'http'}://${req.get('host')}/api/auth/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

function requireGoogleConfig(req) {
  const config = getGoogleConfig(req);
  if (!config.clientId || !config.clientSecret) {
    const error = new Error('Google OAuth is not configured');
    error.status = 503;
    throw error;
  }
  return config;
}

function oauthCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: GOOGLE_COOKIE_MAX_AGE,
    path: '/api/auth/google'
  };
}

function clearOauthCookies(req, res) {
  const options = oauthCookieOptions(req);
  delete options.maxAge;
  res.clearCookie(GOOGLE_STATE_COOKIE, options);
  res.clearCookie(GOOGLE_NONCE_COOKIE, options);
}

function googleAccessAllowed(email) {
  const normalizedEmail = String(email || '').toLowerCase();
  const allowedEmails = String(process.env.GOOGLE_OAUTH_ALLOWED_EMAILS || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const allowedDomains = String(process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!allowedEmails.length && !allowedDomains.length) return true;
  const domain = normalizedEmail.split('@')[1] || '';
  return allowedEmails.includes(normalizedEmail) || allowedDomains.includes(domain);
}

async function uniqueGoogleUsername(email) {
  const localPart = String(email).split('@')[0]
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '') || 'google_user';
  const base = localPart.slice(0, 24).padEnd(3, '_');
  let candidate = base;
  for (let suffix = 1; await findUserByUsername(candidate); suffix += 1) {
    candidate = `${base.slice(0, 27)}_${suffix}`.slice(0, 32);
  }
  return candidate;
}

function googleStatus(req, res) {
  const { clientId, clientSecret } = getGoogleConfig(req);
  return res.json({ enabled: Boolean(clientId && clientSecret) });
}

function googleStart(req, res, next) {
  try {
    const { clientId, clientSecret, redirectUri } = requireGoogleConfig(req);
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const client = new OAuth2Client(clientId, clientSecret, redirectUri);
    const options = oauthCookieOptions(req);
    res.cookie(GOOGLE_STATE_COOKIE, state, options);
    res.cookie(GOOGLE_NONCE_COOKIE, nonce, options);
    return res.redirect(client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
      prompt: 'select_account'
    }));
  } catch (error) {
    return next(error);
  }
}

async function googleCallback(req, res) {
  try {
    const { clientId, clientSecret, redirectUri } = requireGoogleConfig(req);
    const expectedState = getCookie(req, GOOGLE_STATE_COOKIE);
    const expectedNonce = getCookie(req, GOOGLE_NONCE_COOKIE);
    clearOauthCookies(req, res);
    if (!req.query.code || !req.query.state || req.query.state !== expectedState || !expectedNonce) {
      throw new Error('Google sign-in state validation failed');
    }

    const client = new OAuth2Client(clientId, clientSecret, redirectUri);
    const { tokens } = await client.getToken(String(req.query.code));
    if (!tokens.id_token) throw new Error('Google did not return an identity token');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
    const profile = ticket.getPayload();
    if (!profile || profile.nonce !== expectedNonce || !profile.sub || !profile.email || !profile.email_verified) {
      throw new Error('Google identity validation failed');
    }
    if (!googleAccessAllowed(profile.email)) throw new Error('This Google account is not allowed');

    let user = await findUserByGoogleSub(profile.sub);
    if (!user) {
      const userCount = await countUsers();
      if (userCount > 0 && process.env.GOOGLE_OAUTH_ALLOW_SIGNUP !== 'true') {
        throw new Error('No linked EKAFY account exists for this Google account');
      }
      const username = await uniqueGoogleUsername(profile.email);
      const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
      user = await createGoogleUser({
        username,
        passwordHash,
        email: profile.email.toLowerCase(),
        googleSub: profile.sub,
        role: userCount === 0 ? 'admin' : 'user'
      });
      await createLog({ userId: user.id, action: `registered via Google as ${username}` });
    }

    const token = signToken(user);
    setAuthCookie(req, res, token);
    await createLog({ userId: user.id, action: `logged in with Google as ${user.username}` });
    return res.redirect('/dashboard.html');
  } catch (error) {
    clearOauthCookies(req, res);
    return res.redirect(`/login.html?oauth_error=${encodeURIComponent(error.message || 'Google sign-in failed')}`);
  }
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
    setAuthCookie(req, res, token);

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
    setAuthCookie(req, res, token);
    await createLog({ userId: user.id, action: `logged in as ${username}` });

    return res.json({ token, user: sanitizeUser(user) });
  } catch (error) {
    return next(error);
  }
}

async function me(req, res) {
  return res.json({ user: sanitizeUser(req.user) });
}

async function logout(req, res) {
  clearAuthCookie(req, res);
  return res.json({ message: 'Logged out' });
}

module.exports = {
  register,
  login,
  me,
  logout,
  googleStatus,
  googleStart,
  googleCallback
};
