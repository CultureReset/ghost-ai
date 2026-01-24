import Stripe from 'stripe';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Subscription plans
export const PLANS = {
  FREE: {
    id: 'free',
    name: 'Free',
    price: 0,
    features: {
      voice_notes: 10,
      sms_shared: 50,
      reviews: 100,
      profiles: 1
    }
  },
  BASIC: {
    id: 'basic',
    name: 'Basic',
    price: 29,
    stripe_price_id: process.env.STRIPE_PRICE_BASIC,
    features: {
      voice_notes: 100,
      sms_shared: 500,
      reviews: 1000,
      profiles: 3
    }
  },
  PRO: {
    id: 'pro',
    name: 'Pro',
    price: 99,
    stripe_price_id: process.env.STRIPE_PRICE_PRO,
    features: {
      voice_notes: 500,
      sms_shared: 2000,
      reviews: 10000,
      profiles: 10,
      custom_twilio: true,
      phone_ai: true,
      priority_support: true
    }
  },
  ENTERPRISE: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 299,
    stripe_price_id: process.env.STRIPE_PRICE_ENTERPRISE,
    features: {
      voice_notes: -1, // unlimited
      sms_shared: -1,
      reviews: -1,
      profiles: -1,
      custom_twilio: true,
      phone_ai: true,
      priority_support: true,
      dedicated_account_manager: true,
      white_label: true
    }
  }
};

/**
 * Create Stripe customer for business
 * @param {string} businessId - Business UUID
 * @param {string} email - Customer email
 * @param {string} name - Customer name
 * @returns {Promise<object>} - Stripe customer
 */
export async function createStripeCustomer(businessId, email, name) {
  if (!stripe) {
    throw new Error('Stripe not configured');
  }

  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: {
        business_id: businessId
      }
    });

    // Save customer ID to database
    await supabase
      .from('businesses')
      .update({ stripe_customer_id: customer.id })
      .eq('id', businessId);

    logger.info(`Stripe customer created: ${customer.id} for business: ${businessId}`);

    return customer;
  } catch (error) {
    logger.error('Create Stripe customer error:', error);
    throw error;
  }
}

/**
 * Create subscription checkout session
 * @param {string} businessId - Business UUID
 * @param {string} planId - Plan ID (basic, pro, enterprise)
 * @param {string} successUrl - Success redirect URL
 * @param {string} cancelUrl - Cancel redirect URL
 * @returns {Promise<object>} - Checkout session
 */
export async function createCheckoutSession(businessId, planId, successUrl, cancelUrl) {
  if (!stripe) {
    throw new Error('Stripe not configured');
  }

  const plan = Object.values(PLANS).find(p => p.id === planId);
  if (!plan || !plan.stripe_price_id) {
    throw new Error('Invalid plan');
  }

  try {
    // Get or create Stripe customer
    const { data: business } = await supabase
      .from('businesses')
      .select('stripe_customer_id, email, name')
      .eq('id', businessId)
      .single();

    let customerId = business.stripe_customer_id;
    if (!customerId) {
      const customer = await createStripeCustomer(businessId, business.email, business.name);
      customerId = customer.id;
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: plan.stripe_price_id,
          quantity: 1
        }
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        business_id: businessId,
        plan_id: planId
      }
    });

    logger.info(`Checkout session created: ${session.id} for business: ${businessId}`);

    return session;
  } catch (error) {
    logger.error('Create checkout session error:', error);
    throw error;
  }
}

/**
 * Create customer portal session (manage subscription)
 * @param {string} businessId - Business UUID
 * @param {string} returnUrl - Return URL
 * @returns {Promise<object>} - Portal session
 */
export async function createPortalSession(businessId, returnUrl) {
  if (!stripe) {
    throw new Error('Stripe not configured');
  }

  try {
    const { data: business } = await supabase
      .from('businesses')
      .select('stripe_customer_id')
      .eq('id', businessId)
      .single();

    if (!business.stripe_customer_id) {
      throw new Error('No Stripe customer found');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripe_customer_id,
      return_url: returnUrl
    });

    return session;
  } catch (error) {
    logger.error('Create portal session error:', error);
    throw error;
  }
}

/**
 * Handle subscription created/updated webhook
 * @param {object} subscription - Stripe subscription object
 */
export async function handleSubscriptionUpdate(subscription) {
  try {
    const businessId = subscription.metadata.business_id;
    const planId = subscription.metadata.plan_id;

    // Update subscription in database
    await supabase
      .from('subscriptions')
      .upsert({
        business_id: businessId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id: subscription.customer,
        plan_id: planId,
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        cancel_at_period_end: subscription.cancel_at_period_end,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'business_id'
      });

    logger.info(`Subscription updated for business: ${businessId}`);
  } catch (error) {
    logger.error('Handle subscription update error:', error);
    throw error;
  }
}

/**
 * Handle subscription deleted webhook
 * @param {object} subscription - Stripe subscription object
 */
