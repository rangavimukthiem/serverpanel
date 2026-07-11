require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const systemRoutes = require('./routes/system');
const serviceRoutes = require('./routes/services');
const projectRoutes = require('./routes/projects');
const userRoutes = require('./routes/users');
const { testConnection } = require('./config/db');
const { ensureProjectSchema } = require('./models/projectModel');
const { authenticateToken } = require('./middleware/authMiddleware');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

app.set('trust proxy', 1);
app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ekafy-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/system', authenticateToken, systemRoutes);
app.use('/api/services', authenticateToken, serviceRoutes);
app.use('/api/projects', authenticateToken, projectRoutes);
app.use('/api/users', authenticateToken, userRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'API route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    message: err.publicMessage || err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
    details: err.details || null
  });
});

async function start() {
  await testConnection();
  await ensureProjectSchema();

  app.listen(port, host, () => {
    console.log(`EKAFY API running on http://${host}:${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start EKAFY:', error.message);
  process.exit(1);
});
