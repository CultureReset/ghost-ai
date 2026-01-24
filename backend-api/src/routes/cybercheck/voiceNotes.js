import express from 'express';
import multer from 'multer';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';
import { queueVoiceNoteProcessing, getJobStatus, getQueueStats } from '../../workers/voiceNoteWorker.js';

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit (OpenAI Whisper limit)
  },
  fileFilter: (req, file, cb) => {
    // Accept audio files only
    const allowedTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/m4a',
      'audio/webm',
      'audio/ogg',
      'video/webm' // Browser recordings often use video/webm with audio
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  }
});

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/voice-notes
 * Get all voice notes for the authenticated user's business
 */
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0, start_date, end_date } = req.query;

    let query = supabase
      .from('voice_notes')
      .select('*', { count: 'exact' })
      .eq('business_id', req.user.business_id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    }

    if (start_date) {
      query = query.gte('created_at', start_date);
    }

    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    const { data: voiceNotes, error, count } = await query;

    if (error) {
      logger.error('Get voice notes error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get voice notes'
      });
    }

    res.json({
      success: true,
      data: {
        voice_notes: voiceNotes,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    logger.error('Get voice notes error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/voice-notes/stats
 * Get voice notes statistics for dashboard
 */
router.get('/stats', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = supabase
      .from('voice_notes')
      .select('id, status, created_at, audio_duration_seconds')
      .eq('business_id', req.user.business_id);

    if (start_date) {
      query = query.gte('created_at', start_date);
    }
    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    const { data: voiceNotes, error } = await query;

    if (error) {
      logger.error('Get voice notes stats error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get statistics'
      });
    }

    const stats = {
      total_notes: voiceNotes.length,
      completed: voiceNotes.filter(vn => vn.status === 'completed').length,
      processing: voiceNotes.filter(vn => vn.status === 'processing').length,
      failed: voiceNotes.filter(vn => vn.status === 'failed').length,
      total_duration_minutes: Math.round(voiceNotes.reduce((sum, vn) =>
        sum + (vn.audio_duration_seconds || 0), 0) / 60)
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Get voice notes stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/voice-notes/:id
 * Get single voice note by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: voiceNote, error } = await supabase
      .from('voice_notes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !voiceNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    // Check if user has access to this voice note
    if (voiceNote.business_id !== req.user.business_id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: voiceNote
    });
  } catch (error) {
    logger.error('Get voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/voice-notes/upload
 * Upload voice note and process with AI
 */
router.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No audio file provided'
      });
    }

    const { title, note_type, profile_id } = req.body;

    // Upload audio file to Supabase Storage
    const fileName = `voice-notes/${req.user.business_id}/${Date.now()}-${req.file.originalname}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600'
      });

    if (uploadError) {
      logger.error('File upload error:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload audio file'
      });
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    // Create voice note record (processing will be done async)
    const { data: voiceNote, error: createError } = await supabase
      .from('voice_notes')
      .insert({
        business_id: req.user.business_id,
        user_id: req.user.id,
        profile_id: profile_id || null,
        title: title || 'Untitled Voice Note',
        note_type: note_type || 'general',
        audio_url: publicUrl,
        audio_duration_seconds: 0, // Will be updated after processing
        status: 'processing',
        file_size_bytes: req.file.size
      })
      .select()
      .single();

    if (createError) {
      logger.error('Create voice note error:', createError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create voice note record'
      });
    }

    // Queue for AI processing with Bull
    const jobResult = await queueVoiceNoteProcessing({
      voiceNoteId: voiceNote.id,
      audioUrl: publicUrl,
      businessId: req.user.business_id,
      profileId: profile_id || null,
      industry: note_type || 'general'
    });

    logger.info(`Voice note uploaded: ${voiceNote.id} by ${req.user.email} - Job queued: ${jobResult.jobId}`);

    res.status(201).json({
      success: true,
      message: 'Voice note uploaded successfully. AI processing has been queued.',
      data: {
        voice_note: voiceNote,
        job_id: jobResult.jobId,
        queued_at: jobResult.queuedAt
      }
    });
  } catch (error) {
    logger.error('Upload voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/voice-notes/:id/process
 * Manually trigger processing for a voice note (admin/testing)
 */
router.post('/:id/process', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: voiceNote, error } = await supabase
      .from('voice_notes')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !voiceNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    // Check if user has access
    if (voiceNote.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Check if already processed
    if (voiceNote.status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Voice note already processed'
      });
    }

    // Get business and profile info for context
    const { data: business } = await supabase
      .from('businesses')
      .select('name, industry')
      .eq('id', voiceNote.business_id)
      .single();

    // Queue for processing with OpenAI Whisper + GPT-4
    const jobResult = await queueVoiceNoteProcessing({
      voiceNoteId: voiceNote.id,
      audioUrl: voiceNote.audio_url,
      businessId: voiceNote.business_id,
      profileId: voiceNote.profile_id,
      industry: voiceNote.note_type || business?.industry || 'general'
    });

    res.json({
      success: true,
      message: 'Voice note queued for AI processing (Whisper transcription + GPT-4 extraction).',
      data: {
        voice_note_id: id,
        job_id: jobResult.jobId,
        status: 'processing'
      }
    });
  } catch (error) {
    logger.error('Process voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/voice-notes/:id
 * Update voice note metadata
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, note_type, extracted_data } = req.body;

    // Check if voice note exists and user has access
    const { data: existingNote } = await supabase
      .from('voice_notes')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!existingNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    if (existingNote.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (note_type !== undefined) updateData.note_type = note_type;
    if (extracted_data !== undefined) updateData.extracted_data = extracted_data;
    updateData.updated_at = new Date();

    const { data: voiceNote, error } = await supabase
      .from('voice_notes')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Update voice note error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update voice note'
      });
    }

    logger.info(`Voice note updated: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Voice note updated successfully',
      data: voiceNote
    });
  } catch (error) {
    logger.error('Update voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * DELETE /api/voice-notes/:id
 * Delete voice note
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if voice note exists and user has access
    const { data: voiceNote } = await supabase
      .from('voice_notes')
      .select('business_id, audio_url')
      .eq('id', id)
      .single();

    if (!voiceNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    if (voiceNote.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('voice_notes')
      .delete()
      .eq('id', id);

    if (deleteError) {
      logger.error('Delete voice note error:', deleteError);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete voice note'
      });
    }

    // Delete audio file from storage (extract path from URL)
    if (voiceNote.audio_url) {
      const urlParts = voiceNote.audio_url.split('/');
      const filePath = urlParts.slice(urlParts.indexOf('audio') + 1).join('/');

      await supabase.storage
        .from('audio')
        .remove([filePath]);
    }

    logger.info(`Voice note deleted: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Voice note deleted successfully'
    });
  } catch (error) {
    logger.error('Delete voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/voice-notes/:id/contacts
 * Get contacts extracted from this voice note
 */
router.get('/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if voice note exists and user has access
    const { data: voiceNote } = await supabase
      .from('voice_notes')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!voiceNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    if (voiceNote.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Get contacts created from this voice note
    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('source_type', 'voice_note')
      .eq('source_id', id);

    if (error) {
      logger.error('Get contacts from voice note error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get contacts'
      });
    }

    res.json({
      success: true,
      data: contacts || []
    });
  } catch (error) {
    logger.error('Get contacts from voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/voice-notes/:id/create-contact
 * Manually create contact from voice note extracted data
 */
router.post('/:id/create-contact', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if voice note exists and user has access
    const { data: voiceNote } = await supabase
      .from('voice_notes')
      .select('business_id, extracted_data')
      .eq('id', id)
      .single();

    if (!voiceNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    if (voiceNote.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (!voiceNote.extracted_data) {
      return res.status(400).json({
        success: false,
        error: 'No extracted data available to create contact'
      });
    }

    // Extract contact info from extracted_data
    const extracted = voiceNote.extracted_data;

    const { data: contact, error } = await supabase
      .from('contacts')
      .insert({
        business_id: voiceNote.business_id,
        first_name: extracted.first_name || '',
        last_name: extracted.last_name || '',
        email: extracted.email || null,
        phone: extracted.phone || null,
        company: extracted.company || null,
        notes: extracted.notes || extracted.raw_transcript || '',
        source_type: 'voice_note',
        source_id: id,
        metadata: extracted
      })
      .select()
      .single();

    if (error) {
      logger.error('Create contact from voice note error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create contact'
      });
    }

    logger.info(`Contact created from voice note: ${contact.id}`);

    res.status(201).json({
      success: true,
      message: 'Contact created successfully',
      data: contact
    });
  } catch (error) {
    logger.error('Create contact from voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/voice-notes/queue/job/:jobId
 * Get status of a specific processing job
 */
router.get('/queue/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobStatus = await getJobStatus(jobId);

    res.json({
      success: true,
      data: jobStatus
    });
  } catch (error) {
    logger.error('Get job status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get job status'
    });
  }
});

/**
 * GET /api/voice-notes/queue/stats
 * Get queue statistics (waiting, active, completed, failed)
 */
router.get('/queue/stats', async (req, res) => {
  try {
    const stats = await getQueueStats();

    res.json({
      success: true,
      data: stats.stats
    });
  } catch (error) {
    logger.error('Get queue stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get queue statistics'
    });
  }
});

/**
 * POST /api/voice-notes/:id/confirm
 * Confirm and execute AI-proposed actions from voice note
 * This is the core action execution endpoint
 */
router.post('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmed_actions } = req.body;

    if (!confirmed_actions || !Array.isArray(confirmed_actions)) {
      return res.status(400).json({
        success: false,
        error: 'confirmed_actions array is required'
      });
    }

    // Get voice note and verify access
    const { data: voiceNote, error: vnError } = await supabase
      .from('voice_notes')
      .select('business_id, extracted_data')
      .eq('id', id)
      .single();

    if (vnError || !voiceNote) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    if (voiceNote.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Get or create action plan
    let { data: actionPlan } = await supabase
      .from('action_plans')
      .select('*')
      .eq('voice_note_id', id)
      .single();

    if (!actionPlan) {
      // Create new action plan
      const { data: newPlan, error: createError } = await supabase
        .from('action_plans')
        .insert({
          voice_note_id: id,
          business_id: voiceNote.business_id,
          proposed_actions_json: confirmed_actions,
          status: 'confirmed'
        })
        .select()
        .single();

      if (createError) {
        throw createError;
      }
      actionPlan = newPlan;
    }

    // Update action plan with confirmed actions
    await supabase
      .from('action_plans')
      .update({
        confirmed_actions_json: confirmed_actions,
        confirmed_by: req.user.id,
        confirmed_at: new Date(),
        status: 'confirmed'
      })
      .eq('id', actionPlan.id);

    // Execute each action
    const executionResults = [];
    const executedActions = [];

    for (const action of confirmed_actions) {
      try {
        let result = null;

        switch (action.action_type) {
          case 'contact.upsert':
            result = await executeContactUpsert(action.params, voiceNote.business_id, id);
            break;

          case 'lead.create':
            result = await executeLeadCreate(action.params, voiceNote.business_id, id, req.user.id);
            break;

          case 'task.create':
            result = await executeTaskCreate(action.params, voiceNote.business_id, id, req.user.id);
            break;

          case 'calendar_event.create':
            result = await executeCalendarEventCreate(action.params, voiceNote.business_id, id, req.user.id);
            break;

          case 'note.create':
            result = await executeNoteCreate(action.params, voiceNote.business_id, id, req.user.id);
            break;

          case 'message.send_sms':
            result = await executeSendSMS(action.params, voiceNote.business_id);
            break;

          default:
            throw new Error(`Unknown action type: ${action.action_type}`);
        }

        executionResults.push({
          action_type: action.action_type,
          status: 'success',
          result
        });

        executedActions.push({
          ...action,
          executed_at: new Date(),
          result
        });

      } catch (error) {
        logger.error(`Action execution failed for ${action.action_type}:`, error);
        executionResults.push({
          action_type: action.action_type,
          status: 'failed',
          error: error.message
        });
      }
    }

    // Build execution report
    const executionReport = {
      total_actions: confirmed_actions.length,
      successful: executionResults.filter(r => r.status === 'success').length,
      failed: executionResults.filter(r => r.status === 'failed').length,
      results: executionResults
    };

    // Update action plan with execution results
    await supabase
      .from('action_plans')
      .update({
        executed_actions_json: executedActions,
        execution_report_json: executionReport,
        executed_at: new Date(),
        status: executionReport.failed > 0 ? 'partially_executed' : 'executed'
      })
      .eq('id', actionPlan.id);

    logger.info(`Action plan executed for voice note ${id}: ${executionReport.successful}/${executionReport.total_actions} successful`);

    res.json({
      success: true,
      message: 'Actions executed successfully',
      data: {
        action_plan_id: actionPlan.id,
        execution_report: executionReport
      }
    });

  } catch (error) {
    logger.error('Execute actions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute actions'
    });
  }
});

/**
 * Helper: Execute contact upsert action
 */
async function executeContactUpsert(params, businessId, voiceNoteId) {
  const { full_name, first_name, last_name, email, phone, company_name, notes } = params;

  // Check if contact already exists by email or phone
  let existingContact = null;
  if (email) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('business_id', businessId)
      .eq('email', email)
      .single();
    existingContact = data;
  }

  if (!existingContact && phone) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('business_id', businessId)
      .eq('phone', phone)
      .single();
    existingContact = data;
  }

  // Parse full_name if provided
  let finalFirstName = first_name;
  let finalLastName = last_name;
  if (full_name && !first_name && !last_name) {
    const nameParts = full_name.trim().split(' ');
    finalFirstName = nameParts[0];
    finalLastName = nameParts.slice(1).join(' ');
  }

  const contactData = {
    business_id: businessId,
    first_name: finalFirstName || '',
    last_name: finalLastName || '',
    email: email || null,
    phone: phone || null,
    company: company_name || null,
    notes: notes || '',
    source_type: 'voice_note',
    source_id: voiceNoteId,
    tags: ['voice-crm']
  };

  if (existingContact) {
    // Update existing contact
    const { data, error } = await supabase
      .from('contacts')
      .update(contactData)
      .eq('id', existingContact.id)
      .select()
      .single();

    if (error) throw error;
    return { contact_id: data.id, action: 'updated' };
  } else {
    // Create new contact
    const { data, error } = await supabase
      .from('contacts')
      .insert(contactData)
      .select()
      .single();

    if (error) throw error;
    return { contact_id: data.id, action: 'created' };
  }
}

/**
 * Helper: Execute lead create action
 */
async function executeLeadCreate(params, businessId, voiceNoteId, userId) {
  const { lead_name, contact_id, stage, estimated_value_cents, product_interest, notes } = params;

  const { data, error } = await supabase
    .from('leads')
    .insert({
      business_id: businessId,
      lead_name: lead_name || 'Voice Note Lead',
      contact_id: contact_id || null,
      stage: stage || 'new',
      estimated_value_cents: estimated_value_cents || 0,
      product_interest: product_interest || [],
      notes: notes || '',
      source_type: 'voice_note',
      source_id: voiceNoteId,
      assigned_to: userId
    })
    .select()
    .single();

  if (error) throw error;
  return { lead_id: data.id };
}

/**
 * Helper: Execute task create action
 */
async function executeTaskCreate(params, businessId, voiceNoteId, userId) {
  const { title, description, due_at, priority, assigned_to, contact_id, lead_id } = params;

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      business_id: businessId,
      title: title || 'Follow-up Task',
      description: description || '',
      due_at: due_at || null,
      priority: priority || 'medium',
      status: 'pending',
      assigned_to: assigned_to || userId,
      contact_id: contact_id || null,
      lead_id: lead_id || null,
      source_type: 'voice_note',
      source_id: voiceNoteId
    })
    .select()
    .single();

  if (error) throw error;
  return { task_id: data.id };
}

/**
 * Helper: Execute calendar event create action
 */
async function executeCalendarEventCreate(params, businessId, voiceNoteId, userId) {
  const { title, description, starts_at, ends_at, location, attendees, contact_id } = params;

  const { data, error } = await supabase
    .from('calendar_events')
    .insert({
      business_id: businessId,
      user_id: userId,
      title: title || 'Meeting',
      description: description || '',
      starts_at: starts_at || null,
      ends_at: ends_at || null,
      location: location || null,
      attendees: attendees || [],
      contact_id: contact_id || null,
      source_type: 'voice_note',
      source_id: voiceNoteId,
      sync_status: 'pending'
    })
    .select()
    .single();

  if (error) throw error;
  return { calendar_event_id: data.id };
}

/**
 * Helper: Execute note create action
 */
async function executeNoteCreate(params, businessId, voiceNoteId, userId) {
  const { title, content, note_type, contact_id, lead_id } = params;

  const { data, error } = await supabase
    .from('notes')
    .insert({
      business_id: businessId,
      user_id: userId,
      title: title || 'Voice Note',
      content: content || '',
      note_type: note_type || 'general',
      contact_id: contact_id || null,
      lead_id: lead_id || null,
      source_type: 'voice_note',
      source_id: voiceNoteId
    })
    .select()
    .single();

  if (error) throw error;
  return { note_id: data.id };
}

/**
 * Helper: Execute send SMS action
 */
async function executeSendSMS(params, businessId) {
  // This would integrate with Twilio or your SMS service
  const { to_number, message, contact_id } = params;

  // Log SMS for now (actual sending would require SMS service integration)
  await supabase
    .from('sms_usage_log')
    .insert({
      business_id: businessId,
      message_type: 'voice_crm_followup',
      to_number: to_number,
      status: 'queued',
      estimated_cost_cents: 1
    });

  logger.info(`SMS queued to ${to_number}: ${message}`);
  return { sms_status: 'queued', to_number };
}

/**
 * GET /api/voice-notes/stats/summary
 * Get voice notes statistics for dashboard (alias for /stats)
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = supabase
      .from('voice_notes')
      .select('id, status, created_at, audio_duration_seconds')
      .eq('business_id', req.user.business_id);

    if (start_date) {
      query = query.gte('created_at', start_date);
    }
    if (end_date) {
      query = query.lte('created_at', end_date);
    }

    const { data: voiceNotes, error } = await query;

    if (error) {
      logger.error('Get voice notes stats error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get statistics'
      });
    }

    const stats = {
      total_notes: voiceNotes.length,
      completed: voiceNotes.filter(vn => vn.status === 'completed').length,
      processing: voiceNotes.filter(vn => vn.status === 'processing').length,
      failed: voiceNotes.filter(vn => vn.status === 'failed').length,
      total_duration_minutes: voiceNotes.reduce((sum, vn) =>
        sum + (vn.audio_duration_seconds || 0), 0) / 60
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Get voice notes stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
