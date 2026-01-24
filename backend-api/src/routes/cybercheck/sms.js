import express from 'express';
import { body, validationResult } from 'express-validator';
import {
  sendTestSMS,
  sendSMS,
  sendSMSToBusinessOwner
} from '../../services/sms.service.js';
import { supabase } from '../../config/supabase.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

/**
 * POST /api/sms/test
 * Send test SMS to verify Twilio configuration
 */
router.post('/test',
  authenticate,
  [
    body('phone').optional().matches(/^\+[1-9]\d{1,14}$/).withMessage('Phone must be in E.164 format (e.g., +1234567890)')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const { phone } = req.body;
      const businessId = req.user.business_id;

      // If phone provided, send to that number
      // Otherwise, send to business owner's phone
      let result;
      if (phone) {
        result = await sendTestSMS(phone, businessId);
      } else {
        result = await sendSMSToBusinessOwner(
          businessId,
          '✅ CyberCheck SMS notifications are working!\n\nYou\'ll receive updates about:\n🎙️ Voice notes\n⭐ Reviews\n🚨 Urgent leads\n\nReply STOP to opt out',
          { type: 'test' }
        );
      }

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error
        });
      }

      logger.info(`Test SMS sent successfully for business: ${businessId}`);

      res.json({
        success: true,
        message: 'Test SMS sent successfully',
        data: {
          sid: result.sid,
          status: result.status
        }
      });
    } catch (error) {
      logger.error('Test SMS error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send test SMS',
        details: error.message
      });
    }
  }
);

/**
 * GET /api/sms/config
 * Get SMS configuration for business
 * Returns whether custom Twilio is configured (without exposing credentials)
 */
router.get('/config',
  authenticate,
  requireRole(['owner', 'admin']),
  async (req, res) => {
    try {
      const businessId = req.user.business_id;

      const { data: business, error } = await supabase
        .from('businesses')
        .select('sms_config')
        .eq('id', businessId)
        .single();

      if (error) {
        throw error;
      }

      const smsConfig = business?.sms_config || {};

      // Return safe config (no credentials)
      res.json({
        success: true,
        data: {
          custom_twilio_enabled: smsConfig.custom_twilio_enabled || false,
          has_credentials: !!(
            smsConfig.twilio_account_sid &&
            smsConfig.twilio_auth_token &&
            smsConfig.twilio_phone_number
          ),
          phone_number: smsConfig.twilio_phone_number || null,
          using_shared: !smsConfig.custom_twilio_enabled
        }
      });
    } catch (error) {
      logger.error('Get SMS config error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get SMS configuration'
      });
    }
  }
);

/**
 * PUT /api/sms/config
 * Update SMS configuration (admin only)
 * Allows setting custom Twilio credentials
 */
router.put('/config',
  authenticate,
  requireRole(['owner', 'admin']),
  [
    body('custom_twilio_enabled').isBoolean().withMessage('custom_twilio_enabled must be boolean'),
    body('twilio_account_sid').optional().isString().withMessage('Invalid Twilio Account SID'),
    body('twilio_auth_token').optional().isString().withMessage('Invalid Twilio Auth Token'),
    body('twilio_phone_number').optional().matches(/^\+[1-9]\d{1,14}$/).withMessage('Phone must be in E.164 format')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const businessId = req.user.business_id;
      const {
        custom_twilio_enabled,
        twilio_account_sid,
        twilio_auth_token,
        twilio_phone_number
      } = req.body;

      // Build SMS config object
      const smsConfig = {
        custom_twilio_enabled: custom_twilio_enabled || false
      };

      // If enabling custom Twilio, require all credentials
      if (custom_twilio_enabled) {
        if (!twilio_account_sid || !twilio_auth_token || !twilio_phone_number) {
          return res.status(400).json({
            success: false,
            error: 'Custom Twilio requires account_sid, auth_token, and phone_number'
          });
        }

        smsConfig.twilio_account_sid = twilio_account_sid;
        smsConfig.twilio_auth_token = twilio_auth_token;
        smsConfig.twilio_phone_number = twilio_phone_number;
      }

      // Update business SMS config
      const { error } = await supabase
        .from('businesses')
        .update({ sms_config: smsConfig })
        .eq('id', businessId);

      if (error) {
        throw error;
      }

      logger.info(`SMS config updated for business: ${businessId}`);

      res.json({
        success: true,
        message: 'SMS configuration updated successfully',
        data: {
          custom_twilio_enabled: smsConfig.custom_twilio_enabled,
          phone_number: smsConfig.twilio_phone_number || null
        }
      });
    } catch (error) {
      logger.error('Update SMS config error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update SMS configuration'
      });
    }
  }
);

