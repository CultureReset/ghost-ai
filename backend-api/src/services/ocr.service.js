import vision from '@google-cloud/vision';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

// Initialize Google Cloud Vision client
let visionClient;

try {
  // If GOOGLE_APPLICATION_CREDENTIALS is set, use it
  // Otherwise, use the service account key from env
  if (process.env.GOOGLE_CLOUD_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS_JSON);
    visionClient = new vision.ImageAnnotatorClient({
      credentials
    });
  } else {
    visionClient = new vision.ImageAnnotatorClient();
  }
} catch (error) {
  logger.error('Failed to initialize Google Cloud Vision:', error);
  visionClient = null;
}

/**
 * Extract text from receipt image using OCR
 * @param {string} imageUrl - URL to receipt image
 * @returns {Promise<object>} - Extracted text and structured data
 */
export async function extractReceiptData(imageUrl) {
  if (!visionClient) {
    throw new Error('Google Cloud Vision client not initialized. Please check credentials.');
  }

  try {
    logger.info(`Processing receipt OCR: ${imageUrl}`);

    // Perform text detection
    const [textDetection] = await visionClient.textDetection(imageUrl);
    const fullText = textDetection.fullTextAnnotation?.text || '';

    if (!fullText) {
      throw new Error('No text detected in receipt image');
    }

    // Perform document text detection for better structure
    const [documentDetection] = await visionClient.documentTextDetection(imageUrl);
    const pages = documentDetection.fullTextAnnotation?.pages || [];

    // Parse receipt data
    const receiptData = parseReceiptText(fullText);

    logger.info('Receipt OCR completed successfully');

    return {
      success: true,
      raw_text: fullText,
      structured_data: receiptData,
      confidence: calculateConfidence(textDetection),
      pages: pages.length,
      detected_language: documentDetection.fullTextAnnotation?.pages[0]?.property?.detectedLanguages?.[0]?.languageCode || 'en'
    };
  } catch (error) {
    logger.error('Receipt OCR error:', error);
    throw new Error(`OCR processing failed: ${error.message}`);
  }
}

/**
 * Parse raw receipt text into structured data
 * @param {string} text - Raw OCR text
 * @returns {object} - Structured receipt data
 */
function parseReceiptText(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  const receiptData = {
    merchant_name: null,
    merchant_address: null,
    date: null,
    time: null,
    items: [],
    subtotal: null,
    tax: null,
    tip: null,
    total: null,
    payment_method: null,
    last_four_digits: null,
    transaction_id: null
  };

  // Extract merchant name (usually first few lines)
  if (lines.length > 0) {
    receiptData.merchant_name = lines[0];
  }

  // Extract date (multiple formats)
  const dateRegex = /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})|(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i;
  const timeRegex = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i;

  for (const line of lines) {
    // Date
    const dateMatch = line.match(dateRegex);
    if (dateMatch && !receiptData.date) {
      receiptData.date = dateMatch[0];
    }

    // Time
    const timeMatch = line.match(timeRegex);
    if (timeMatch && !receiptData.time) {
      receiptData.time = timeMatch[0];
    }

    // Total
    if (line.toLowerCase().includes('total') && !line.toLowerCase().includes('subtotal')) {
      const amount = extractAmount(line);
      if (amount && !receiptData.total) {
        receiptData.total = amount;
      }
    }

    // Subtotal
    if (line.toLowerCase().includes('subtotal')) {
      const amount = extractAmount(line);
      if (amount) {
        receiptData.subtotal = amount;
      }
    }

    // Tax
    if (line.toLowerCase().includes('tax')) {
      const amount = extractAmount(line);
      if (amount) {
        receiptData.tax = amount;
      }
    }

    // Tip
    if (line.toLowerCase().includes('tip') || line.toLowerCase().includes('gratuity')) {
      const amount = extractAmount(line);
      if (amount) {
        receiptData.tip = amount;
      }
    }

    // Payment method
    if (line.toLowerCase().includes('visa') || line.toLowerCase().includes('mastercard') ||
        line.toLowerCase().includes('amex') || line.toLowerCase().includes('discover')) {
      receiptData.payment_method = line;

      // Extract last 4 digits
      const cardMatch = line.match(/\*+(\d{4})/);
      if (cardMatch) {
        receiptData.last_four_digits = cardMatch[1];
      }
    }

    // Transaction ID
    if (line.toLowerCase().includes('transaction') || line.toLowerCase().includes('auth')) {
      const idMatch = line.match(/\d{6,}/);
      if (idMatch) {
        receiptData.transaction_id = idMatch[0];
      }
    }
  }

  // Extract items (lines with prices that aren't totals/tax)
  const itemRegex = /^(.+?)\s+\$?(\d+\.\d{2})$/;
  for (const line of lines) {
    if (line.toLowerCase().includes('total') ||
        line.toLowerCase().includes('tax') ||
        line.toLowerCase().includes('tip')) {
      continue;
    }

    const itemMatch = line.match(itemRegex);
    if (itemMatch) {
      receiptData.items.push({
        name: itemMatch[1].trim(),
        price: parseFloat(itemMatch[2])
      });
    }
  }

  return receiptData;
}

