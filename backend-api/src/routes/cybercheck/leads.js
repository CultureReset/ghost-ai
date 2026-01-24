import express from 'express';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/leads
 * Get all leads for business with filtering and pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      stage,
      assigned_to,
      contact_id,
      min_value,
      max_value,
      search,
      sort_by = 'created_at',
      sort_order = 'desc',
      limit = 50,
      offset = 0
    } = req.query;

    let query = supabase
      .from('leads')
      .select('*, contact:contacts(id, first_name, last_name, email, phone), assigned_user:users!assigned_to(id, full_name)', { count: 'exact' })
      .eq('business_id', req.user.business_id);

    // Filters
    if (stage) {
      query = query.eq('stage', stage);
    }

    if (assigned_to) {
      query = query.eq('assigned_to', assigned_to);
    }

    if (contact_id) {
      query = query.eq('contact_id', contact_id);
    }

    if (min_value) {
      query = query.gte('estimated_value_cents', parseInt(min_value));
    }

    if (max_value) {
      query = query.lte('estimated_value_cents', parseInt(max_value));
    }

    if (search) {
      query = query.or(`lead_name.ilike.%${search}%,notes.ilike.%${search}%`);
    }

    // Sorting
    query = query.order(sort_by, { ascending: sort_order === 'asc' });

    // Pagination
    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: leads, error, count } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: {
        leads,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    logger.error('Get leads error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get leads'
    });
  }
});

/**
 * GET /api/leads/pipeline
 * Get leads organized by pipeline stages
 */
router.get('/pipeline', async (req, res) => {
  try {
    const { assigned_to } = req.query;

    let query = supabase
      .from('leads')
      .select('*, contact:contacts(id, first_name, last_name, email, phone), assigned_user:users!assigned_to(id, full_name)')
      .eq('business_id', req.user.business_id)
      .order('stage_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (assigned_to) {
      query = query.eq('assigned_to', assigned_to);
    }

    const { data: leads, error } = await query;

    if (error) throw error;

    // Organize by stage
    const pipeline = {
      new: [],
      contacted: [],
      qualified: [],
      proposal: [],
      negotiation: [],
      won: [],
      lost: []
    };

    leads.forEach(lead => {
      const stage = lead.stage || 'new';
      if (pipeline[stage]) {
        pipeline[stage].push(lead);
      }
    });

    // Calculate stage totals
    const stageTotals = {};
    Object.keys(pipeline).forEach(stage => {
      stageTotals[stage] = {
        count: pipeline[stage].length,
        total_value_cents: pipeline[stage].reduce((sum, lead) => sum + (lead.estimated_value_cents || 0), 0)
      };
    });

    res.json({
      success: true,
      data: {
        pipeline,
        stage_totals: stageTotals,
        total_leads: leads.length,
        total_value_cents: leads.reduce((sum, lead) => sum + (lead.estimated_value_cents || 0), 0)
      }
    });
  } catch (error) {
    logger.error('Get pipeline error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get pipeline'
    });
  }
});

/**
 * GET /api/leads/stats
 * Get lead statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = supabase
      .from('leads')
      .select('*')
      .eq('business_id', req.user.business_id);

    if (start_date) {
      query = query.gte('created_at', start_date);
    }

    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    const { data: leads, error } = await query;

    if (error) throw error;

    const stats = {
      total_leads: leads.length,
      by_stage: {},
      total_value_cents: 0,
      won_value_cents: 0,
      conversion_rate: 0,
      avg_deal_size_cents: 0
    };

    // Calculate stats
    const stageCount = {};
    leads.forEach(lead => {
      const stage = lead.stage || 'new';
      stageCount[stage] = (stageCount[stage] || 0) + 1;
      stats.total_value_cents += lead.estimated_value_cents || 0;

      if (stage === 'won') {
        stats.won_value_cents += lead.estimated_value_cents || 0;
      }
    });

    stats.by_stage = stageCount;
    stats.conversion_rate = leads.length > 0
      ? ((stageCount['won'] || 0) / leads.length * 100).toFixed(2)
      : 0;
    stats.avg_deal_size_cents = leads.length > 0
      ? Math.round(stats.total_value_cents / leads.length)
      : 0;

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Get leads stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get lead statistics'
    });
  }
});

/**
 * GET /api/leads/:id
 * Get single lead by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: lead, error } = await supabase
      .from('leads')
      .select(`
        *,
        contact:contacts(*),
        assigned_user:users!assigned_to(id, full_name, email),
        tasks:tasks(id, title, status, due_at, priority),
        notes:notes(id, title, content, created_at, user:users(id, full_name)),
        activities:activities(id, type, description, created_at, user:users(id, full_name))
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!lead || lead.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found'
      });
    }

    res.json({
      success: true,
      data: lead
    });
  } catch (error) {
    logger.error('Get lead error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get lead'
    });
  }
});

/**
 * POST /api/leads
 * Create new lead
 */