/**
 * POST /api/sms/toggle-notifications
 * Toggle SMS notifications on/off for current user
 */
router.post('/toggle-notifications',
  authenticate,
  [
    body('enabled').isBoolean().withMessage('enabled must be boolean')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const userId = req.user.id;
      const { enabled } = req.body;

      const { error } = await supabase
        .from('users')
        .update({ sms_notifications_enabled: enabled })
        .eq('id', userId);

      if (error) {
        throw error;
      }

      logger.info(`SMS notifications ${enabled ? 'enabled' : 'disabled'} for user: ${userId}`);

      res.json({
        success: true,
        message: `SMS notifications ${enabled ? 'enabled' : 'disabled'}`,
        data: {
          sms_notifications_enabled: enabled
        }
      });
    } catch (error) {
      logger.error('Toggle SMS notifications error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to toggle SMS notifications'
      });
    }
  }
);

/**
 * POST /api/sms/test-custom
 * Test custom Twilio credentials before saving
 * Validates that the provided credentials work
 */
router.post('/test-custom',
  authenticate,
  requireRole(['owner', 'admin']),
  [
    body('twilio_account_sid').isString().withMessage('Invalid Twilio Account SID'),
    body('twilio_auth_token').isString().withMessage('Invalid Twilio Auth Token'),
    body('twilio_phone_number').matches(/^\+[1-9]\d{1,14}$/).withMessage('Phone must be in E.164 format'),
    body('test_phone').matches(/^\+[1-9]\d{1,14}$/).withMessage('Test phone must be in E.164 format')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const {
        twilio_account_sid,
        twilio_auth_token,
        twilio_phone_number,
        test_phone
      } = req.body;

      // Import twilio here to test credentials
      const twilio = (await import('twilio')).default;
      const testClient = twilio(twilio_account_sid, twilio_auth_token);

      // Try to send test SMS
      const message = await testClient.messages.create({
        body: '✅ Custom Twilio credentials test successful! Your CyberCheck SMS notifications are configured correctly.',
        from: twilio_phone_number,
        to: test_phone
      });

      logger.info(`Custom Twilio test successful for business: ${req.user.business_id}`);

      res.json({
        success: true,
        message: 'Custom Twilio credentials validated successfully',
        data: {
          sid: message.sid,
          status: message.status
        }
      });
    } catch (error) {
      logger.error('Custom Twilio test error:', error);
      res.status(400).json({
        success: false,
        error: 'Custom Twilio credentials invalid',
        details: error.message
      });
    }
  }
);

/**
 * GET /api/sms/campaigns
 * List all SMS campaigns with filters
 */
router.get('/campaigns',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const {
        status,
        limit = 50,
        offset = 0
      } = req.query;

      let query = supabase
        .from('sms_campaigns')
        .select('*', { count: 'exact' })
        .eq('business_id', businessId)
        .is('deleted_at', null);

      if (status) {
        query = query.eq('status', status);
      }

      query = query
        .order('created_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      const { data: campaigns, error, count } = await query;

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        data: campaigns,
        meta: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });

    } catch (error) {
      logger.error('List campaigns error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch campaigns'
      });
    }
  }
);

/**
 * GET /api/sms/campaigns/:id
 * Get a single campaign by ID
 */
router.get('/campaigns/:id',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      const { data: campaign, error } = await supabase
        .from('sms_campaigns')
        .select('*')
        .eq('id', id)
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .single();

      if (error || !campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      res.json({
        success: true,
        data: campaign
      });

    } catch (error) {
      logger.error('Get campaign error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch campaign'
      });
    }
  }
);

