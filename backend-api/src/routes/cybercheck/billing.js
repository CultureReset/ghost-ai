import express from 'express';
import { body, query, validationResult } from 'express-validator';
import {
  PLANS,
  createCheckoutSession,
  createPortalSession,
  getBusinessSubscription,
  calculateUsageCharges,
  handleSubscriptionUpdate,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed
} from '../../services/stripe.service.js';
import { supabase } from '../../config/supabase.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import logger from '../../config/logger.js';
import Stripe from 'stripe';

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * GET /api/billing/plans
 * Get available subscription plans
 */
router.get('/plans', (req, res) => {
  try {
    const plans = Object.values(PLANS).map(plan => ({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      features: plan.features
    }));

    res.json({
      success: true,
      data: plans
    });
  } catch (error) {
    logger.error('Get plans error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get plans'
    });
  }
});

/**
 * GET /api/billing/subscription
 * Get current subscription
 */
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const businessId = req.user.business_id;
    const subscription = await getBusinessSubscription(businessId);

    res.json({
      success: true,
      data: subscription
    });
  } catch (error) {
    logger.error('Get subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get subscription'
    });
  }
});

/**
 * POST /api/billing/checkout
 * Create checkout session for subscription
 */
router.post('/checkout',
  authenticate,
  requireRole(['owner', 'admin']),
  [
    body('plan_id').isIn(['basic', 'pro', 'enterprise']).withMessage('Invalid plan')
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
      const { plan_id } = req.body;

      const successUrl = `${process.env.FRONTEND_URL}/dashboard?subscription=success`;
      const cancelUrl = `${process.env.FRONTEND_URL}/dashboard?subscription=canceled`;

      const session = await createCheckoutSession(businessId, plan_id, successUrl, cancelUrl);

      res.json({
        success: true,
        data: {
          session_id: session.id,
          url: session.url
        }
      });
    } catch (error) {
      logger.error('Create checkout error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create checkout session'
      });
    }
  }
);

/**
 * POST /api/billing/portal
 * Create customer portal session
 */
router.post('/portal',
  authenticate,
  requireRole(['owner', 'admin']),
  async (req, res) => {
    try {
      const businessId = req.user.business_id;
      const returnUrl = `${process.env.FRONTEND_URL}/dashboard`;

      const session = await createPortalSession(businessId, returnUrl);

      res.json({
        success: true,
        data: {
          url: session.url
        }
      });
    } catch (error) {
      logger.error('Create portal error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create portal session'
      });
    }
  }
);

/**
 * GET /api/billing/usage
 * Get usage statistics
 */
router.get('/usage',
  authenticate,
  [
    query('start_date').optional().isISO8601().withMessage('Invalid start date'),
    query('end_date').optional().isISO8601().withMessage('Invalid end date')
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

      // Default to current month
      const now = new Date();
      const startDate = req.query.start_date || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const endDate = req.query.end_date || now.toISOString().split('T')[0];

      const usage = await calculateUsageCharges(businessId, startDate, endDate);

      res.json({
        success: true,
        data: {
          period: {
            start: startDate,
            end: endDate
          },
          usage
        }
      });
    } catch (error) {
      logger.error('Get usage error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get usage statistics'
      });
    }
  }
);

/**
 * GET /api/billing/usage/history
 * Get usage history
 */
router.get('/usage/history',
  authenticate,
  [
    query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be between 1 and 365')
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
      const days = parseInt(req.query.days) || 30;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const { data: records, error } = await supabase
        .from('usage_records')
        .select('*')
        .eq('business_id', businessId)
        .gte('date', startDate.toISOString().split('T')[0])
        .order('date', { ascending: false });

      if (error) {
        throw error;
      }

      // Group by date
      const groupedByDate = {};
      records.forEach(record => {
        if (!groupedByDate[record.date]) {
          groupedByDate[record.date] = {
            date: record.date,
            voice_notes: 0,
            sms: 0,
            ocr: 0,
            phone_calls: 0,
            total_cost: 0
          };
        }

        switch (record.usage_type) {
          case 'voice_note_processing':
            groupedByDate[record.date].voice_notes += record.quantity;
            break;
          case 'sms_notification':
            groupedByDate[record.date].sms += record.quantity;
            break;
          case 'receipt_ocr':
            groupedByDate[record.date].ocr += record.quantity;
            break;
          case 'phone_call':
            groupedByDate[record.date].phone_calls += record.quantity;
            break;
        }

        groupedByDate[record.date].total_cost += record.cost;
      });

      const history = Object.values(groupedByDate);

      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      logger.error('Get usage history error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get usage history'
      });
    }
  }
);

/**
 * GET /api/billing/invoices
 * Get invoice history
 */
router.get('/invoices',
  authenticate,
  async (req, res) => {
    try {
      const businessId = req.user.business_id;

      const { data: invoices, error } = await supabase
        .from('payments')
        .select('*')
        .eq('business_id', businessId)
        .order('paid_at', { ascending: false })
        .limit(50);

      if (error) {
        throw error;
      }

      res.json({
        success: true,
        data: invoices || []
      });
    } catch (error) {
      logger.error('Get invoices error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get invoices'
      });
    }
  }
);

/**
 * POST /api/billing/webhook
 * Stripe webhook handler
 */
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) {
      return res.status(503).json({
        success: false,
        error: 'Stripe not configured'
      });
    }

    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.error('Stripe webhook secret not configured');
      return res.status(500).json({
        success: false,
        error: 'Webhook not configured'
      });
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.error('Webhook signature verification failed:', err.message);
      return res.status(400).json({
        success: false,
        error: `Webhook Error: ${err.message}`
      });
    }

    try {
      // Handle different event types
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await handleSubscriptionUpdate(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object);
          break;

        case 'invoice.payment_succeeded':
          await handleInvoicePaymentSucceeded(event.data.object);
          break;

        case 'invoice.payment_failed':
          await handleInvoicePaymentFailed(event.data.object);
          break;

        default:
          logger.info(`Unhandled Stripe event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      logger.error('Webhook handler error:', error);
      res.status(500).json({
        success: false,
        error: 'Webhook handler failed'
      });
    }
  }
);

export default router;
