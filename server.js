require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const systemRoutes = require('./routes/system');
const serviceRoutes = require('./routes/services');
const projectRoutes = require('./routes/projects');
const { testConnection } = require('./config/db');
const { authenticateToken } = require('./middleware/authMiddleware');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ekafy-api' });
});

app.use('/api/auth', authRoutes);
app.use('/api/system', authenticateToken, systemRoutes);
app.use('/api/services', authenticateToken, serviceRoutes);
app.use('/api/projects', authenticateToken, projectRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'API route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    message: err.publicMessage || 'Internal server error'
  });
});

async function start() {
  await testConnection();

  app.listen(port, () => {
    console.log(`EKAFY API running on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start EKAFY:', error.message);
  process.exit(1);
});
