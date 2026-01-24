/**
 * Voice Data Extraction Service
 * Dynamically extracts custom data from voice notes based on business-specific fields
 * This is the core unique feature of CyberCheck - user-defined extraction categories
 */

import OpenAI from 'openai';
import { supabase } from '../config/database.js';
import logger from '../config/logger.js';

const isOpenAIConfigured = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-key';
const openai = isOpenAIConfigured ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Extract custom data from voice note transcription
 * @param {string} businessId - Business UUID
 * @param {string} transcription - Voice note transcription text
 * @param {Array} customFields - Optional custom fields (if not provided, loaded from DB)
 * @returns {Promise<Object>} Extracted data matching custom field definitions
 */
export async function extractCustomData(businessId, transcription, customFields = null) {
  try {
    // Load custom fields if not provided
    if (!customFields) {
      customFields = await getBusinessCustomFields(businessId);
    }

    if (!customFields || customFields.length === 0) {
      logger.info(`No custom fields defined for business ${businessId}`);
      return {};
    }

    // Generate dynamic extraction prompt
    const extractionPrompt = buildExtractionPrompt(customFields, transcription);

    logger.info(`Extracting custom data for business ${businessId} with ${customFields.length} fields`);

    // Call GPT-4 for extraction
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a data extraction assistant. Extract specific information from voice note transcriptions based on the provided field definitions. Return only valid JSON with the extracted data. If a field value is not found in the transcription, omit that field from the response.'
        },
        {
          role: 'user',
          content: extractionPrompt
        }
      ],
      temperature: 0.1, // Low temperature for consistent extraction
      response_format: { type: 'json_object' }
    });

    const extractedData = JSON.parse(completion.choices[0].message.content);

    logger.info(`Successfully extracted data: ${Object.keys(extractedData).length} fields`);

    // Validate and transform extracted data
    const validatedData = validateExtractedData(extractedData, customFields);

    return validatedData;

  } catch (error) {
    logger.error('Failed to extract custom data:', error);
    throw error;
  }
}

/**
 * Get custom fields for a business
 * Combines template fields (from industry template) with business-specific overrides
 */
async function getBusinessCustomFields(businessId) {
  try {
    // Get business and its industry template
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('id, industry_template_id')
      .eq('id', businessId)
      .single();

    if (bizError) throw bizError;

    if (!business) {
      throw new Error('Business not found');
    }

    let fields = [];

    // Get business-specific custom fields (overrides)
    const { data: businessFields, error: fieldError } = await supabase
      .from('business_custom_fields')
      .select('*')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('display_order');

    if (fieldError) throw fieldError;

    if (businessFields && businessFields.length > 0) {
      fields = businessFields;
    } else if (business.industry_template_id) {
      // Fall back to template default fields
      const { data: templateFields, error: templateError } = await supabase
        .from('template_fields')
        .select('*')
        .eq('template_id', business.industry_template_id)
        .order('display_order');

      if (templateError) throw templateError;

      if (templateFields) {
        fields = templateFields;
      }
    }

    return fields;

  } catch (error) {
    logger.error('Failed to get business custom fields:', error);
    throw error;
  }
}

/**
 * Build dynamic extraction prompt based on custom field definitions
 */
function buildExtractionPrompt(fields, transcription) {
  const fieldInstructions = fields.map(field => {
    let instruction = `- ${field.field_name} (${field.field_type})`;

    if (field.extraction_prompt) {
      instruction += `: ${field.extraction_prompt}`;
    } else {
      // Generate default extraction instruction based on field type
      instruction += `: Extract the ${field.field_name.toLowerCase()} from the text`;
    }

    if (field.is_required) {
      instruction += ' [REQUIRED]';
    }

    return instruction;
  }).join('\n');

  const prompt = `
Extract the following information from this voice note transcription:

${fieldInstructions}

Voice Note Transcription:
"""
${transcription}
"""

Return the extracted data as a JSON object with the following structure:
{
${fields.map(f => `  "${f.field_name}": <extracted value or null>`).join(',\n')}
}

Guidelines:
- Only include fields where you found a value in the transcription
- Return null for fields you cannot determine
- For required fields marked [REQUIRED], try your best to infer from context
- Format values according to the specified type:
  - text: plain text string
  - number: numeric value
  - currency: numeric value (just the number, no $ sign)
  - date: YYYY-MM-DD format
  - datetime: ISO 8601 format
  - phone: E.164 format if possible, or as provided
  - email: valid email address
  - url: valid URL
`;

  return prompt;
}

/**
 * Validate and transform extracted data
 */
