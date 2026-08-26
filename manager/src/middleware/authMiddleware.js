const jwt = require('jsonwebtoken');

/**
 * Validates the JWT token attached to requests.
 * Protects the Server Manager API routes.
 */
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'ekafy_default_secret');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: 'Invalid or expired token.' });
  }
};

/**
 * Ensures the user has an Admin role.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Access denied. Admin role required.' });
  }
  next();
};

module.exports = {
  verifyToken,
  requireAdmin
};
