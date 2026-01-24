// GCR Featured Businesses Management
// Admin API to control Featured This Week and Featured Restaurants

import express from 'express';
import { supabase } from '../../config/supabase.js';
import { getAllGCRBusinesses } from '../../../gcr-google-sheets-sync.js';

const router = express.Router();

/**
 * GET /api/gcr-featured/sections
 * Get all featured sections with businesses
 */
router.get('/sections', async (req, res) => {
  try {
    const { data: sections, error } = await supabase
      .from('gcr_featured_sections')
      .select(`
        *,
        gcr_featured_businesses!inner(count)
      `)
      .eq('gcr_featured_businesses.is_active', true)
      .order('display_order', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      sections: sections || []
    });
  } catch (error) {
    console.error('Error getting featured sections:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      sections: []
    });
  }
});

/**
 * GET /api/gcr-featured/sections/:sectionKey/businesses
 * Get businesses in a featured section
 */
router.get('/sections/:sectionKey/businesses', async (req, res) => {
  try {
    const { sectionKey } = req.params;

    // Get featured businesses for this section
    const { data: featuredBusinesses, error } = await supabase
      .from('gcr_featured_businesses')
      .select(`
        *,
        gcr_featured_sections!inner(section_key)
      `)
      .eq('gcr_featured_sections.section_key', sectionKey)
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    if (error) throw error;

    // Get full business data from Google Sheets
    const allBusinesses = await getAllGCRBusinesses();

    // Match featured businesses with full data
    const businessesWithData = (featuredBusinesses || []).map(fb => {
      const fullData = allBusinesses.find(b =>
        b.google_place_id === fb.google_place_id ||
        (b.business_name || b.name)?.toLowerCase() === fb.business_name?.toLowerCase()
      );

      return {
        ...fb,
        ...fullData,
        // Images from Google Sheets
        profile_pic: fullData?.profile_pic || '',
        main_image: fullData?.main_image || '',
        logo_image: fullData?.logo_image || ''
      };
    });

    res.json({
      success: true,
      section_key: sectionKey,
      count: businessesWithData.length,
      businesses: businessesWithData
    });
  } catch (error) {
    console.error('Error getting featured businesses:', error);
    res.json({
      success: true,
      section_key: sectionKey,
      count: 0,
      businesses: []
    });
  }
});

/**
 * GET /api/gcr-featured/admin/available-businesses
 * Get all businesses available to feature (from Google Sheets)
 */
router.get('/admin/available-businesses', async (req, res) => {
  try {
    const businesses = await getAllGCRBusinesses();

    // Transform to simplified format for selection
    const availableBusinesses = businesses.map(b => ({
      google_place_id: b.google_place_id || b.place_id,
      business_name: b.business_name || b.name,
      category: b.category,
      city: b.city || b.location,
      rating: b.rating,
      profile_pic: b.profile_pic || b.main_image,
      main_image: b.main_image,
      logo_image: b.logo_image
    }));

    res.json({
      success: true,
      count: availableBusinesses.length,
      businesses: availableBusinesses
    });
  } catch (error) {
    console.error('Error getting available businesses:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/gcr-featured/admin/sections/:sectionKey/add
 * Add business to featured section
 */
router.post('/admin/sections/:sectionKey/add', async (req, res) => {
  try {
    const { sectionKey } = req.params;
    const { google_place_id, business_name } = req.body;

    if (!google_place_id || !business_name) {
      return res.status(400).json({
        success: false,
        error: 'google_place_id and business_name are required'
      });
    }

    // Get section
    const { data: sections, error: sectionError } = await supabase
      .from('gcr_featured_sections')
      .select('*')
      .eq('section_key', sectionKey)
      .single();

    if (sectionError || !sections) {
      return res.status(404).json({
        success: false,
        error: 'Section not found'
      });
    }

    // Check if section is full
    const { count, error: countError } = await supabase
      .from('gcr_featured_businesses')
      .select('*', { count: 'exact', head: true })
      .eq('section_id', sections.id)
      .eq('is_active', true);

    if (countError) throw countError;

    if (count >= sections.max_items) {
      return res.status(400).json({
        success: false,
        error: `Section is full (max ${sections.max_items} items)`
      });
    }

    // Check if already featured
    const { data: existing } = await supabase
      .from('gcr_featured_businesses')
      .select('id')
      .eq('section_id', sections.id)
      .eq('google_place_id', google_place_id)
      .eq('is_active', true)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Business already featured in this section'
      });
    }

    // Get next display order
    const { data: maxOrder } = await supabase
      .from('gcr_featured_businesses')
      .select('display_order')
      .eq('section_id', sections.id)
      .order('display_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    const displayOrder = (maxOrder?.display_order || 0) + 1;

    // Insert featured business
    const { data: inserted, error: insertError } = await supabase
      .from('gcr_featured_businesses')
      .insert({
        section_id: sections.id,
        google_place_id,
        business_name,
        display_order: displayOrder,
        is_active: true
      })
      .select()
      .single();

    if (insertError) throw insertError;

    res.json({
      success: true,
      message: 'Business added to featured section',
      featured_business: inserted
    });
  } catch (error) {
    console.error('Error adding featured business:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/gcr-featured/admin/businesses/:id
 * Remove business from featured section
 */
router.delete('/admin/businesses/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('gcr_featured_businesses')
      .update({ is_active: false })
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Business removed from featured section'
    });
  } catch (error) {
    console.error('Error removing featured business:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/gcr-featured/admin/businesses/:id/order
 * Update display order of featured business
 */
router.put('/admin/businesses/:id/order', async (req, res) => {
  try {
    const { id } = req.params;
    const { display_order } = req.body;

    if (display_order === undefined) {
      return res.status(400).json({
        success: false,
        error: 'display_order is required'
      });
    }

    const { error } = await supabase
      .from('gcr_featured_businesses')
      .update({ display_order })
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Display order updated'
    });
  } catch (error) {
    console.error('Error updating display order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/gcr-featured/admin/businesses/:id/move
 * Move business up or down in order
 */
router.put('/admin/businesses/:id/move', async (req, res) => {
  try {
    const { id } = req.params;
    const { direction } = req.body; // 'up' or 'down'

    // Get current business
    const { data: currentBusiness, error: currentError } = await supabase
      .from('gcr_featured_businesses')
      .select('*')
      .eq('id', id)
      .single();

    if (currentError || !currentBusiness) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    const currentOrder = currentBusiness.display_order;

    // Get swap target
    const { data: swapBusiness, error: swapError } = await supabase
      .from('gcr_featured_businesses')
      .select('*')
      .eq('section_id', currentBusiness.section_id)
      .eq('is_active', true)
      [direction === 'up' ? 'lt' : 'gt']('display_order', currentOrder)
      .order('display_order', { ascending: direction !== 'up' })
      .limit(1)
      .maybeSingle();

    if (swapError || !swapBusiness) {
      return res.status(400).json({
        success: false,
        error: `Cannot move ${direction} - already at ${direction === 'up' ? 'top' : 'bottom'}`
      });
    }

    const swapOrder = swapBusiness.display_order;

    // Swap orders
    await supabase
      .from('gcr_featured_businesses')
      .update({ display_order: swapOrder })
      .eq('id', currentBusiness.id);

    await supabase
      .from('gcr_featured_businesses')
      .update({ display_order: currentOrder })
      .eq('id', swapBusiness.id);

    res.json({
      success: true,
      message: `Business moved ${direction}`
    });
  } catch (error) {
    console.error('Error moving business:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
