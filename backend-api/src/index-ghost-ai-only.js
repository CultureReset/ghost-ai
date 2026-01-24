// GHOST AI ONLY - Clean backend without other platforms
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS - Allow all origins for testing
app.use(cors({
  origin: '*',
  credentials: true
}));

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Ghost AI Backend API is running',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Waitlist route
try {
  const { default: waitlistRoutes } = await import('./routes/waitlist.js');
  app.use('/api/waitlist', waitlistRoutes);
  console.log('✓ Waitlist routes loaded');
} catch (error) {
  console.error('Failed to load waitlist routes:', error);
}

// Ghost AI routes
try {
  const { default: ghostAIRoutes } = await import('./routes/ghost-ai.js');
  const { setupMediaStreamWebSocket } = await import('./routes/ghost-ai.js');

  app.use('/api/ghost-ai', ghostAIRoutes);

  // Setup WebSocket server for Ghost AI media streams
  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/api/ghost-ai/media-stream'
  });

  setupMediaStreamWebSocket(wss);

  server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🚀 Ghost AI Backend Running          ║
╠════════════════════════════════════════╣
║   Port: ${PORT}                           ║
║   Environment: ${process.env.NODE_ENV || 'production'}              ║
║   WebSocket: /api/ghost-ai/media-stream║
║   Health: /health                      ║
╚════════════════════════════════════════╝
    `);
  });
} catch (error) {
  console.error('Failed to load Ghost AI routes:', error);

  // Start server anyway with basic routes
  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`Ghost AI Backend running on port ${PORT} (Ghost AI routes disabled due to error)`);
  });
}

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});