/**
 * POST /api/sms/campaigns
 * Create a new SMS campaign
 */
router.post('/campaigns',
  authenticate,
  [
    body('name').trim().notEmpty().withMessage('Campaign name is required'),
    body('message').trim().notEmpty().withMessage('Message is required'),
    body('recipient_type').isIn(['all', 'customers', 'leads', 'recent', 'custom', 'segment']).withMessage('Invalid recipient type')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const businessId = req.user.business_id;
      const userId = req.user.id;

      const {
        name,
        message,
        recipient_type,
        recipient_segment,
        send_type = 'immediate',
        scheduled_for,
        settings = {}
      } = req.body;

      // Validate scheduled_for if send_type is scheduled
      if (send_type === 'scheduled' && !scheduled_for) {
        return res.status(400).json({
          success: false,
          error: 'scheduled_for is required when send_type is "scheduled"'
        });
      }

      const campaignData = {
        business_id: businessId,
        created_by: userId,
        name: name.trim(),
        message: message.trim(),
        recipient_type,
        recipient_segment: recipient_segment || null,
        send_type,
        scheduled_for: scheduled_for || null,
        status: send_type === 'immediate' ? 'sending' : 'scheduled',
        settings
      };

      const { data: campaign, error } = await supabase
        .from('sms_campaigns')
        .insert(campaignData)
        .select()
        .single();

      if (error) {
        throw error;
      }

      // TODO: If immediate send, trigger campaign execution
      // if (send_type === 'immediate') {
      //   await executeCampaign(campaign.id);
      // }

      res.status(201).json({
        success: true,
        data: campaign
      });

    } catch (error) {
      logger.error('Create campaign error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create campaign'
      });
    }
  }
);

/**
 * PUT /api/sms/campaigns/:id
 * Update an existing campaign
 */
router.put('/campaigns/:id',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      // Check if campaign exists
      const { data: existing, error: fetchError } = await supabase
        .from('sms_campaigns')
        .select('status')
        .eq('id', id)
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      // Can't edit campaigns that have already been sent
      if (existing.status === 'sent' || existing.status === 'sending') {
        return res.status(400).json({
          success: false,
          error: 'Cannot edit campaigns that have been sent or are sending'
        });
      }

      const {
        name,
        message,
        recipient_type,
        recipient_segment,
        send_type,
        scheduled_for,
        settings
      } = req.body;

      const updateData = {
        updated_at: new Date().toISOString()
      };

      if (name !== undefined) updateData.name = name.trim();
      if (message !== undefined) updateData.message = message.trim();
      if (recipient_type !== undefined) updateData.recipient_type = recipient_type;
      if (recipient_segment !== undefined) updateData.recipient_segment = recipient_segment;
      if (send_type !== undefined) updateData.send_type = send_type;
      if (scheduled_for !== undefined) updateData.scheduled_for = scheduled_for;
      if (settings !== undefined) updateData.settings = settings;

      const { data: campaign, error } = await supabase
        .from('sms_campaigns')
        .update(updateData)
        .eq('id', id)
        .eq('business_id', businessId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        data: campaign
      });

    } catch (error) {
      logger.error('Update campaign error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update campaign'
      });
    }
  }
);

/**
 * DELETE /api/sms/campaigns/:id
 * Soft delete a campaign
 */
router.delete('/campaigns/:id',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      const { error } = await supabase
        .from('sms_campaigns')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('business_id', businessId);

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        message: 'Campaign deleted successfully'
      });

    } catch (error) {
      logger.error('Delete campaign error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete campaign'
      });
    }
  }
);

/**
 * POST /api/sms/campaigns/:id/cancel
 * Cancel a scheduled campaign
 */
router.post('/campaigns/:id/cancel',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      const { data: campaign, error } = await supabase
        .from('sms_campaigns')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .eq('business_id', businessId)
        .eq('status', 'scheduled')
        .select()
        .single();

      if (error || !campaign) {
        return res.status(404).json({
          success: false,
          error: 'Scheduled campaign not found'
        });
      }

      res.json({
        success: true,
        data: campaign
      });

    } catch (error) {
      logger.error('Cancel campaign error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cancel campaign'
      });
    }
  }
);

