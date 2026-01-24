// GCR (Gulf Coast Radar) API Routes
// Serves businesses from Google Sheets with profile pictures

import express from 'express';
import multer from 'multer';
import {
  getAllGCRBusinesses,
  getCompleteBusinessData
} from '../../../gcr-google-sheets-sync.js';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// Configure multer for photo uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

/**
 * GET /api/gcr/businesses
 * Get all businesses from Google Sheets with profile pictures
 */
router.get('/businesses', async (req, res) => {
  try {
    const { category, search, location } = req.query;

    // Get all businesses from Google Sheets (or Supabase as fallback)
    let businesses;
    try {
      businesses = await getAllGCRBusinesses();
    } catch (sheetError) {
      console.log('Google Sheets not configured, trying Supabase database...');
      // Fallback to Supabase if Google Sheets fails
      const { data, error } = await supabase
        .from('gcr_businesses')
        .select('*');

      if (error) {
        console.error('Supabase fallback error:', error);
        businesses = [];
      } else {
        businesses = data || [];
      }
    }

    // Filter by category if provided
    if (category) {
      businesses = businesses.filter(b =>
        b.category?.toLowerCase() === category.toLowerCase()
      );
    }

    // Filter by search term if provided
    if (search) {
      const searchLower = search.toLowerCase();
      businesses = businesses.filter(b =>
        b.business_name?.toLowerCase().includes(searchLower) ||
        b.name?.toLowerCase().includes(searchLower) ||
        b.description?.toLowerCase().includes(searchLower) ||
        b.address?.toLowerCase().includes(searchLower) ||
        b.city?.toLowerCase().includes(searchLower)
      );
    }

    // Filter by location if provided
    if (location) {
      const locationLower = location.toLowerCase();
      businesses = businesses.filter(b =>
        b.city?.toLowerCase().includes(locationLower) ||
        b.location?.toLowerCase().includes(locationLower)
      );
    }

    // Transform data to match frontend expectations
    const transformedBusinesses = businesses.map(b => ({
      id: b.id || b.business_id || b.google_place_id,
      slug: b.slug || b.business_id || createSlug(b.business_name || b.name),
      business_name: b.business_name || b.name,
      name: b.business_name || b.name,

      // IMAGES - This is what we need!
      profile_pic: b.profile_pic || b.main_image || '',
      main_image: b.main_image || b.profile_pic || '',
      logo_image: b.logo_image || b.profile_pic || '',
      logo_url: b.logo_image || b.profile_pic || b.main_image || '', // For backward compatibility
      cover_image_url: b.main_image || b.profile_pic || '', // For backward compatibility

      // Contact info
      address: b.address || '',
      city: b.city || b.location || '',
      state: b.state || 'AL',
      zip: b.zip || b.zip_code || '',
      phone: b.phone || b.phone_number || '',
      website: b.website || '',

      // Business details
      category: b.category || 'business',
      description: b.description || '',
      short_description: b.short_description || b.description?.substring(0, 150) || '',

      // Ratings & reviews
      rating: b.rating || null,
      review_count: b.review_count || 0,
      price_level: b.price_level || null,

      // Location
      latitude: b.latitude || b.lat || null,
      longitude: b.longitude || b.lng || b.lon || null,

      // Hours
      hours: b.hours || null,

      // Metadata
      google_place_id: b.google_place_id || b.place_id || null,
      created_at: b.created_at || new Date().toISOString()
    }));

    res.json({
      success: true,
      count: transformedBusinesses.length,
      businesses: transformedBusinesses
    });

  } catch (error) {
    console.error('Error fetching GCR businesses:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      businesses: []
    });
  }
});

/**
 * GET /api/gcr/businesses/:slug
 * Get single business by slug
 */
