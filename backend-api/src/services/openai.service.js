import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

// Check if OpenAI API key is configured
const isOpenAIConfigured = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-key';

if (!isOpenAIConfigured) {
  console.warn('⚠️  WARNING: OpenAI API key not configured - AI features disabled');
}

// Initialize OpenAI client only if configured
const openai = isOpenAIConfigured
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Transcribe audio file using OpenAI Whisper
 * @param {string} audioFilePath - Path to audio file or URL
 * @param {string} language - Optional language code (e.g., 'en', 'es')
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeAudio(audioFilePath, language = 'en') {
  if (!openai) {
    throw new Error('OpenAI not configured - add OPENAI_API_KEY to .env');
  }

  try {
    logger.info(`Transcribing audio: ${audioFilePath}`);

    // If it's a URL, download it first
    let fileToTranscribe;
    if (audioFilePath.startsWith('http')) {
      // Download file from Supabase Storage
      const response = await fetch(audioFilePath);
      const buffer = await response.arrayBuffer();

      // Save to temp file
      const tempPath = `/tmp/audio-${Date.now()}.mp3`;
      fs.writeFileSync(tempPath, Buffer.from(buffer));
      fileToTranscribe = fs.createReadStream(tempPath);
    } else {
      fileToTranscribe = fs.createReadStream(audioFilePath);
    }

    const transcription = await openai.audio.transcriptions.create({
      file: fileToTranscribe,
      model: 'whisper-1',
      language: language,
      response_format: 'verbose_json', // Get timestamps and more details
      temperature: 0.2 // Lower temperature for more accurate transcription
    });

    logger.info(`Transcription completed: ${transcription.text.substring(0, 100)}...`);

    return {
      text: transcription.text,
      duration: transcription.duration,
      language: transcription.language,
      segments: transcription.segments || []
    };
  } catch (error) {
    logger.error('Whisper transcription error:', error);
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

/**
 * Extract structured data from transcript using GPT-4
 * @param {string} transcript - Transcribed text
 * @param {string} industry - Industry type (restaurant, dealership, salon, etc.)
 * @param {object} context - Additional context (business name, etc.)
 * @returns {Promise<object>} - Extracted structured data
 */
export async function extractStructuredData(transcript, industry, context = {}) {
  if (!openai) {
    throw new Error('OpenAI not configured - add OPENAI_API_KEY to .env');
  }

  try {
    logger.info(`Extracting data for industry: ${industry}`);

    const systemPrompt = getExtractionPrompt(industry);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Business Context: ${JSON.stringify(context)}\n\nTranscript: ${transcript}`
        }
      ],
      temperature: 0.3, // Lower temperature for consistent extraction
      response_format: { type: 'json_object' }, // Force JSON response
      max_tokens: 2000
    });

    const extractedData = JSON.parse(completion.choices[0].message.content);

    logger.info('Data extraction completed');

    return {
      ...extractedData,
      raw_transcript: transcript,
      extraction_confidence: completion.choices[0].finish_reason === 'stop' ? 'high' : 'medium',
      tokens_used: completion.usage.total_tokens
    };
  } catch (error) {
    logger.error('GPT-4 extraction error:', error);
    throw new Error(`Data extraction failed: ${error.message}`);
  }
}

/**
 * Get extraction prompt based on industry
 */
function getExtractionPrompt(industry) {
  const prompts = {
    restaurant: `You are an AI assistant that extracts structured data from restaurant-related conversations.

Extract the following information from the transcript and return ONLY valid JSON:

{
  "contact": {
    "first_name": "string or null",
    "last_name": "string or null",
    "company": "string or null",
    "phone": "string or null (format: +1234567890)",
    "email": "string or null"
  },
  "event": {
    "type": "string or null (wedding, birthday, corporate, etc.)",
    "date": "string or null (YYYY-MM-DD format)",
    "time": "string or null (HH:MM format)",
    "guest_count": "number or null",
    "budget": "string or null",
    "special_requests": "string or null"
  },
  "inquiry": {
    "type": "string (reservation, catering, private_event, general)",
    "status": "string (new, follow_up, confirmed, cancelled)",
    "priority": "string (low, medium, high, urgent)",
    "dietary_restrictions": "array of strings or empty array",
    "menu_preferences": "array of strings or empty array"
  },
  "next_steps": "array of strings (what needs to be done next)",
  "sentiment": "string (positive, neutral, negative)",
  "key_points": "array of strings (important details mentioned)",
  "follow_up_date": "string or null (YYYY-MM-DD when to follow up)"
}

Important:
- Extract only information explicitly mentioned
- Use null for missing information
- Ensure phone numbers are in E.164 format if possible
- Be precise with dates and times
- Capture dietary restrictions and allergies carefully`,

    dealership: `You are an AI assistant that extracts structured data from car dealership sales conversations.

Extract the following information from the transcript and return ONLY valid JSON:

{
  "contact": {
    "first_name": "string or null",
    "last_name": "string or null",
    "company": "string or null",
    "phone": "string or null",
    "email": "string or null"
  },
  "vehicle_interest": {
    "make": "string or null (Toyota, Ford, etc.)",
    "model": "string or null",
    "year": "number or null",
    "type": "string or null (new, used, certified)",
    "color_preference": "string or null",
    "budget_range": "string or null ($20k-$30k)",
    "financing_needed": "boolean or null"
  },
  "trade_in": {
    "has_trade": "boolean or null",
    "make": "string or null",
    "model": "string or null",
    "year": "number or null",
    "mileage": "number or null",
    "condition": "string or null (excellent, good, fair, poor)"
  },
  "timeline": {
    "urgency": "string (immediate, this_week, this_month, researching)",
    "preferred_contact_time": "string or null",
    "test_drive_scheduled": "boolean or null",
    "test_drive_date": "string or null (YYYY-MM-DD)"
  },
  "inquiry": {
    "type": "string (new_purchase, trade_in, service, financing)",
    "status": "string (lead, qualified, test_drive, negotiation, closed)",
    "source": "string or null (walk_in, phone, referral, online)"
  },
  "next_steps": "array of strings",
  "sentiment": "string (positive, neutral, negative)",
  "key_points": "array of strings",
  "follow_up_date": "string or null (YYYY-MM-DD)"
}`,

    salon: `You are an AI assistant that extracts structured data from salon/spa conversations.

Extract the following information from the transcript and return ONLY valid JSON:

{
  "contact": {
    "first_name": "string or null",
    "last_name": "string or null",
    "phone": "string or null",
    "email": "string or null"
  },
  "appointment": {
    "services": "array of strings (haircut, color, highlights, etc.)",
    "preferred_stylist": "string or null",
    "date": "string or null (YYYY-MM-DD)",
    "time": "string or null (HH:MM)",
    "duration_estimate": "number or null (in minutes)",
    "is_first_visit": "boolean or null"
  },
  "preferences": {
    "hair_type": "string or null (straight, wavy, curly, coily)",
    "hair_length": "string or null (short, medium, long)",
    "previous_services": "array of strings",
    "allergies": "array of strings",
    "color_preferences": "string or null"
  },
  "inquiry": {
    "type": "string (booking, consultation, product, rescheduling)",
    "status": "string (new, confirmed, waitlist, cancelled)",
    "special_requests": "string or null"
  },
  "next_steps": "array of strings",
  "sentiment": "string (positive, neutral, negative)",
  "key_points": "array of strings",
  "follow_up_date": "string or null (YYYY-MM-DD)"
}`,

    real_estate: `You are an AI assistant that extracts structured data from real estate conversations.

Extract the following information from the transcript and return ONLY valid JSON:

{
  "contact": {
    "first_name": "string or null",
    "last_name": "string or null",
    "phone": "string or null",
    "email": "string or null"
  },
  "property_interest": {
    "intent": "string (buying, selling, renting, investing)",
    "property_type": "string or null (house, condo, apartment, commercial)",
    "bedrooms": "number or null",
    "bathrooms": "number or null",
    "location_preferences": "array of strings (neighborhoods, cities)",
    "budget_range": "string or null",
    "move_in_timeline": "string or null"
  },
  "current_situation": {
    "is_pre_approved": "boolean or null",
    "has_property_to_sell": "boolean or null",
    "current_lease_end": "string or null (YYYY-MM-DD)",
    "working_with_agent": "boolean or null"
  },
  "preferences": {
    "must_haves": "array of strings (pool, garage, etc.)",
    "nice_to_haves": "array of strings",
    "deal_breakers": "array of strings"
  },
  "inquiry": {
    "type": "string (viewing, listing, valuation, general)",
    "status": "string (new, qualified, showing_scheduled, offer_pending)",
    "urgency": "string (low, medium, high, urgent)"
  },
  "next_steps": "array of strings",
  "sentiment": "string (positive, neutral, negative)",
  "key_points": "array of strings",
  "follow_up_date": "string or null (YYYY-MM-DD)"
}`,

    general: `You are an AI assistant that extracts structured data from business conversations.

Extract the following information from the transcript and return ONLY valid JSON:

{
  "contact": {
    "first_name": "string or null",
    "last_name": "string or null",
    "company": "string or null",
    "phone": "string or null",
    "email": "string or null"
  },
  "inquiry": {
    "type": "string (sales, support, information, complaint, feedback)",
    "subject": "string or null",
    "status": "string (new, in_progress, resolved, follow_up_needed)",
    "priority": "string (low, medium, high, urgent)",
    "category": "string or null"
  },
  "details": {
    "main_request": "string or null",
    "specific_needs": "array of strings",
    "timeline": "string or null",
    "budget_mentioned": "string or null"
  },
  "next_steps": "array of strings",
  "sentiment": "string (positive, neutral, negative)",
  "key_points": "array of strings",
  "follow_up_date": "string or null (YYYY-MM-DD)"
}`,
  };

  return prompts[industry] || prompts.general;
}

/**
 * Generate AI summary of conversation
 * @param {string} transcript - Transcribed text
 * @returns {Promise<string>} - Summary
 */
export async function generateSummary(transcript) {
  if (!openai) {
    throw new Error('OpenAI not configured - add OPENAI_API_KEY to .env');
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'You are a concise assistant. Summarize this conversation in 2-3 sentences, focusing on the key points and action items.'
        },
        {
          role: 'user',
          content: transcript
        }
      ],
      temperature: 0.5,
      max_tokens: 200
    });

    return completion.choices[0].message.content;
  } catch (error) {
    logger.error('Summary generation error:', error);
    return null;
  }
}

/**
 * Suggest next steps based on conversation
 * @param {object} extractedData - Previously extracted data
 * @param {string} industry - Industry type
 * @returns {Promise<array>} - Array of suggested next steps
 */
export async function suggestNextSteps(extractedData, industry) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: `You are a ${industry} business assistant. Based on the conversation data, suggest 3-5 specific, actionable next steps. Return as a JSON array of strings.`
        },
        {
          role: 'user',
          content: JSON.stringify(extractedData)
        }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      max_tokens: 300
    });

    const result = JSON.parse(completion.choices[0].message.content);
    return result.next_steps || [];
  } catch (error) {
    logger.error('Next steps suggestion error:', error);
    return [];
  }
}

/**
 * Analyze sentiment of conversation
 * @param {string} transcript - Transcribed text
 * @returns {Promise<object>} - Sentiment analysis
 */
export async function analyzeSentiment(transcript) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: `Analyze the sentiment of this conversation. Return JSON with:
{
  "overall": "positive|neutral|negative",
  "score": number from -1 to 1,
  "emotions": ["array", "of", "detected", "emotions"],
  "customer_satisfaction": "high|medium|low",
  "urgency_level": "low|medium|high|urgent"
}`
        },
        {
          role: 'user',
          content: transcript
        }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 200
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    logger.error('Sentiment analysis error:', error);
    return {
      overall: 'neutral',
      score: 0,
      emotions: [],
      customer_satisfaction: 'medium',
      urgency_level: 'medium'
    };
  }
}

/**
 * Process complete voice note: transcribe + extract data
 * @param {string} voiceNoteId - Voice note UUID
 * @param {string} audioUrl - URL to audio file
 * @param {string} industry - Industry type
 * @param {object} context - Additional context
 * @returns {Promise<object>} - Complete processing result
 */
export async function processVoiceNote(voiceNoteId, audioUrl, industry, context = {}) {
  try {
    logger.info(`Processing voice note: ${voiceNoteId}`);

    // Step 1: Transcribe audio
    const transcription = await transcribeAudio(audioUrl);

    // Step 2: Extract structured data
    const extractedData = await extractStructuredData(
      transcription.text,
      industry,
      context
    );

    // Step 3: Generate summary
    const summary = await generateSummary(transcription.text);

    // Step 4: Analyze sentiment
    const sentiment = await analyzeSentiment(transcription.text);

    // Step 5: Update voice note in database
    const { error: updateError } = await supabase
      .from('voice_notes')
      .update({
        transcript: transcription.text,
        extracted_data: extractedData,
        audio_duration_seconds: Math.round(transcription.duration),
        status: 'completed',
        processed_at: new Date(),
        summary: summary,
        sentiment_analysis: sentiment
      })
      .eq('id', voiceNoteId);

    if (updateError) {
      throw new Error(`Failed to update voice note: ${updateError.message}`);
    }

    // Step 6: Track usage
    await supabase.from('usage_records').insert({
      business_id: context.business_id,
      usage_type: 'ai_extraction',
      quantity: 1,
      cost: 1.00, // $1 per voice note processing
      date: new Date().toISOString().split('T')[0],
      metadata: {
        voice_note_id: voiceNoteId,
        tokens_used: extractedData.tokens_used || 0,
        duration_seconds: transcription.duration
      }
    });

    logger.info(`Voice note processing completed: ${voiceNoteId}`);

    return {
      success: true,
      voice_note_id: voiceNoteId,
      transcript: transcription.text,
      extracted_data: extractedData,
      summary: summary,
      sentiment: sentiment,
      duration: transcription.duration
    };
  } catch (error) {
    logger.error(`Voice note processing failed for ${voiceNoteId}:`, error);

    // Update voice note status to failed
    await supabase
      .from('voice_notes')
      .update({
        status: 'failed',
        error_message: error.message,
        processed_at: new Date()
      })
      .eq('id', voiceNoteId);

    throw error;
  }
}

export default {
  transcribeAudio,
  extractStructuredData,
  generateSummary,
  suggestNextSteps,
  analyzeSentiment,
  processVoiceNote
};
