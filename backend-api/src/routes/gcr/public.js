// =============================================
// PUBLIC PROFILE ROUTES (No Authentication Required)
// Access business profiles, generate VCF files, QR codes
// =============================================

import express from 'express';
import { supabase } from '../../config/supabase.js';
import logger from '../../config/logger.js';

const router = express.Router();

// ============================================
// GET /api/public/profile/:slug
// Fetch public business profile by slug
// ============================================

router.get('/profile/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // Get business and profile data
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select(`
        id,
        business_name,
        slug,
        industry,
        profiles (
          display_name,
          tagline,
          description,
          logo_url,
          cover_image_url,
          phone,
          email,
          website,
          address,
          city,
          state,
          zip,
          country,
          latitude,
          longitude,
          facebook_url,
          instagram_url,
          twitter_url,
          linkedin_url,
          youtube_url,
          tiktok_url,
          category,
          subcategory,
          tags,
          features,
          theme_color,
          theme_settings,
          view_count,
          contact_count,
          rating_average,
          rating_count,
          verified_review_count,
          is_published
        ),
        business_hours (
          day_of_week,
          opens_at,
          closes_at,
          is_closed,
          notes
        ),
        media (
          id,
          type,
          url,
          thumbnail_url,
          title,
          description,
          display_order
        )
      `)
      .eq('slug', slug)
      .eq('profiles.is_published', true)
      .is('deleted_at', null)
      .single();

    if (businessError || !business) {
      logger.warn(`Profile not found for slug: ${slug}`);
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    // Check if profile exists and is published
    if (!business.profiles || business.profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Profile not published'
      });
    }

    // Increment view count (async, don't wait)
    supabase
      .from('profiles')
      .update({
        view_count: (business.profiles[0].view_count || 0) + 1
      })
      .eq('business_id', business.id)
      .then(() => logger.info(`Incremented view count for ${slug}`))
      .catch(err => logger.error('Failed to increment view count:', err));

    // Format response
    const profile = business.profiles[0];
    const hours = business.business_hours || [];
    const gallery = (business.media || [])
      .filter(m => m.type === 'photo')
      .sort((a, b) => (a.display_order || 999) - (b.display_order || 999));

    res.json({
      success: true,
      data: {
        id: business.id,
        slug: business.slug,
        business_name: business.business_name,
        industry: business.industry,
        display_name: profile.display_name,
        tagline: profile.tagline,
        description: profile.description,
        logo_url: profile.logo_url,
        cover_image_url: profile.cover_image_url,
        contact: {
          phone: profile.phone,
          email: profile.email,
          website: profile.website
        },
        location: {
          address: profile.address,
          city: profile.city,
          state: profile.state,
          zip: profile.zip,
          country: profile.country,
          latitude: profile.latitude,
          longitude: profile.longitude
        },
        social: {
          facebook: profile.facebook_url,
          instagram: profile.instagram_url,
          twitter: profile.twitter_url,
          linkedin: profile.linkedin_url,
          youtube: profile.youtube_url,
          tiktok: profile.tiktok_url
        },
        category: profile.category,
        subcategory: profile.subcategory,
        tags: profile.tags || [],
        features: profile.features || [],
        theme: {
          color: profile.theme_color,
          settings: profile.theme_settings || {}
        },
        stats: {
          views: profile.view_count || 0,
          contacts: profile.contact_count || 0,
          rating: parseFloat(profile.rating_average || 0),
          review_count: profile.rating_count || 0,
          verified_reviews: profile.verified_review_count || 0
        },
        hours: formatBusinessHours(hours),
        gallery: gallery
      }
    });

  } catch (error) {
    logger.error('Get public profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load profile'
    });
  }
});

// ============================================
// GET /api/public/profile/:slug/vcard
// Generate and download VCF file
// ============================================

router.get('/profile/:slug/vcard', async (req, res) => {
  try {
    const { slug } = req.params;

    // Get business profile data
    const { data: business, error } = await supabase
      .from('businesses')
      .select(`
        id,
        business_name,
        slug,
        profiles (
          display_name,
          phone,
          email,
          website,
          address,
          city,
          state,
          zip,
          country,
          logo_url
        )
      `)
      .eq('slug', slug)
      .eq('profiles.is_published', true)
      .is('deleted_at', null)
      .single();

    if (error || !business || !business.profiles || business.profiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    const profile = business.profiles[0];

    // Generate VCF content
    const vcard = generateVCard({
      name: profile.display_name || business.business_name,
      phone: profile.phone,
      email: profile.email,
      website: profile.website,
      slug: business.slug,
      address: {
        street: profile.address,
        city: profile.city,
        state: profile.state,
        zip: profile.zip,
        country: profile.country
      },
      logo: profile.logo_url
    });

    // Track contact download (async)
    supabase
      .from('profiles')
      .update({
        contact_count: ((business.profiles[0].contact_count || 0) + 1)
      })
      .eq('business_id', business.id)
      .then(() => logger.info(`Contact downloaded for ${slug}`))
      .catch(err => logger.error('Failed to track contact download:', err));

    // Send VCF file
    res.set({
      'Content-Type': 'text/vcard',
      'Content-Disposition': `attachment; filename="${slug}.vcf"`
    });
    res.send(vcard);

  } catch (error) {
    logger.error('Generate vCard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate contact card'
    });
  }
});

