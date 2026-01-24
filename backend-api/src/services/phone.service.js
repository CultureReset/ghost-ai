import twilio from 'twilio';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';
import { processVoiceNote } from './openai.service.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Generate TwiML response for incoming call
 * @param {string} businessId - Business UUID
 * @param {string} callSid - Twilio call SID
 * @param {string} from - Caller phone number
 * @returns {Promise<string>} - TwiML XML
 */
export async function handleIncomingCall(businessId, callSid, from) {
  try {
    // Get business info
    const { data: business } = await supabase
      .from('businesses')
      .select('name, business_type, phone_ai_greeting')
      .eq('id', businessId)
      .single();

    if (!business) {
      throw new Error('Business not found');
    }

    const twiml = new VoiceResponse();

    // Custom greeting or default
    const greeting = business.phone_ai_greeting ||
      `Thank you for calling ${business.name}. Your call will be recorded for quality assurance. Please leave a detailed message after the beep, and we'll get back to you as soon as possible.`;

    // Say greeting
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, greeting);

    // Record the call
    twiml.record({
      action: `/api/phone/recording-complete?business_id=${businessId}&call_sid=${callSid}`,
      method: 'POST',
      maxLength: 300, // 5 minutes max
      transcribe: false, // We'll use Whisper instead
      recordingStatusCallback: `/api/phone/recording-status?business_id=${businessId}&call_sid=${callSid}`,
      recordingStatusCallbackMethod: 'POST'
    });

    // End call
    twiml.say('Thank you. Goodbye.');
    twiml.hangup();

    // Log call in database
    await supabase.from('phone_calls').insert({
      business_id: businessId,
      call_sid: callSid,
      from_number: from,
      status: 'ringing',
      direction: 'inbound',
      created_at: new Date().toISOString()
    });

    logger.info(`Incoming call handled: ${callSid} for business: ${businessId}`);

    return twiml.toString();
  } catch (error) {
    logger.error('Handle incoming call error:', error);

    // Fallback TwiML
    const twiml = new VoiceResponse();
    twiml.say('We are currently unable to take your call. Please try again later.');
    twiml.hangup();

    return twiml.toString();
  }
}

/**
 * Handle recording complete callback
 * @param {string} businessId - Business UUID
 * @param {string} callSid - Twilio call SID
 * @param {string} recordingUrl - URL of recorded audio
 * @param {number} recordingDuration - Duration in seconds
 * @returns {Promise<object>} - Processing result
 */
export async function handleRecordingComplete(businessId, callSid, recordingUrl, recordingDuration) {
  try {
    // Update call record with recording info
    await supabase
      .from('phone_calls')
      .update({
        recording_url: recordingUrl,
        duration_seconds: recordingDuration,
        status: 'completed',
        updated_at: new Date().toISOString()
      })
      .eq('call_sid', callSid);

    // Get business info for AI processing context
    const { data: business } = await supabase
      .from('businesses')
      .select('name, business_type')
      .eq('id', businessId)
      .single();

    // Process recording with AI (Whisper + GPT-4)
    const aiResult = await processVoiceNote(
      callSid,
      recordingUrl,
      business?.business_type || 'general',
      {
        business_id: businessId,
        business_name: business?.name,
        source: 'phone_call'
      }
    );

    // Update call with AI results
    await supabase
      .from('phone_calls')
      .update({
        transcript: aiResult.transcript,
        extracted_data: aiResult.extracted_data,
        sentiment: aiResult.sentiment,
        summary: aiResult.summary,
        ai_processed: true,
        processed_at: new Date().toISOString()
      })
      .eq('call_sid', callSid);

    // Track usage
    await supabase.from('usage_records').insert({
      business_id: businessId,
      usage_type: 'phone_call',
      quantity: 1,
      cost: calculateCallCost(recordingDuration),
      date: new Date().toISOString().split('T')[0],
      metadata: {
        call_sid: callSid,
        duration_seconds: recordingDuration,
        duration_minutes: Math.ceil(recordingDuration / 60)
      }
    });

    // Create notification for business owner
    const { data: owner } = await supabase
      .from('users')
      .select('id')
      .eq('business_id', businessId)
      .eq('role', 'owner')
      .single();

    if (owner) {
      const contactName = aiResult.extracted_data?.contact?.first_name || 'Customer';
      const isUrgent = aiResult.sentiment?.urgency_level === 'urgent';

      await supabase.from('notifications').insert({
        user_id: owner.id,
        business_id: businessId,
        type: isUrgent ? 'urgent_phone_call' : 'new_phone_call',
        title: isUrgent ? '🚨 Urgent Phone Call' : '📞 New Phone Call',
        message: `Phone call from ${contactName}: ${aiResult.summary?.substring(0, 100)}`,
        action_url: `/calls/${callSid}`,
        action_label: 'Listen & View Details',
        data: {
          call_sid: callSid,
          summary: aiResult.summary,
          urgency: aiResult.sentiment?.urgency_level
        }
      });
    }

    // TODO: Send SMS notification if enabled

    logger.info(`Recording processed for call: ${callSid}`);

    return {
      success: true,
      call_sid: callSid,
      ai_result: aiResult
    };
  } catch (error) {
    logger.error('Handle recording complete error:', error);

    // Mark call as failed
    await supabase
      .from('phone_calls')
      .update({
        status: 'failed',
        error_message: error.message
      })
      .eq('call_sid', callSid);

    throw error;
  }
}

