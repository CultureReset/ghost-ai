/**
 * ADMIN INTEGRATIONS - For admin to add master API keys
 * Connects to existing: /admin/admin-add-integration.html
 */

import express from 'express';
import { supabase } from '../../config/supabase.js';

const router = express.Router();

// ============================================
// GET ALL ADMIN INTEGRATIONS
// ============================================
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_platform_credentials')
      .select('id, platform_name, display_name, is_active, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, integrations: data || [] });
  } catch (error) {
    console.error('Get integrations error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ADD NEW INTEGRATION
// ============================================
router.post('/', async (req, res) => {
  try {
    const {
      tool_name,       // From admin-add-integration.html
      display_name,
      api_key,
      api_secret,
      credentials_json
    } = req.body;

    // Validate
    if (!tool_name || !display_name) {
      return res.status(400).json({
        success: false,
        error: 'tool_name and display_name are required'
      });
    }

    // Save to database
    const { data, error } = await supabase
      .from('admin_platform_credentials')
      .insert({
        platform_name: tool_name,
        display_name: display_name,
        api_key: api_key,
        api_secret: api_secret,
        credentials_json: credentials_json,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      // Handle duplicate
      if (error.code === '23505') {
        return res.status(400).json({
          success: false,
          error: 'This integration already exists'
        });
      }
      throw error;
    }

    res.json({
      success: true,
      integration: {
        id: data.id,
        platform_name: data.platform_name,
        display_name: data.display_name,
        is_active: data.is_active
      }
    });

  } catch (error) {
    console.error('Add integration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GET SINGLE INTEGRATION
// ============================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('admin_platform_credentials')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Integration not found'
      });
    }

    res.json({ success: true, integration: data });

  } catch (error) {
    console.error('Get integration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// UPDATE INTEGRATION
// ============================================
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      display_name,
      api_key,
      api_secret,
      credentials_json,
      is_active
    } = req.body;

    const updates = {};
    if (display_name !== undefined) updates.display_name = display_name;
    if (api_key !== undefined) updates.api_key = api_key;
    if (api_secret !== undefined) updates.api_secret = api_secret;
    if (credentials_json !== undefined) updates.credentials_json = credentials_json;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from('admin_platform_credentials')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, integration: data });

  } catch (error) {
    console.error('Update integration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DELETE INTEGRATION
// ============================================
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('admin_platform_credentials')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true });

  } catch (error) {
    console.error('Delete integration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GET CREDENTIAL BY PLATFORM NAME
// (For voice assistant to use)
// ============================================
router.get('/platform/:platform_name', async (req, res) => {
  try {
    const { platform_name } = req.params;

    const { data, error } = await supabase
      .from('admin_platform_credentials')
      .select('*')
      .eq('platform_name', platform_name)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Platform not connected'
      });
    }

    res.json({ success: true, credentials: data });

  } catch (error) {
    console.error('Get platform credentials error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
