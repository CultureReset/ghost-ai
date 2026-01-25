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

    // Skip database queries for maximum speed
    const conversationContext = [];
    const userId = null;

    // Get AI response (use Grok with date context)
    let aiResponse;
    aiResponse = await getGrokResponse('there', question, conversationContext);

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
 * Hybrid AI: Grok starts (understanding), Perplexity joins (data lookup)
 * @param {string} userName - User's name
 * @param {string} question - User's question
 * @param {array} context - Conversation history
 * @returns {Promise<string>} - AI response
 */
async function getGrokResponse(userName, question, context = []) {
  try {
    // Get current date and time
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });

    // Direct routing - ONE API call only (fastest)
    const needsWebSearch = /\b(weather|news|today|now|current|latest|happening|stock|price|score|game|election|update|tomorrow)\b/i.test(question);

    const systemPrompt = `You are Ghost OS. ${needsWebSearch ? 'Use real-time web search for CURRENT data.' : 'Give helpful answers.'} If question unclear, ask for clarification. SHORT responses (1-3 sentences).

CURRENT TIME: ${dateStr}, ${timeStr}`;

    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...context,
      {
        role: 'user',
        content: question
      }
    ];

    if (needsWebSearch) {
      // Perplexity for real-time data
      const completion = await perplexity.chat.completions.create({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: messages,
        max_tokens: 50,
        temperature: 0.7
      });

      return completion.choices[0].message.content.trim();
    } else {
      // Grok for general questions (faster/cheaper)
      const completion = await grok.chat.completions.create({
        model: 'grok-3',
        messages: messages,
        max_tokens: 50,
        temperature: 0.7
      });

      return completion.choices[0].message.content.trim();
    }

  } catch (error) {
    logger.error('AI failed:', error);
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
