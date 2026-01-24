import twilio from 'twilio';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

// Shared/Co-op Twilio credentials (platform-wide)
// Only initialize if valid credentials are provided
let sharedTwilioClient = null;
let sharedPhoneNumber = null;

if (process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_ACCOUNT_SID.startsWith('AC')) {
  sharedTwilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  sharedPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
  logger.info('Shared Twilio client initialized');
} else {
  logger.warn('Twilio not configured - SMS features disabled');
}

/**
 * Get Twilio client for a business
 * Checks if business has custom credentials, otherwise uses shared
 * @param {string} businessId - Business UUID
 * @returns {Promise<object>} - { client, phoneNumber, isCustom }
 */
async function getTwilioClient(businessId) {
  try {
    // Check if business has custom Twilio credentials
    const { data: business } = await supabase
      .from('businesses')
      .select('sms_config')
      .eq('id', businessId)
      .single();

    const smsConfig = business?.sms_config || {};

    // If business has custom credentials, use those
    if (smsConfig.custom_twilio_enabled &&
        smsConfig.twilio_account_sid &&
        smsConfig.twilio_auth_token &&
        smsConfig.twilio_phone_number) {

      logger.info(`Using custom Twilio for business: ${businessId}`);

      const customClient = twilio(
        smsConfig.twilio_account_sid,
        smsConfig.twilio_auth_token
      );

      return {
        client: customClient,
        phoneNumber: smsConfig.twilio_phone_number,
        isCustom: true
      };
    }

    // Otherwise use shared platform credentials
    logger.info(`Using shared Twilio for business: ${businessId}`);

    return {
      client: sharedTwilioClient,
      phoneNumber: sharedPhoneNumber,
      isCustom: false
    };
  } catch (error) {
    logger.error('Get Twilio client error:', error);
    // Fallback to shared
    return {
      client: sharedTwilioClient,
      phoneNumber: sharedPhoneNumber,
      isCustom: false
    };
  }
}

/**
 * Send SMS notification
 * @param {string} to - Phone number to send to (E.164 format)
 * @param {string} message - SMS message text
 * @param {object} metadata - Additional tracking data (must include business_id)
 * @returns {Promise<object>} - SMS send result
 */
