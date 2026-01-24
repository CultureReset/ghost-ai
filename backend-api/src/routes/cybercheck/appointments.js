import express from 'express';
import { supabase } from '../../config/database.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// Apply authentication to all routes
router.use(authenticateToken);

/**
 * GET /api/appointments
 * List all appointments with optional filters
 */
router.get('/', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const {
      start_date,     // Filter by start date (YYYY-MM-DD)
      end_date,       // Filter by end date (YYYY-MM-DD)
      status,         // Filter by status (scheduled, completed, cancelled, no-show)
      contact_id,     // Filter by contact
      assigned_to,    // Filter by assigned user
      limit = 100,
      offset = 0
    } = req.query;

    let query = supabase
      .from('appointments')
      .select(`
        *,
        contact:contacts(id, first_name, last_name, email, phone),
        assigned_user:users(id, email, full_name)
      `, { count: 'exact' })
      .eq('business_id', businessId)
      .is('deleted_at', null);

    // Filter by date range
    if (start_date) {
      query = query.gte('start_time', start_date);
    }
    if (end_date) {
      query = query.lte('start_time', end_date);
    }

    // Filter by status
    if (status) {
      query = query.eq('status', status);
    }

    // Filter by contact
    if (contact_id) {
      query = query.eq('contact_id', contact_id);
    }

    // Filter by assigned user
    if (assigned_to) {
      query = query.eq('assigned_to', assigned_to);
    }

    // Pagination and ordering
    query = query
      .order('start_time', { ascending: true })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: appointments, error, count } = await query;

    if (error) {
      logger.error('Error fetching appointments:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch appointments'
      });
    }

    res.json({
      success: true,
      data: appointments,
      meta: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (err) {
    logger.error('Appointments list error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/appointments/stats
 * Get appointment statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const businessId = req.user.business_id;

    // Get counts by status
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('status, start_time')
      .eq('business_id', businessId)
      .is('deleted_at', null);

    if (error) throw error;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const stats = {
      total: appointments.length,
      scheduled: appointments.filter(a => a.status === 'scheduled').length,
      completed: appointments.filter(a => a.status === 'completed').length,
      cancelled: appointments.filter(a => a.status === 'cancelled').length,
      no_show: appointments.filter(a => a.status === 'no-show').length,
      today: appointments.filter(a => {
        const apptDate = new Date(a.start_time);
        return apptDate >= today && apptDate < new Date(today.getTime() + 24 * 60 * 60 * 1000);
      }).length,
      upcoming: appointments.filter(a => {
        const apptDate = new Date(a.start_time);
        return apptDate > now && a.status === 'scheduled';
      }).length
    };

    res.json({
      success: true,
      data: stats
    });

  } catch (err) {
    logger.error('Appointments stats error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointment statistics'
    });
  }
});

/**
 * GET /api/appointments/:id
 * Get a single appointment by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    const { data: appointment, error } = await supabase
      .from('appointments')
      .select(`
        *,
        contact:contacts(id, first_name, last_name, email, phone),
        assigned_user:users(id, email, full_name)
      `)
      .eq('id', id)
      .eq('business_id', businessId)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'Appointment not found'
        });
      }
      throw error;
    }

    res.json({
      success: true,
      data: appointment
    });

  } catch (err) {
    logger.error('Appointment fetch error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointment'
    });
  }
});

/**
 * POST /api/appointments
 * Create a new appointment
 */
