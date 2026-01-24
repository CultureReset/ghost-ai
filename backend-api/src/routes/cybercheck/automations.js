import express from 'express';
import { supabase } from '../../config/supabase.js';

const router = express.Router();

// Get all automations for a user
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from('automations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      automations: data || []
    });
  } catch (error) {
    console.error('Error fetching automations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch automations'
    });
  }
});

// Create new automation
router.post('/', async (req, res) => {
  try {
    const {
      userId,
      name,
      trigger,
      event,
      condition,
      conditionValue,
      action,
      schedule,
      enabled
    } = req.body;

    const { data, error} = await supabase
      .from('automations')
      .insert({
        user_id: userId,
        name,
        trigger,
        event,
        condition,
        condition_value: conditionValue,
        action,
        schedule,
        enabled: enabled !== undefined ? enabled : true,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      automation: data
    });
  } catch (error) {
    console.error('Error creating automation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create automation'
    });
  }
});

// Update automation
router.put('/:automationId', async (req, res) => {
  try {
    const { automationId } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('automations')
      .update(updates)
      .eq('id', automationId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      automation: data
    });
  } catch (error) {
    console.error('Error updating automation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update automation'
    });
  }
});

// Toggle automation enabled/disabled
router.patch('/:automationId/toggle', async (req, res) => {
  try {
    const { automationId } = req.params;

    // Get current state
    const { data: current, error: fetchError } = await supabase
      .from('automations')
      .select('enabled')
      .eq('id', automationId)
      .single();

    if (fetchError) throw fetchError;

    // Toggle it
    const { data, error } = await supabase
      .from('automations')
      .update({ enabled: !current.enabled })
      .eq('id', automationId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      automation: data
    });
  } catch (error) {
    console.error('Error toggling automation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to toggle automation'
    });
  }
});

// Delete automation
router.delete('/:automationId', async (req, res) => {
  try {
    const { automationId } = req.params;

    const { error } = await supabase
      .from('automations')
      .delete()
      .eq('id', automationId);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Automation deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting automation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete automation'
    });
  }
});

// Get automation templates
router.get('/templates/all', async (req, res) => {
  try {
    const templates = [
      {
        id: 'high-value',
        name: 'High-Value Customer Alert',
        category: 'sales',
        trigger: 'stripe',
        event: 'New payment received',
        condition: 'amount_greater_than',
        conditionValue: '100',
        action: 'email_and_post',
        description: 'Get notified when customers make large purchases'
      },
      {
        id: 'daily-sales',
        name: 'Daily Sales Report',
        category: 'sales',
        trigger: 'schedule',
        event: 'Every day at 9:00 AM',
        condition: null,
        conditionValue: null,
        action: 'email_report',
        description: 'Receive a daily summary of your sales'
      },
      {
        id: 'cross-post',
        name: 'Social Media Cross-Post',
        category: 'marketing',
        trigger: 'instagram',
        event: 'New post published',
        condition: null,
        conditionValue: null,
        action: 'post_to_facebook',
        description: 'Automatically share Instagram posts to Facebook'
      }
    ];

    res.json({
      success: true,
      templates
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch automation templates'
    });
  }
});

export default router;
