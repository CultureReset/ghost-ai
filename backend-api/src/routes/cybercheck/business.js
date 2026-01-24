import express from 'express';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/businesses/:id
 * Get business details
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user has access to this business
    if (req.user.business_id !== id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const { data: business, error } = await supabase
      .from('businesses')
      .select(`
        *,
        subscriptions (
          plan_tier,
          status,
          trial_ends_at,
          current_period_end
        )
      `)
      .eq('id', id)
      .single();

    if (error || !business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    res.json({
      success: true,
      data: business
    });
  } catch (error) {
    logger.error('Get business error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/businesses/:id
 * Update business details
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Check if user is owner or admin
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only business owner or admin can update business details'
      });
    }

    const {
      name,
      business_type,
      industry,
      description,
      website,
      phone,
      email,
      address,
      city,
      state,
      zip_code,
      country,
      logo_url,
      cover_image_url,
      timezone,
      currency,
      settings
    } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (business_type !== undefined) updateData.business_type = business_type;
    if (industry !== undefined) updateData.industry = industry;
    if (description !== undefined) updateData.description = description;
    if (website !== undefined) updateData.website = website;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (address !== undefined) updateData.address = address;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (zip_code !== undefined) updateData.zip_code = zip_code;
    if (country !== undefined) updateData.country = country;
    if (logo_url !== undefined) updateData.logo_url = logo_url;
    if (cover_image_url !== undefined) updateData.cover_image_url = cover_image_url;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (currency !== undefined) updateData.currency = currency;
    if (settings !== undefined) updateData.settings = settings;

    updateData.updated_at = new Date();

    const { data: business, error } = await supabase
      .from('businesses')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Update business error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update business'
      });
    }

    // Log activity
    await supabase.from('activity_log').insert({
      business_id: id,
      user_id: req.user.id,
      action: 'update',
      entity_type: 'business',
      entity_id: id,
      changes: { after: updateData }
    });

    logger.info(`Business updated: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Business updated successfully',
      data: business
    });
  } catch (error) {
    logger.error('Update business error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/businesses/:id/hours
 * Get business hours
 */
router.get('/:id/hours', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user has access to this business
    if (req.user.business_id !== id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const { data: hours, error } = await supabase
      .from('business_hours')
      .select('*')
      .eq('business_id', id)
      .order('day_of_week', { ascending: true });

    if (error) {
      logger.error('Get business hours error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get business hours'
      });
    }

    res.json({
      success: true,
      data: hours || []
    });
  } catch (error) {
    logger.error('Get business hours error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/businesses/:id/hours
 * Create or update business hours
 */
router.post('/:id/hours', async (req, res) => {
  try {
    const { id } = req.params;
    const { hours } = req.body; // Array of hours objects

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (!Array.isArray(hours)) {
      return res.status(400).json({
        success: false,
        error: 'Hours must be an array'
      });
    }

    // Delete existing hours
    await supabase
      .from('business_hours')
      .delete()
      .eq('business_id', id);

    // Insert new hours
    const hoursToInsert = hours.map(hour => ({
      business_id: id,
      day_of_week: hour.day_of_week,
      open_time: hour.open_time,
      close_time: hour.close_time,
      is_closed: hour.is_closed || false
    }));

    const { data: newHours, error } = await supabase
      .from('business_hours')
      .insert(hoursToInsert)
      .select();

    if (error) {
      logger.error('Update business hours error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update business hours'
      });
    }

    logger.info(`Business hours updated: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Business hours updated successfully',
      data: newHours
    });
  } catch (error) {
    logger.error('Update business hours error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/businesses/:id/analytics
 * Get business analytics summary
 */
router.get('/:id/analytics', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    let query = supabase
      .from('business_analytics_daily')
      .select('*')
      .eq('business_id', id)
      .order('date', { ascending: false });

    if (start_date) {
      query = query.gte('date', start_date);
    }
    if (end_date) {
      query = query.lte('date', end_date);
    }

    const { data: analytics, error } = await query.limit(30);

    if (error) {
      logger.error('Get analytics error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get analytics'
      });
    }

    // Calculate totals
    const totals = analytics.reduce((acc, day) => ({
      total_views: acc.total_views + (day.total_views || 0),
      unique_visitors: acc.unique_visitors + (day.unique_visitors || 0),
      total_inquiries: acc.total_inquiries + (day.total_inquiries || 0),
      total_reservations: acc.total_reservations + (day.total_reservations || 0),
      total_reviews: acc.total_reviews + (day.total_reviews || 0),
      avg_rating: acc.avg_rating + (day.avg_rating || 0)
    }), {
      total_views: 0,
      unique_visitors: 0,
      total_inquiries: 0,
      total_reservations: 0,
      total_reviews: 0,
      avg_rating: 0
    });

    if (analytics.length > 0) {
      totals.avg_rating = totals.avg_rating / analytics.length;
    }

    res.json({
      success: true,
      data: {
        daily: analytics,
        totals,
        period: {
          start: start_date || analytics[analytics.length - 1]?.date,
          end: end_date || analytics[0]?.date
        }
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

/**
 * GET /api/businesses/:id/team
 * Get team members
 */
router.get('/:id/team', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const { data: team, error } = await supabase
      .from('users')
      .select('id, email, full_name, phone, role, status, created_at')
      .eq('business_id', id)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Get team error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get team members'
      });
    }

    res.json({
      success: true,
      data: team
    });
  } catch (error) {
    logger.error('Get team error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/businesses/:id/team
 * Invite team member
 */
router.post('/:id/team', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, full_name, role } = req.body;

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Only owner or admin can invite team members
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only business owner or admin can invite team members'
      });
    }

    if (!email || !full_name || !role) {
      return res.status(400).json({
        success: false,
        error: 'Email, full_name, and role are required'
      });
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Generate temporary password
    const tempPassword = Math.random().toString(36).slice(-12);
    const bcrypt = await import('bcryptjs');
    const password_hash = await bcrypt.hash(tempPassword, 10);

    // Create user
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash,
        full_name,
        business_id: id,
        role,
        status: 'active'
      })
      .select('id, email, full_name, role, status, created_at')
      .single();

    if (error) {
      logger.error('Create team member error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create team member'
      });
    }

    // Queue invitation email
    await supabase.from('email_queue').insert({
      to_email: email,
      from_email: 'noreply@cybercheck.com',
      from_name: 'CyberCheck',
      subject: 'You\'ve been invited to join a team on CyberCheck',
      html_body: `
        <h2>Team Invitation</h2>
        <p>Hi ${full_name},</p>
        <p>You've been invited to join a team on CyberCheck.</p>
        <p><strong>Temporary Password:</strong> ${tempPassword}</p>
        <p><a href="${process.env.FRONTEND_URL}/login">Login Now</a></p>
        <p>Please change your password after your first login.</p>
      `,
      business_id: id,
      user_id: req.user.id,
      status: 'pending'
    });

    logger.info(`Team member invited: ${email} to business ${id}`);

    res.status(201).json({
      success: true,
      message: 'Team member invited successfully',
      data: newUser
    });
  } catch (error) {
    logger.error('Invite team member error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * DELETE /api/businesses/:id/team/:userId
 * Remove team member
 */
router.delete('/:id/team/:userId', async (req, res) => {
  try {
    const { id, userId } = req.params;

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Only owner or admin can remove team members
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only business owner or admin can remove team members'
      });
    }

    // Can't remove yourself
    if (userId === req.user.id) {
      return res.status(400).json({
        success: false,
        error: 'You cannot remove yourself from the team'
      });
    }

    // Check if user exists and belongs to this business
    const { data: userToRemove } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', userId)
      .eq('business_id', id)
      .single();

    if (!userToRemove) {
      return res.status(404).json({
        success: false,
        error: 'User not found or does not belong to this business'
      });
    }

    // Can't remove owner
    if (userToRemove.role === 'owner') {
      return res.status(400).json({
        success: false,
        error: 'Cannot remove business owner'
      });
    }

    // Deactivate user instead of deleting (to preserve data integrity)
    const { error } = await supabase
      .from('users')
      .update({ status: 'inactive', updated_at: new Date() })
      .eq('id', userId);

    if (error) {
      logger.error('Remove team member error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to remove team member'
      });
    }

    logger.info(`Team member removed: ${userId} from business ${id}`);

    res.json({
      success: true,
      message: 'Team member removed successfully'
    });
  } catch (error) {
    logger.error('Remove team member error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/businesses/:id/gcr-visibility
 * Update GCR visibility setting
 */
router.put('/:id/gcr-visibility', async (req, res) => {
  try {
    const { id } = req.params;
    const { show_on_gcr } = req.body;

    // Check if user has access to this business
    if (req.user.business_id !== id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Check if user is owner or admin
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only business owner or admin can update GCR visibility'
      });
    }

    if (typeof show_on_gcr !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'show_on_gcr must be a boolean value'
      });
    }

    // Update the businesses table
    const { data: business, error } = await supabase
      .from('businesses')
      .update({
        show_on_gcr,
        updated_at: new Date()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Update GCR visibility error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update GCR visibility'
      });
    }

    // Also update gcr_businesses table if the business exists there
    const { data: gcrBusiness } = await supabase
      .from('gcr_businesses')
      .select('id')
      .eq('business_id', id)
      .single();

    if (gcrBusiness) {
      await supabase
        .from('gcr_businesses')
        .update({
          show_on_gcr,
          updated_at: new Date()
        })
        .eq('business_id', id);
    }

    // Log activity
    await supabase.from('activity_log').insert({
      business_id: id,
      user_id: req.user.id,
      action: 'update',
      entity_type: 'business',
      entity_id: id,
      changes: {
        field: 'show_on_gcr',
        from: !show_on_gcr,
        to: show_on_gcr
      }
    });

    logger.info(`GCR visibility updated: ${id} to ${show_on_gcr} by ${req.user.email}`);

    res.json({
      success: true,
      message: `Business ${show_on_gcr ? 'will now appear' : 'is now hidden'} on Gulf Coast Radar`,
      business
    });
  } catch (error) {
    logger.error('Update GCR visibility error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