// ============================================
// GET /api/public/profile/:slug/qrcode
// Generate QR code for profile URL
// ============================================

router.get('/profile/:slug/qrcode', async (req, res) => {
  try {
    const { slug } = req.params;
    const { size = '300' } = req.query;

    // Verify profile exists
    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, slug, profiles(is_published)')
      .eq('slug', slug)
      .eq('profiles.is_published', true)
      .is('deleted_at', null)
      .single();

    if (error || !business) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    // Generate QR code URL (using external service for simplicity)
    const profileUrl = `${process.env.FRONTEND_URL || 'https://cybercheck.app'}/profile/${slug}`;
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(profileUrl)}`;

    res.json({
      success: true,
      data: {
        qr_code_url: qrCodeUrl,
        profile_url: profileUrl
      }
    });

  } catch (error) {
    logger.error('Generate QR code error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate QR code'
    });
  }
});

// ============================================
// GET /api/public/reviews/:slug
// Get public reviews for a business
// ============================================

router.get('/reviews/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { limit = 20, offset = 0, min_rating } = req.query;

    // Get business ID from slug
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('slug', slug)
      .is('deleted_at', null)
      .single();

    if (!business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    // Build query
    let query = supabase
      .from('reviews')
      .select(`
        id,
        overall_rating,
        review_text,
        reviewer_name,
        reviewer_location,
        created_at,
        receipt_verified,
        likes_count,
        helpful_count
      `, { count: 'exact' })
      .eq('business_id', business.id)
      .eq('status', 'approved')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (min_rating) {
      query = query.gte('overall_rating', parseInt(min_rating));
    }

    const { data: reviews, error, count } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      data: reviews || [],
      meta: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (error) {
    logger.error('Get public reviews error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load reviews'
    });
  }
});

// ============================================
// POST /api/public/analytics/click
// Track link clicks for analytics
// ============================================

router.post('/analytics/click', async (req, res) => {
  try {
    const { slug, action, template } = req.body;

    if (!slug || !action) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get business ID from slug
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('slug', slug)
      .is('deleted_at', null)
      .single();

    if (!business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    // Log click event (fire and forget - don't wait for response)
    supabase
      .from('profile_analytics')
      .insert({
        business_id: business.id,
        event_type: 'click',
        action: action,
        template: template || 'unknown',
        user_agent: req.headers['user-agent'] || null,
        ip_address: req.ip || req.connection.remoteAddress || null,
        created_at: new Date().toISOString()
      })
      .then(() => logger.info(`Click tracked: ${slug} - ${action}`))
      .catch(err => logger.error('Failed to track click:', err));

    // Return success immediately
    res.json({
      success: true,
      message: 'Click tracked'
    });

  } catch (error) {
    logger.error('Track click error:', error);
    // Don't fail the request if analytics fails
    res.json({
      success: true,
      message: 'Analytics unavailable'
    });
  }
});

// ============================================
// Helper Functions
// ============================================

/**
 * Generate VCard (VCF) content
 */
function generateVCard(data) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0'
  ];

  if (data.name) {
    lines.push(`FN:${data.name}`);
    lines.push(`ORG:${data.name}`);
  }

  if (data.phone) {
    lines.push(`TEL;TYPE=WORK,VOICE:${data.phone}`);
  }

  if (data.email) {
    lines.push(`EMAIL;TYPE=INTERNET,WORK:${data.email}`);
  }

  if (data.website) {
    lines.push(`URL:${data.website}`);
  }

  // Add CyberCheck profile URL
  if (data.slug) {
    const profileUrl = `${process.env.FRONTEND_URL || 'https://cybercheck.app'}/profile/${data.slug}`;
    lines.push(`URL;TYPE=PROFILE:${profileUrl}`);
    lines.push(`NOTE:View full profile with reviews\\, hours\\, and gallery at ${profileUrl}`);
  }

  if (data.address && data.address.street) {
    const addr = data.address;
    lines.push(`ADR;TYPE=WORK:;;${addr.street || ''};${addr.city || ''};${addr.state || ''};${addr.zip || ''};${addr.country || ''}`);
  }

  if (data.logo) {
    // Note: Logo embedding requires base64 encoding, simplified here
    lines.push(`PHOTO;VALUE=URI:${data.logo}`);
  }

  lines.push('END:VCARD');

  return lines.join('\r\n');
}

/**
 * Format business hours into readable structure
 */
function formatBusinessHours(hours) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const formatted = {};

  for (let i = 0; i < 7; i++) {
    const dayHours = hours.find(h => h.day_of_week === i);

    if (!dayHours || dayHours.is_closed) {
      formatted[dayNames[i]] = {
        open: false,
        hours: 'Closed'
      };
    } else {
      formatted[dayNames[i]] = {
        open: true,
        opens_at: dayHours.opens_at,
        closes_at: dayHours.closes_at,
        hours: `${formatTime(dayHours.opens_at)} - ${formatTime(dayHours.closes_at)}`,
        notes: dayHours.notes || null
      };
    }
  }

  return formatted;
}

/**
 * Format time from 24h to 12h
 */
function formatTime(time) {
  if (!time) return '';

  const [hours, minutes] = time.split(':');
  const hour = parseInt(hours);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;

  return `${displayHour}:${minutes} ${ampm}`;
}

export default router;
