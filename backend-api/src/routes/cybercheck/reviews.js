import express from 'express';
import multer from 'multer';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';
import { queueReceiptProcessing, getQueueStats } from '../../workers/receiptWorker.js';

const router = express.Router();

// Configure multer for receipt uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    const allowedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

/**
 * GET /api/reviews
 * Get reviews (public or for authenticated business)
 */
router.get('/', async (req, res) => {
  try {
    const { profile_id, business_id, status, limit = 20, offset = 0 } = req.query;

    let query = supabase
      .from('reviews')
      .select(`
        *,
        users (
          full_name
        ),
        profiles (
          name,
          slug
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    // If authenticated, show all reviews for their business
    // If not authenticated, only show approved reviews
    if (req.user) {
      if (business_id) {
        query = query.eq('business_id', business_id);
      } else {
        query = query.eq('business_id', req.user.business_id);
      }
    } else {
      query = query.eq('status', 'approved');
    }

    if (profile_id) {
      query = query.eq('profile_id', profile_id);
    }

    if (status && req.user) {
      query = query.eq('status', status);
    }

    const { data: reviews, error, count } = await query;

    if (error) {
      logger.error('Get reviews error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get reviews'
      });
    }

    res.json({
      success: true,
      data: {
        reviews,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    logger.error('Get reviews error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/reviews/stats
 * Get review statistics for authenticated business
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const { data: reviews } = await supabase
      .from('reviews')
      .select('overall_rating, status, created_at')
      .eq('business_id', req.user.business_id);

    if (!reviews || reviews.length === 0) {
      return res.json({
        success: true,
        data: {
          total: 0,
          pending: 0,
          approved: 0,
          rejected: 0,
          average_rating: 0
        }
      });
    }

    const stats = {
      total: reviews.length,
      pending: reviews.filter(r => r.status === 'pending').length,
      approved: reviews.filter(r => r.status === 'approved').length,
      rejected: reviews.filter(r => r.status === 'rejected').length,
      average_rating: reviews.filter(r => r.status === 'approved').length > 0
        ? (reviews.filter(r => r.status === 'approved').reduce((sum, r) => sum + r.overall_rating, 0) / reviews.filter(r => r.status === 'approved').length).toFixed(1)
        : 0
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Get reviews stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/reviews/:id
 * Get single review by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: review, error } = await supabase
      .from('reviews')
      .select(`
        *,
        users (
          full_name,
          email
        ),
        profiles (
          name,
          slug
        ),
        review_reactions (
          reaction_type,
          count
        )
      `)
      .eq('id', id)
      .single();

    if (error || !review) {
      return res.status(404).json({
        success: false,
        error: 'Review not found'
      });
    }

    // If not authenticated or not their business, only show approved reviews
    if (!req.user || (req.user.business_id !== review.business_id)) {
      if (review.status !== 'approved') {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }
    }

    res.json({
      success: true,
      data: review
    });
  } catch (error) {
    logger.error('Get review error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/reviews
 * Submit a new review with receipt verification
 */
router.post('/', authenticateToken, upload.single('receipt'), async (req, res) => {
  try {
    const {
      profile_id,
      overall_rating,
      review_text,
      food_rating,
      service_rating,
      ambiance_rating,
      value_rating,
      item_ratings, // JSON string of item-specific ratings
      visit_date
    } = req.body;

    // Validation
    if (!profile_id || !overall_rating) {
      return res.status(400).json({
        success: false,
        error: 'profile_id and overall_rating are required'
      });
    }

    if (overall_rating < 1 || overall_rating > 5) {
      return res.status(400).json({
        success: false,
        error: 'overall_rating must be between 1 and 5'
      });
    }

    // Get profile and business info
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, business_id, name')
      .eq('id', profile_id)
      .single();

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    let receiptUrl = null;
    let receiptVerified = false;
    let ocrData = null;

    // Upload receipt if provided
    if (req.file) {
      const fileName = `receipts/${profile.business_id}/${Date.now()}-${req.file.originalname}`;

      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          cacheControl: '3600'
        });

      if (uploadError) {
        logger.error('Receipt upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: 'Failed to upload receipt'
        });
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('receipts')
        .getPublicUrl(fileName);

      receiptUrl = publicUrl;

      // Mark as pending verification - OCR will be processed in background
      receiptVerified = false;
      ocrData = {
        status: 'queued',
        message: 'Receipt verification queued for OCR processing'
      };
    }

    // Create review
    const { data: review, error: createError } = await supabase
      .from('reviews')
      .insert({
        business_id: profile.business_id,
        profile_id: profile_id,
        user_id: req.user.id,
        overall_rating: parseFloat(overall_rating),
        food_rating: food_rating ? parseFloat(food_rating) : null,
        service_rating: service_rating ? parseFloat(service_rating) : null,
        ambiance_rating: ambiance_rating ? parseFloat(ambiance_rating) : null,
        value_rating: value_rating ? parseFloat(value_rating) : null,
        review_text: review_text || null,
        visit_date: visit_date || new Date().toISOString().split('T')[0],
        receipt_url: receiptUrl,
        receipt_verified: receiptVerified,
        ocr_data: ocrData,
        item_ratings: item_ratings ? JSON.parse(item_ratings) : null,
        status: receiptUrl ? 'pending' : 'approved' // Auto-approve if no receipt
      })
      .select()
      .single();

    if (createError) {
      logger.error('Create review error:', createError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create review'
      });
    }

    // Queue OCR processing if receipt was uploaded
    if (receiptUrl) {
      await queueReceiptProcessing({
        reviewId: review.id,
        receiptUrl: receiptUrl,
        profileId: profile_id,
        businessId: profile.business_id
      });

      logger.info(`Receipt OCR queued for review: ${review.id}`);
    }

    // Create notification for business owner
    await supabase.from('notifications').insert({
      user_id: req.user.id, // TODO: Should be business owner's user_id
      business_id: profile.business_id,
      type: 'new_review',
      title: 'New Review Submitted',
      message: `${req.user.full_name} left a ${overall_rating}-star review for ${profile.name}`,
      action_url: `/reviews/${review.id}`,
      action_label: 'View Review'
    });

    logger.info(`Review created: ${review.id} for profile ${profile_id} by ${req.user.email}`);

    res.status(201).json({
      success: true,
      message: receiptUrl
        ? 'Review submitted. Receipt verification in progress.'
        : 'Review submitted successfully.',
      data: review
    });
  } catch (error) {
    logger.error('Create review error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/reviews/:id/approve
 * Approve a review (business owner/admin only)
 */
router.put('/:id/approve', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get review
    const { data: review } = await supabase
      .from('reviews')
      .select('business_id, status')
      .eq('id', id)
      .single();

    if (!review) {
      return res.status(404).json({
        success: false,
        error: 'Review not found'
      });
    }

    // Check if user has permission
    if (review.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only business owner or admin can approve reviews'
      });
    }

    // Update review status
    const { data: updatedReview, error } = await supabase
      .from('reviews')
      .update({
        status: 'approved',
        approved_at: new Date(),
        approved_by: req.user.id,
        updated_at: new Date()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Approve review error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to approve review'
      });
    }

    logger.info(`Review approved: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Review approved successfully',
      data: updatedReview
    });
  } catch (error) {
    logger.error('Approve review error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/reviews/:id/reject
 * Reject a review (business owner/admin only)
 */
router.put('/:id/reject', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rejection_reason } = req.body;

    // Get review
    const { data: review } = await supabase
      .from('reviews')
      .select('business_id, user_id')
      .eq('id', id)
      .single();

    if (!review) {
      return res.status(404).json({
        success: false,
        error: 'Review not found'
      });
    }

    // Check if user has permission
    if (review.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Only business owner or admin can reject reviews'
      });
    }

    // Update review status
    const { data: updatedReview, error } = await supabase
      .from('reviews')
      .update({
        status: 'rejected',
        rejection_reason: rejection_reason || 'Review did not meet verification requirements',
        updated_at: new Date()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Reject review error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to reject review'
      });
    }

    // Notify the reviewer
    await supabase.from('notifications').insert({
      user_id: review.user_id,
      business_id: review.business_id,
      type: 'review_rejected',
      title: 'Review Not Approved',
      message: rejection_reason || 'Your review could not be verified',
      action_url: `/reviews/${id}`,
      action_label: 'View Details'
    });

    logger.info(`Review rejected: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Review rejected',
      data: updatedReview
    });
  } catch (error) {
    logger.error('Reject review error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/reviews/:id/respond
 * Business owner responds to a review
 */
router.post('/:id/respond', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { response_text } = req.body;

    if (!response_text || response_text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'response_text is required'
      });
    }

    // Get review
    const { data: review } = await supabase
      .from('reviews')
      .select('business_id, user_id, status')
      .eq('id', id)
      .single();

    if (!review) {
      return res.status(404).json({
        success: false,
        error: 'Review not found'
      });
    }

    // Check if user has permission
    if (review.business_id !== req.user.business_id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    // Only respond to approved reviews
    if (review.status !== 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Can only respond to approved reviews'
      });
    }

    // Update review with response
    const { data: updatedReview, error } = await supabase
      .from('reviews')
      .update({
        response_text: response_text,
        response_date: new Date(),
        updated_at: new Date()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Respond to review error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to respond to review'
      });
    }

    // Notify the reviewer
    await supabase.from('notifications').insert({
      user_id: review.user_id,
      business_id: review.business_id,
      type: 'review_responded',
      title: 'Business Responded to Your Review',
      message: 'The business has responded to your review',
      action_url: `/reviews/${id}`,
      action_label: 'View Response'
    });

    logger.info(`Review response added: ${id} by ${req.user.email}`);

    res.json({
      success: true,
      message: 'Response posted successfully',
      data: updatedReview
    });
  } catch (error) {
    logger.error('Respond to review error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/reviews/:id/react
 * Add a reaction to a review (helpful, funny, etc.)
 */
router.post('/:id/react', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { reaction_type } = req.body;

    const validReactions = ['helpful', 'funny', 'inspiring', 'not_helpful'];
    if (!validReactions.includes(reaction_type)) {
      return res.status(400).json({
        success: false,
        error: `reaction_type must be one of: ${validReactions.join(', ')}`
      });
    }

    // Check if review exists
    const { data: review } = await supabase
      .from('reviews')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!review || review.status !== 'approved') {
      return res.status(404).json({
        success: false,
        error: 'Review not found'
      });
    }

    // Check if user already reacted
    const { data: existingReaction } = await supabase
      .from('review_reactions')
      .select('id, reaction_type')
      .eq('review_id', id)
      .eq('user_id', req.user.id)
      .single();

    if (existingReaction) {
      // Update reaction if different
      if (existingReaction.reaction_type !== reaction_type) {
        await supabase
          .from('review_reactions')
          .update({ reaction_type, updated_at: new Date() })
          .eq('id', existingReaction.id);

        return res.json({
          success: true,
          message: 'Reaction updated'
        });
      } else {
        // Remove reaction if same (toggle)
        await supabase
          .from('review_reactions')
          .delete()
          .eq('id', existingReaction.id);

        return res.json({
          success: true,
          message: 'Reaction removed'
        });
      }
    }

    // Add new reaction
    await supabase
      .from('review_reactions')
      .insert({
        review_id: id,
        user_id: req.user.id,
        reaction_type
      });

    res.json({
      success: true,
      message: 'Reaction added'
    });
  } catch (error) {
    logger.error('React to review error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/reviews/queue/stats
 * Get receipt OCR queue statistics
 */
router.get('/queue/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await getQueueStats();

    res.json({
      success: true,
      data: stats.stats
    });
  } catch (error) {
    logger.error('Get receipt queue stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get queue statistics'
    });
  }
});

/**
 * GET /api/reviews/verify-token
 * Verify a magic link token for review submission
 */
router.get('/verify-token', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }

    // Query review_tokens table
    const { data: tokenData, error } = await supabase
      .from('review_tokens')
      .select(`
        *,
        businesses (
          name,
          business_type
        ),
        profiles (
          name,
          slug
        )
      `)
      .eq('token', token)
      .eq('is_used', false)
      .single();

    if (error || !tokenData) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Check if token is expired (optional - add expires_at column if needed)
    if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
      return res.status(404).json({
        success: false,
        error: 'Token has expired'
      });
    }

    res.json({
      success: true,
      data: {
        business_id: tokenData.business_id,
        business_name: tokenData.businesses?.name,
        business_type: tokenData.businesses?.business_type,
        profile_id: tokenData.profile_id,
        profile_name: tokenData.profiles?.name,
        customer_name: tokenData.customer_name,
        customer_phone: tokenData.customer_phone
      }
    });
  } catch (error) {
    logger.error('Verify token error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/reviews/submit
 * Submit a review via magic link (no authentication required)
 */
router.post('/submit', upload.single('receipt_photo'), async (req, res) => {
  try {
    const {
      token,
      rating,
      review_text,
      customer_name
    } = req.body;

    // Validate required fields
    if (!token || !rating || !review_text) {
      return res.status(400).json({
        success: false,
        error: 'Token, rating, and review_text are required'
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        error: 'Rating must be between 1 and 5'
      });
    }

    // Verify token
    const { data: tokenData, error: tokenError } = await supabase
      .from('review_tokens')
      .select('*')
      .eq('token', token)
      .eq('is_used', false)
      .single();

    if (tokenError || !tokenData) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or already used token'
      });
    }

    // Check if token is expired (if expires_at exists)
    if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
      return res.status(404).json({
        success: false,
        error: 'Token has expired'
      });
    }

    let receiptUrl = null;
    let receiptVerified = false;

    // Upload receipt if provided
    if (req.file) {
      const fileName = `receipts/${tokenData.business_id}/${Date.now()}-${req.file.originalname}`;

      const { error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          cacheControl: '3600'
        });

      if (uploadError) {
        logger.error('Receipt upload error:', uploadError);
        return res.status(500).json({
          success: false,
          error: 'Failed to upload receipt'
        });
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('receipts')
        .getPublicUrl(fileName);

      receiptUrl = publicUrl;
    }

    // Create review
    const { data: review, error: createError } = await supabase
      .from('reviews')
      .insert({
        business_id: tokenData.business_id,
        profile_id: tokenData.profile_id,
        overall_rating: parseFloat(rating),
        review_text: review_text,
        customer_name: customer_name || tokenData.customer_name,
        customer_phone: tokenData.customer_phone,
        visit_date: new Date().toISOString().split('T')[0],
        receipt_url: receiptUrl,
        receipt_verified: receiptVerified,
        status: receiptUrl ? 'pending' : 'approved', // Auto-approve if no receipt
        source: 'magic_link'
      })
      .select()
      .single();

    if (createError) {
      logger.error('Create review error:', createError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create review'
      });
    }

    // Queue OCR processing if receipt was uploaded
    if (receiptUrl) {
      await queueReceiptProcessing({
        reviewId: review.id,
        receiptUrl: receiptUrl,
        profileId: tokenData.profile_id,
        businessId: tokenData.business_id
      });

      logger.info(`Receipt OCR queued for review: ${review.id}`);
    }

    // Mark token as used
    await supabase
      .from('review_tokens')
      .update({
        is_used: true,
        used_at: new Date()
      })
      .eq('token', token);

    // Create notification for business owner
    await supabase.from('notifications').insert({
      business_id: tokenData.business_id,
      type: 'new_review',
      title: 'New Review Submitted',
      message: `${customer_name || 'A customer'} left a ${rating}-star review`,
      action_url: `/reviews/${review.id}`,
      action_label: 'View Review'
    });

    logger.info(`Review created via magic link: ${review.id} for profile ${tokenData.profile_id}`);

    res.status(201).json({
      success: true,
      message: receiptUrl
        ? 'Review submitted! Receipt verification in progress.'
        : 'Review submitted successfully!',
      data: review
    });
  } catch (error) {
    logger.error('Submit review via magic link error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/reviews/stats/:profile_id
 * Get review statistics for a profile
 */
router.get('/stats/:profile_id', async (req, res) => {
  try {
    const { profile_id } = req.params;

    // Get all approved reviews for this profile
    const { data: reviews } = await supabase
      .from('reviews')
      .select('overall_rating, food_rating, service_rating, ambiance_rating, value_rating, receipt_verified')
      .eq('profile_id', profile_id)
      .eq('status', 'approved');

    if (!reviews || reviews.length === 0) {
      return res.json({
        success: true,
        data: {
          total_reviews: 0,
          average_rating: 0,
          verified_reviews: 0,
          rating_breakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
        }
      });
    }

    const stats = {
      total_reviews: reviews.length,
      verified_reviews: reviews.filter(r => r.receipt_verified).length,
      average_rating: (reviews.reduce((sum, r) => sum + r.overall_rating, 0) / reviews.length).toFixed(1),
      avg_food_rating: reviews.filter(r => r.food_rating).length > 0
        ? (reviews.filter(r => r.food_rating).reduce((sum, r) => sum + r.food_rating, 0) / reviews.filter(r => r.food_rating).length).toFixed(1)
        : null,
      avg_service_rating: reviews.filter(r => r.service_rating).length > 0
        ? (reviews.filter(r => r.service_rating).reduce((sum, r) => sum + r.service_rating, 0) / reviews.filter(r => r.service_rating).length).toFixed(1)
        : null,
      avg_ambiance_rating: reviews.filter(r => r.ambiance_rating).length > 0
        ? (reviews.filter(r => r.ambiance_rating).reduce((sum, r) => sum + r.ambiance_rating, 0) / reviews.filter(r => r.ambiance_rating).length).toFixed(1)
        : null,
      avg_value_rating: reviews.filter(r => r.value_rating).length > 0
        ? (reviews.filter(r => r.value_rating).reduce((sum, r) => sum + r.value_rating, 0) / reviews.filter(r => r.value_rating).length).toFixed(1)
        : null,
      rating_breakdown: {
        5: reviews.filter(r => r.overall_rating === 5).length,
        4: reviews.filter(r => r.overall_rating === 4).length,
        3: reviews.filter(r => r.overall_rating === 3).length,
        2: reviews.filter(r => r.overall_rating === 2).length,
        1: reviews.filter(r => r.overall_rating === 1).length
      }
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Get review stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;
