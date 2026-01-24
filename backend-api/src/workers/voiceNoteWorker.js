import Queue from 'bull';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';
import AIService from '../services/ai.service.js';
import { sendVoiceNoteCompleteNotification, sendUrgentLeadNotification } from '../services/sms.service.js';

// Create Bull queue for voice note processing
export const voiceNoteQueue = new Queue('voice-note-processing', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    // For Upstash Redis (TLS)
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
  },
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times
    backoff: {
      type: 'exponential',
      delay: 5000 // Start with 5 second delay
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 200 // Keep last 200 failed jobs
  }
});

/**
 * Process voice note job
 */
voiceNoteQueue.process(async (job) => {
  const { voiceNoteId, audioUrl, businessId, profileId, industry } = job.data;

  logger.info(`Processing voice note job: ${job.id} - Voice Note: ${voiceNoteId}`);

  try {
    // Update status to processing
    await supabase
      .from('voice_notes')
      .update({
        status: 'processing',
        processing_started_at: new Date()
      })
      .eq('id', voiceNoteId);

    // Get business context
    const { data: business } = await supabase
      .from('businesses')
      .select('name, business_type')
      .eq('id', businessId)
      .single();

    // Get profile context if provided
    let profile = null;
    if (profileId) {
      const { data } = await supabase
        .from('profiles')
        .select('name, profile_type')
        .eq('id', profileId)
        .single();
      profile = data;
    }

    // Step 1: Transcribe audio with Whisper
    logger.info(`Starting transcription for voice note: ${voiceNoteId}`);
    const transcription = await AIService.transcribeAudio(audioUrl, {
      language: 'en',
      response_format: 'verbose_json'
    });

    // Store transcript
    await supabase
      .from('voice_notes')
      .update({
        transcript: transcription.text,
        transcript_json: transcription.segments || [],
        audio_duration_seconds: Math.round(transcription.duration || 0)
      })
      .eq('id', voiceNoteId);

    logger.info(`Transcription completed for voice note: ${voiceNoteId} - ${transcription.text.length} chars`);

    // Step 2: Extract structured data with GPT-4
    logger.info(`Starting extraction for voice note: ${voiceNoteId}`);
    const extraction = await AIService.extractStructuredData(
      transcription.text,
      businessId,
      'sales_voice_note'
    );

    // Store extracted data
    const extractedData = extraction.extracted_data;

    // Create AI extraction record
    await supabase
      .from('ai_extractions')
      .insert({
        voice_note_id: voiceNoteId,
        business_id: businessId,
        extraction_type: 'sales_voice_note',
        raw_ai_output: extractedData,
        tokens_used: extraction.tokens_used
      });

    // Update voice note with extracted data
    await supabase
      .from('voice_notes')
      .update({
        extracted_data: extractedData,
        status: 'completed',
        processed_at: new Date()
      })
      .eq('id', voiceNoteId);

    // Step 3: Build proposed action plan
    const proposedActions = buildProposedActions(extractedData, transcription.text);

    if (proposedActions.length > 0) {
      // Create action plan
      await supabase
        .from('action_plans')
        .insert({
          voice_note_id: voiceNoteId,
          business_id: businessId,
          proposed_actions_json: proposedActions,
          status: 'proposed'
        });

      logger.info(`Action plan created for voice note: ${voiceNoteId} - ${proposedActions.length} actions`);
    }

    const result = {
      transcript: transcription.text,
      extracted_data: extractedData,
      proposed_actions: proposedActions,
      tokens_used: extraction.tokens_used
    };

    // Create notification for business owner
    const { data: owner } = await supabase
      .from('users')
      .select('id')
      .eq('business_id', businessId)
      .eq('role', 'owner')
      .single();

    if (owner) {
      await supabase.from('notifications').insert({
        user_id: owner.id,
        business_id: businessId,
        type: 'voice_note_processed',
        title: 'Voice Note Processed',
        message: `Your voice note has been transcribed and processed successfully.`,
        action_url: `/voice-notes/${voiceNoteId}`,
        action_label: 'View Details',
        data: {
          voice_note_id: voiceNoteId,
          actions_count: proposedActions.length
        }
      });
    }

    // Send SMS notification if SMS service is configured
    try {
      const isUrgent = extractedData.lead?.stage === 'urgent';

      if (isUrgent && typeof sendUrgentLeadNotification === 'function') {
        await sendUrgentLeadNotification(voiceNoteId, businessId);
      } else if (typeof sendVoiceNoteCompleteNotification === 'function') {
        await sendVoiceNoteCompleteNotification(voiceNoteId, businessId);
      }
    } catch (smsError) {
      logger.warn(`SMS notification failed for voice note ${voiceNoteId}:`, smsError);
    }

    logger.info(`Voice note processing completed: ${voiceNoteId}`);

    return {
      success: true,
      voiceNoteId,
      result
    };
  } catch (error) {
    logger.error(`Voice note processing failed: ${voiceNoteId}`, error);

    // Update status to failed
    await supabase
      .from('voice_notes')
      .update({
        status: 'failed',
        error_message: error.message,
        processed_at: new Date()
      })
      .eq('id', voiceNoteId);

    throw error; // Let Bull handle retries
  }
});

/**
 * Handle job completion
 */
voiceNoteQueue.on('completed', (job, result) => {
  logger.info(`Voice note job completed: ${job.id}`, result);
});

/**
 * Handle job failure
 */
voiceNoteQueue.on('failed', (job, error) => {
  logger.error(`Voice note job failed: ${job.id}`, error);
});

