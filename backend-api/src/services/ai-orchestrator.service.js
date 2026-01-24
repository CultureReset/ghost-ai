import OpenAI from 'openai';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';

// Initialize OpenAI
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * AI Orchestrator Service
 * Interprets user intent from natural language and generates action plans
 */

// Supported intents
export const INTENTS = {
  UPDATE_HOURS: 'update_hours',
  SEND_SMS: 'send_sms',
  CREATE_EVENT: 'create_event',
  UPDATE_STATUS: 'update_status',
  ADD_SPECIAL: 'add_special',
  GET_STATUS: 'get_status',
  // Menu intents
  UPDATE_MENU_PRICE: 'update_menu_price',
  MARK_SOLD_OUT: 'mark_sold_out',
  MARK_AVAILABLE: 'mark_available',
  ADD_MENU_ITEM: 'add_menu_item',
  UPDATE_MENU_DESCRIPTION: 'update_menu_description',
  UNKNOWN: 'unknown'
};

/**
 * Generate action plan from transcript
 * @param {string} transcript - Transcribed speech
 * @param {string} businessId - Business UUID
 * @param {string} userId - User UUID (caller)
 * @param {string} callId - Voice call UUID
 * @returns {Promise<object>} - Action plan
 */
export async function generateActionPlan(transcript, businessId, userId = null, callId = null) {
  if (!openai) {
    throw new Error('OpenAI not configured');
  }

  try {
    // Get business context
    const { data: business } = await supabase
      .from('businesses')
      .select('name, email, phone')
      .eq('id', businessId)
      .single();

    // Get profile data for context
    const { data: profiles } = await supabase
      .from('profiles')
      .select('*')
      .eq('business_id', businessId)
      .eq('status', 'active');

    const profile = profiles?.[0];

    // Prepare context for AI
    const context = {
      business_name: business?.name,
      has_profile: !!profile,
      current_hours: profile?.structured_fields?.hours || null,
      current_status: profile?.structured_fields?.status || null
    };

    // Create prompt for AI
    const systemPrompt = `You are an AI assistant that interprets business owner voice commands and generates action plans.

Business Context:
- Business: ${context.business_name}
- Has Profile: ${context.has_profile}
- Current Hours: ${JSON.stringify(context.current_hours)}
- Current Status: ${JSON.stringify(context.current_status)}

Your task is to:
1. Interpret the owner's intent from their spoken words
2. Extract relevant entities (dates, times, messages, etc.)
3. Generate a structured action plan to execute their request

Supported Intents:
- update_hours: Change business operating hours
- send_sms: Send SMS message to customers
- create_event: Create new event or special
- update_status: Update business status (open/closed/special hours)
- add_special: Add daily special or promotion
- get_status: Get current business status
- update_menu_price: Change price of menu item
- mark_sold_out: Mark menu item as sold out (86'd)
- mark_available: Mark menu item as available again
- add_menu_item: Add new item to menu
- update_menu_description: Update menu item description

Output Format (JSON):
{
  "intent": "update_hours",
  "confidence": 0.95,
  "entities": {
    "date": "2025-12-19",
    "hours": "10:00-18:00",
    "reason": "closing early"
  },
  "actions": [
    {
      "type": "page_update",
      "target": "profile",
      "operation": "patch",
      "path": "structured_fields.hours.thursday",
      "value": "10:00-18:00"
    },
    {
      "type": "tool_call",
      "tool": "sms",
      "command": "send_bulk",
      "inputs": {
        "message": "We're closing early today at 6pm. Thank you!"
      }
    }
  ],
  "requires_confirmation": false,
  "response_text": "I've updated your hours to close at 6pm today and sent SMS notifications to your customers."
}

Important:
- Be conservative with confidence scores (0.0 to 1.0)
- Set requires_confirmation to true for destructive actions
- Generate natural response_text to speak back to the owner
- Use ISO 8601 format for dates/times
- If intent is unclear, use "unknown" and ask for clarification`;

    const userPrompt = `Owner said: "${transcript}"

Generate the action plan:`;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const planData = JSON.parse(completion.choices[0].message.content);

    // Generate request ID for idempotency
    const requestId = uuidv4();

    // Store action plan in database
    const { data: actionPlan, error } = await supabase
      .from('action_plans')
      .insert({
        call_id: callId,
        request_id: requestId,
        business_id: businessId,
        user_id: userId,
        intent: planData.intent,
        entities: planData.entities || {},
        original_input: transcript,
        actions: planData.actions || [],
        requires_confirmation: planData.requires_confirmation || false,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    logger.info(`Action plan generated: ${actionPlan.id} for business: ${businessId}`, {
      intent: planData.intent,
      confidence: planData.confidence,
      actions_count: planData.actions?.length || 0
    });

    return {
      ...planData,
      action_plan_id: actionPlan.id,
      request_id: requestId
    };
  } catch (error) {
    logger.error('Generate action plan error:', error);
    throw error;
  }
}

/**
 * Classify intent from transcript (simpler version without OpenAI)
 * @param {string} transcript - Transcribed speech
 * @returns {object} - Intent classification
 */
export function classifyIntentSimple(transcript) {
  const text = transcript.toLowerCase();

  // Simple keyword matching
  if (text.includes('hour') || text.includes('close') || text.includes('open')) {
    return {
      intent: INTENTS.UPDATE_HOURS,
      confidence: 0.7,
      keywords: ['hours', 'close', 'open']
    };
  }

  if (text.includes('send') && (text.includes('text') || text.includes('message') || text.includes('sms'))) {
    return {
      intent: INTENTS.SEND_SMS,
      confidence: 0.75,
      keywords: ['send', 'text', 'message', 'sms']
    };
  }

  if (text.includes('event') || text.includes('special') || text.includes('promotion')) {
    return {
      intent: INTENTS.ADD_SPECIAL,
      confidence: 0.7,
      keywords: ['event', 'special', 'promotion']
    };
  }

  if (text.includes('status') || text.includes('how') && text.includes('doing')) {
    return {
      intent: INTENTS.GET_STATUS,
      confidence: 0.65,
      keywords: ['status']
    };
  }

  return {
    intent: INTENTS.UNKNOWN,
    confidence: 0.0,
    keywords: []
  };
}

/**
 * Extract entities from transcript for specific intent
 * @param {string} transcript - Transcribed speech
 * @param {string} intent - Classified intent
 * @returns {object} - Extracted entities
 */
export function extractEntities(transcript, intent) {
  const entities = {};

  switch (intent) {
    case INTENTS.UPDATE_HOURS: {
      // Extract time patterns
      const timePattern = /(\d{1,2})\s*(am|pm)?/gi;
      const matches = [...transcript.matchAll(timePattern)];

      if (matches.length > 0) {
        const hour = parseInt(matches[0][1]);
        const period = matches[0][2] || (hour < 12 ? 'am' : 'pm');
        entities.closing_time = `${hour}:00${period}`;
      }

      // Extract date references
      if (transcript.toLowerCase().includes('today')) {
        entities.date = 'today';
      }
      break;
    }

    case INTENTS.SEND_SMS: {
      // Extract message after "send" or "text"
      const msgPattern = /(?:send|text)\s+(?:them|customers)?\s*[":']?(.+?)[":']?$/i;
      const match = transcript.match(msgPattern);
      if (match) {
        entities.message = match[1].trim();
      }
      break;
    }
  }

  return entities;
}

/**
 * Generate default action plan for simple intents (no OpenAI required)
 * @param {string} intent - Intent type
 * @param {object} entities - Extracted entities
 * @param {string} businessId - Business UUID
 * @returns {object} - Simple action plan
 */
export function generateSimpleActionPlan(intent, entities, businessId) {
  const actions = [];
  let responseText = "I'm not sure what you want me to do. Can you try again?";

  switch (intent) {
    case INTENTS.UPDATE_HOURS: {
      if (entities.closing_time) {
        actions.push({
          type: 'page_update',
          target: 'profile',
          operation: 'patch',
          path: 'structured_fields.status',
          value: `Closing early at ${entities.closing_time}`
        });

        actions.push({
          type: 'tool_call',
          tool: 'sms',
          command: 'send_bulk',
          inputs: {
            message: `We're closing early today at ${entities.closing_time}. Thank you!`
          }
        });

        responseText = `I've updated your status to show you're closing early at ${entities.closing_time} and sent notifications to customers.`;
      }
      break;
    }

    case INTENTS.SEND_SMS: {
      if (entities.message) {
        actions.push({
          type: 'tool_call',
          tool: 'sms',
          command: 'send_bulk',
          inputs: {
            message: entities.message
          }
        });

        responseText = `I've sent your message to all customers.`;
      }
      break;
    }

    case INTENTS.GET_STATUS: {
      actions.push({
        type: 'query',
        target: 'business_status',
        operation: 'get'
      });

      responseText = "Let me check your current business status.";
      break;
    }
  }

  return {
    intent,
    entities,
    actions,
    requires_confirmation: false,
    response_text: responseText
  };
}

export default {
  INTENTS,
  generateActionPlan,
  classifyIntentSimple,
  extractEntities,
  generateSimpleActionPlan
};
