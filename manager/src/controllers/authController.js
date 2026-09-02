const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
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

function generateToken(user) {
  const jwtSecret = process.env.JWT_SECRET || 'ekafy_default_secret';
  const expiresIn = process.env.JWT_EXPIRES_IN || '8h';
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    jwtSecret,
    { expiresIn }
  );
}

// 1. Check Auth Status & Google OAuth Config
exports.getAuthStatus = async (req, res) => {
  let conn;
  try {
    conn = await getMasterConnection();
    const [rows] = await conn.query('SELECT COUNT(*) as count FROM users');
    const hasAdmin = rows[0].count > 0;
    res.json({
      success: true,
      hasAdmin,
      googleAuthEnabled: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID),
      googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || ''
    });
  } catch (err) {
    console.error('Auth status error:', err);
    res.status(500).json({ success: false, error: 'Failed to check auth status.' });
  } finally {
    if (conn) await conn.end();
  }
};

// 2. Current User Profile
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

// 3. Google OAuth Login & Bootstrap
exports.googleLogin = async (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Google OAuth is not configured. Please set GOOGLE_OAUTH_CLIENT_ID in your .env file.' 
    });
  }

  const client = new OAuth2Client(clientId);
  let conn;
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Google credential token is required.' });
    }

    // Verify token with Google
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    const { email, name, sub: google_sub } = payload;

    conn = await getMasterConnection();
    const [users] = await conn.query('SELECT * FROM users WHERE email = ?', [email]);
    let user = users[0];

    if (!user) {
      // Check if this is the first user (bootstrap primary admin)
      const [existingUsers] = await conn.query('SELECT COUNT(*) as count FROM users');
      const isFirstUser = existingUsers[0].count === 0;

      const allowSignup = process.env.GOOGLE_OAUTH_ALLOW_SIGNUP === 'true';
      const allowedEmails = process.env.GOOGLE_OAUTH_ALLOWED_EMAILS 
        ? process.env.GOOGLE_OAUTH_ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase()) 
        : [];
      const allowedDomains = process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS 
        ? process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS.split(',').map(d => d.trim().toLowerCase()) 
        : [];

      const emailDomain = email.split('@')[1] ? email.split('@')[1].toLowerCase() : '';
      const isWhitelisted = allowedEmails.includes(email.toLowerCase()) || (allowedDomains.length > 0 && allowedDomains.includes(emailDomain));

      if (!isFirstUser && !allowSignup && !isWhitelisted) {
        return res.status(403).json({ 
          success: false, 
          error: `Unauthorized email (${email}). Access is restricted to registered administrators.` 
        });
      }

      const role = 'admin';
      const username = name || email.split('@')[0];

      const [result] = await conn.query(
        'INSERT INTO users (username, email, google_sub, role) VALUES (?, ?, ?, ?)',
        [username, email, google_sub, role]
      );
      
      user = { id: result.insertId, username, email, google_sub, role };
    } else if (!user.google_sub) {
      await conn.query('UPDATE users SET google_sub = ? WHERE id = ?', [google_sub, user.id]);
      user.google_sub = google_sub;
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
    res.status(401).json({ success: false, error: 'Invalid Google authentication token.' });
  } finally {
    if (conn) await conn.end();
  }
};
