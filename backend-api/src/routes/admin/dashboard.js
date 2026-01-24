/**
 * ADMIN DASHBOARD ROUTES
 * Provides stats, leads, and activity data for admin dashboard
 */

import express from 'express';
import { supabase } from '../../config/supabase.js';
import { verifyAdminToken } from './auth.js';

const router = express.Router();

// Apply admin authentication to all routes
router.use(verifyAdminToken);

// ============================================
// GET DASHBOARD STATS
// ============================================
router.get('/stats', async (req, res) => {
  try {
    // Get Ghost OS stats
    const { data: ghostOSLeads, error: ghostError } = await supabase
      .from('platform_leads')
      .select('*')
      .eq('platform', 'Ghost OS');

    // Get CyberCheck stats
    const { data: cyberchecBusinesses, error: ccError } = await supabase
      .from('cybercheck_businesses')
      .select('*');

    const { data: cyberchecLeads, error: ccLeadsError } = await supabase
      .from('cybercheck_leads')
      .select('*');

    // Get GCR stats
    const { data: gcrBusinesses, error: gcrError } = await supabase
      .from('gcr_businesses')
      .select('*');

    const { data: gcrLeads, error: gcrLeadsError } = await supabase
      .from('platform_leads')
      .select('*')
      .eq('platform', 'GCR');

    // Calculate stats
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const stats = {
      ghost_os: {
        total_leads: ghostOSLeads?.length || 0,
        new_today: ghostOSLeads?.filter(l => l.created_at?.startsWith(today)).length || 0,
        pending: ghostOSLeads?.filter(l => l.status === 'new').length || 0,
        converted: ghostOSLeads?.filter(l => l.status === 'converted').length || 0
      },
      cybercheck: {
        total_businesses: cyberchecBusinesses?.length || 0,
        active_businesses: cyberchecBusinesses?.filter(b => b.is_active).length || 0,
        total_leads: cyberchecLeads?.length || 0,
        new_today: cyberchecLeads?.filter(l => l.created_at?.startsWith(today)).length || 0
      },
      gcr: {
        total_businesses: gcrBusinesses?.length || 0,
        active_businesses: gcrBusinesses?.filter(b => b.status === 'active').length || 0,
        updated_today: gcrBusinesses?.filter(b => b.updated_at?.startsWith(today)).length || 0,
        total_leads: gcrLeads?.length || 0
      }
    };

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GET LEADS BY PLATFORM
// ============================================
router.get('/leads', async (req, res) => {
  try {
    const { platform, status, limit = 100 } = req.query;

    let query = supabase
      .from('platform_leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (platform) {
      query = query.eq('platform', platform);
    }

    if (status) {
      query = query.eq('status', status);
    }

    const { data: leads, error } = await query;

    if (error) throw error;

    // Transform data for frontend
    const transformedLeads = (leads || []).map(lead => ({
      id: lead.id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      source_type: lead.source || 'Unknown',
      status: lead.status || 'new',
      created_at: lead.created_at
    }));

    res.json({ success: true, leads: transformedLeads });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// GET ACTIVITY FEED
// ============================================
router.get('/activity', async (req, res) => {
  try {
    const { platform, limit = 20 } = req.query;

    // Get recent leads as activity
    let query = supabase
      .from('platform_leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (platform) {
      query = query.eq('platform', platform);
    }

    const { data: leads, error } = await query;

    if (error) throw error;

    // Transform to activity format
    const activities = (leads || []).map(lead => ({
      id: lead.id,
      type: 'lead',
      platform: lead.platform,
      description: `New lead: ${lead.name} - ${lead.source || 'Unknown source'}`,
      timestamp: lead.created_at
    }));

    res.json({ success: true, activities });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// UPDATE LEAD STATUS
// ============================================
router.patch('/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const { data, error } = await supabase
      .from('platform_leads')
      .update({ status })
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ success: true, lead: data[0] });
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
