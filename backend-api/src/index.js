// CRITICAL: Load environment variables FIRST before any other imports
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import twilio from 'twilio';
import { supabase } from './config/supabase.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration - Allow all 3 frontends
app.use(cors({
  origin: [
    process.env.GHOST_OS_URL || 'http://localhost:8080',
    process.env.CYBERCHECK_URL || 'http://localhost:8081',
    process.env.GCR_URL || 'http://localhost:8082',
    'https://ghostos.ai',
    'https://cybercheck.com',
    'https://gulfcoastradar.com'
  ],
  credentials: true
}));

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Shared Backend API is running',
    platforms: ['Ghost OS', 'CyberCheck', 'GCR'],
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// GHOST OS ROUTES
// ============================================
// Temporarily disabled until Twilio credentials are configured
// import ghostDemoRoutes from './routes/ghost-os/demo.js';
// app.use('/api/ghost-os', ghostDemoRoutes);

// ============================================
// GHOST AI ROUTES - Real-time voice conversations
// ============================================
import ghostAIRoutes from './routes/ghost-ai.js';
import { setupMediaStreamWebSocket } from './routes/ghost-ai.js';
app.use('/api/ghost-ai', ghostAIRoutes);

// ============================================
// CYBERCHECK ROUTES
// ============================================
import cyberchecAuthRoutes from './routes/cybercheck/auth.js';
import cyberchecMenuRoutes from './routes/cybercheck/menu.js';
import cyberchecAIRoutes from './routes/cybercheck/ai.js';
import cyberchecContactsRoutes from './routes/cybercheck/contacts.js';
import cyberchecReviewsRoutes from './routes/cybercheck/reviews.js';
import cyberchecSMSRoutes from './routes/cybercheck/sms.js';
import cyberchecBusinessRoutes from './routes/cybercheck/business.js';
import cyberchecLeadsRoutes from './routes/cybercheck/leads.js';
import cyberchecLoyaltyRoutes from './routes/cybercheck/loyalty.js';
import cyberchecBillingRoutes from './routes/cybercheck/billing.js';
import cyberchecProfileRoutes from './routes/cybercheck/profile.js';
import cyberchecTasksRoutes from './routes/cybercheck/tasks.js';
import cyberchecAppointmentsRoutes from './routes/cybercheck/appointments.js';
import cyberchecPhoneRoutes from './routes/cybercheck/phone.js';
import cyberchecVoiceNotesRoutes from './routes/cybercheck/voiceNotes.js';
import cyberchecSocialMediaRoutes from './routes/cybercheck/social-media.js';
import { setupVoiceCRMRoutes } from './routes/cybercheck/voice-crm.js';
import cyberchecToolsRoutes from './routes/cybercheck/tools.js';
import cyberchecAutomationsRoutes from './routes/cybercheck/automations.js';
import cyberchecDashboardRoutes from './routes/cybercheck/dashboard.js';

app.use('/api/cybercheck/auth', cyberchecAuthRoutes);
app.use('/api/cybercheck/menu', cyberchecMenuRoutes);
app.use('/api/cybercheck/ai', cyberchecAIRoutes);
app.use('/api/cybercheck/contacts', cyberchecContactsRoutes);
app.use('/api/cybercheck/reviews', cyberchecReviewsRoutes);
app.use('/api/cybercheck/sms', cyberchecSMSRoutes);
app.use('/api/cybercheck/business', cyberchecBusinessRoutes);
app.use('/api/cybercheck/leads', cyberchecLeadsRoutes);
app.use('/api/cybercheck/loyalty', cyberchecLoyaltyRoutes);
app.use('/api/cybercheck/billing', cyberchecBillingRoutes);
app.use('/api/cybercheck/profile', cyberchecProfileRoutes);
app.use('/api/cybercheck/tasks', cyberchecTasksRoutes);
app.use('/api/cybercheck/appointments', cyberchecAppointmentsRoutes);
app.use('/api/cybercheck/phone', cyberchecPhoneRoutes);
app.use('/api/cybercheck/voice-notes', cyberchecVoiceNotesRoutes);
app.use('/api/cybercheck/social-media', cyberchecSocialMediaRoutes);
app.use('/api/cybercheck/tools', cyberchecToolsRoutes);
app.use('/api/cybercheck/automations', cyberchecAutomationsRoutes);
app.use('/api/cybercheck/dashboard', cyberchecDashboardRoutes);
// app.use('/api/cybercheck/voice-crm', cyberchecVoiceCRMRoutes); // TODO: Fix export pattern

// ============================================
// GCR ROUTES
// ============================================
import gcrRoutes from './routes/gcr/gcr.js';
import gcrFeaturedRoutes from './routes/gcr/gcr-featured.js';
import gcrPublicRoutes from './routes/gcr/public.js';

app.use('/api/gcr', gcrRoutes);
app.use('/api/gcr/featured', gcrFeaturedRoutes);
app.use('/api/gcr/public', gcrPublicRoutes);

// ============================================
// ADMIN ROUTES
// ============================================
import adminAuthRoutes from './routes/admin/auth.js';
import adminDashboardRoutes from './routes/admin/dashboard.js';
import adminIntegrationsRoutes from './routes/admin/integrations.js';

app.use('/api/admin', adminAuthRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/integrations', adminIntegrationsRoutes);

// ============================================
// USER ROUTES
// ============================================
import userPlatformsRoutes from './routes/user/platforms.js';
app.use('/api/user/platforms', userPlatformsRoutes);

// ============================================
// VOICE CRM ASSISTANT
// ============================================
// Initialize Twilio client only if credentials are configured
if (process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_ACCOUNT_SID.startsWith('AC')) {
  try {
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    // Setup voice CRM routes
    setupVoiceCRMRoutes(app, supabase, twilioClient);
    console.log('✓ Voice CRM assistant enabled');
  } catch (error) {
    console.warn('Warning: Twilio initialization failed - voice features disabled');
  }
} else {
  console.warn('Warning: Twilio credentials not configured - voice assistant disabled');
  console.warn('Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env to enable voice features');
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
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

// Start server
import http from 'http';
import { WebSocketServer } from 'ws';

const server = http.createServer(app);

// Setup WebSocket server for Ghost AI media streams
const wss = new WebSocketServer({
  server,
  path: '/api/ghost-ai/media-stream'
});

setupMediaStreamWebSocket(wss);

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 Shared Backend API Running        ║
╠════════════════════════════════════════╣
║                                        ║
║   Port: ${PORT}                           ║
║   Environment: ${process.env.NODE_ENV || 'development'}              ║
║                                        ║
║   Platforms:                           ║
║   • Ghost OS     /api/ghost-os/*       ║
║   • Ghost AI     /api/ghost-ai/*       ║
║   • CyberCheck   /api/cybercheck/*     ║
║   • GCR          /api/gcr/*            ║
║                                        ║
║   WebSocket: ws://localhost:${PORT}/api/ghost-ai/media-stream ║
║   Health: http://localhost:${PORT}/health   ║
║                                        ║
╚════════════════════════════════════════╝
  `);
});

export default app;
