import Queue from 'bull';
import { processReviewReceipt } from '../services/ocr.service.js';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';
import { sendReceiptVerifiedNotification } from '../services/sms.service.js';

// Create Bull queue for receipt OCR processing
export const receiptQueue = new Queue('receipt-processing', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: 100,
    removeOnFail: 200
  }
});

/**
 * Process receipt OCR job
 */
receiptQueue.process(async (job) => {
  const { reviewId, receiptUrl, profileId, businessId } = job.data;

  logger.info(`Processing receipt job: ${job.id} - Review: ${reviewId}`);

  try {
    // Process receipt with OCR
    const result = await processReviewReceipt(reviewId, receiptUrl, profileId);

    // Create notification for business owner
    const { data: owner } = await supabase
      .from('users')
      .select('id')
      .eq('business_id', businessId)
      .eq('role', 'owner')
      .single();

    if (owner) {
      const status = result.auto_approved ? 'approved' : 'needs review';
      await supabase.from('notifications').insert({
        user_id: owner.id,
        business_id: businessId,
        type: 'review_receipt_processed',
        title: 'Receipt Verified',
        message: `A review receipt has been processed and ${status}.`,
        action_url: `/reviews/${reviewId}`,
        action_label: 'View Review',
        data: {
          review_id: reviewId,
          verified: result.verification.verified,
          auto_approved: result.auto_approved
        }
      });
    }

    // Send SMS notification
    await sendReceiptVerifiedNotification(reviewId, businessId);

    logger.info(`Receipt processing completed: ${reviewId}`);

    return {
      success: true,
      reviewId,
      result
    };
  } catch (error) {
    logger.error(`Receipt processing failed: ${reviewId}`, error);
    throw error; // Let Bull handle retries
  }
});

/**
 * Handle job completion
 */
receiptQueue.on('completed', (job, result) => {
  logger.info(`Receipt job completed: ${job.id}`, result);
});

/**
 * Handle job failure
 */
receiptQueue.on('failed', (job, error) => {
  logger.error(`Receipt job failed: ${job.id}`, error);
});

/**
 * Add receipt to processing queue
 * @param {object} data - Job data
 * @returns {Promise<object>} - Job info
 */
export async function queueReceiptProcessing(data) {
  try {
    const job = await receiptQueue.add(data, {
      priority: data.priority || 5,
      delay: data.delay || 0
    });

    logger.info(`Receipt queued for processing: ${data.reviewId} - Job ID: ${job.id}`);

    return {
      success: true,
      jobId: job.id,
      reviewId: data.reviewId,
      queuedAt: new Date()
    };
  } catch (error) {
    logger.error('Failed to queue receipt:', error);
    throw error;
  }
}

/**
 * Get queue stats
 * @returns {Promise<object>} - Queue statistics
 */
export async function getQueueStats() {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      receiptQueue.getWaitingCount(),
      receiptQueue.getActiveCount(),
      receiptQueue.getCompletedCount(),
      receiptQueue.getFailedCount()
    ]);

    return {
      success: true,
      stats: {
        waiting,
        active,
        completed,
        failed,
        total: waiting + active
      }
    };
  } catch (error) {
    logger.error('Failed to get queue stats:', error);
    throw error;
  }
}

export default {
  receiptQueue,
  queueReceiptProcessing,
  getQueueStats
};