/**
 * Extract dollar amount from text line
 * @param {string} text - Line of text
 * @returns {number|null} - Extracted amount
 */
function extractAmount(text) {
  const amountRegex = /\$?\s*(\d+\.\d{2})/;
  const match = text.match(amountRegex);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Calculate overall confidence score
 * @param {object} detection - Vision API detection result
 * @returns {number} - Confidence score 0-1
 */
function calculateConfidence(detection) {
  const annotations = detection.textAnnotations || [];
  if (annotations.length === 0) return 0;

  const confidences = annotations
    .filter(ann => ann.confidence !== undefined)
    .map(ann => ann.confidence);

  if (confidences.length === 0) return 0.8; // Default if no confidence scores

  const avgConfidence = confidences.reduce((sum, conf) => sum + conf, 0) / confidences.length;
  return Math.round(avgConfidence * 100) / 100;
}

/**
 * Verify receipt matches profile (business name matching)
 * @param {object} receiptData - Parsed receipt data
 * @param {string} profileId - Profile UUID
 * @returns {Promise<object>} - Verification result
 */
export async function verifyReceiptMatchesProfile(receiptData, profileId) {
  try {
    // Get profile/business info
    const { data: profile } = await supabase
      .from('profiles')
      .select(`
        name,
        businesses (
          name
        )
      `)
      .eq('id', profileId)
      .single();

    if (!profile) {
      return {
        verified: false,
        reason: 'Profile not found',
        confidence: 0
      };
    }

    const merchantName = receiptData.merchant_name?.toLowerCase() || '';
    const profileName = profile.name.toLowerCase();
    const businessName = profile.businesses?.name?.toLowerCase() || '';

    // Simple name matching (can be enhanced with fuzzy matching)
    const matchesProfile = merchantName.includes(profileName) || profileName.includes(merchantName);
    const matchesBusiness = merchantName.includes(businessName) || businessName.includes(merchantName);

    const verified = matchesProfile || matchesBusiness;
    const confidence = verified ? 0.85 : 0.15;

    return {
      verified,
      confidence,
      reason: verified ? 'Merchant name matches' : 'Merchant name does not match',
      merchant_detected: receiptData.merchant_name,
      profile_name: profile.name,
      business_name: profile.businesses?.name
    };
  } catch (error) {
    logger.error('Receipt verification error:', error);
    return {
      verified: false,
      reason: `Verification failed: ${error.message}`,
      confidence: 0
    };
  }
}

/**
 * Process review receipt: OCR + verification
 * @param {string} reviewId - Review UUID
 * @param {string} receiptUrl - URL to receipt image
 * @param {string} profileId - Profile UUID
 * @returns {Promise<object>} - Complete processing result
 */
export async function processReviewReceipt(reviewId, receiptUrl, profileId) {
  try {
    logger.info(`Processing receipt for review: ${reviewId}`);

    // Step 1: Extract receipt data via OCR
    const ocrResult = await extractReceiptData(receiptUrl);

    // Step 2: Verify receipt matches profile
    const verification = await verifyReceiptMatchesProfile(ocrResult.structured_data, profileId);

    // Step 3: Update review in database
    const { error: updateError } = await supabase
      .from('reviews')
      .update({
        ocr_data: ocrResult.structured_data,
        receipt_verified: verification.verified,
        verification_confidence: verification.confidence,
        verification_reason: verification.reason,
        ocr_processed_at: new Date()
      })
      .eq('id', reviewId);

    if (updateError) {
      throw new Error(`Failed to update review: ${updateError.message}`);
    }

    // Step 4: Auto-approve if verification confidence is high
    if (verification.verified && verification.confidence > 0.8) {
      await supabase
        .from('reviews')
        .update({
          status: 'approved',
          approved_at: new Date()
        })
        .eq('id', reviewId);

      logger.info(`Review auto-approved: ${reviewId}`);
    }

    logger.info(`Receipt processing completed for review: ${reviewId}`);

    return {
      success: true,
      review_id: reviewId,
      ocr_result: ocrResult,
      verification: verification,
      auto_approved: verification.verified && verification.confidence > 0.8
    };
  } catch (error) {
    logger.error(`Receipt processing failed for review ${reviewId}:`, error);

    // Update review with error
    await supabase
      .from('reviews')
      .update({
        ocr_data: {
          error: error.message,
          failed_at: new Date().toISOString()
        },
        receipt_verified: false
      })
      .eq('id', reviewId);

    throw error;
  }
}

/**
 * Batch process receipts (for background jobs)
 * @param {array} receiptJobs - Array of {reviewId, receiptUrl, profileId}
 * @returns {Promise<array>} - Results for each job
 */
export async function batchProcessReceipts(receiptJobs) {
  const results = [];

  for (const job of receiptJobs) {
    try {
      const result = await processReviewReceipt(job.reviewId, job.receiptUrl, job.profileId);
      results.push({
        ...result,
        job_id: job.id
      });
    } catch (error) {
      results.push({
        success: false,
        job_id: job.id,
        review_id: job.reviewId,
        error: error.message
      });
    }
  }

  return results;
}

export default {
  extractReceiptData,
  verifyReceiptMatchesProfile,
  processReviewReceipt,
  batchProcessReceipts
};
