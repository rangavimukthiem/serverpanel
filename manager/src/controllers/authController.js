const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);

const getMasterConnection = async () => {
  return await mysql.createConnection({
    host: process.env.DB_HOST || 'mariadb',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'ekafy_admin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ekafy_master'
  });
};

exports.googleLogin = async (req, res) => {
  let conn;
  try {
    const { token } = req.body; // The Google ID Token from the frontend

    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    // 1. Verify the token with Google
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { email, sub: google_sub } = payload;

    // 2. Check if the user exists in our Master Database
    conn = await getMasterConnection();
    const [users] = await conn.query('SELECT * FROM users WHERE email = ?', [email]);
    let user = users[0];

    // 3. Handle Registration / Whitelisting
    if (!user) {
      const allowRegistration = process.env.GOOGLE_OAUTH_ALLOW_SIGNUP === 'true';
      const allowedEmails = process.env.GOOGLE_OAUTH_ALLOWED_EMAILS 
        ? process.env.GOOGLE_OAUTH_ALLOWED_EMAILS.split(',').map(e => e.trim()) 
        : [];

      // Check if registration is allowed or email is whitelisted
      const isAllowed = allowRegistration || (allowedEmails.length > 0 && allowedEmails.includes(email));

      if (!isAllowed) {
        return res.status(403).json({ success: false, error: 'Unauthorized email. Registration is disabled.' });
      }

      // Create the user as an admin (since this is the Server Manager)
      const [result] = await conn.query(
        'INSERT INTO users (email, google_sub, role) VALUES (?, ?, ?)',
        [email, google_sub, 'admin']
      );
      
      user = {
        id: result.insertId,
        email,
        google_sub,
        role: 'admin'
      };
    } else {
      // Update google_sub if it was missing (e.g., they existed before but logging in with Google now)
      if (!user.google_sub) {
        await conn.query('UPDATE users SET google_sub = ? WHERE id = ?', [google_sub, user.id]);
      }
    }

    // 4. Issue a secure JWT Session
    const jwtSecret = process.env.JWT_SECRET || 'ekafy_default_secret';
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      jwtSecret,
      { expiresIn }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Google OAuth Error:', error);
    res.status(401).json({ success: false, error: 'Invalid Google token' });
  } finally {
    if (conn) await conn.end();
  }
};
