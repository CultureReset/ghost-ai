import twilio from 'twilio';
import OpenAI from 'openai';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

/**
 * SMS-BASED AI SERVICE
 * Handles text-based AI questions via SMS
 * Supports multiple AI providers based on user preference
 */

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const perplexity = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: 'https://api.perplexity.ai'
});

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

const GHOST_AI_NUMBER = process.env.GHOST_OS_WAITLIST_NUMBER;

/**
 * Handle AI question via SMS
 * @param {string} fromNumber - User's phone number
 * @param {string} question - User's question
 * @param {string} messageSid - Twilio message SID
 */
export async function handleAIQuestion(fromNumber, question, messageSid) {
  try {
    logger.info(`🤖 AI Question from ${fromNumber}: ${question}`);

    // Normalize phone number
    const phone = normalizePhoneNumber(fromNumber);

    // Get user info and AI preference (optional - works without database)
    let user = null;
    let history = null;

    if (supabase) {
      try {
        const { data: userData } = await supabase
          .from('ghost_os_waitlist')
          .select('preferred_ai, name, id')
          .eq('phone_number', phone)
          .single();
        user = userData;

        // Get conversation history (last 5 messages)
        const { data: historyData } = await supabase
          .from('sms_conversations')
          .select('*')
          .eq('phone_number', phone)
          .order('created_at', { ascending: false })
          .limit(5);
        history = historyData;
      } catch (dbError) {
        logger.warn('Database query failed, continuing without user data:', dbError.message);
      }
    }

    const aiProvider = user?.preferred_ai || 'openai';
    const userName = user?.name || 'there';
    const userId = user?.id;

    // Build context from history (reverse to oldest first)
    const conversationContext = history
      ? history.reverse().map(msg => ({
          role: msg.role,
          content: msg.content
        }))
      : [];

    // Get AI response (default to Grok)
    let aiResponse;
    if (aiProvider === 'grok' || aiProvider === 'openai') {
      aiResponse = await getGrokResponse(userName, question, conversationContext);
    } else {
      // For other providers, fall back to Grok
      logger.warn(`Provider ${aiProvider} not yet supported for SMS. Falling back to Grok.`);
      aiResponse = await getGrokResponse(userName, question, conversationContext);
    }

    // Save conversation to database
    await saveSMSConversation(phone, userId, question, aiResponse, aiProvider, messageSid);

    // Send AI response via SMS
    await sendSMS(phone, aiResponse);

    // Track usage
    await trackSMSUsage(phone, aiProvider, question.length, aiResponse.length);

    logger.info(`✅ AI Response sent to ${fromNumber}: ${aiResponse.substring(0, 100)}...`);

    return {
      success: true,
      response: aiResponse
    };

  } catch (error) {
    logger.error('Error handling AI question:', error);

    // Send fallback response
    try {
      await sendSMS(fromNumber, "Sorry, I'm having trouble thinking right now. Please try again in a moment or call me instead.");
    } catch (sendError) {
      logger.error('Failed to send fallback SMS:', sendError);
    }

    throw error;
  }
}

/**
 * Get response from Grok (primary AI provider)
 * Falls back to Perplexity if Grok fails
 * @param {string} userName - User's name
 * @param {string} question - User's question
 * @param {array} context - Conversation history
 * @returns {Promise<string>} - AI response
 */
async function getGrokResponse(userName, question, context = []) {
  try {
    const messages = [
      {
        role: 'system',
        content: `You are Ghost OS, a helpful AI assistant. Have natural conversations like ChatGPT or Perplexity. Give real answers with current information by searching the web. When something's unclear, ask what they mean. Be conversational and helpful. For SMS, try to keep responses reasonably concise but don't sacrifice quality - give complete, useful answers.`
      },
      ...context,
      {
        role: 'user',
        content: question
      }
    ];

    // Use Grok as primary AI provider (faster and cheaper)
    try {
      const completion = await grok.chat.completions.create({
        model: 'grok-3',
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
      });

      const response = completion.choices[0].message.content.trim();

      // If response is too long, truncate and add note
      if (response.length > 1500) {
        return response.substring(0, 1497) + '...';
      }

      return response;
    } catch (grokError) {
      logger.warn('Grok API failed, falling back to Perplexity:', grokError.message);

      // Fallback to Perplexity
      const completion = await perplexity.chat.completions.create({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
      });

      const response = completion.choices[0].message.content.trim();

      if (response.length > 1500) {
        return response.substring(0, 1497) + '...';
      }

      return response;
    }

  } catch (error) {
    logger.error('All AI providers failed:', error);
    throw error;
  }
}