/**
 * POST /api/sms/campaigns/:id/duplicate
 * Duplicate an existing campaign
 */
router.post('/campaigns/:id/duplicate',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const userId = req.user.id;
      const { id } = req.params;

      // Get original campaign
      const { data: original, error: fetchError } = await supabase
        .from('sms_campaigns')
        .select('*')
        .eq('id', id)
        .eq('business_id', businessId)
        .single();

      if (fetchError || !original) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      // Create duplicate
      const duplicateData = {
        business_id: businessId,
        created_by: userId,
        name: `${original.name} (Copy)`,
        message: original.message,
        recipient_type: original.recipient_type,
        recipient_segment: original.recipient_segment,
        send_type: 'immediate',
        status: 'draft',
        settings: original.settings
      };

      const { data: duplicate, error } = await supabase
        .from('sms_campaigns')
        .insert(duplicateData)
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.status(201).json({
        success: true,
        data: duplicate
      });

    } catch (error) {
      logger.error('Duplicate campaign error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to duplicate campaign'
      });
    }
  }
);

/**
 * GET /api/sms/automations
 * List all SMS automations
 */
router.get('/automations',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { enabled, trigger_type } = req.query;

      let query = supabase
        .from('sms_automations')
        .select('*')
        .eq('business_id', businessId)
        .is('deleted_at', null);

      if (enabled !== undefined) {
        query = query.eq('enabled', enabled === 'true');
      }

      if (trigger_type) {
        query = query.eq('trigger_type', trigger_type);
      }

      query = query.order('created_at', { ascending: false });

      const { data: automations, error } = await query;

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        data: automations
      });

    } catch (error) {
      logger.error('List automations error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch automations'
      });
    }
  }
);

/**
 * GET /api/sms/automations/:id
 * Get a single automation by ID
 */
router.get('/automations/:id',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      const { data: automation, error } = await supabase
        .from('sms_automations')
        .select('*')
        .eq('id', id)
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .single();

      if (error || !automation) {
        return res.status(404).json({
          success: false,
          error: 'Automation not found'
        });
      }

      res.json({
        success: true,
        data: automation
      });

    } catch (error) {
      logger.error('Get automation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch automation'
      });
    }
  }
);

/**
 * POST /api/sms/automations
 * Create a new SMS automation
 */
router.post('/automations',
  authenticate,
  [
    body('name').trim().notEmpty().withMessage('Automation name is required'),
    body('trigger_type').isIn([
      'appointment_reminder',
      'review_request',
      'birthday',
      'anniversary',
      'follow_up',
      'welcome',
      'abandoned_cart',
      'custom'
    ]).withMessage('Invalid trigger type'),
    body('message_template').trim().notEmpty().withMessage('Message template is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const businessId = req.user.business_id;
      const userId = req.user.id;

      const {
        name,
        description,
        icon = '📱',
        trigger_type,
        trigger_config = {},
        message_template,
        delay_amount,
        delay_unit,
        send_time_start,
        send_time_end,
        enabled = true,
        settings = {}
      } = req.body;

      const automationData = {
        business_id: businessId,
        created_by: userId,
        name: name.trim(),
        description: description?.trim() || null,
        icon,
        trigger_type,
        trigger_config,
        message_template: message_template.trim(),
        delay_amount,
        delay_unit,
        send_time_start,
        send_time_end,
        enabled,
        settings
      };

      const { data: automation, error } = await supabase
        .from('sms_automations')
        .insert(automationData)
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.status(201).json({
        success: true,
        data: automation
      });

    } catch (error) {
      logger.error('Create automation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create automation'
      });
    }
  }
);

/**
 * PUT /api/sms/automations/:id
 * Update an existing automation
 */