function validateExtractedData(extractedData, fields) {
  const validated = {};

  fields.forEach(field => {
    const value = extractedData[field.field_name];

    // Skip if no value extracted
    if (value === null || value === undefined || value === '') {
      return;
    }

    // Type-specific validation and transformation
    switch (field.field_type) {
      case 'number':
      case 'currency':
        const num = parseFloat(value);
        if (!isNaN(num)) {
          validated[field.field_name] = num;
        }
        break;

      case 'phone':
        // Basic phone validation
        const phone = value.toString().replace(/\D/g, '');
        if (phone.length >= 10) {
          validated[field.field_name] = value;
        }
        break;

      case 'email':
        // Basic email validation
        if (value.includes('@') && value.includes('.')) {
          validated[field.field_name] = value;
        }
        break;

      case 'url':
        // Basic URL validation
        if (value.startsWith('http://') || value.startsWith('https://') || value.includes('.')) {
          validated[field.field_name] = value;
        }
        break;

      case 'date':
      case 'datetime':
        // Keep as is if it's a valid date format
        validated[field.field_name] = value;
        break;

      case 'text':
      default:
        // Keep as text
        validated[field.field_name] = value.toString();
        break;
    }
  });

  return validated;
}

/**
 * Process voice note and update with extracted data
 * @param {string} voiceNoteId - Voice note UUID
 * @returns {Promise<Object>} Updated voice note with extracted data
 */
export async function processVoiceNoteExtraction(voiceNoteId) {
  try {
    // Get voice note
    const { data: voiceNote, error: noteError } = await supabase
      .from('voice_notes')
      .select('id, business_id, transcription, extracted_data')
      .eq('id', voiceNoteId)
      .single();

    if (noteError) throw noteError;

    if (!voiceNote || !voiceNote.transcription) {
      throw new Error('Voice note not found or has no transcription');
    }

    // Extract custom data
    const extractedData = await extractCustomData(
      voiceNote.business_id,
      voiceNote.transcription
    );

    // Update voice note with extracted data
    const { data: updated, error: updateError } = await supabase
      .from('voice_notes')
      .update({
        extracted_data: extractedData,
        updated_at: new Date().toISOString()
      })
      .eq('id', voiceNoteId)
      .select()
      .single();

    if (updateError) throw updateError;

    logger.info(`Voice note ${voiceNoteId} processed with extracted data`);

    return updated;

  } catch (error) {
    logger.error('Failed to process voice note extraction:', error);
    throw error;
  }
}

/**
 * Re-extract data for all voice notes of a business
 * Useful when custom fields are updated
 * @param {string} businessId - Business UUID
 * @param {Object} options - Options for re-extraction
 * @returns {Promise<Object>} Summary of re-extraction results
 */
export async function reExtractBusinessVoiceNotes(businessId, options = {}) {
  try {
    const { limit = 100, onlyUnextracted = false } = options;

    // Get voice notes
    let query = supabase
      .from('voice_notes')
      .select('id, transcription, extracted_data')
      .eq('business_id', businessId)
      .not('transcription', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (onlyUnextracted) {
      query = query.or('extracted_data.is.null,extracted_data.eq.{}');
    }

    const { data: voiceNotes, error } = await query;

    if (error) throw error;

    logger.info(`Re-extracting data for ${voiceNotes.length} voice notes`);

    const results = {
      total: voiceNotes.length,
      successful: 0,
      failed: 0,
      errors: []
    };

    // Get custom fields once (same for all notes)
    const customFields = await getBusinessCustomFields(businessId);

    // Process each voice note
    for (const note of voiceNotes) {
      try {
        const extractedData = await extractCustomData(
          businessId,
          note.transcription,
          customFields
        );

        await supabase
          .from('voice_notes')
          .update({
            extracted_data: extractedData,
            updated_at: new Date().toISOString()
          })
          .eq('id', note.id);

        results.successful++;

      } catch (error) {
        results.failed++;
        results.errors.push({
          voiceNoteId: note.id,
          error: error.message
        });
        logger.error(`Failed to re-extract voice note ${note.id}:`, error);
      }

      // Add small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info(`Re-extraction complete: ${results.successful}/${results.total} successful`);

    return results;

  } catch (error) {
    logger.error('Failed to re-extract business voice notes:', error);
    throw error;
  }
}

/**
 * Get extraction statistics for a business
 */
export async function getExtractionStats(businessId) {
  try {
    const { data: voiceNotes, error } = await supabase
      .from('voice_notes')
      .select('extracted_data')
      .eq('business_id', businessId);

    if (error) throw error;

    const stats = {
      total_notes: voiceNotes.length,
      notes_with_data: 0,
      notes_without_data: 0,
      extracted_fields: {},
      total_extractions: 0
    };

    voiceNotes.forEach(note => {
      if (note.extracted_data && Object.keys(note.extracted_data).length > 0) {
        stats.notes_with_data++;

        Object.keys(note.extracted_data).forEach(fieldName => {
          stats.extracted_fields[fieldName] = (stats.extracted_fields[fieldName] || 0) + 1;
          stats.total_extractions++;
        });
      } else {
        stats.notes_without_data++;
      }
    });

    return stats;

  } catch (error) {
    logger.error('Failed to get extraction stats:', error);
    throw error;
  }
}

export default {
  extractCustomData,
  processVoiceNoteExtraction,
  reExtractBusinessVoiceNotes,
  getExtractionStats
};
