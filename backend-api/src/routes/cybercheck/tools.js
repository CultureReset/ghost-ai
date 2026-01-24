import express from 'express';
import { supabase } from '../../config/supabase.js';

const router = express.Router();

// Get all available tools
router.get('/available', async (req, res) => {
  try {
    const tools = [
      {
        id: 'stripe',
        name: 'Stripe',
        icon: '💳',
        category: 'payments',
        description: 'Accept online payments, manage subscriptions, and track revenue',
        features: ['Online Payments', 'Subscriptions', 'Invoicing', 'Analytics']
      },
      {
        id: 'square',
        name: 'Square',
        icon: '⬛',
        category: 'payments',
        description: 'Complete POS system with payment processing and inventory management',
        features: ['POS System', 'Online Payments', 'Inventory', 'Team Management']
      },
      {
        id: 'instagram',
        name: 'Instagram',
        icon: '📸',
        category: 'social',
        description: 'Share photos and stories, engage with customers on social media',
        features: ['Posts', 'Stories', 'Analytics', 'Direct Messages']
      },
      {
        id: 'facebook',
        name: 'Facebook',
        icon: '📘',
        category: 'social',
        description: 'Manage your business page, run ads, and engage with customers',
        features: ['Page Posts', 'Ads Manager', 'Messenger', 'Insights']
      },
      {
        id: 'google-analytics',
        name: 'Google Analytics',
        icon: '📊',
        category: 'analytics',
        description: 'Track website traffic, user behavior, and conversion metrics',
        features: ['Traffic Analysis', 'Conversion Tracking', 'User Behavior', 'Reports']
      },
      {
        id: 'google-calendar',
        name: 'Google Calendar',
        icon: '📅',
        category: 'productivity',
        description: 'Manage appointments, bookings, and team schedules',
        features: ['Event Scheduling', 'Booking System', 'Reminders', 'Team Calendars']
      },
      {
        id: 'mailchimp',
        name: 'Mailchimp',
        icon: '📧',
        category: 'marketing',
        description: 'Email marketing campaigns, newsletters, and automation',
        features: ['Email Campaigns', 'Automation', 'Analytics', 'Templates']
      },
      {
        id: 'twilio',
        name: 'Twilio',
        icon: '💬',
        category: 'communication',
        description: 'Send SMS messages, make calls, and manage customer communications',
        features: ['SMS Messaging', 'Voice Calls', 'Phone Numbers', 'WhatsApp']
      }
    ];

    res.json({
      success: true,
      tools
    });
  } catch (error) {
    console.error('Error fetching available tools:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available tools'
    });
  }
});

// Get user's connected tools
router.get('/connected/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'connected');

    if (error) throw error;

    res.json({
      success: true,
      tools: data || []
    });
  } catch (error) {
    console.error('Error fetching connected tools:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch connected tools'
    });
  }
});

// Connect a new tool
router.post('/connect', async (req, res) => {
  try {
    const { userId, toolId, credentials } = req.body;

    // In production, this would:
    // 1. Validate OAuth token or API key
    // 2. Test the connection
    // 3. Store encrypted credentials

    const { data, error } = await supabase
      .from('user_integrations')
      .insert({
        user_id: userId,
        tool_id: toolId,
        status: 'connected',
        connected_at: new Date().toISOString(),
        credentials: credentials // In production: encrypt this
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      integration: data
    });
  } catch (error) {
    console.error('Error connecting tool:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to connect tool'
    });
  }
});

// Disconnect a tool
router.delete('/disconnect/:userId/:toolId', async (req, res) => {
  try {
    const { userId, toolId } = req.params;

    const { error } = await supabase
      .from('user_integrations')
      .delete()
      .eq('user_id', userId)
      .eq('tool_id', toolId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Tool disconnected successfully'
    });
  } catch (error) {
    console.error('Error disconnecting tool:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to disconnect tool'
    });
  }
});

export default router;