router.put('/automations/:id',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      const { data: existing, error: fetchError } = await supabase
        .from('sms_automations')
        .select('id')
        .eq('id', id)
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({
          success: false,
          error: 'Automation not found'
        });
      }

      const {
        name,
        description,
        icon,
        trigger_config,
        message_template,
        delay_amount,
        delay_unit,
        send_time_start,
        send_time_end,
        enabled,
        settings
      } = req.body;

      const updateData = {
        updated_at: new Date().toISOString()
      };

      if (name !== undefined) updateData.name = name.trim();
      if (description !== undefined) updateData.description = description?.trim() || null;
      if (icon !== undefined) updateData.icon = icon;
      if (trigger_config !== undefined) updateData.trigger_config = trigger_config;
      if (message_template !== undefined) updateData.message_template = message_template.trim();
      if (delay_amount !== undefined) updateData.delay_amount = delay_amount;
      if (delay_unit !== undefined) updateData.delay_unit = delay_unit;
      if (send_time_start !== undefined) updateData.send_time_start = send_time_start;
      if (send_time_end !== undefined) updateData.send_time_end = send_time_end;
      if (enabled !== undefined) updateData.enabled = enabled;
      if (settings !== undefined) updateData.settings = settings;

      const { data: automation, error } = await supabase
        .from('sms_automations')
        .update(updateData)
        .eq('id', id)
        .eq('business_id', businessId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        data: automation
      });

    } catch (error) {
      logger.error('Update automation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update automation'
      });
    }
  }
);

/**
 * PATCH /api/sms/automations/:id/toggle
 * Toggle automation enabled/disabled
 */
router.patch('/automations/:id/toggle',
  authenticate,
  [
    body('enabled').isBoolean().withMessage('enabled must be boolean')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }

      const businessId = req.user.business_id;
      const { id } = req.params;
      const { enabled } = req.body;

      const { data: automation, error } = await supabase
        .from('sms_automations')
        .update({ enabled, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .select()
        .single();

      if (error || !automation) {
        return res.status(404).json({
          success: false,
          error: 'Automation not found'
        });
      }

      res.json({
        success: true,
        data: automation
      });

    } catch (error) {
      logger.error('Toggle automation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to toggle automation'
      });
    }
  }
);

/**
 * DELETE /api/sms/automations/:id
 * Soft delete an automation
 */
router.delete('/automations/:id',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const { id } = req.params;

      const { error } = await supabase
        .from('sms_automations')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .eq('business_id', businessId);

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        message: 'Automation deleted successfully'
      });

    } catch (error) {
      logger.error('Delete automation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete automation'
      });
    }
  }
);

/**
 * GET /api/sms/history
 * Get SMS message history/logs
 */
router.get('/history',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const {
        message_type,
        start_date,
        end_date,
        limit = 50,
        offset = 0
      } = req.query;

      let query = supabase
        .from('sms_message_logs')
        .select(`
          *,
          campaign:sms_campaigns(id, name),
          automation:sms_automations(id, name),
          contact:contacts(id, first_name, last_name)
        `, { count: 'exact' })
        .eq('business_id', businessId);

      if (message_type) {
        query = query.eq('message_type', message_type);
      }

      if (start_date) {
        query = query.gte('sent_at', start_date);
      }

      if (end_date) {
        query = query.lte('sent_at', end_date);
      }

      query = query
        .order('sent_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      const { data: logs, error, count } = await query;

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        data: logs,
        meta: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });

    } catch (error) {
      logger.error('Get SMS history error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch SMS history'
      });
    }
  }
);

/**
 * POST /api/sms/inbound
 * Twilio webhook for incoming SMS/MMS messages
 * Handles menu photo uploads: "Shrimp Tacos" + photo → updates menu item
 */