router.get('/businesses/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // Get all businesses and find matching slug
    let businesses;
    try {
      businesses = await getAllGCRBusinesses();
    } catch (sheetError) {
      console.log('Google Sheets not configured, trying Supabase database...');
      const { data, error } = await supabase
        .from('gcr_businesses')
        .select('*');

      if (error) {
        console.error('Supabase fallback error:', error);
        businesses = [];
      } else {
        businesses = data || [];
      }
    }

    const business = businesses.find(b => {
      const businessSlug = b.slug || createSlug(b.business_name || b.name);
      return businessSlug === slug;
    });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    // Get business ID for fetching related data
    const businessId = business.id || business.business_id || business.google_place_id;

    // Fetch all related data from sheets 2-29
    const completeData = await getCompleteBusinessData(businessId);

    // Transform to match frontend expectations
    const transformed = {
      id: businessId,
      slug: business.slug || createSlug(business.business_name || business.name),
      business_name: business.business_name || business.name,

      // IMAGES
      profile_pic: business.profile_pic || business.main_image || '',
      main_image: business.main_image || business.profile_pic || '',
      logo_image: business.logo_image || business.profile_pic || '',

      // Contact
      address: business.address || '',
      city: business.city || business.location || '',
      state: business.state || 'AL',
      zip: business.zip || business.zip_code || '',
      phone: business.phone || business.phone_number || '',
      website: business.website || '',

      // Details
      category: business.category || 'business',
      description: business.description || '',
      rating: business.rating || null,
      review_count: business.review_count || 0,
      price_level: business.price_level || null,

      // Location
      latitude: business.latitude || business.lat || null,
      longitude: business.longitude || business.lng || null,

      // Hours
      hours: business.hours || null,

      // Metadata
      google_place_id: business.google_place_id || business.place_id || null,

      // Additional data from sheets 2-29
      ...(completeData && {
        hours_detail: completeData.hours,
        menu_items: completeData.menu_items,
        drink_menu: completeData.drink_menu,
        happy_hours: completeData.happy_hours,
        events: completeData.events,
        specials: completeData.specials,
        tags: completeData.tags,
        photos: completeData.photos,
        coupons: completeData.coupons,
        delivery_info: completeData.delivery_info,
        daily_specials: completeData.daily_specials
      })
    };

    res.json({
      success: true,
      business: transformed
    });

  } catch (error) {
    console.error('Error fetching business:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/gcr/upload-photo
 * Upload cover photo, logo, or gallery image for a business
 */
router.post('/upload-photo', authenticateToken, upload.single('photo'), async (req, res) => {
  try {
    const { business_id, photo_type } = req.body;

    if (!business_id) {
      return res.status(400).json({
        success: false,
        error: 'business_id is required'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No photo file provided'
      });
    }

    const validPhotoTypes = ['cover', 'logo', 'gallery'];
    if (!validPhotoTypes.includes(photo_type)) {
      return res.status(400).json({
        success: false,
        error: 'photo_type must be: cover, logo, or gallery'
      });
    }

    // Get file details
    const file = req.file;
    const fileExt = file.originalname.split('.').pop();
    const fileName = `${business_id}/${photo_type}-${Date.now()}.${fileExt}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('business-photos')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadError) {
      logger.error('Photo upload error:', uploadError);
      return res.status(500).json({
        success: false,
        error: 'Failed to upload photo: ' + uploadError.message
      });
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('business-photos')
      .getPublicUrl(fileName);

    logger.info(`Photo uploaded: ${publicUrl}`);

    // Update business record
    const updateData = { updated_at: new Date() };

    if (photo_type === 'cover') {
      updateData.cover_image_url = publicUrl;
    } else if (photo_type === 'logo') {
      updateData.logo_url = publicUrl;
    } else if (photo_type === 'gallery') {
      // Get current gallery images
      const { data: currentBusiness } = await supabase
        .from('gcr_businesses')
        .select('gallery_images')
        .eq('id', business_id)
        .single();

      const galleryImages = currentBusiness?.gallery_images || [];
      galleryImages.push(publicUrl);
      updateData.gallery_images = galleryImages;
    }

    // Update gcr_businesses table
    const { error: updateError } = await supabase
      .from('gcr_businesses')
      .update(updateData)
      .eq('id', business_id);

    if (updateError) {
      logger.error('Business update error:', updateError);
      return res.status(500).json({
        success: false,
        error: 'Failed to update business: ' + updateError.message
      });
    }

    logger.info(`${photo_type} photo saved for business ${business_id}`);

    res.json({
      success: true,
      message: `${photo_type} photo uploaded successfully`,
      url: publicUrl
    });

  } catch (error) {
    logger.error('Upload photo error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Helper: Create URL-friendly slug from business name
 */
function createSlug(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default router;