router.post('/', async (req, res) => {
  try {
    const {
      lead_name,
      contact_id,
      stage = 'new',
      estimated_value_cents = 0,
      product_interest = [],
      notes,
      source_type = 'manual',
      assigned_to
    } = req.body;

    if (!lead_name) {
      return res.status(400).json({
        success: false,
        error: 'lead_name is required'
      });
    }

    // Verify contact belongs to business if provided
    if (contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('business_id')
        .eq('id', contact_id)
        .single();

      if (!contact || contact.business_id !== req.user.business_id) {
        return res.status(400).json({
          success: false,
          error: 'Invalid contact_id'
        });
      }
    }

    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        business_id: req.user.business_id,
        lead_name,
        contact_id: contact_id || null,
        stage,
        estimated_value_cents,
        product_interest,
        notes: notes || '',
        source_type,
        assigned_to: assigned_to || req.user.id,
        stage_changed_at: new Date()
      })
      .select('*, contact:contacts(id, first_name, last_name, email, phone)')
      .single();

    if (error) throw error;

    // Log activity
    await supabase.from('activities').insert({
      business_id: req.user.business_id,
      user_id: req.user.id,
      lead_id: lead.id,
      type: 'lead_created',
      description: `Lead "${lead_name}" created`
    });

    logger.info(`Lead created: ${lead.id} by user: ${req.user.id}`);

    res.status(201).json({
      success: true,
      message: 'Lead created successfully',
      data: lead
    });
  } catch (error) {
    logger.error('Create lead error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create lead'
    });
  }
});

/**
 * PUT /api/leads/:id
 * Update lead
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      lead_name,
      contact_id,
      stage,
      estimated_value_cents,
      product_interest,
      notes,
      assigned_to,
      stage_order
    } = req.body;

    // Verify lead belongs to business
    const { data: existingLead } = await supabase
      .from('leads')
      .select('business_id, stage')
      .eq('id', id)
      .single();

    if (!existingLead || existingLead.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found'
      });
    }

    const updates = {};
    if (lead_name !== undefined) updates.lead_name = lead_name;
    if (contact_id !== undefined) updates.contact_id = contact_id;
    if (estimated_value_cents !== undefined) updates.estimated_value_cents = estimated_value_cents;
    if (product_interest !== undefined) updates.product_interest = product_interest;
    if (notes !== undefined) updates.notes = notes;
    if (assigned_to !== undefined) updates.assigned_to = assigned_to;
    if (stage_order !== undefined) updates.stage_order = stage_order;

    // Track stage changes
    if (stage !== undefined && stage !== existingLead.stage) {
      updates.stage = stage;
      updates.stage_changed_at = new Date();
      updates.previous_stage = existingLead.stage;

      // Log stage change activity
      await supabase.from('activities').insert({
        business_id: req.user.business_id,
        user_id: req.user.id,
        lead_id: id,
        type: 'stage_changed',
        description: `Stage changed from "${existingLead.stage}" to "${stage}"`
      });
    }

    updates.updated_at = new Date();

    const { data: lead, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', id)
      .select('*, contact:contacts(id, first_name, last_name, email, phone)')
      .single();

    if (error) throw error;

    logger.info(`Lead updated: ${id} by user: ${req.user.id}`);

    res.json({
      success: true,
      message: 'Lead updated successfully',
      data: lead
    });
  } catch (error) {
    logger.error('Update lead error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update lead'
    });
  }
});

/**
 * DELETE /api/leads/:id
 * Delete lead
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify lead belongs to business
    const { data: existingLead } = await supabase
      .from('leads')
      .select('business_id, lead_name')
      .eq('id', id)
      .single();

    if (!existingLead || existingLead.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found'
      });
    }

    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', id);

    if (error) throw error;

    logger.info(`Lead deleted: ${id} by user: ${req.user.id}`);

    res.json({
      success: true,
      message: 'Lead deleted successfully'
    });
  } catch (error) {
    logger.error('Delete lead error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete lead'
    });
  }
});

/**
 * POST /api/leads/:id/notes
 * Add note to lead
 */
router.post('/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'content is required'
      });
    }

    // Verify lead belongs to business
    const { data: lead } = await supabase
      .from('leads')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!lead || lead.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found'
      });
    }

    const { data: note, error } = await supabase
      .from('notes')
      .insert({
        business_id: req.user.business_id,
        user_id: req.user.id,
        lead_id: id,
        title: title || 'Lead Note',
        content,
        note_type: 'lead'
      })
      .select('*, user:users(id, full_name)')
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Note added successfully',
      data: note
    });
  } catch (error) {
    logger.error('Add lead note error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add note'
    });
  }
});

/**
 * POST /api/leads/:id/activities
 * Log activity for lead
 */
router.post('/:id/activities', async (req, res) => {
  try {
    const { id } = req.params;
    const { type, description, metadata } = req.body;

    if (!type || !description) {
      return res.status(400).json({
        success: false,
        error: 'type and description are required'
      });
    }

    // Verify lead belongs to business
    const { data: lead } = await supabase
      .from('leads')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!lead || lead.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Lead not found'
      });
    }

    const { data: activity, error } = await supabase
      .from('activities')
      .insert({
        business_id: req.user.business_id,
        user_id: req.user.id,
        lead_id: id,
        type,
        description,
        metadata: metadata || {}
      })
      .select('*, user:users(id, full_name)')
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Activity logged successfully',
      data: activity
    });
  } catch (error) {
    logger.error('Log lead activity error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to log activity'
    });
  }
});

export default router;