export async function sendSMS(to, message, metadata = {}) {
  try {
    // Get appropriate Twilio client for this business
    const { client, phoneNumber, isCustom } = await getTwilioClient(metadata.business_id);

    if (!client || !phoneNumber) {
      logger.warn('Twilio not configured, skipping SMS');
      return {
        success: false,
        error: 'Twilio not configured'
      };
    }

    // Validate phone number format
    if (!to || !to.startsWith('+')) {
      throw new Error('Phone number must be in E.164 format (e.g., +1234567890)');
    }

    logger.info(`Sending SMS to ${to} using ${isCustom ? 'custom' : 'shared'} Twilio: ${message.substring(0, 50)}...`);

    const result = await client.messages.create({
      body: message,
      from: phoneNumber,
      to: to
    });

    logger.info(`SMS sent successfully: ${result.sid}`);

    // Track SMS usage
    if (metadata.business_id) {
      await supabase.from('usage_records').insert({
        business_id: metadata.business_id,
        usage_type: 'sms_notification',
        quantity: 1,
        // Only charge for shared Twilio usage, custom is free (they pay Twilio directly)
        cost: isCustom ? 0 : 0.01, // $0.01 per SMS on shared plan
        date: new Date().toISOString().split('T')[0],
        metadata: {
          ...metadata,
          sms_sid: result.sid,
          to: to,
          twilio_type: isCustom ? 'custom' : 'shared',
          from: phoneNumber
        }
      });
    }

    return {
      success: true,
      sid: result.sid,
      status: result.status
    };
  } catch (error) {
    logger.error('SMS send error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send SMS to business owner
 * @param {string} businessId - Business UUID
 * @param {string} message - SMS message
 * @param {object} metadata - Additional data
 * @returns {Promise<object>} - SMS result
 */
export async function sendSMSToBusinessOwner(businessId, message, metadata = {}) {
  try {
    // Get business owner's phone number
    const { data: owner, error } = await supabase
      .from('users')
      .select('phone, full_name, sms_notifications_enabled')
      .eq('business_id', businessId)
      .eq('role', 'owner')
      .single();

    if (error || !owner) {
      logger.warn(`Business owner not found for business: ${businessId}`);
      return {
        success: false,
        error: 'Business owner not found'
      };
    }

    // Check if SMS notifications are enabled
    if (owner.sms_notifications_enabled === false) {
      logger.info(`SMS notifications disabled for business: ${businessId}`);
      return {
        success: false,
        error: 'SMS notifications disabled'
      };
    }

    if (!owner.phone) {
      logger.warn(`No phone number for business owner: ${businessId}`);
      return {
        success: false,
        error: 'No phone number'
      };
    }

    return await sendSMS(owner.phone, message, {
      ...metadata,
      business_id: businessId
    });
  } catch (error) {
    logger.error('Send SMS to owner error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Voice note processing complete notification
 */
export async function sendVoiceNoteCompleteNotification(voiceNoteId, businessId) {
  try {
    const { data: voiceNote } = await supabase
      .from('voice_notes')
      .select('title, extracted_data')
      .eq('id', voiceNoteId)
      .single();

    if (!voiceNote) {
      throw new Error('Voice note not found');
    }

    const contactName = voiceNote.extracted_data?.contact?.first_name || 'Customer';
    const title = voiceNote.title || 'Voice Note';

    const message = `🎙️ Voice Note Processed!\n\n"${title}"\n\nContact: ${contactName}\nAI extracted: ${JSON.stringify(voiceNote.extracted_data?.inquiry?.type || 'conversation details')}\n\nView in CyberCheck dashboard`;

    return await sendSMSToBusinessOwner(businessId, message, {
      type: 'voice_note_complete',
      voice_note_id: voiceNoteId
    });
  } catch (error) {
    logger.error('Voice note SMS notification error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Receipt verified notification
 */
export async function sendReceiptVerifiedNotification(reviewId, businessId) {
  try {
    const { data: review } = await supabase
      .from('reviews')
      .select(`
        overall_rating,
        review_text,
        receipt_verified,
        users (full_name),
        profiles (name)
      `)
      .eq('id', reviewId)
      .single();

    if (!review) {
      throw new Error('Review not found');
    }

    const stars = '⭐'.repeat(review.overall_rating);
    const status = review.receipt_verified ? '✅ VERIFIED' : '⚠️ Pending';
    const reviewerName = review.users?.full_name || 'Customer';
    const profileName = review.profiles?.name || 'Your business';

    const message = `${status} New Review!\n\n${stars} (${review.overall_rating}/5)\nFrom: ${reviewerName}\nFor: ${profileName}\n\n"${review.review_text?.substring(0, 100) || 'No text'}${review.review_text?.length > 100 ? '...' : ''}"\n\nView in CyberCheck`;

    return await sendSMSToBusinessOwner(businessId, message, {
      type: 'review_verified',
      review_id: reviewId
    });
  } catch (error) {
    logger.error('Receipt verified SMS notification error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * High-priority lead notification (urgent inquiries)
 */
export async function sendUrgentLeadNotification(voiceNoteId, businessId) {
  try {
    const { data: voiceNote } = await supabase
      .from('voice_notes')
      .select('extracted_data')
      .eq('id', voiceNoteId)
      .single();

    if (!voiceNote) {
      throw new Error('Voice note not found');
    }

    const extractedData = voiceNote.extracted_data || {};
    const contact = extractedData.contact || {};
    const inquiry = extractedData.inquiry || {};

    const contactName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Customer';
    const phone = contact.phone || 'No phone';
    const inquiryType = inquiry.type || 'inquiry';

    const message = `🚨 URGENT LEAD!\n\nName: ${contactName}\nPhone: ${phone}\nType: ${inquiryType}\nPriority: ${inquiry.priority || 'HIGH'}\n\nFollow up immediately!\n\nView details in CyberCheck`;

    return await sendSMSToBusinessOwner(businessId, message, {
      type: 'urgent_lead',
      voice_note_id: voiceNoteId,
      priority: 'urgent'
    });
  } catch (error) {
    logger.error('Urgent lead SMS notification error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Daily summary notification
 */
export async function sendDailySummary(businessId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get today's stats
    const [voiceNotes, reviews] = await Promise.all([
      supabase
        .from('voice_notes')
        .select('id', { count: 'exact' })
        .eq('business_id', businessId)
        .gte('created_at', today),
      supabase
        .from('reviews')
        .select('id, overall_rating', { count: 'exact' })
        .eq('business_id', businessId)
        .gte('created_at', today)
    ]);

    const voiceNoteCount = voiceNotes.count || 0;
    const reviewCount = reviews.count || 0;
    const avgRating = reviewCount > 0
      ? (reviews.data.reduce((sum, r) => sum + r.overall_rating, 0) / reviewCount).toFixed(1)
      : 'N/A';

    const message = `📊 Daily Summary\n\n🎙️ Voice Notes: ${voiceNoteCount}\n⭐ Reviews: ${reviewCount}\n📈 Avg Rating: ${avgRating}\n\nView full analytics in CyberCheck`;

    return await sendSMSToBusinessOwner(businessId, message, {
      type: 'daily_summary',
      date: today
    });
  } catch (error) {
    logger.error('Daily summary SMS error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send bulk SMS to multiple recipients
 * @param {string} businessId - Business UUID
 * @param {array} phoneNumbers - Array of phone numbers (E.164 format)
 * @param {string} message - SMS message
 * @param {object} metadata - Additional data
 * @returns {Promise<object>} - Bulk send results
 */
export async function sendBulkSMS(businessId, phoneNumbers, message, metadata = {}) {
  try {
    const results = {
      total: phoneNumbers.length,
      sent: 0,
      failed: 0,
      details: []
    };

    // Send to each recipient
    for (const phoneNumber of phoneNumbers) {
      const result = await sendSMS(phoneNumber, message, {
        ...metadata,
        business_id: businessId
      });

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
      }

      results.details.push({
        to: phoneNumber,
        success: result.success,
        error: result.error
      });
    }

    logger.info(`Bulk SMS complete for business ${businessId}: ${results.sent} sent, ${results.failed} failed`);

    return results;
  } catch (error) {
    logger.error('Bulk SMS error:', error);
    throw error;
  }
}

/**
 * Test SMS (for setup verification)
 */
export async function sendTestSMS(to, businessId) {
  const message = `✅ CyberCheck SMS notifications are working!\n\nYou'll receive updates about:\n🎙️ Voice notes\n⭐ Reviews\n🚨 Urgent leads\n\nReply STOP to opt out`;

  return await sendSMS(to, message, {
    type: 'test',
    business_id: businessId
  });
}

export default {
  sendSMS,
  sendSMSToBusinessOwner,
  sendVoiceNoteCompleteNotification,
  sendReceiptVerifiedNotification,
  sendUrgentLeadNotification,
  sendDailySummary,
  sendTestSMS,
  sendBulkSMS
};
