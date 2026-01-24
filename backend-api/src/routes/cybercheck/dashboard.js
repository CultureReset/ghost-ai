import express from 'express';
import { supabase } from '../../config/supabase.js';

const router = express.Router();

// Get dashboard data for a user
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's connected tools
    const { data: integrations, error: intError } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'connected');

    if (intError) throw intError;

    // In production, this would:
    // 1. Pull real data from each connected service
    // 2. Cache the data
    // 3. Return aggregated metrics

    // For now, return mock data structure
    const dashboardData = {
      stats: {
        revenue: {
          today: 1247,
          change: 12,
          source: 'stripe'
        },
        orders: {
          today: 47,
          change: 8,
          source: 'square'
        },
        visitors: {
          today: 2341,
          change: 23,
          source: 'google-analytics'
        },
        engagement: {
          today: 1284,
          change: 15,
          source: 'instagram'
        }
      },
      widgets: {
        stripe: {
          weekly_sales: [847, 1024, 745, 1157, 1289, 1456, 978]
        },
        square: {
          recent_orders: []
        },
        instagram: {
          recent_posts: []
        },
        google_analytics: {
          top_pages: []
        }
      },
      connected_tools: integrations || []
    };

    res.json({
      success: true,
      data: dashboardData
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
});

// Get data from specific integration
router.get('/:userId/integration/:toolId', async (req, res) => {
  try {
    const { userId, toolId } = req.params;
    const { dataType } = req.query; // e.g., 'sales', 'posts', 'analytics'

    // Verify user has this integration
    const { data: integration, error: intError } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('tool_id', toolId)
      .single();

    if (intError || !integration) {
      return res.status(404).json({
        success: false,
        error: 'Integration not found'
      });
    }

    // In production: Call the actual API (Stripe, Square, etc.)
    // using the stored credentials

    // For demo: return mock data
    let data = {};

    switch (toolId) {
      case 'stripe':
        data = {
          total_revenue: 7496,
          transactions: 42,
          avg_transaction: 178.48
        };
        break;
      case 'square':
        data = {
          total_sales: 5234,
          orders: 38,
          items_sold: 142
        };
        break;
      case 'instagram':
        data = {
          followers: 3421,
          posts: 156,
          engagement_rate: 4.2
        };
        break;
      case 'google-analytics':
        data = {
          sessions: 8765,
          pageviews: 23421,
          bounce_rate: 42.3
        };
        break;
      default:
        data = { message: 'No data available' };
    }

    res.json({
      success: true,
      tool: toolId,
      data
    });
  } catch (error) {
    console.error('Error fetching integration data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch integration data'
    });
  }
});

// Refresh dashboard data
router.post('/:userId/refresh', async (req, res) => {
  try {
    const { userId } = req.params;

    // In production: trigger data refresh from all connected services

    res.json({
      success: true,
      message: 'Dashboard data refresh initiated',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error refreshing dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh dashboard data'
    });
  }
});

export default router;
