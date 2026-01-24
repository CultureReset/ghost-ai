import express from 'express';
import { supabase } from '../../config/database.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// Apply authentication to all routes
router.use(authenticateToken);

/**
 * GET /api/contacts
 * List all contacts with optional search and filters
 */
router.get('/', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const {
      q,              // Search query
      lifecycle_stage, // Filter by lifecycle stage
      tags,           // Filter by tags (comma-separated)
      limit = 50,
      offset = 0
    } = req.query;

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId)
      .is('deleted_at', null);

    // Search by name, email, phone, or company
    if (q && q.trim()) {
      const searchTerm = `%${q.trim()}%`;
      query = query.or(`first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},email.ilike.${searchTerm},phone.ilike.${searchTerm},company.ilike.${searchTerm}`);
    }

    // Filter by lifecycle stage
    if (lifecycle_stage) {
      query = query.eq('lifecycle_stage', lifecycle_stage);
    }

    // Filter by tags
    if (tags) {
      const tagArray = tags.split(',').map(t => t.trim());
      query = query.contains('tags', tagArray);
    }

    // Pagination
    query = query
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: contacts, error, count } = await query;

    if (error) {
      logger.error('Error fetching contacts:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch contacts'
      });
    }

    res.json({
      success: true,
      data: contacts,
      meta: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (err) {
    logger.error('Contacts list error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/contacts/stats
 * Get contact statistics and counts
 */
router.get('/stats', async (req, res) => {
  try {
    const businessId = req.user.business_id;

    // Get counts by lifecycle stage
    const { data: stageCounts, error: stageError } = await supabase
      .from('contacts')
      .select('lifecycle_stage')
      .eq('business_id', businessId)
      .is('deleted_at', null);

    if (stageError) throw stageError;

    const stats = {
      total: stageCounts.length,
      by_stage: {
        lead: stageCounts.filter(c => c.lifecycle_stage === 'lead').length,
        customer: stageCounts.filter(c => c.lifecycle_stage === 'customer').length,
        partner: stageCounts.filter(c => c.lifecycle_stage === 'partner').length,
        other: stageCounts.filter(c => !c.lifecycle_stage || (c.lifecycle_stage !== 'lead' && c.lifecycle_stage !== 'customer' && c.lifecycle_stage !== 'partner')).length
      }
    };

    res.json({
      success: true,
      data: stats
    });

  } catch (err) {
    logger.error('Contact stats error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contact statistics'
    });
  }
});

/**
 * GET /api/contacts/:id
 * Get single contact by ID with related data
 */
router.get('/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    // Get contact with related leads and tasks
    const { data: contact, error } = await supabase
      .from('contacts')
      .select(`
        *,
        leads (
          id,
          lead_name,
          stage,
          estimated_value_cents,
          created_at
        ),
        tasks (
          id,
          title,
          status,
          priority,
          due_at,
          created_at
        )
      `)
      .eq('business_id', businessId)
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (error || !contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    res.json({
      success: true,
      data: contact
    });

  } catch (err) {
    logger.error('Contact fetch error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contact'
    });
  }
});

/**
 * POST /api/contacts
 * Create a new contact
 */
router.post('/', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const userId = req.user.id;

    const {
      first_name,
      last_name,
      email,
      phone,
      secondary_phone,
      company,
      job_title,
      address,
      city,
      state,
      zip_code,
      country,
      source_type = 'manual',
      source_id,
      tags = [],
      lifecycle_stage,
      lead_score = 0,
      custom_fields = {},
      notes
    } = req.body;

    // Validation
    if (!first_name && !last_name && !email && !phone) {
      return res.status(400).json({
        success: false,
        error: 'At least one of first_name, last_name, email, or phone is required'
      });
    }

    // Check for duplicate email in same business
    if (email) {
      const { data: existing } = await supabase
        .from('contacts')
        .select('id')
        .eq('business_id', businessId)
        .eq('email', email.toLowerCase())
        .is('deleted_at', null)
        .single();

      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'Contact with this email already exists'
        });
      }
    }

    // Create contact
    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({
        business_id: businessId,
        first_name,
        last_name,
        email: email ? email.toLowerCase() : null,
        phone,
        secondary_phone,
        company,
        job_title,
        address,
        city,
        state,
        zip_code,
        country,
        source_type,
        source_id,
        tags,
        lifecycle_stage,
        lead_score,
        custom_fields,
        notes,
        created_by: userId
      })
      .select()
      .single();

    if (error) {
      logger.error('Error creating contact:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create contact'
      });
    }

    logger.info(`Contact created: ${contact.id} by user ${userId}`);

    res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      data: contact
    });

  } catch (err) {
    logger.error('Contact creation error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/contacts/:id
 * Update an existing contact
 */
router.put('/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    // Verify contact belongs to business
    const { data: existing, error: fetchError } = await supabase
      .from('contacts')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', id)
      .is('deleted_at', null)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    const {
      first_name,
      last_name,
      email,
      phone,
      secondary_phone,
      company,
      job_title,
      address,
      city,
      state,
      zip_code,
      country,
      tags,
      lifecycle_stage,
      lead_score,
      custom_fields,
      notes,
      is_active
    } = req.body;

    // Build update object (only include fields that were sent)
    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (first_name !== undefined) updateData.first_name = first_name;
    if (last_name !== undefined) updateData.last_name = last_name;
    if (email !== undefined) updateData.email = email ? email.toLowerCase() : null;
    if (phone !== undefined) updateData.phone = phone;
    if (secondary_phone !== undefined) updateData.secondary_phone = secondary_phone;
    if (company !== undefined) updateData.company = company;
    if (job_title !== undefined) updateData.job_title = job_title;
    if (address !== undefined) updateData.address = address;
    if (city !== undefined) updateData.city = city;
    if (state !== undefined) updateData.state = state;
    if (zip_code !== undefined) updateData.zip_code = zip_code;
    if (country !== undefined) updateData.country = country;
    if (tags !== undefined) updateData.tags = tags;
    if (lifecycle_stage !== undefined) updateData.lifecycle_stage = lifecycle_stage;
    if (lead_score !== undefined) updateData.lead_score = lead_score;
    if (custom_fields !== undefined) updateData.custom_fields = custom_fields;
    if (notes !== undefined) updateData.notes = notes;
    if (is_active !== undefined) updateData.is_active = is_active;

    // Update contact
    const { data: contact, error } = await supabase
      .from('contacts')
      .update(updateData)
      .eq('business_id', businessId)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating contact:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update contact'
      });
    }

    logger.info(`Contact updated: ${id}`);

    res.json({
      success: true,
      message: 'Contact updated successfully',
      data: contact
    });

  } catch (err) {
    logger.error('Contact update error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * DELETE /api/contacts/:id
 * Soft delete a contact (set deleted_at timestamp)
 */
router.delete('/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    // Soft delete: set deleted_at timestamp
    const { data: contact, error } = await supabase
      .from('contacts')
      .update({
        deleted_at: new Date().toISOString(),
        is_active: false
      })
      .eq('business_id', businessId)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    logger.info(`Contact deleted: ${id}`);

    res.json({
      success: true,
      message: 'Contact deleted successfully'
    });

  } catch (err) {
    logger.error('Contact deletion error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/contacts/:id/restore
 * Restore a soft-deleted contact
 */
router.post('/:id/restore', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    const { data: contact, error } = await supabase
      .from('contacts')
      .update({
        deleted_at: null,
        is_active: true
      })
      .eq('business_id', businessId)
      .eq('id', id)
      .select()
      .single();

    if (error || !contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    logger.info(`Contact restored: ${id}`);

    res.json({
      success: true,
      message: 'Contact restored successfully',
      data: contact
    });

  } catch (err) {
    logger.error('Contact restore error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
