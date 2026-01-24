import express from 'express';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';
import crypto from 'crypto';

const router = express.Router();

// Facebook App credentials (from environment variables)
const FB_APP_ID = process.env.FACEBOOK_APP_ID;
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
const FB_API_VERSION = 'v18.0';
const REDIRECT_URI = process.env.SOCIAL_MEDIA_REDIRECT_URI || 'http://localhost:3000/api/social-media/callback/facebook';

// All routes require authentication except callbacks
router.use((req, res, next) => {
  if (req.path.startsWith('/callback') || req.path.startsWith('/public')) {
    return next();
  }
  return authenticateToken(req, res, next);
});

// =============================================
// OAUTH FLOW
// =============================================

/**
 * GET /api/social-media/connect/facebook
 * Initiate Facebook OAuth flow
 */
router.get('/connect/facebook', (req, res) => {
  try {
    // Generate state parameter for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Store state in session or temporary storage
    // For now, we'll encode business_id in state
    const stateData = {
      business_id: req.user.business_id,
      user_id: req.user.id,
      timestamp: Date.now()
    };
    const encodedState = Buffer.from(JSON.stringify(stateData)).toString('base64');

    // Facebook OAuth URL
    const fbAuthUrl = new URL(`https://www.facebook.com/${FB_API_VERSION}/dialog/oauth`);
    fbAuthUrl.searchParams.append('client_id', FB_APP_ID);
    fbAuthUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    fbAuthUrl.searchParams.append('state', encodedState);
    fbAuthUrl.searchParams.append('scope', [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'instagram_basic',
      'instagram_content_publish',
      'business_management'
    ].join(','));
    fbAuthUrl.searchParams.append('response_type', 'code');

    logger.info(`Initiating Facebook OAuth for business: ${req.user.business_id}`);

    res.json({
      success: true,
      data: {
        auth_url: fbAuthUrl.toString()
      }
    });
  } catch (error) {
    logger.error('Facebook OAuth initiation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/social-media/callback/facebook
 * Handle Facebook OAuth callback
 */
router.get('/callback/facebook', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors
    if (error) {
      logger.error('Facebook OAuth error:', error, error_description);
      return res.redirect(`/pages/dashboard/settings.html?error=${encodeURIComponent(error_description || error)}`);
    }

    // Decode state
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const { business_id, user_id } = stateData;

    // Exchange code for access token
    const tokenUrl = new URL(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.append('client_id', FB_APP_ID);
    tokenUrl.searchParams.append('client_secret', FB_APP_SECRET);
    tokenUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    tokenUrl.searchParams.append('code', code);

    const tokenResponse = await fetch(tokenUrl.toString());
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(tokenData.error?.message || 'Failed to exchange code for token');
    }

    const { access_token, token_type, expires_in } = tokenData;
    const expiresAt = new Date(Date.now() + (expires_in * 1000));

    logger.info(`Received Facebook access token for business: ${business_id}`);

    // Get user's Facebook Pages
    const pagesResponse = await fetch(
      `https://graph.facebook.com/${FB_API_VERSION}/me/accounts?access_token=${access_token}`
    );
    const pagesData = await pagesResponse.json();

    if (!pagesResponse.ok) {
      throw new Error(pagesData.error?.message || 'Failed to fetch Facebook pages');
    }

    // Store connections for each page
    const pages = pagesData.data || [];
    const connections = [];

    for (const page of pages) {
      // Get Instagram account linked to this page
      const igResponse = await fetch(
        `https://graph.facebook.com/${FB_API_VERSION}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
      );
      const igData = await igResponse.json();

      // Store Facebook Page connection
      const { data: fbConnection, error: fbError } = await supabase
        .from('social_media_connections')
        .upsert({
          business_id,
          platform: 'facebook',
          access_token: page.access_token, // Use page access token
          token_expires_at: null, // Page tokens don't expire
          facebook_page_id: page.id,
          facebook_page_name: page.name,
          facebook_page_access_token: page.access_token,
          display_on_profile: true,
          auto_sync: true,
          permissions_granted: page.perms || [],
          updated_at: new Date()
        }, {
          onConflict: 'business_id,platform,facebook_page_id'
        })
        .select()
        .single();

      if (fbError) {
        logger.error('Failed to store Facebook connection:', fbError);
      } else {
        connections.push(fbConnection);
        logger.info(`Stored Facebook connection for page: ${page.name}`);
      }

      // Store Instagram connection if available
      if (igData.instagram_business_account) {
        const igAccountId = igData.instagram_business_account.id;

        // Get Instagram account details
        const igDetailsResponse = await fetch(
          `https://graph.facebook.com/${FB_API_VERSION}/${igAccountId}?fields=username,profile_picture_url&access_token=${page.access_token}`
        );
        const igDetails = await igDetailsResponse.json();

        const { data: igConnection, error: igError } = await supabase
          .from('social_media_connections')
          .upsert({
            business_id,
            platform: 'instagram',
            access_token: page.access_token, // Use page access token
            token_expires_at: null,
            facebook_page_id: page.id, // Link to parent page
            instagram_account_id: igAccountId,
            instagram_username: igDetails.username,
            display_on_profile: true,
            auto_sync: true,
            account_data: igDetails,
            updated_at: new Date()
          }, {
            onConflict: 'business_id,platform,instagram_account_id'
          })
          .select()
          .single();

        if (igError) {
          logger.error('Failed to store Instagram connection:', igError);
        } else {
          connections.push(igConnection);
          logger.info(`Stored Instagram connection for: ${igDetails.username}`);
        }
      }
    }

    // Enable social feed display
    await supabase
      .from('businesses')
      .update({ display_social_feed: true })
      .eq('id', business_id);

    // Trigger initial sync
    for (const connection of connections) {
      syncFeed(connection.id).catch(err => {
        logger.error(`Initial sync failed for connection ${connection.id}:`, err);
      });
    }

    // Redirect to settings page with success message
    res.redirect('/pages/dashboard/settings.html?social_media=connected&pages=' + pages.length);

  } catch (error) {
    logger.error('Facebook OAuth callback error:', error);
    res.redirect(`/pages/dashboard/settings.html?error=${encodeURIComponent(error.message)}`);
  }
});

// =============================================
// CONNECTION MANAGEMENT
// =============================================

/**
 * GET /api/social-media/connections
 * Get all social media connections for business
 */
router.get('/connections', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('social_media_connections')
      .select('*')
      .eq('business_id', req.user.business_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Remove sensitive tokens from response
    const sanitized = data.map(conn => ({
      ...conn,
      access_token: undefined,
      refresh_token: undefined,
      facebook_page_access_token: undefined
    }));

    res.json({
      success: true,
      data: sanitized
    });
  } catch (error) {
    logger.error('Get connections error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/social-media/connections/:id
 * Update connection settings
 */
router.put('/connections/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { display_on_profile, auto_sync, sync_interval_minutes } = req.body;

    const { data, error } = await supabase
      .from('social_media_connections')
      .update({
        display_on_profile,
        auto_sync,
        sync_interval_minutes,
        updated_at: new Date()
      })
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Update connection error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/social-media/connections/:id
 * Disconnect social media account
 */
router.delete('/connections/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('social_media_connections')
      .delete()
      .eq('id', id)
      .eq('business_id', req.user.business_id);

    if (error) throw error;

    logger.info(`Disconnected social media connection: ${id}`);

    res.json({
      success: true,
      message: 'Social media account disconnected'
    });
  } catch (error) {
    logger.error('Delete connection error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/social-media/connections/:id/sync
 * Manually trigger feed sync
 */
router.post('/connections/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify connection belongs to business
    const { data: connection, error } = await supabase
      .from('social_media_connections')
      .select('*')
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (error || !connection) {
      return res.status(404).json({
        success: false,
        error: 'Connection not found'
      });
    }

    // Trigger sync asynchronously
    syncFeed(id).catch(err => {
      logger.error(`Manual sync failed for connection ${id}:`, err);
    });

    res.json({
      success: true,
      message: 'Feed sync started'
    });
  } catch (error) {
    logger.error('Trigger sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// POSTS
// =============================================

/**
 * GET /api/social-media/posts
 * Get social media posts for business
 */
router.get('/posts', async (req, res) => {
  try {
    const { platform, limit = 20, offset = 0 } = req.query;

    let query = supabase
      .from('social_media_posts')
      .select('*')
      .eq('business_id', req.user.business_id)
      .eq('visible_on_profile', true)
      .order('posted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (platform) {
      query = query.eq('platform', platform);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    logger.error('Get posts error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/social-media/posts/:id
 * Update post settings (visibility, pinned)
 */
router.put('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { visible_on_profile, pinned } = req.body;

    const { data, error } = await supabase
      .from('social_media_posts')
      .update({
        visible_on_profile,
        pinned,
        last_updated: new Date()
      })
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Update post error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// PUBLIC ROUTES
// =============================================

/**
 * GET /api/social-media/public/:slug/posts
 * Get public social media feed for profile page
 */
router.get('/public/:slug/posts', async (req, res) => {
  try {
    const { slug } = req.params;
    const { platform, limit = 12 } = req.query;

    // Get business by slug
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('id, display_social_feed, social_feed_limit')
      .eq('slug', slug)
      .single();

    if (businessError || !business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    if (!business.display_social_feed) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Use stored procedure for efficient query
    const platforms = platform ? [platform] : ['facebook', 'instagram'];
    const postLimit = Math.min(parseInt(limit), business.social_feed_limit || 12);

    const { data: posts, error } = await supabase
      .rpc('get_profile_social_posts', {
        p_business_id: business.id,
        p_limit: postLimit,
        p_platforms: platforms
      });

    if (error) throw error;

    res.json({
      success: true,
      data: posts || []
    });
  } catch (error) {
    logger.error('Get public posts error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// FEED SYNC FUNCTION
// =============================================

/**
 * Sync feed for a specific connection
 * @param {string} connectionId - Connection ID to sync
 */
async function syncFeed(connectionId) {
  const startTime = Date.now();
  let syncLogId = null;

  try {
    // Get connection
    const { data: connection, error: connError } = await supabase
      .from('social_media_connections')
      .select('*')
      .eq('id', connectionId)
      .single();

    if (connError || !connection) {
      throw new Error('Connection not found');
    }

    // Create sync log
    const { data: syncLog, error: logError } = await supabase
      .from('social_media_sync_log')
      .insert({
        connection_id: connectionId,
        business_id: connection.business_id,
        sync_status: 'running'
      })
      .select()
      .single();

    if (logError) throw logError;
    syncLogId = syncLog.id;

    logger.info(`Starting sync for connection ${connectionId} (${connection.platform})`);

    let posts = [];
    let apiCallsMade = 0;

    // Fetch posts based on platform
    if (connection.platform === 'facebook') {
      posts = await fetchFacebookPosts(connection);
      apiCallsMade = 1;
    } else if (connection.platform === 'instagram') {
      posts = await fetchInstagramPosts(connection);
      apiCallsMade = 1;
    }

    // Store posts in database
    let created = 0;
    let updated = 0;

    for (const post of posts) {
      const { data, error } = await supabase
        .from('social_media_posts')
        .upsert({
          connection_id: connectionId,
          business_id: connection.business_id,
          platform: connection.platform,
          ...post,
          fetched_at: new Date()
        }, {
          onConflict: 'connection_id,post_id'
        })
        .select();

      if (!error) {
        if (data[0].created_at === data[0].fetched_at) {
          created++;
        } else {
          updated++;
        }
      }
    }

    const duration = Date.now() - startTime;

    // Update sync log
    await supabase
      .from('social_media_sync_log')
      .update({
        sync_completed_at: new Date(),
        sync_status: 'completed',
        posts_fetched: posts.length,
        posts_created: created,
        posts_updated: updated,
        duration_ms: duration,
        api_calls_made: apiCallsMade
      })
      .eq('id', syncLogId);

    logger.info(`Sync completed for connection ${connectionId}: ${posts.length} posts fetched, ${created} created, ${updated} updated`);

  } catch (error) {
    logger.error(`Sync failed for connection ${connectionId}:`, error);

    if (syncLogId) {
      await supabase
        .from('social_media_sync_log')
        .update({
          sync_completed_at: new Date(),
          sync_status: 'failed',
          error_message: error.message,
          error_details: { stack: error.stack },
          duration_ms: Date.now() - startTime
        })
        .eq('id', syncLogId);
    }
  }
}

/**
 * Fetch Facebook posts
 */
async function fetchFacebookPosts(connection) {
  const accessToken = connection.facebook_page_access_token || connection.access_token;
  const pageId = connection.facebook_page_id;

  const url = new URL(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/posts`);
  url.searchParams.append('access_token', accessToken);
  url.searchParams.append('fields', [
    'id',
    'message',
    'story',
    'created_time',
    'type',
    'full_picture',
    'permalink_url',
    'likes.summary(true)',
    'comments.summary(true)',
    'shares'
  ].join(','));
  url.searchParams.append('limit', '25');

  const response = await fetch(url.toString());
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to fetch Facebook posts');
  }

  return (data.data || []).map(post => ({
    post_id: post.id,
    post_type: post.type,
    message: post.message,
    story: post.story,
    media_url: post.full_picture,
    permalink: post.permalink_url,
    likes_count: post.likes?.summary?.total_count || 0,
    comments_count: post.comments?.summary?.total_count || 0,
    shares_count: post.shares?.count || 0,
    posted_at: new Date(post.created_time),
    raw_data: post
  }));
}

/**
 * Fetch Instagram posts
 */
async function fetchInstagramPosts(connection) {
  const accessToken = connection.access_token;
  const accountId = connection.instagram_account_id;

  const url = new URL(`https://graph.facebook.com/${FB_API_VERSION}/${accountId}/media`);
  url.searchParams.append('access_token', accessToken);
  url.searchParams.append('fields', [
    'id',
    'caption',
    'media_type',
    'media_url',
    'thumbnail_url',
    'permalink',
    'timestamp',
    'like_count',
    'comments_count'
  ].join(','));
  url.searchParams.append('limit', '25');

  const response = await fetch(url.toString());
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Failed to fetch Instagram posts');
  }

  return (data.data || []).map(post => ({
    post_id: post.id,
    post_type: post.media_type?.toLowerCase(),
    caption: post.caption,
    media_type: post.media_type === 'VIDEO' ? 'video' : 'image',
    media_url: post.media_url,
    thumbnail_url: post.thumbnail_url,
    permalink: post.permalink,
    likes_count: post.like_count || 0,
    comments_count: post.comments_count || 0,
    posted_at: new Date(post.timestamp),
    raw_data: post
  }));
}

// Export sync function for background jobs
export { syncFeed };
export default router;
