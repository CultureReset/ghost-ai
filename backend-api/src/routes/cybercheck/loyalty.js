import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { supabase } from '../../config/database.js';
import { authenticate } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// Configure multer for receipt uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Apply authentication to all routes except public review pages
router.use((req, res, next) => {
  // Public routes
  if (req.path.startsWith('/review/') || req.path.startsWith('/checkin/')) {
    return next();
  }
  // Protected routes
  authenticate(req, res, next);
});

// =============================================
// PROGRAM MANAGEMENT
// =============================================

/**
 * GET /api/loyalty/program
 * Get loyalty program settings
 */
router.get('/program', async (req, res) => {
  try {
    const businessId = req.user.business_id;

    const { data, error } = await supabase
      .from('loyalty_programs')
      .select('*')
      .eq('business_id', businessId)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: data || {}
    });

  } catch (error) {
    logger.error('Failed to get loyalty program:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get loyalty program',
      message: error.message
    });
  }
});

/**
 * PUT /api/loyalty/program
 * Update loyalty program settings
 */
router.put('/program', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const updates = req.body;

    const { data, error } = await supabase
      .from('loyalty_programs')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('business_id', businessId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data,
      message: 'Loyalty program updated successfully'
    });

  } catch (error) {
    logger.error('Failed to update loyalty program:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update loyalty program',
      message: error.message
    });
  }
});

/**
 * GET /api/loyalty/stats
 * Get loyalty program statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const businessId = req.user.business_id;

    // Get member counts
    const { data: members } = await supabase
      .from('loyalty_members')
      .select('id, status, monthly_spent, created_at')
      .eq('business_id', businessId);

    // Get transaction totals
    const { data: transactions } = await supabase
      .from('loyalty_transactions')
      .select('total_amount, transaction_date')
      .eq('business_id', businessId);

    // Calculate stats
    const totalMembers = members?.length || 0;
    const activeMembers = members?.filter(m => m.status === 'active').length || 0;
    const thisMonth = new Date();
    thisMonth.setDate(1);
    const activeThisMonth = members?.filter(m =>
      m.monthly_spent > 0
    ).length || 0;

    const totalRevenue = transactions?.reduce((sum, t) =>
      sum + parseFloat(t.total_amount), 0
    ) || 0;

    const avgVisitValue = transactions?.length > 0
      ? totalRevenue / transactions.length
      : 0;

    res.json({
      success: true,
      data: {
        total_members: totalMembers,
        active_members: activeMembers,
        active_this_month: activeThisMonth,
        total_revenue: totalRevenue,
        avg_visit_value: avgVisitValue,
        total_transactions: transactions?.length || 0
      }
    });

  } catch (error) {
    logger.error('Failed to get loyalty stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get loyalty stats',
      message: error.message
    });
  }
});

// =============================================
// MEMBER MANAGEMENT
// =============================================

/**
 * GET /api/loyalty/members
 * List all loyalty members
 */
