const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const client = process.env.GOOGLE_OAUTH_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID) : null;

const getMasterConnection = async () => {
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'mariadb',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'ekafy_admin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ekafy_master'
  });
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

function generateToken(user) {
  const jwtSecret = process.env.JWT_SECRET || 'ekafy_default_secret';
  const expiresIn = process.env.JWT_EXPIRES_IN || '8h';
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    jwtSecret,
    { expiresIn }
  );
}

// 1. Password Login
exports.passwordLogin = async (req, res) => {
  let conn;
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Username/Email and password are required.' });
    }

    conn = await getMasterConnection();
    const [users] = await conn.query(
      'SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1',
      [identifier, identifier]
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    const user = users[0];
    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    const token = generateToken(user);
    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Internal login error.' });
  } finally {
    if (conn) await conn.end();
  }
};

// 2. Initial Setup or Register Admin
exports.register = async (req, res) => {
  let conn;
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'Username, email and password are required.' });
    }

    conn = await getMasterConnection();
    const [existing] = await conn.query('SELECT COUNT(*) as count FROM users');
    const userCount = existing[0].count;

    const allowReg = process.env.ALLOW_REGISTRATION === 'true';
    if (userCount > 0 && !allowReg) {
      return res.status(403).json({ success: false, error: 'Registration is closed. Existing admin exists.' });
    }

    const [dup] = await conn.query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (dup.length > 0) {
      return res.status(409).json({ success: false, error: 'User with this email or username already exists.' });
    }

    const pHash = hashPassword(password);
    const role = userCount === 0 ? 'admin' : 'user';

    const [result] = await conn.query(
      'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [username, email, pHash, role]
    );

    const newUser = { id: result.insertId, username, email, role };
    const token = generateToken(newUser);

    res.json({
      success: true,
      message: 'Account registered successfully.',
      token,
      user: newUser
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, error: 'Failed to register account.' });
  } finally {
    if (conn) await conn.end();
  }
};

// 3. Check Auth Status (Is Setup Required?)
exports.getAuthStatus = async (req, res) => {
  let conn;
  try {
    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT COUNT(*) as count FROM users');
    const hasAdmin = rows[0].count > 0;
    res.json({
      success: true,
      hasAdmin,
      allowRegistration: hasAdmin ? (process.env.ALLOW_REGISTRATION === 'true') : true,
      googleAuthEnabled: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID)
    });
  } catch (err) {
    console.error('Auth status error:', err);
    res.status(500).json({ success: false, error: 'Failed to check auth status.' });
  } finally {
    if (conn) await conn.end();
  }
};

// 4. Current User Info
exports.getMe = async (req, res) => {
  let conn;
  try {
    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT id, username, email, role, created_at FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch user profile.' });
  } finally {
    if (conn) await conn.end();
  }
};

// 5. Google OAuth Login
exports.googleLogin = async (req, res) => {
  if (!client) {
    return res.status(400).json({ success: false, error: 'Google OAuth is not configured.' });
  }
  let conn;
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required.' });
    }

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, sub: google_sub } = payload;

    conn = await getMasterConnection();
    const [users] = await conn.query('SELECT * FROM users WHERE email = ?', [email]);
    let user = users[0];

    if (!user) {
      const allowRegistration = process.env.GOOGLE_OAUTH_ALLOW_SIGNUP === 'true';
      const allowedEmails = process.env.GOOGLE_OAUTH_ALLOWED_EMAILS 
        ? process.env.GOOGLE_OAUTH_ALLOWED_EMAILS.split(',').map(e => e.trim()) 
        : [];

      const isAllowed = allowRegistration || (allowedEmails.length > 0 && allowedEmails.includes(email));
      if (!isAllowed) {
        return res.status(403).json({ success: false, error: 'Unauthorized email.' });
      }

      const [result] = await conn.query(
        'INSERT INTO users (username, email, google_sub, role) VALUES (?, ?, ?, ?)',
        [email.split('@')[0], email, google_sub, 'admin']
      );
      
      user = { id: result.insertId, username: email.split('@')[0], email, google_sub, role: 'admin' };
    } else if (!user.google_sub) {
      await conn.query('UPDATE users SET google_sub = ? WHERE id = ?', [google_sub, user.id]);
    }

    const sessionToken = generateToken(user);
    res.json({
      success: true,
      message: 'Login successful',
      token: sessionToken,
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });
  } catch (error) {
    console.error('Google OAuth Error:', error);
    res.status(401).json({ success: false, error: 'Invalid Google token.' });
  } finally {
    if (conn) await conn.end();
  }
};
