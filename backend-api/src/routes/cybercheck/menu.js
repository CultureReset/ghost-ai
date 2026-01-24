import express from 'express';
import multer from 'multer';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';
import { transcribeAudio } from '../../services/openai.service.js';
import OpenAI from 'openai';

const router = express.Router();
const isOpenAIConfigured = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-key';
const openai = isOpenAIConfigured ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Configure multer for audio uploads (reuse voice note config)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/m4a',
      'audio/webm',
      'audio/ogg',
      'video/webm'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  }
});

// Configure multer for image uploads
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for images
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif'
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images (JPEG, PNG, WebP, GIF) are allowed.'));
    }
  }
});

// All routes require authentication
router.use(authenticateToken);

// =============================================
// MENU TYPES
// =============================================

/**
 * GET /api/menu/types
 * Get all menu types for business
 */
router.get('/types', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('menu_types')
      .select('*')
      .eq('business_id', req.user.business_id)
      .order('display_order', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: data || []
    });
  } catch (error) {
    logger.error('Get menu types error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/menu/types
 * Create new menu type
 */
router.post('/types', async (req, res) => {
  try {
    const {
      name,
      description,
      icon,
      available_start_time,
      available_end_time,
      available_days,
      display_order
    } = req.body;

    const { data, error } = await supabase
      .from('menu_types')
      .insert({
        business_id: req.user.business_id,
        name,
        description,
        icon,
        available_start_time,
        available_end_time,
        available_days,
        display_order: display_order || 0,
        enabled: true
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Create menu type error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/menu/types/:id
 * Update menu type
 */
router.put('/types/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('menu_types')
      .update(updates)
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Update menu type error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/menu/types/:id
 * Delete menu type (and all categories/items within it)
 */
router.delete('/types/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('menu_types')
      .delete()
      .eq('id', id)
      .eq('business_id', req.user.business_id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Menu type deleted successfully'
    });
  } catch (error) {
    logger.error('Delete menu type error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// MENU CATEGORIES
// =============================================

/**
 * GET /api/menu/categories
 * Get all categories for business (optionally filter by menu type)
 */
router.get('/categories', async (req, res) => {
  try {
    const { menu_type_id } = req.query;

    let query = supabase
      .from('menu_categories')
      .select('*, menu_types(*)')
      .eq('business_id', req.user.business_id)
      .order('display_order', { ascending: true });

    if (menu_type_id) {
      query = query.eq('menu_type_id', menu_type_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: data || []
    });
  } catch (error) {
    logger.error('Get menu categories error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/menu/categories
 * Create new category
 */
router.post('/categories', async (req, res) => {
  try {
    const { menu_type_id, name, description, display_order } = req.body;

    const { data, error } = await supabase
      .from('menu_categories')
      .insert({
        business_id: req.user.business_id,
        menu_type_id,
        name,
        description,
        display_order: display_order || 0,
        enabled: true
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Create menu category error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/menu/categories/:id
 * Update category
 */
router.put('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('menu_categories')
      .update(updates)
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Update menu category error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/menu/categories/:id
 * Delete category (and all items within it)
 */
router.delete('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('menu_categories')
      .delete()
      .eq('id', id)
      .eq('business_id', req.user.business_id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    logger.error('Delete menu category error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// MENU ITEMS
// =============================================

/**
 * GET /api/menu/items
 * Get all items (optionally filter by category or menu type)
 */
router.get('/items', async (req, res) => {
  try {
    const { category_id, menu_type_id, availability } = req.query;

    let query = supabase
      .from('menu_items')
      .select(`
        *,
        menu_categories(id, name, menu_type_id),
        menu_types:menu_categories(menu_types(*))
      `)
      .eq('business_id', req.user.business_id)
      .order('display_order', { ascending: true });

    if (category_id) {
      query = query.eq('category_id', category_id);
    }

    if (availability) {
      query = query.eq('availability', availability);
    }

    const { data, error } = await query;

    if (error) throw error;

    // If filtering by menu_type_id, do it client-side since it's nested
    let items = data || [];
    if (menu_type_id) {
      items = items.filter(item =>
        item.menu_categories?.menu_type_id === menu_type_id
      );
    }

    res.json({
      success: true,
      data: items
    });
  } catch (error) {
    logger.error('Get menu items error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/menu/items/:id
 * Get single menu item
 */
router.get('/items/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('menu_items')
      .select(`
        *,
        menu_categories(id, name, menu_type_id, menu_types(*))
      `)
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Get menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/menu/items
 * Create new menu item
 */
router.post('/items', async (req, res) => {
  try {
    const {
      category_id,
      item_name,
      description,
      price,
      image_url,
      tags,
      is_vegan,
      is_vegetarian,
      is_gluten_free,
      contains_dairy,
      contains_nuts,
      is_spicy,
      spice_level,
      is_top_rated,
      is_crowd_favorite,
      is_chef_special,
      is_new,
      is_seasonal,
      availability,
      display_order
    } = req.body;

    const { data, error } = await supabase
      .from('menu_items')
      .insert({
        business_id: req.user.business_id,
        category_id,
        item_name,
        description,
        price,
        image_url,
        tags: tags || [],
        is_vegan: is_vegan || false,
        is_vegetarian: is_vegetarian || false,
        is_gluten_free: is_gluten_free || false,
        contains_dairy: contains_dairy || false,
        contains_nuts: contains_nuts || false,
        is_spicy: is_spicy || false,
        spice_level,
        is_top_rated: is_top_rated || false,
        is_crowd_favorite: is_crowd_favorite || false,
        is_chef_special: is_chef_special || false,
        is_new: is_new || false,
        is_seasonal: is_seasonal || false,
        availability: availability || 'available',
        display_order: display_order || 0
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Create menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/menu/items/:id
 * Update menu item
 */
router.put('/items/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('menu_items')
      .update(updates)
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Update menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/menu/items/:id
 * Delete menu item
 */
router.delete('/items/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('menu_items')
      .delete()
      .eq('id', id)
      .eq('business_id', req.user.business_id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Menu item deleted successfully'
    });
  } catch (error) {
    logger.error('Delete menu item error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/menu/items/:id/photo
 * Upload photo for menu item
 */
router.post('/items/:id/photo', imageUpload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No photo file provided'
      });
    }

    // Verify menu item exists and belongs to user's business
    const { data: menuItem, error: fetchError } = await supabase
      .from('menu_items')
      .select('id, item_name, photo_url')
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (fetchError || !menuItem) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    // Generate filename with timestamp
    const fileExt = req.file.mimetype.split('/')[1];
    const fileName = `menu-items/${req.user.business_id}/${id}/${Date.now()}.${fileExt}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('menu-photos')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: true
      });

    if (uploadError) {
      logger.error('Supabase storage upload error:', uploadError);
      throw uploadError;
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('menu-photos')
      .getPublicUrl(fileName);

    // Delete old photo if it exists
    if (menuItem.photo_url) {
      try {
        const oldFileName = menuItem.photo_url.split('/menu-photos/')[1];
        if (oldFileName) {
          await supabase.storage.from('menu-photos').remove([oldFileName]);
        }
      } catch (deleteError) {
        logger.warn('Failed to delete old photo:', deleteError);
        // Continue even if deletion fails
      }
    }

    // Update menu item with new photo URL
    const { data: updatedItem, error: updateError } = await supabase
      .from('menu_items')
      .update({ photo_url: publicUrl })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    logger.info(`Photo uploaded for menu item ${id}: ${publicUrl}`);

    res.json({
      success: true,
      data: {
        photo_url: publicUrl,
        item: updatedItem
      },
      message: 'Photo uploaded successfully'
    });
  } catch (error) {
    logger.error('Upload menu item photo error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload photo'
    });
  }
});

/**
 * DELETE /api/menu/items/:id/photo
 * Delete photo from menu item
 */
router.delete('/items/:id/photo', async (req, res) => {
  try {
    const { id } = req.params;

    // Get menu item
    const { data: menuItem, error: fetchError } = await supabase
      .from('menu_items')
      .select('id, photo_url')
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (fetchError || !menuItem) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    if (!menuItem.photo_url) {
      return res.status(400).json({
        success: false,
        error: 'Menu item has no photo'
      });
    }

    // Delete from storage
    try {
      const fileName = menuItem.photo_url.split('/menu-photos/')[1];
      if (fileName) {
        await supabase.storage.from('menu-photos').remove([fileName]);
      }
    } catch (deleteError) {
      logger.warn('Failed to delete photo from storage:', deleteError);
    }

    // Remove URL from database
    const { error: updateError } = await supabase
      .from('menu_items')
      .update({ photo_url: null })
      .eq('id', id);

    if (updateError) throw updateError;

    logger.info(`Photo deleted for menu item ${id}`);

    res.json({
      success: true,
      message: 'Photo deleted successfully'
    });
  } catch (error) {
    logger.error('Delete menu item photo error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// AI CONTEXT FOR MENU ITEMS
// =============================================

/**
 * POST /api/menu/items/:id/ai-context/voice
 * Upload voice recording for menu item AI context (30 seconds max)
 * Uses existing voice note infrastructure
 */
router.post('/items/:id/ai-context/voice', upload.single('audio'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No audio file provided'
      });
    }

    // Get menu item
    const { data: menuItem, error: fetchError } = await supabase
      .from('menu_items')
      .select('*')
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (fetchError || !menuItem) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    // Upload audio to Supabase Storage
    const fileName = `menu-items/${req.user.business_id}/${id}/${Date.now()}.webm`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('audio')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600'
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(fileName);

    // Update menu item with audio URL and set processing status
    await supabase
      .from('menu_items')
      .update({
        ai_context_audio_url: publicUrl,
        ai_context_audio_duration: req.body.duration || null,
        ai_context_processing_status: 'pending',
        ai_context_last_updated: new Date()
      })
      .eq('id', id);

    // Process audio asynchronously
    processMenuItemAIContext(id, publicUrl, menuItem);

    res.json({
      success: true,
      data: {
        audio_url: publicUrl,
        status: 'processing',
        message: 'Voice recording uploaded. AI processing started.'
      }
    });
  } catch (error) {
    logger.error('Upload menu AI voice context error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/menu/items/:id/ai-context/text
 * Submit typed AI context for menu item
 */
router.post('/items/:id/ai-context/text', async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Text content is required'
      });
    }

    // Get menu item
    const { data: menuItem, error: fetchError } = await supabase
      .from('menu_items')
      .select('*')
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (fetchError || !menuItem) {
      return res.status(404).json({
        success: false,
        error: 'Menu item not found'
      });
    }

    // Update menu item with text
    await supabase
      .from('menu_items')
      .update({
        ai_context_text: text,
        ai_context_processing_status: 'pending',
        ai_context_last_updated: new Date()
      })
      .eq('id', id);

    // Process text with GPT-4
    processMenuItemTextContext(id, text, menuItem);

    res.json({
      success: true,
      data: {
        status: 'processing',
        message: 'Text context submitted. AI processing started.'
      }
    });
  } catch (error) {
    logger.error('Submit menu AI text context error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/menu/items/:id/ai-context
 * Get AI context processing status and result
 */
router.get('/items/:id/ai-context', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('menu_items')
      .select('ai_context_audio_url, ai_context_text, ai_context_processed, ai_context_confidence, ai_context_processing_status, ai_context_last_updated')
      .eq('id', id)
      .eq('business_id', req.user.business_id)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Get menu AI context error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// BACKGROUND PROCESSING FUNCTIONS
// =============================================

/**
 * Process voice recording for menu item
 * Uses existing OpenAI service
 */
async function processMenuItemAIContext(itemId, audioUrl, menuItem) {
  try {
    logger.info(`Processing AI context for menu item: ${itemId}`);

    // Update status
    await supabase
      .from('menu_items')
      .update({ ai_context_processing_status: 'processing' })
      .eq('id', itemId);

    // Step 1: Transcribe with Whisper (reuse existing function)
    const transcription = await transcribeAudio(audioUrl, 'en');

    // Step 2: Process with GPT-4
    const processed = await processMenuContext(transcription.text, menuItem);

    // Update menu item with processed context
    await supabase
      .from('menu_items')
      .update({
        ai_context_processed: processed.context,
        ai_context_confidence: processed.confidence,
        ai_context_processing_status: 'completed',
        ai_context_last_updated: new Date()
      })
      .eq('id', itemId);

    logger.info(`AI context processing completed for menu item: ${itemId}`);
  } catch (error) {
    logger.error(`AI context processing failed for menu item ${itemId}:`, error);

    await supabase
      .from('menu_items')
      .update({
        ai_context_processing_status: 'failed',
        ai_context_processing_error: error.message
      })
      .eq('id', itemId);
  }
}

/**
 * Process typed text context
 */
async function processMenuItemTextContext(itemId, text, menuItem) {
  try {
    logger.info(`Processing text AI context for menu item: ${itemId}`);

    await supabase
      .from('menu_items')
      .update({ ai_context_processing_status: 'processing' })
      .eq('id', itemId);

    const processed = await processMenuContext(text, menuItem);

    await supabase
      .from('menu_items')
      .update({
        ai_context_processed: processed.context,
        ai_context_confidence: processed.confidence,
        ai_context_processing_status: 'completed',
        ai_context_last_updated: new Date()
      })
      .eq('id', itemId);

    logger.info(`Text AI context processing completed for menu item: ${itemId}`);
  } catch (error) {
    logger.error(`Text AI context processing failed for menu item ${itemId}:`, error);

    await supabase
      .from('menu_items')
      .update({
        ai_context_processing_status: 'failed',
        ai_context_processing_error: error.message
      })
      .eq('id', itemId);
  }
}

/**
 * Process menu context with GPT-4
 * Extracts structured information for Phone AI - SALES AGENT STYLE
 */
async function processMenuContext(text, menuItem) {
  // Get real reviews for this item if available
  const { data: reviews } = await supabase
    .from('review_items')
    .select('rating, review_text, reviews(customer_name)')
    .eq('item_name', menuItem.item_name)
    .eq('rating', 5) // Only get 5-star reviews
    .limit(5);

  const reviewContext = reviews && reviews.length > 0
    ? `\n\n**REAL CUSTOMER REVIEWS (Receipt-Verified):**\n${reviews.map(r =>
        `- "${r.review_text}" - ${r.reviews?.customer_name || 'Customer'}`
      ).join('\n')}`
    : '';

  const prompt = `You are training an AI Phone Agent to be an EXPERT SALES SERVER for this restaurant.

**MENU ITEM:**
- **Name:** ${menuItem.item_name}
- **Description:** ${menuItem.description}
- **Base Price:** $${menuItem.price}
- **Dietary:** ${[
    menuItem.is_vegan ? 'Vegan' : null,
    menuItem.is_vegetarian ? 'Vegetarian' : null,
    menuItem.is_gluten_free ? 'Gluten-Free' : null,
    menuItem.is_spicy ? `Spicy (Level ${menuItem.spice_level || 'N/A'})` : null
  ].filter(Boolean).join(', ') || 'None specified'}
- **Badges:** ${[
    menuItem.is_top_rated ? 'Top Rated' : null,
    menuItem.is_crowd_favorite ? 'Crowd Favorite' : null,
    menuItem.is_chef_special ? 'Chef Special' : null
  ].filter(Boolean).join(', ') || 'None'}

**OWNER'S INSIDER KNOWLEDGE:**
${text}
${reviewContext}

**YOUR TASK:** Create a sales-focused AI training guide that makes the Phone AI an EXPERT who can:
1. **SELL THIS ITEM** - Why customers love it, what makes it special
2. **RECOMMEND SMARTLY** - When to suggest this (customer preferences, dietary needs, occasions)
3. **UPSELL NATURALLY** - Add-ons, premium upgrades, pairings that enhance the experience
4. **HANDLE MODIFICATIONS** - Substitutions, dietary accommodations, customizations available
5. **OVERCOME OBJECTIONS** - Address common concerns (spice level, portion size, price)
6. **USE SOCIAL PROOF** - Reference reviews, popularity, awards, chef recommendations
7. **CROSS-SELL** - What sides, drinks, desserts pair perfectly
8. **PRICING TRANSPARENCY** - Base price + all possible upcharges (extra protein, premium sides, etc.)

**FORMAT LIKE THIS:**

**SALES PITCH:** [One compelling sentence that sells this item like a skilled server would]

**WHEN TO RECOMMEND:**
- Customer says: [trigger phrases] → Suggest this because: [reason]

**UPSELLS & ADD-ONS:**
- [Add-on name]: +$[price] - [why it's worth it]
- [Premium upgrade]: +$[price] - [benefit]

**CUSTOMIZATIONS:**
- Can modify: [list options]
- Cannot modify: [list restrictions]
- Popular requests: [common customizations]

**PAIRINGS:**
- Goes great with: [specific items with prices]
- Perfect drink pairing: [specific drinks]

**HANDLE CONCERNS:**
- "Is it spicy?" → [exact response]
- "Is it worth $X?" → [value proposition]
- "I'm on a diet" → [dietary info + modifications]

**REVIEWS & SOCIAL PROOF:**
- [Quote best reviews]
- [Mention popularity stats if top rated/crowd favorite]

**EXPERT TIP:** [One insider tip that makes the AI sound like a restaurant expert]

Keep it conversational, persuasive, and actionable. The AI should sound like the BEST server who knows every detail and genuinely wants customers to have an amazing experience.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      {
        role: 'system',
        content: 'You are training a Phone AI to be an expert sales server who knows the menu inside-out, upsells naturally, and uses real customer feedback to sell items effectively.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4, // Slightly higher for more persuasive language
    max_tokens: 1000 // More tokens for detailed sales training
  });

  const context = completion.choices[0].message.content;
  const confidence = completion.choices[0].finish_reason === 'stop' ? 0.95 : 0.75;

  logger.info(`Generated sales-focused AI context for ${menuItem.item_name}: ${context.length} chars`);

  return { context, confidence };
}

// =============================================
// PUBLIC ROUTES (no auth required)
// =============================================

/**
 * GET /api/menu/public/:slug
 * Get public menu for profile page
 */
router.get('/public/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // Get business by slug
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('id')
      .eq('slug', slug)
      .single();

    if (businessError || !business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    // Get all menu types with categories and items
    const { data, error } = await supabase
      .from('menu_types')
      .select(`
        *,
        menu_categories(
          *,
          menu_items(*)
        )
      `)
      .eq('business_id', business.id)
      .eq('enabled', true)
      .order('display_order', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: data || []
    });
  } catch (error) {
    logger.error('Get public menu error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/menu/public/:slug/:menu_type
 * Get specific menu type for public view
 */
router.get('/public/:slug/:menu_type', async (req, res) => {
  try {
    const { slug, menu_type } = req.params;

    // Get business by slug
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('id')
      .eq('slug', slug)
      .single();

    if (businessError || !business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    // Get specific menu type with all categories and items
    const { data, error } = await supabase
      .from('menu_types')
      .select(`
        *,
        menu_categories(
          *,
          menu_items(*)
        )
      `)
      .eq('business_id', business.id)
      .eq('name', menu_type)
      .eq('enabled', true)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('Get public menu type error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
