import express from 'express';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';
import AIService from '../../services/ai.service.js';

const router = express.Router();

/**
 * POST /api/ai/customer-query
 * Public-facing AI chat for customers on business profile
 * NO AUTH REQUIRED (public)
 */
router.post('/customer-query', async (req, res) => {
  try {
    const { business_id, message, session_id } = req.body;

    if (!business_id || !message) {
      return res.status(400).json({
        success: false,
        error: 'business_id and message are required'
      });
    }

    // Check if AI is enabled and not in preview mode
    const { data: aiConfig } = await supabase
      .from('ai_configs')
      .select('*')
      .eq('business_id', business_id)
      .single();

    if (!aiConfig || !aiConfig.is_enabled) {
      return res.status(403).json({
        success: false,
        error: 'AI assistant is not available for this business'
      });
    }

    if (aiConfig.preview_mode) {
      return res.status(403).json({
        success: false,
        error: 'AI assistant is in preview mode and not publicly available yet'
      });
    }

    // Call AI service
    const result = await AIService.callAIForBusiness(
      business_id,
      'customer_chat',
      message
    );

    // Log interaction
    await supabase.from('ai_interactions').insert({
      business_id,
      interaction_type: 'customer_chat',
      session_id: session_id || null,
      user_message: message,
      ai_response: result.response,
      model_used: 'gpt-4-turbo',
      tokens_input: result.usage.tokens_input,
      tokens_output: result.usage.tokens_output,
      tokens_total: result.usage.tokens_total,
      response_time_ms: result.response_time_ms,
      ip_address: req.ip,
      user_agent: req.get('user-agent')
    });

    res.json({
      success: true,
      data: {
        response: result.response,
        fuel_status: result.fuel_status
      }
    });
  } catch (error) {
    logger.error('Customer AI query error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process AI query'
    });
  }
});

/**
 * POST /api/ai/customer-feedback
 * Log user feedback on AI response (thumbs up/down)
 * NO AUTH REQUIRED (public)
 */
router.post('/customer-feedback', async (req, res) => {
  try {
    const { interaction_id, rating, feedback } = req.body;

    await supabase
      .from('ai_interactions')
      .update({
        user_rating: rating,
        user_feedback: feedback
      })
      .eq('id', interaction_id);

    res.json({
      success: true,
      message: 'Thank you for your feedback'
    });
  } catch (error) {
    logger.error('AI feedback error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save feedback'
    });
  }
});

// All routes below require authentication
router.use(authenticateToken);

/**
 * POST /api/ai/owner-query
 * Owner AI Coach - answer owner questions about their business
 */
router.post('/owner-query', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required'
      });
    }

    // Get business metrics to provide context
    const businessId = req.user.business_id;

    // Fetch recent business stats
    const { data: contactsCount } = await supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    const { data: reviewsCount } = await supabase
      .from('reviews')
      .select('rating_overall')
      .eq('business_id', businessId);

    const avgRating = reviewsCount && reviewsCount.length > 0
      ? reviewsCount.reduce((sum, r) => sum + r.rating_overall, 0) / reviewsCount.length
      : 0;

    // Build context with metrics
    const context = `
Recent Business Metrics (last 30 days):
- New contacts: ${contactsCount || 0}
- Total reviews: ${reviewsCount?.length || 0}
- Average rating: ${avgRating.toFixed(1)} stars

Owner Question: ${message}
`;

    // Call AI service
    const result = await AIService.callAIForBusiness(
      businessId,
      'owner_coach',
      context
    );

    // Log interaction
    await supabase.from('ai_interactions').insert({
      business_id: businessId,
      interaction_type: 'owner_coach',
      user_id: req.user.id,
      user_message: message,
      ai_response: result.response,
      model_used: 'gpt-4-turbo',
      tokens_input: result.usage.tokens_input,
      tokens_output: result.usage.tokens_output,
      tokens_total: result.usage.tokens_total,
      response_time_ms: result.response_time_ms
    });

    res.json({
      success: true,
      data: {
        response: result.response,
        fuel_status: result.fuel_status
      }
    });
  } catch (error) {
    logger.error('Owner AI query error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process AI query'
    });
  }
});

/**
 * GET /api/ai/config
 * Get AI configuration for current business
 */
router.get('/config', async (req, res) => {
  try {
    const { data: aiConfig, error } = await supabase
      .from('ai_configs')
      .select('*')
      .eq('business_id', req.user.business_id)
      .single();

    if (error && error.code !== 'PGRST116') { // Not found is ok
      throw error;
    }

    res.json({
      success: true,
      data: aiConfig || null
    });
  } catch (error) {
    logger.error('Get AI config error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI configuration'
    });
  }
});

/**
 * PUT /api/ai/config
 * Update AI configuration
 */
router.put('/config', async (req, res) => {
  try {
    const {
      is_enabled,
      mode,
      preview_mode,
      system_prompt,
      tone,
      allowed_domains
    } = req.body;

    const updates = {};
    if (is_enabled !== undefined) updates.is_enabled = is_enabled;
    if (mode !== undefined) updates.mode = mode;
    if (preview_mode !== undefined) updates.preview_mode = preview_mode;
    if (system_prompt !== undefined) updates.system_prompt = system_prompt;
    if (tone !== undefined) updates.tone = tone;
    if (allowed_domains !== undefined) updates.allowed_domains = allowed_domains;
    updates.updated_at = new Date();

    // Upsert AI config
    const { data: existingConfig } = await supabase
      .from('ai_configs')
      .select('id')
      .eq('business_id', req.user.business_id)
      .single();

    let aiConfig;
    if (existingConfig) {
      const { data, error } = await supabase
        .from('ai_configs')
        .update(updates)
        .eq('business_id', req.user.business_id)
        .select()
        .single();

      if (error) throw error;
      aiConfig = data;
    } else {
      const { data, error } = await supabase
        .from('ai_configs')
        .insert({
          business_id: req.user.business_id,
          ...updates
        })
        .select()
        .single();

      if (error) throw error;
      aiConfig = data;
    }

    logger.info(`AI config updated for business: ${req.user.business_id}`);

    res.json({
      success: true,
      message: 'AI configuration updated',
      data: aiConfig
    });
  } catch (error) {
    logger.error('Update AI config error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update AI configuration'
    });
  }
});

/**
 * GET /api/ai/interactions
 * Get AI interaction history
 */
router.get('/interactions', async (req, res) => {
  try {
    const { type, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('ai_interactions')
      .select('*', { count: 'exact' })
      .eq('business_id', req.user.business_id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (type) {
      query = query.eq('interaction_type', type);
    }

    const { data: interactions, error, count } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: {
        interactions,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    logger.error('Get AI interactions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI interactions'
    });
  }
});

/**
 * GET /api/ai/fuel
 * Get current AI fuel status (token usage)
 */
router.get('/fuel', async (req, res) => {
  try {
    const fuelStatus = await AIService.checkAIFuel(req.user.business_id);

    res.json({
      success: true,
      data: fuelStatus
    });
  } catch (error) {
    logger.error('Get AI fuel error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI fuel status'
    });
  }
});

export default router;