export async function handleSubscriptionDeleted(subscription) {
  try {
    const businessId = subscription.metadata.business_id;

    // Mark subscription as canceled
    await supabase
      .from('subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString()
      })
      .eq('business_id', businessId);

    logger.info(`Subscription canceled for business: ${businessId}`);
  } catch (error) {
    logger.error('Handle subscription deleted error:', error);
    throw error;
  }
}

/**
 * Handle invoice payment succeeded webhook
 * @param {object} invoice - Stripe invoice object
 */
export async function handleInvoicePaymentSucceeded(invoice) {
  try {
    const businessId = invoice.subscription_data?.metadata?.business_id;

    if (businessId) {
      // Record payment in database
      await supabase.from('payments').insert({
        business_id: businessId,
        stripe_invoice_id: invoice.id,
        amount: invoice.amount_paid / 100, // Convert cents to dollars
        currency: invoice.currency,
        status: 'paid',
        paid_at: new Date(invoice.status_transitions.paid_at * 1000).toISOString()
      });

      logger.info(`Payment recorded for business: ${businessId}, amount: $${invoice.amount_paid / 100}`);
    }
  } catch (error) {
    logger.error('Handle invoice payment succeeded error:', error);
    throw error;
  }
}

/**
 * Handle invoice payment failed webhook
 * @param {object} invoice - Stripe invoice object
 */
export async function handleInvoicePaymentFailed(invoice) {
  try {
    const businessId = invoice.subscription_data?.metadata?.business_id;

    if (businessId) {
      // Record failed payment
      await supabase.from('payments').insert({
        business_id: businessId,
        stripe_invoice_id: invoice.id,
        amount: invoice.amount_due / 100,
        currency: invoice.currency,
        status: 'failed',
        error_message: invoice.last_finalization_error?.message
      });

      // TODO: Send notification to business owner about failed payment

      logger.warn(`Payment failed for business: ${businessId}`);
    }
  } catch (error) {
    logger.error('Handle invoice payment failed error:', error);
    throw error;
  }
}

/**
 * Get business subscription
 * @param {string} businessId - Business UUID
 * @returns {Promise<object>} - Subscription data
 */
export async function getBusinessSubscription(businessId) {
  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('business_id', businessId)
      .single();

    if (error && error.code !== 'PGRST116') { // Not found error
      throw error;
    }

    // If no subscription, return free plan
    if (!subscription) {
      return {
        plan_id: 'free',
        plan_name: 'Free',
        status: 'active',
        features: PLANS.FREE.features
      };
    }

    const plan = Object.values(PLANS).find(p => p.id === subscription.plan_id);

    return {
      ...subscription,
      plan_name: plan?.name || subscription.plan_id,
      features: plan?.features || {}
    };
  } catch (error) {
    logger.error('Get business subscription error:', error);
    throw error;
  }
}

/**
 * Check if business can use feature
 * @param {string} businessId - Business UUID
 * @param {string} feature - Feature name
 * @param {number} currentUsage - Current usage count
 * @returns {Promise<boolean>} - Can use feature
 */
export async function canUseFeature(businessId, feature, currentUsage = 0) {
  try {
    const subscription = await getBusinessSubscription(businessId);
    const limit = subscription.features[feature];

    // Unlimited (-1)
    if (limit === -1) {
      return true;
    }

    // Check if under limit
    return currentUsage < limit;
  } catch (error) {
    logger.error('Check feature usage error:', error);
    return false;
  }
}

/**
 * Calculate usage-based charges
 * @param {string} businessId - Business UUID
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<object>} - Usage breakdown
 */
export async function calculateUsageCharges(businessId, startDate, endDate) {
  try {
    const { data: records } = await supabase
      .from('usage_records')
      .select('*')
      .eq('business_id', businessId)
      .gte('date', startDate)
      .lte('date', endDate);

    const breakdown = {
      voice_notes: { count: 0, cost: 0 },
      sms: { count: 0, cost: 0 },
      ocr: { count: 0, cost: 0 },
      phone_calls: { count: 0, cost: 0, minutes: 0 },
      total_cost: 0
    };

    records?.forEach(record => {
      switch (record.usage_type) {
        case 'voice_note_processing':
          breakdown.voice_notes.count += record.quantity;
          breakdown.voice_notes.cost += record.cost;
          break;
        case 'sms_notification':
          breakdown.sms.count += record.quantity;
          breakdown.sms.cost += record.cost;
          break;
        case 'receipt_ocr':
          breakdown.ocr.count += record.quantity;
          breakdown.ocr.cost += record.cost;
          break;
        case 'phone_call':
          breakdown.phone_calls.count += record.quantity;
          breakdown.phone_calls.minutes += record.metadata?.duration_minutes || 0;
          breakdown.phone_calls.cost += record.cost;
          break;
      }
    });

    breakdown.total_cost =
      breakdown.voice_notes.cost +
      breakdown.sms.cost +
      breakdown.ocr.cost +
      breakdown.phone_calls.cost;

    return breakdown;
  } catch (error) {
    logger.error('Calculate usage charges error:', error);
    throw error;
  }
}

export default {
  PLANS,
  createStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  handleSubscriptionUpdate,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  getBusinessSubscription,
  canUseFeature,
  calculateUsageCharges
};