router.post('/inbound', async (req, res) => {
  try {
    const {
      From,
      To,
      Body,
      NumMedia,
      MediaUrl0,
      MediaContentType0
    } = req.body;

    logger.info(`Inbound SMS/MMS from ${From}: ${Body || '(no text)'}, Media: ${NumMedia || 0}`);

    // Find user by phone number
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('id, business_id, businesses(id, name)')
      .eq('phone', From)
      .limit(1);

    if (userError || !users || users.length === 0) {
      logger.warn(`Inbound SMS from unrecognized number: ${From}`);

      // Send help message
      await sendSMS(From, 'Welcome to CyberCheck! To use this service, please register at cybercheck.com and add your phone number.', {
        type: 'help'
      });

      return res.status(200).send('<Response></Response>');
    }

    const user = users[0];
    const businessId = user.business_id;
    const userId = user.id;

    // Check if MMS with photo
    const hasMedia = parseInt(NumMedia || '0') > 0;
    const hasText = Body && Body.trim().length > 0;

    if (!hasMedia && !hasText) {
      await sendSMS(From, 'Please send a menu item name with a photo to update your menu. Example: "Fish Tacos" + photo', {
        business_id: businessId,
        type: 'help'
      });
      return res.status(200).send('<Response></Response>');
    }

    // MENU PHOTO UPDATE WORKFLOW
    if (hasMedia && MediaContentType0?.startsWith('image/')) {
      const itemName = Body?.trim() || '';

      if (!itemName) {
        await sendSMS(From, 'Please include the menu item name in your message. Example: "Fish Tacos"', {
          business_id: businessId,
          type: 'error'
        });
        return res.status(200).send('<Response></Response>');
      }

      // Search for menu item by name (fuzzy match)
      const { data: menuItems, error: searchError } = await supabase
        .from('menu_items')
        .select('*')
        .eq('business_id', businessId)
        .ilike('name', `%${itemName}%`)
        .limit(5);

      if (searchError) {
        throw searchError;
      }

      if (!menuItems || menuItems.length === 0) {
        // No matches found - offer to create new item
        await sendSMS(From, `"${itemName}" not found in your menu. Would you like to add it? Call your AI assistant to add new menu items.`, {
          business_id: businessId,
          type: 'not_found'
        });
        return res.status(200).send('<Response></Response>');
      }

      // Find best match (exact match first, then starts with, then contains)
      const sortedItems = menuItems.sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        const searchLower = itemName.toLowerCase();

        if (aLower === searchLower) return -1;
        if (bLower === searchLower) return 1;
        if (aLower.startsWith(searchLower)) return -1;
        if (bLower.startsWith(searchLower)) return 1;
        return 0;
      });

      const matchedItem = sortedItems[0];

      // Store image URL directly (Twilio hosts MMS media for 48 hours+ and can be downloaded)
      // For production, download and upload to Supabase Storage
      const imageUrl = MediaUrl0;

      // Update menu item
      const { data: updatedItem, error: updateError } = await supabase
        .from('menu_items')
        .update({
          image_url: imageUrl,
          thumbnail_url: imageUrl,
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('id', matchedItem.id)
        .select()
        .single();

      if (updateError) {
        throw updateError;
      }

      // Log image history
      await supabase
        .from('menu_item_images')
        .insert({
          menu_item_id: matchedItem.id,
          image_url: imageUrl,
          thumbnail_url: imageUrl,
          source: 'sms',
          uploaded_by: userId
        });

      logger.info(`Menu item image updated via SMS: ${matchedItem.name} (${matchedItem.id}) for business ${businessId}`);

      // Send confirmation
      const confirmationMessage = sortedItems.length > 1
        ? `✅ Updated image for "${matchedItem.name}"\n\nDid you mean:\n${sortedItems.slice(1, 3).map(item => `• ${item.name}`).join('\n')}\n\nText the correct name if I got it wrong!`
        : `✅ Image updated for "${matchedItem.name}"!\n\nLive on your menu now. Text another item name + photo to update more.`;

      await sendSMS(From, confirmationMessage, {
        business_id: businessId,
        type: 'menu_photo_updated',
        metadata: {
          menu_item_id: matchedItem.id,
          menu_item_name: matchedItem.name
        }
      });

      return res.status(200).send('<Response></Response>');
    }

    // TEXT-ONLY MESSAGE (for future features)
    // Could handle: "mark fish tacos as sold out", "what's the price of shrimp tacos", etc.
    await sendSMS(From, 'Got your message! For menu updates, send a photo with the item name. For other requests, call your AI assistant.', {
      business_id: businessId,
      type: 'text_received'
    });

    res.status(200).send('<Response></Response>');
  } catch (error) {
    logger.error('Inbound SMS/MMS error:', error);

    // Always return 200 to Twilio to prevent retries
    res.status(200).send('<Response></Response>');
  }
});

export default router;