/**
 * Save SMS conversation to database
 * @param {string} phoneNumber - User's phone number
 * @param {string} userId - User's waitlist ID
 * @param {string} userMessage - User's message
 * @param {string} aiResponse - AI's response
 * @param {string} aiProvider - AI provider used
 * @param {string} messageSid - Twilio message SID
 */
async function saveSMSConversation(phoneNumber, userId, userMessage, aiResponse, aiProvider, messageSid) {
  if (!supabase) {
    logger.warn('Supabase not configured, skipping conversation save');
    return;
  }

  try {
    // Save user message
    await supabase.from('sms_conversations').insert({
      phone_number: phoneNumber,
      waitlist_id: userId,
      role: 'user',
      content: userMessage,
      message_sid: messageSid,
      ai_provider: aiProvider,
      created_at: new Date().toISOString()
    });

    // Save AI response
    await supabase.from('sms_conversations').insert({
      phone_number: phoneNumber,
      waitlist_id: userId,
      role: 'assistant',
      content: aiResponse,
      ai_provider: aiProvider,
      created_at: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error saving SMS conversation:', error);
    // Don't throw - this is non-critical
  }
}

/**
 * Send SMS message
 * @param {string} toNumber - Recipient phone number
 * @param {string} message - Message to send
 */
async function sendSMS(toNumber, message) {
  try {
    const result = await twilioClient.messages.create({
      from: GHOST_AI_NUMBER,
      to: toNumber,
      body: message
    });

    logger.info(`📤 SMS sent to ${toNumber}: ${result.sid}`);

    return result;

  } catch (error) {
    logger.error('Error sending SMS:', error);
    throw error;
  }
}

/**
 * Track SMS usage for billing
 * @param {string} phoneNumber - User's phone number
 * @param {string} aiProvider - AI provider used
 * @param {number} questionLength - Length of user's question
 * @param {number} responseLength - Length of AI's response
 */
async function trackSMSUsage(phoneNumber, aiProvider, questionLength, responseLength) {
  if (!supabase) {
    return;
  }

  try {
    const tokensUsed = Math.ceil((questionLength + responseLength) / 4); // Rough estimate

    await supabase.from('usage_records').insert({
      phone_number: phoneNumber,
      usage_type: 'sms_ai_question',
      quantity: 1,
      cost: calculateSMSAICost(tokensUsed),
      date: new Date().toISOString().split('T')[0],
      metadata: {
        ai_provider: aiProvider,
        tokens_estimated: tokensUsed,
        question_length: questionLength,
        response_length: responseLength
      }
    });

  } catch (error) {
    logger.error('Error tracking SMS usage:', error);
    // Don't throw - this is non-critical
  }
}

/**
 * Calculate cost for SMS AI question
 * @param {number} tokensUsed - Estimated tokens used
 * @returns {number} - Cost in dollars
 */
function calculateSMSAICost(tokensUsed) {
  // OpenAI GPT-4o: ~$0.005 per 1K input tokens, ~$0.015 per 1K output tokens
  // Average: ~$0.01 per 1K tokens
  // Twilio SMS: ~$0.0075 per message

  const openaiCost = (tokensUsed / 1000) * 0.01;
  const twilioCost = 0.0075;

  return openaiCost + twilioCost;
}

/**
 * Normalize phone number
 * @param {string} phone - Phone number
 * @returns {string} - Normalized phone number
 */
function normalizePhoneNumber(phone) {
  // Remove all non-numeric characters
  const cleaned = phone.replace(/\D/g, '');

  // Add +1 if US number without country code
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }

  // Add + if not present
  if (!phone.startsWith('+')) {
    return `+${cleaned}`;
  }

  return phone;
}

export default {
  handleAIQuestion
};
