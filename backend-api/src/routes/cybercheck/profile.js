import express from 'express';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/profiles
 * Get all profiles for the authenticated user's business
 */
router.get('/', async (req, res) => {
  try {
    const { status, type } = req.query;

    let query = supabase
      .from('profiles')
      .select(`
        *,
        media (
          id,
          media_type,
          media_url,
          thumbnail_url,
          is_primary,
          display_order
        )
      `)
      .eq('business_id', req.user.business_id)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    if (type) {
      query = query.eq('profile_type', type);
    }

    const { data: profiles, error } = await query;

    if (error) {
      logger.error('Get profiles error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get profiles'
      });
    }

    res.json({
      success: true,
      data: profiles
    });
  } catch (error) {
    logger.error('Get profiles error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/profiles/:id
 * Get single profile by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select(`
        *,
        media (
          id,
          media_type,
          media_url,
          thumbnail_url,
          caption,
          is_primary,
          display_order,
          created_at
        ),
        business_hours (
          day_of_week,
          open_time,
          close_time,
          is_closed
        )
      `)
      .eq('id', id)
      .single();

    if (error || !profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    // Check if user has access to this profile
    if (profile.business_id !== req.user.business_id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: profile
    });
  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/profiles
 * Create new profile
 */
router.post('/', async (req, res) => {
  try {
    const {
      profile_type,
      name,
      slug,
      tagline,
      description,
      phone,
      email,
      website,
      address,
      city,
      state,
      zip_code,
      country,
      latitude,
      longitude,
      logo_url,
      cover_image_url,
      social_links,
      amenities,
      tags,
      settings,
      seo_title,
      seo_description,
      seo_keywords,
      custom_fields
    } = req.body;

    // Validation
    if (!profile_type || !name) {
      return res.status(400).json({
        success: false,
        error: 'profile_type and name are required'
      });
    }

    // Generate slug if not provided
    let finalSlug = slug;
    if (!finalSlug) {
      finalSlug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    }

    // Check if slug already exists for this business
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('business_id', req.user.business_id)
      .eq('slug', finalSlug)
      .single();

    if (existingProfile) {
      // Add random suffix to slug
      finalSlug = `${finalSlug}-${Math.random().toString(36).substring(2, 7)}`;
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .insert({
        business_id: req.user.business_id,
        profile_type,
        name,
        slug: finalSlug,
        tagline,
        description,
        phone,
        email,
        website,
        address,
        city,
        state,
        zip_code,
        country,
        latitude,
        longitude,
        logo_url,
        cover_image_url,
        social_links,
        amenities,
        tags,
        settings,
        seo_title,
        seo_description,
        seo_keywords,
        custom_fields,
        status: 'active'
      })
      .select()
      .single();

    if (error) {
      logger.error('Create profile error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create profile'
      });
    }

    // Log activity
    await supabase.from('activity_log').insert({
      business_id: req.user.business_id,
      user_id: req.user.id,
      action: 'create',
      entity_type: 'profile',
      entity_id: profile.id,
      changes: { after: profile }
    });

    logger.info(`Profile created: ${profile.id} - ${name} by ${req.user.email}`);

    res.status(201).json({
      success: true,
      message: 'Profile created successfully',
      data: profile
    });
  } catch (error) {
    logger.error('Create profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/profiles/:id
 * Update profile
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if profile exists and user has access
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!existingProfile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    if (existingProfile.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const {
      profile_type,
      name,
      slug,
      tagline,
      description,
      phone,
      email,
      website,
      address,
      city,
      state,
      zip_code,
      country,
      latitude,
      longitude,
      logo_url,
      cover_image_url,
      social_links,
      amenities,
      tags,
      settings,
      seo_title,
      seo_description,
      seo_keywords,
      custom_fields,
      status
    } = req.body;

    const updateData = {};
    if (profile_type !== undefined) updateData.profile_type = profile_type;
    if (name !== undefined) updateData.name = name;
    if (slug !== undefined) updateData.slug = slug;
    if (tagline !== undefined) updateData.tagline = tagline;
    if (description !== undefined) updateData.description = description;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (website !== undefined) updateData.website = website;
    if (address !== undefined) updateData.address = address;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (zip_code !== undefined) updateData.zip_code = zip_code;
    if (country !== undefined) updateData.country = country;
    if (latitude !== undefined) updateData.latitude = latitude;
    if (longitude !== undefined) updateData.longitude = longitude;
    if (logo_url !== undefined) updateData.logo_url = logo_url;
    if (cover_image_url !== undefined) updateData.cover_image_url = cover_image_url;
    if (social_links !== undefined) updateData.social_links = social_links;
    if (amenities !== undefined) updateData.amenities = amenities;
    if (tags !== undefined) updateData.tags = tags;
    if (settings !== undefined) updateData.settings = settings;
    if (seo_title !== undefined) updateData.seo_title = seo_title;
    if (seo_description !== undefined) updateData.seo_description = seo_description;
    if (seo_keywords !== undefined) updateData.seo_keywords = seo_keywords;
    if (custom_fields !== undefined) updateData.custom_fields = custom_fields;
    if (status !== undefined) updateData.status = status;

    updateData.updated_at = new Date();

    const { data: profile, error } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Update profile error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update profile'
      });
    }

    // Log activity
    await supabase.from('activity_log').insert({
      business_id: req.user.business_id,
      user_id: req.user.id,
      action: 'update',
      entity_type: 'profile',
      entity_id: id,
      changes: { after: updateData }
    });

    logger.info(`Profile updated: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: profile
    });
  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * DELETE /api/profiles/:id
 * Delete profile (soft delete - set status to deleted)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if profile exists and user has access
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('business_id, name')
      .eq('id', id)
      .single();

    if (!existingProfile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    if (existingProfile.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Soft delete
    const { error } = await supabase
      .from('profiles')
      .update({ status: 'deleted', updated_at: new Date() })
      .eq('id', id);

    if (error) {
      logger.error('Delete profile error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete profile'
      });
    }

    // Log activity
    await supabase.from('activity_log').insert({
      business_id: req.user.business_id,
      user_id: req.user.id,
      action: 'delete',
      entity_type: 'profile',
      entity_id: id,
      changes: { before: { name: existingProfile.name } }
    });

    logger.info(`Profile deleted: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Profile deleted successfully'
    });
  } catch (error) {
    logger.error('Delete profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/profiles/:id/items
 * Get items/menu for profile (restaurants, stores, etc.)
 */
router.get('/:id/items', async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, status } = req.query;

    // Check if profile exists and user has access
    const { data: profile } = await supabase
      .from('profiles')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    if (profile.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let query = supabase
      .from('items')
      .select(`
        *,
        categories (
          id,
          name,
          display_order
        ),
        item_variants (
          id,
          name,
          price,
          is_available
        )
      `)
      .eq('profile_id', id)
      .order('display_order', { ascending: true });

    if (category_id) {
      query = query.eq('category_id', category_id);
    }

    if (status) {
      query = query.eq('status', status);
    }

    const { data: items, error } = await query;

    if (error) {
      logger.error('Get items error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get items'
      });
    }

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    logger.error('Get items error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/profiles/:id/reviews
 * Get reviews for profile
 */
router.get('/:id/reviews', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, limit = 20, offset = 0 } = req.query;

    // Check if profile exists and user has access
    const { data: profile } = await supabase
      .from('profiles')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    if (profile.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let query = supabase
      .from('reviews')
      .select(`
        *,
        users (
          full_name,
          email
        )
      `, { count: 'exact' })
      .eq('profile_id', id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: reviews, error, count } = await query;

    if (error) {
      logger.error('Get reviews error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get reviews'
      });
    }

    // Calculate average rating
    const { data: stats } = await supabase
      .from('reviews')
      .select('overall_rating')
      .eq('profile_id', id)
      .eq('status', 'approved');

    const avgRating = stats && stats.length > 0
      ? stats.reduce((sum, r) => sum + r.overall_rating, 0) / stats.length
      : 0;

    res.json({
      success: true,
      data: {
        reviews,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        },
        stats: {
          total_reviews: count,
          average_rating: avgRating.toFixed(1)
        }
      }
    });
  } catch (error) {
    logger.error('Get reviews error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/profiles/:id/analytics
 * Get analytics for profile
 */
router.get('/:id/analytics', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    // Check if profile exists and user has access
    const { data: profile } = await supabase
      .from('profiles')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    if (profile.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let query = supabase
      .from('page_views')
      .select('*')
      .eq('profile_id', id)
      .order('viewed_at', { ascending: false });

    if (start_date) {
      query = query.gte('viewed_at', start_date);
    }
    if (end_date) {
      query = query.lte('viewed_at', end_date);
    }

    const { data: pageViews, error } = await query.limit(1000);

    if (error) {
      logger.error('Get analytics error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get analytics'
      });
    }

    // Calculate stats
    const totalViews = pageViews.length;
    const uniqueVisitors = new Set(pageViews.map(pv => pv.user_id || pv.session_id)).size;

    res.json({
      success: true,
      data: {
        total_views: totalViews,
        unique_visitors: uniqueVisitors,
        views_by_day: pageViews.reduce((acc, pv) => {
          const date = new Date(pv.viewed_at).toISOString().split('T')[0];
          acc[date] = (acc[date] || 0) + 1;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    logger.error('Get analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