/**
 * Handle job stalled (stuck)
 */
voiceNoteQueue.on('stalled', (job) => {
  logger.warn(`Voice note job stalled: ${job.id}`);
});

/**
 * Add voice note to processing queue
 * @param {object} data - Job data
 * @returns {Promise<object>} - Job info
 */
export async function queueVoiceNoteProcessing(data) {
  try {
    const job = await voiceNoteQueue.add(data, {
      priority: data.priority || 5, // Default priority
      delay: data.delay || 0 // Process immediately by default
    });

    logger.info(`Voice note queued for processing: ${data.voiceNoteId} - Job ID: ${job.id}`);

    return {
      success: true,
      jobId: job.id,
      voiceNoteId: data.voiceNoteId,
      queuedAt: new Date()
    };
  } catch (error) {
    logger.error('Failed to queue voice note:', error);
    throw error;
  }
}

/**
 * Get job status
 * @param {string} jobId - Bull job ID
 * @returns {Promise<object>} - Job status
 */
export async function getJobStatus(jobId) {
  try {
    const job = await voiceNoteQueue.getJob(jobId);

    if (!job) {
      return {
        success: false,
        error: 'Job not found'
      };
    }

    const state = await job.getState();
    const progress = job.progress();
    const failedReason = job.failedReason;

    return {
      success: true,
      jobId: job.id,
      state,
      progress,
      failedReason,
      data: job.data,
      returnValue: job.returnvalue,
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn
    };
  } catch (error) {
    logger.error('Failed to get job status:', error);
    throw error;
  }
}

/**
 * Get queue stats
 * @returns {Promise<object>} - Queue statistics
 */
export async function getQueueStats() {
  try {
    const [
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused
    ] = await Promise.all([
      voiceNoteQueue.getWaitingCount(),
      voiceNoteQueue.getActiveCount(),
      voiceNoteQueue.getCompletedCount(),
      voiceNoteQueue.getFailedCount(),
      voiceNoteQueue.getDelayedCount(),
      voiceNoteQueue.getPausedCount()
    ]);

    return {
      success: true,
      stats: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        paused,
        total: waiting + active + delayed
      }
    };
  } catch (error) {
    logger.error('Failed to get queue stats:', error);
    throw error;
  }
}

/**
 * Clear completed jobs
 * @returns {Promise<object>} - Clear result
 */
export async function clearCompleted() {
  try {
    await voiceNoteQueue.clean(24 * 60 * 60 * 1000); // Clear jobs older than 24 hours
    logger.info('Cleared completed voice note jobs');
    return { success: true };
  } catch (error) {
    logger.error('Failed to clear completed jobs:', error);
    throw error;
  }
}

/**
 * Build proposed actions from extracted data
 * Converts AI extraction into actionable items for user confirmation
 */
function buildProposedActions(extractedData, transcript) {
  const actions = [];

  // Action 1: Create/Update Contact
  if (extractedData.contact) {
    const contact = extractedData.contact;
    if (contact.full_name || contact.email || contact.phone) {
      actions.push({
        action_type: 'contact.upsert',
        label: 'Create/Update Contact',
        params: {
          full_name: contact.full_name || '',
          first_name: contact.first_name || '',
          last_name: contact.last_name || '',
          email: contact.email || null,
          phone: contact.phone || null,
          company_name: contact.company_name || null,
          notes: extractedData.notes || transcript.substring(0, 500)
        },
        confidence: 0.9
      });
    }
  }

  // Action 2: Create Lead
  if (extractedData.lead) {
    const lead = extractedData.lead;
    if (lead.lead_name) {
      actions.push({
        action_type: 'lead.create',
        label: 'Create Lead',
        params: {
          lead_name: lead.lead_name || 'New Lead',
          stage: lead.stage || 'new',
          estimated_value_cents: lead.estimated_value_cents || 0,
          product_interest: lead.product_interest || [],
          notes: extractedData.notes || ''
        },
        confidence: 0.85
      });
    }
  }

  // Action 3: Create Tasks
  if (extractedData.tasks && Array.isArray(extractedData.tasks)) {
    extractedData.tasks.forEach((task) => {
      if (task.title) {
        actions.push({
          action_type: 'task.create',
          label: `Create Task: ${task.title}`,
          params: {
            title: task.title,
            description: task.description || '',
            due_at: task.due_at || null,
            priority: task.priority || 'medium'
          },
          confidence: 0.8
        });
      }
    });
  }

  // Action 4: Create Calendar Events
  if (extractedData.calendar_events && Array.isArray(extractedData.calendar_events)) {
    extractedData.calendar_events.forEach((event) => {
      if (event.title && event.starts_at) {
        actions.push({
          action_type: 'calendar_event.create',
          label: `Schedule: ${event.title}`,
          params: {
            title: event.title,
            description: event.description || '',
            starts_at: event.starts_at,
            ends_at: event.ends_at || null,
            location: event.location || null,
            attendees: event.attendees || []
          },
          confidence: 0.85
        });
      }
    });
  }

  // Action 5: Create Note (always create a note to preserve transcript)
  actions.push({
    action_type: 'note.create',
    label: 'Save Voice Note as CRM Note',
    params: {
      title: `Voice Note - ${new Date().toLocaleDateString()}`,
      content: transcript,
      note_type: 'voice_crm'
    },
    confidence: 1.0
  });

  return actions;
}

export default {
  voiceNoteQueue,
  queueVoiceNoteProcessing,
  getJobStatus,
  getQueueStats,
  clearCompleted
};