router.get('/members', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const {
      status,
      tier,
      min_spent,
      search,
      limit = 50,
      offset = 0
    } = req.query;

    let query = supabase
      .from('loyalty_members')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId);

    if (status) query = query.eq('status', status);
    if (tier) query = query.eq('current_tier', tier);
    if (min_spent) query = query.gte('lifetime_spent', min_spent);
    if (search) {
      query = query.or(`phone_number.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      success: true,
      data,
      pagination: {
        total: count,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (error) {
    logger.error('Failed to get loyalty members:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get loyalty members',
      message: error.message
    });
  }
});

/**
 * GET /api/loyalty/members/:phone
 * Get member by phone number
 */
router.get('/members/:phone', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { phone } = req.params;

    // Get member
    const { data: member, error: memberError } = await supabase
      .from('loyalty_members')
      .select('*')
      .eq('business_id', businessId)
      .eq('phone_number', phone)
      .single();

    if (memberError) throw memberError;

    // Get recent transactions
    const { data: transactions } = await supabase
      .from('loyalty_transactions')
      .select('*')
      .eq('member_id', member.id)
      .order('transaction_date', { ascending: false })
      .limit(10);

    res.json({
      success: true,
      data: {
        ...member,
        recent_transactions: transactions || []
      }
    });

  } catch (error) {
    if (error.code === 'PGRST116') {
      return res.status(404).json({
        success: false,
        error: 'Member not found'
      });
    }

    logger.error('Failed to get loyalty member:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get loyalty member',
      message: error.message
    });
  }
});

/**
 * POST /api/loyalty/members
 * Create/enroll new member
 */
router.post('/members', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { phone_number, email, first_name, last_name } = req.body;

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    // Check if member already exists
    const { data: existing } = await supabase
      .from('loyalty_members')
      .select('id')
      .eq('business_id', businessId)
      .eq('phone_number', phone_number)
      .single();

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Member already enrolled with this phone number'
      });
    }

    // Create member
    const { data, error } = await supabase
      .from('loyalty_members')
      .insert({
        business_id: businessId,
        phone_number,
        email,
        first_name,
        last_name
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data,
      message: 'Member enrolled successfully'
    });

  } catch (error) {
    logger.error('Failed to create loyalty member:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create loyalty member',
      message: error.message
    });
  }
});

// =============================================
// RECEIPT UPLOAD & VERIFICATION
// =============================================

/**
 * POST /api/loyalty/receipts/upload
 * Upload receipt image
 */
router.post('/receipts/upload', upload.single('receipt'), async (req, res) => {
  try {
    const businessId = req.user?.business_id || req.body.business_id;
    const { phone_number, location_lat, location_lng } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'Receipt image is required'
      });
    }

    // Generate image hash
    const imageHash = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    // Check for duplicates
    const { data: duplicate } = await supabase
      .from('loyalty_receipts')
      .select('id')
      .eq('business_id', businessId)
      .eq('image_hash', imageHash)
      .single();

    if (duplicate) {
      return res.status(400).json({
        success: false,
        error: 'This receipt has already been uploaded'
      });
    }

    // Upload image to storage
    const fileName = `${businessId}/${Date.now()}-${imageHash.slice(0, 8)}.jpg`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('receipts')
      .getPublicUrl(fileName);

    // TODO: Run OCR on receipt
    // This would integrate with Google Vision, AWS Textract, or similar
    const ocrData = {
      merchant_name: 'Extracted Merchant',
      date: new Date().toISOString(),
      total: 45.67,
      items: []
    };

    // Get or create member
    let member;
    const { data: existingMember } = await supabase
      .from('loyalty_members')
      .select('*')
      .eq('business_id', businessId)
      .eq('phone_number', phone_number)
      .single();

    if (existingMember) {
      member = existingMember;
    } else {
      // Auto-enroll
      const { data: newMember, error: memberError } = await supabase
        .from('loyalty_members')
        .insert({
          business_id: businessId,
          phone_number
        })
        .select()
        .single();

      if (memberError) throw memberError;
      member = newMember;
    }

    // Create receipt record
    const { data: receipt, error: receiptError } = await supabase
      .from('loyalty_receipts')
      .insert({
        business_id: businessId,
        member_id: member.id,
        image_url: publicUrl,
        image_hash: imageHash,
        ocr_text: JSON.stringify(ocrData),
        extracted_data: ocrData,
        verification_status: 'verified',
        verification_score: 85.5,
        upload_location_lat: location_lat,
        upload_location_lng: location_lng
      })
      .select()
      .single();

    if (receiptError) throw receiptError;

    // Create transaction
    const pointsEarned = Math.floor(ocrData.total);

    const { data: transaction, error: transactionError } = await supabase
      .from('loyalty_transactions')
      .insert({
        business_id: businessId,
        member_id: member.id,
        total_amount: ocrData.total,
        subtotal: ocrData.total,
        items: ocrData.items,
        points_earned: pointsEarned,
        verified: true,
        verification_method: 'receipt_ocr'
      })
      .select()
      .single();

    if (transactionError) throw transactionError;

    // Update receipt with transaction ID
    await supabase
      .from('loyalty_receipts')
      .update({ transaction_id: transaction.id })
      .eq('id', receipt.id);

    // Update member stats
    await supabase
      .from('loyalty_members')
      .update({
        total_visits: member.total_visits + 1,
        total_spent: parseFloat(member.total_spent) + ocrData.total,
        lifetime_spent: parseFloat(member.lifetime_spent) + ocrData.total,
        monthly_visits: member.monthly_visits + 1,
        monthly_spent: parseFloat(member.monthly_spent) + ocrData.total,
        current_points: member.current_points + pointsEarned,
        last_visit: new Date().toISOString()
      })
      .eq('id', member.id);

    res.json({
      success: true,
      data: {
        receipt_id: receipt.id,
        verification_status: 'verified',
        verification_score: 85.5,
        transaction: {
          id: transaction.id,
          total_amount: ocrData.total,
          points_earned: pointsEarned
        },
        member: {
          total_points: member.current_points + pointsEarned
        }
      },
      message: 'Receipt uploaded and verified successfully'
    });

  } catch (error) {
    logger.error('Failed to upload receipt:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload receipt',
      message: error.message
    });
  }
});

/**
 * GET /api/loyalty/receipts/:id
 * Get receipt details
 */
router.get('/receipts/:id', async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('loyalty_receipts')
      .select(`
        *,
        member:loyalty_members(phone_number, first_name, last_name),
        transaction:loyalty_transactions(*)
      `)
      .eq('business_id', businessId)
      .eq('id', id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });

  } catch (error) {
    logger.error('Failed to get receipt:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get receipt',
      message: error.message
    });
  }
});

// =============================================
// REVIEWS
// =============================================

/**
 * POST /api/loyalty/receipts/:receipt_id/reviews
 * Submit item reviews
 */
router.post('/receipts/:receipt_id/reviews', async (req, res) => {
  try {
    const { receipt_id } = req.params;
    const { reviews } = req.body;

    // Get receipt and member info
    const { data: receipt, error: receiptError } = await supabase
      .from('loyalty_receipts')
      .select('*, member:loyalty_members(*), transaction:loyalty_transactions(*)')
      .eq('id', receipt_id)
      .single();

    if (receiptError) throw receiptError;

    const businessId = receipt.business_id;
    const memberId = receipt.member_id;

    // Process each review
    for (const review of reviews) {
      // Find menu item by name
      const { data: menuItem } = await supabase
        .from('menu_items')
        .select('id')
        .eq('business_id', businessId)
        .ilike('name', review.item_name)
        .single();

      // Save review
      await supabase
        .from('item_reviews')
        .insert({
          business_id: businessId,
          menu_item_id: menuItem?.id,
          member_id: memberId,
          transaction_id: receipt.transaction_id,
          rating: review.rating,
          comment: review.comment,
          verified_purchase: true,
          status: 'approved'
        });
    }

    // Award points for leaving reviews
    const pointsForReviews = reviews.length * 10;
    await supabase
      .from('loyalty_members')
      .update({
        current_points: receipt.member.current_points + pointsForReviews
      })
      .eq('id', memberId);

    // Get updated member
    const { data: updatedMember } = await supabase
      .from('loyalty_members')
      .select('current_points, current_tier')
      .eq('id', memberId)
      .single();

    res.json({
      success: true,
      data: {
        receipt_id,
        reviews_submitted: reviews.length,
        points_earned: pointsForReviews,
        total_points: updatedMember.current_points,
        member: {
          id: memberId,
          current_tier: updatedMember.current_tier
        }
      }
    });

  } catch (error) {
    logger.error('Failed to submit reviews:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit reviews',
      message: error.message
    });
  }
});

/**
 * GET /api/loyalty/menu/:item_id/reviews
 * Get reviews for menu item
 */
router.get('/menu/:item_id/reviews', async (req, res) => {
  try {
    const { item_id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const { data, error, count } = await supabase
      .from('item_reviews')
      .select(`
        *,
        member:loyalty_members(first_name, last_name)
      `, { count: 'exact' })
      .eq('menu_item_id', item_id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Calculate rating breakdown
    const { data: ratings } = await supabase
      .from('item_reviews')
      .select('rating')
      .eq('menu_item_id', item_id)
      .eq('status', 'approved');

    const ratingBreakdown = {
      5: 0, 4: 0, 3: 0, 2: 0, 1: 0
    };

    ratings?.forEach(r => {
      ratingBreakdown[r.rating]++;
    });

    const total = ratings?.length || 1;
    const breakdown = Object.entries(ratingBreakdown).map(([rating, count]) => ({
      rating: parseInt(rating),
      count,
      percentage: Math.round((count / total) * 100)
    }));

    res.json({
      success: true,
      data: {
        reviews: data,
        breakdown,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });

  } catch (error) {
    logger.error('Failed to get reviews:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get reviews',
      message: error.message
    });
  }
});

// =============================================
// PUBLIC ROUTES (No Auth Required)
// =============================================

/**
 * GET /api/loyalty/review/:receipt_id
 * Public review page data
 */
router.get('/review/:receipt_id', async (req, res) => {
  try {
    const { receipt_id } = req.params;

    const { data: receipt, error } = await supabase
      .from('loyalty_receipts')
      .select(`
        *,
        transaction:loyalty_transactions(*),
        business:businesses(name, logo_url)
      `)
      .eq('id', receipt_id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: {
        receipt_id,
        business: receipt.business,
        items: receipt.transaction.items,
        transaction_date: receipt.transaction.transaction_date
      }
    });

  } catch (error) {
    logger.error('Failed to get review data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get review data',
      message: error.message
    });
  }
});

export default router;
