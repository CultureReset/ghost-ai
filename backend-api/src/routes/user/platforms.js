/**
 * USER PLATFORM CONNECTIONS - For users to OAuth their accounts
 * Connects to existing: /pages/dashboard/settings.html (Integrations tab)
 */

import express from 'express';
import { supabase } from '../../config/supabase.js';
import { google } from 'googleapis';

const router = express.Router();

// ============================================
// GET USER'S CONNECTED PLATFORMS
// ============================================
router.get('/connections', async (req, res) => {
  try {
    // TODO: Get user_id from auth middleware
    const userId = req.user?.id || req.query.user_id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const { data, error } = await supabase
      .from('user_platform_connections')
      .select('id, platform_type, platform_name, platform_account_name, status, connected_at, last_sync_at')
      .eq('user_id', userId)
      .order('connected_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, connections: data || [] });

  } catch (error) {
    console.error('Get connections error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// OAUTH: START FLOW
// ============================================
router.get('/oauth/:platform/start', async (req, res) => {
  try {
    const { platform } = req.params;
    const userId = req.user?.id || req.query.user_id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Generate state for CSRF protection
    const state = Buffer.from(JSON.stringify({
      user_id: userId,
      platform,
      timestamp: Date.now()
    })).toString('base64');

    let authUrl;

    switch (platform) {
      case 'gmail':
      case 'google_analytics':
      case 'google_calendar':
        authUrl = await getGoogleOAuthUrl(platform, state);
        break;

      case 'facebook':
        authUrl = await getFacebookOAuthUrl(state);
        break;

      case 'instagram':
        authUrl = await getInstagramOAuthUrl(state);
        break;

      default:
        return res.status(400).json({
          success: false,
          error: 'Unsupported platform'
        });
    }

    res.json({ success: true, authUrl });

  } catch (error) {
    console.error('OAuth start error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// OAUTH: CALLBACK (after user authorizes)
// ============================================
router.get('/oauth/:platform/callback', async (req, res) => {
  try {
    const { platform } = req.params;
    const { code, state } = req.query;

    // Decode state
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const { user_id: userId } = stateData;

    // Exchange code for tokens
    let tokens;
    let platformInfo = {};

    switch (platform) {
      case 'gmail':
      case 'google_analytics':
      case 'google_calendar':
        tokens = await exchangeGoogleCode(code);
        platformInfo = await getGoogleUserInfo(tokens.access_token);
        break;

      case 'facebook':
        tokens = await exchangeFacebookCode(code);
        platformInfo = await getFacebookUserInfo(tokens.access_token);
        break;

      case 'instagram':
        tokens = await exchangeInstagramCode(code);
        platformInfo = await getInstagramUserInfo(tokens.access_token);
        break;
    }

    // Save to database
    const { data, error } = await supabase
      .from('user_platform_connections')
      .upsert({
        user_id: userId,
        platform_type: platform,
        platform_name: platformInfo.name,
        platform_user_id: platformInfo.id,
        platform_account_name: platformInfo.email || platformInfo.username,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: tokens.expires_at,
        scope: tokens.scope,
        status: 'active',
        connected_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,platform_type,platform_account_id'
      })
      .select()
      .single();

    if (error) throw error;

    // Redirect back to dashboard
    res.redirect(`/pages/dashboard/settings.html?tab=integrations&connected=${platform}`);

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`/pages/dashboard/settings.html?tab=integrations&error=${encodeURIComponent(error.message)}`);
  }
});

// ============================================
// DISCONNECT PLATFORM
// ============================================
router.delete('/connections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.query.user_id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const { error } = await supabase
      .from('user_platform_connections')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;

    res.json({ success: true });

  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// REFRESH TOKEN
// ============================================
router.post('/connections/:id/refresh', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.query.user_id;

    // Get connection
    const { data: connection } = await supabase
      .from('user_platform_connections')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    // Refresh token
    let newTokens;

    switch (connection.platform_type) {
      case 'gmail':
      case 'google_analytics':
      case 'google_calendar':
        newTokens = await refreshGoogleToken(connection.refresh_token);
        break;

      case 'facebook':
      case 'instagram':
        newTokens = await refreshFacebookToken(connection.access_token);
        break;
    }

    // Update in database
    await supabase
      .from('user_platform_connections')
      .update({
        access_token: newTokens.access_token,
        token_expires_at: newTokens.expires_at,
        status: 'active',
        last_sync_at: new Date().toISOString()
      })
      .eq('id', id);

    res.json({ success: true });

  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HELPER: Get Google OAuth URL
// ============================================
async function getGoogleOAuthUrl(platform, state) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.API_URL}/api/user/platforms/oauth/${platform}/callback`
  );

  const scopes = {
    'gmail': ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    'google_analytics': ['https://www.googleapis.com/auth/analytics.readonly'],
    'google_calendar': ['https://www.googleapis.com/auth/calendar.readonly']
  };

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes[platform] || [],
    state: state
  });
}

// ============================================
// HELPER: Exchange Google code for tokens
// ============================================
async function exchangeGoogleCode(code) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const { tokens } = await oauth2Client.getToken(code);

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(tokens.expiry_date).toISOString(),
    scope: tokens.scope.split(' ')
  };
}

// ============================================
// HELPER: Get Google user info
// ============================================
async function getGoogleUserInfo(accessToken) {
  const oauth2 = google.oauth2({ version: 'v2', auth: accessToken });
  const { data } = await oauth2.userinfo.get();

  return {
    id: data.id,
    name: data.name,
    email: data.email
  };
}

// ============================================
// HELPER: Facebook OAuth (placeholder)
// ============================================
async function getFacebookOAuthUrl(state) {
  const appId = process.env.FACEBOOK_APP_ID;
  const redirectUri = `${process.env.API_URL}/api/user/platforms/oauth/facebook/callback`;
  const scope = 'pages_manage_posts,pages_read_engagement';

  return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${scope}`;
}

async function exchangeFacebookCode(code) {
  // TODO: Implement Facebook token exchange
  throw new Error('Facebook OAuth not implemented yet');
}

async function getFacebookUserInfo(accessToken) {
  // TODO: Implement Facebook user info
  throw new Error('Facebook OAuth not implemented yet');
}

// ============================================
// HELPER: Instagram OAuth (placeholder)
// ============================================
async function getInstagramOAuthUrl(state) {
  // TODO: Implement Instagram OAuth URL
  throw new Error('Instagram OAuth not implemented yet');
}

async function exchangeInstagramCode(code) {
  // TODO: Implement Instagram token exchange
  throw new Error('Instagram OAuth not implemented yet');
}

async function getInstagramUserInfo(accessToken) {
  // TODO: Implement Instagram user info
  throw new Error('Instagram OAuth not implemented yet');
}

// ============================================
// HELPER: Refresh Google token
// ============================================
async function refreshGoogleToken(refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();

  return {
    access_token: credentials.access_token,
    expires_at: new Date(credentials.expiry_date).toISOString()
  };
}

// ============================================
// HELPER: Refresh Facebook token
// ============================================
async function refreshFacebookToken(accessToken) {
  // TODO: Implement Facebook token refresh
  throw new Error('Facebook token refresh not implemented yet');
}

export default router;