router.post('/', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const userId = req.user.id;

    const {
      title,
      description,
      start_time,
      end_time,
      contact_id,
      assigned_to,
      location,
      status = 'scheduled',
      reminder_minutes,
      notes
    } = req.body;

    // Validate required fields
    if (!title || !start_time || !end_time) {
      return res.status(400).json({
        success: false,
        error: 'Title, start_time, and end_time are required'
      });
    }

    // Validate contact exists if provided
    if (contact_id) {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('business_id', businessId)
        .single();

      if (contactError || !contact) {
        return res.status(400).json({
          success: false,
          error: 'Invalid contact_id'
        });
      }
    }

    // Create appointment
    const appointmentData = {
      business_id: businessId,
      title: title.trim(),
      description: description?.trim() || null,
      start_time,
      end_time,
      contact_id: contact_id || null,
      assigned_to: assigned_to || userId,
      location: location?.trim() || null,
      status,
      reminder_minutes: reminder_minutes || null,
      notes: notes?.trim() || null,
      created_by: userId
    };

    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert(appointmentData)
      .select(`
        *,
        contact:contacts(id, first_name, last_name, email, phone),
        assigned_user:users(id, email, full_name)
      `)
      .single();

    if (error) {
      logger.error('Error creating appointment:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create appointment'
      });
    }

    res.status(201).json({
      success: true,
      data: appointment
    });

  } catch (err) {
    logger.error('Appointment creation error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/appointments/:id
 * Update an existing appointment
 */
router.put('/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    // Check if appointment exists
    const { data: existing, error: fetchError } = await supabase
      .from('appointments')
      .select('id')
      .eq('id', id)
      .eq('business_id', businessId)
      .is('deleted_at', null)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    const {
      title,
      description,
      start_time,
      end_time,
      contact_id,
      assigned_to,
      location,
      status,
      reminder_minutes,
      notes
    } = req.body;

    // Validate contact if provided
    if (contact_id) {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('business_id', businessId)
        .single();

      if (contactError || !contact) {
        return res.status(400).json({
          success: false,
          error: 'Invalid contact_id'
        });
      }
    }

    // Build update object (only include provided fields)
    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description?.trim() || null;
    if (start_time !== undefined) updateData.start_time = start_time;
    if (end_time !== undefined) updateData.end_time = end_time;
    if (contact_id !== undefined) updateData.contact_id = contact_id;
    if (assigned_to !== undefined) updateData.assigned_to = assigned_to;
    if (location !== undefined) updateData.location = location?.trim() || null;
    if (status !== undefined) updateData.status = status;
    if (reminder_minutes !== undefined) updateData.reminder_minutes = reminder_minutes;
    if (notes !== undefined) updateData.notes = notes?.trim() || null;

    const { data: appointment, error } = await supabase
      .from('appointments')
      .update(updateData)
      .eq('id', id)
      .eq('business_id', businessId)
      .select(`
        *,
        contact:contacts(id, first_name, last_name, email, phone),
        assigned_user:users(id, email, full_name)
      `)
      .single();

    if (error) {
      logger.error('Error updating appointment:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update appointment'
      });
    }

    res.json({
      success: true,
      data: appointment
    });

  } catch (err) {
    logger.error('Appointment update error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * DELETE /api/appointments/:id
 * Soft delete an appointment
 */
router.delete('/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    // Check if appointment exists
    const { data: existing, error: fetchError } = await supabase
      .from('appointments')
      .select('id')
      .eq('id', id)
      .eq('business_id', businessId)
      .is('deleted_at', null)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    // Soft delete
    const { error } = await supabase
      .from('appointments')
      .update({
        deleted_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('business_id', businessId);

    if (error) {
      logger.error('Error deleting appointment:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete appointment'
      });
    }

    res.json({
      success: true,
      message: 'Appointment deleted successfully'
    });

  } catch (err) {
    logger.error('Appointment deletion error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/appointments/:id/restore
 * Restore a soft-deleted appointment
 */
router.post('/:id/restore', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    const { data: appointment, error } = await supabase
      .from('appointments')
      .update({
        deleted_at: null
      })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .single();

    if (error || !appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    res.json({
      success: true,
      data: appointment,
      message: 'Appointment restored successfully'
    });

  } catch (err) {
    logger.error('Appointment restore error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PATCH /api/appointments/:id/status
 * Update appointment status quickly
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['scheduled', 'completed', 'cancelled', 'no-show'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const { data: appointment, error } = await supabase
      .from('appointments')
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('business_id', businessId)
      .is('deleted_at', null)
      .select()
      .single();

    if (error || !appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }

    res.json({
      success: true,
      data: appointment
    });

  } catch (err) {
    logger.error('Appointment status update error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