/**
 * Calculate call cost based on duration
 * @param {number} durationSeconds - Call duration in seconds
 * @returns {number} - Cost in dollars
 */
function calculateCallCost(durationSeconds) {
  const minutes = Math.ceil(durationSeconds / 60);

  // Twilio Voice: ~$0.0130/min for inbound
  // AI Processing (Whisper + GPT-4): ~$0.02/min
  // Total: ~$0.033/min
  const costPerMinute = 0.033;

  return minutes * costPerMinute;
}

/**
 * Get call details
 * @param {string} callSid - Twilio call SID
 * @returns {Promise<object>} - Call details
 */
export async function getCallDetails(callSid) {
  try {
    const { data: call, error } = await supabase
      .from('phone_calls')
      .select('*')
      .eq('call_sid', callSid)
      .single();

    if (error) {
      throw error;
    }

    return call;
  } catch (error) {
    logger.error('Get call details error:', error);
    throw error;
  }
}

/**
 * Get calls for business
 * @param {string} businessId - Business UUID
 * @param {object} options - Query options
 * @returns {Promise<array>} - Array of calls
 */
export async function getBusinessCalls(businessId, options = {}) {
  try {
    let query = supabase
      .from('phone_calls')
      .select('*')
      .eq('business_id', businessId);

    // Filters
    if (options.status) {
      query = query.eq('status', options.status);
    }

    if (options.start_date) {
      query = query.gte('created_at', options.start_date);
    }

    if (options.end_date) {
      query = query.lte('created_at', options.end_date);
    }

    // Pagination
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: calls, error } = await query;

    if (error) {
      throw error;
    }

    return calls || [];
  } catch (error) {
    logger.error('Get business calls error:', error);
    throw error;
  }
}

/**
 * Forward call to business number
 * @param {string} businessId - Business UUID
 * @param {string} forwardNumber - Number to forward to
 * @returns {string} - TwiML XML
 */
export function forwardCallTwiML(businessId, forwardNumber) {
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, 'Please hold while we connect you.');

  // Dial the forward number
  const dial = twiml.dial({
    action: `/api/phone/forward-complete?business_id=${businessId}`,
    timeout: 30,
    callerId: process.env.TWILIO_PHONE_NUMBER
  });

  dial.number(forwardNumber);

  // If no answer, go to voicemail
  twiml.say('The line is busy. Please leave a message after the beep.');
  twiml.record({
    maxLength: 300,
    action: `/api/phone/recording-complete?business_id=${businessId}`
  });

  return twiml.toString();
}

/**
 * Get call statistics
 * @param {string} businessId - Business UUID
 * @param {string} startDate - Start date
 * @param {string} endDate - End date
 * @returns {Promise<object>} - Call statistics
 */
export async function getCallStats(businessId, startDate, endDate) {
  try {
    const { data: calls } = await supabase
      .from('phone_calls')
      .select('*')
      .eq('business_id', businessId)
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    const stats = {
      total_calls: calls?.length || 0,
      completed_calls: calls?.filter(c => c.status === 'completed').length || 0,
      missed_calls: calls?.filter(c => c.status === 'no-answer').length || 0,
      total_duration_minutes: 0,
      avg_duration_minutes: 0,
      urgent_calls: 0
    };

    if (calls && calls.length > 0) {
      stats.total_duration_minutes = calls.reduce((sum, c) => sum + (c.duration_seconds || 0), 0) / 60;
      stats.avg_duration_minutes = stats.total_duration_minutes / stats.completed_calls || 0;
      stats.urgent_calls = calls.filter(c => c.sentiment?.urgency_level === 'urgent').length;
    }

    return stats;
  } catch (error) {
    logger.error('Get call stats error:', error);
    throw error;
  }
}

export default {
  handleIncomingCall,
  handleRecordingComplete,
  getCallDetails,
  getBusinessCalls,
  forwardCallTwiML,
  getCallStats
};
