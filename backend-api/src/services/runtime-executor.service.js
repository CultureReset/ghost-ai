import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';
import { sendBulkSMS } from './sms.service.js';

/**
 * Runtime Executor Service
 * Safely executes action plans with validation, logging, and idempotency
 */

/**
 * Execute action plan
 * @param {string} actionPlanId - Action plan UUID
 * @param {string} businessId - Business UUID
 * @param {string} userId - User UUID (actor)
 * @returns {Promise<object>} - Execution results
 */
export async function executeActionPlan(actionPlanId, businessId, userId = null) {
  const startTime = Date.now();

  try {
    // Load action plan
    const { data: plan, error: planError } = await supabase
      .from('action_plans')
      .select('*')
      .eq('id', actionPlanId)
      .single();

    if (planError || !plan) {
      throw new Error('Action plan not found');
    }

    // Validate plan belongs to business
    if (plan.business_id !== businessId) {
      throw new Error('Action plan does not belong to business');
    }

    // Check if already executed
    if (plan.status === 'completed') {
      logger.info(`Action plan ${actionPlanId} already executed, skipping`);
      return {
        success: true,
        already_executed: true,
        results: plan.results
      };
    }

    // Check if requires confirmation and not confirmed
    if (plan.requires_confirmation && !plan.confirmed) {
      throw new Error('Action plan requires confirmation');
    }

    // Update status to executing
    await supabase
      .from('action_plans')
      .update({
        status: 'executing',
        executed_at: new Date().toISOString()
      })
      .eq('id', actionPlanId);

    // Execute each action
    const results = [];
    const actions = plan.actions || [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      try {
        const result = await executeAction(
          action,
          businessId,
          userId,
          plan.request_id,
          actionPlanId
        );

        results.push({
          action_index: i,
          action_type: action.type,
          status: 'success',
          result
        });
      } catch (error) {
        logger.error(`Action ${i} failed:`, error);

        results.push({
          action_index: i,
          action_type: action.type,
          status: 'failed',
          error: error.message
        });

        // Stop on first error
        break;
      }
    }

    // Check if all succeeded
    const allSucceeded = results.every(r => r.status === 'success');
    const executionDuration = Date.now() - startTime;

    // Update action plan status
    await supabase
      .from('action_plans')
      .update({
        status: allSucceeded ? 'completed' : 'failed',
        results,
        execution_duration: executionDuration,
        updated_at: new Date().toISOString()
      })
      .eq('id', actionPlanId);

    logger.info(`Action plan ${actionPlanId} executed in ${executionDuration}ms`, {
      actions_count: actions.length,
      succeeded: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length
    });

    return {
      success: allSucceeded,
      results,
      execution_duration: executionDuration
    };
  } catch (error) {
    logger.error('Execute action plan error:', error);

    // Update plan to failed
    await supabase
      .from('action_plans')
      .update({
        status: 'failed',
        error_message: error.message,
        updated_at: new Date().toISOString()
      })
      .eq('id', actionPlanId);

    throw error;
  }
}

/**
 * Execute single action
 * @param {object} action - Action object
 * @param {string} businessId - Business UUID
 * @param {string} userId - User UUID
 * @param {string} requestId - Request ID for correlation
 * @param {string} actionPlanId - Action plan ID
 * @returns {Promise<object>} - Action result
 */
async function executeAction(action, businessId, userId, requestId, actionPlanId) {
  const actionStartTime = Date.now();
  const idempotencyKey = `${requestId}-${action.type}-${actionStartTime}`;

  // Check if action already executed (idempotency)
  const { data: existingLog } = await supabase
    .from('action_logs')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (existingLog) {
    logger.info(`Action already executed: ${idempotencyKey}`);
    return existingLog.output;
  }

  let beforeState = null;
  let afterState = null;
  let output = null;
  let status = 'success';
  let errorMessage = null;

  try {
    switch (action.type) {
      case 'page_update':
        ({ beforeState, afterState, output } = await executePageUpdate(action, businessId));
        break;

      case 'tool_call':
        ({ beforeState, afterState, output } = await executeToolCall(action, businessId));
        break;

      case 'query':
        ({ beforeState, afterState, output } = await executeQuery(action, businessId));
        break;

      case 'menu_update':
        ({ beforeState, afterState, output } = await executeMenuUpdate(action, businessId, userId));
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  } catch (error) {
    status = 'failed';
    errorMessage = error.message;
    throw error;
  } finally {
    // Log action
    const duration = Date.now() - actionStartTime;

    await supabase.from('action_logs').insert({
      action_plan_id: actionPlanId,
      request_id: requestId,
      business_id: businessId,
      user_id: userId,
      actor_type: 'user',
      action_type: action.type,
      action_target: action.target,
      command: action.command || action.operation,
      inputs: action.inputs || action,
      before_state: beforeState,
      after_state: afterState,
      diff: calculateDiff(beforeState, afterState),
      status,
      output,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
      duration,
      idempotency_key: idempotencyKey
    });
  }

  return output;
}

/**
 * Execute page update action
 * @param {object} action - Action object
 * @param {string} businessId - Business UUID
 * @returns {Promise<object>} - Execution result
 */
async function executePageUpdate(action, businessId) {
  const { target, operation, path, value } = action;

  if (target !== 'profile') {
    throw new Error(`Unsupported page update target: ${target}`);
  }

  // Get current profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'active')
    .single();

  if (!profile) {
    throw new Error('No active profile found');
  }

  const beforeState = { ...profile };

  // Apply update based on operation
  let updates = {};

  switch (operation) {
    case 'patch': {
      // Parse path (e.g., "structured_fields.hours.thursday")
      const pathParts = path.split('.');
      const field = pathParts[0]; // "structured_fields"
      const subPath = pathParts.slice(1); // ["hours", "thursday"]

      if (field === 'structured_fields') {
        const newStructuredFields = { ...profile.structured_fields };
        setNestedValue(newStructuredFields, subPath, value);
        updates.structured_fields = newStructuredFields;
      } else {
        updates[field] = value;
      }
      break;
    }

    case 'set': {
      updates[path] = value;
      break;
    }

    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }

  // Update profile
  const { data: updatedProfile, error } = await supabase
    .from('profiles')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', profile.id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return {
    beforeState,
    afterState: updatedProfile,
    output: {
      profile_id: profile.id,
      updated_fields: Object.keys(updates)
    }
  };
}

/**
 * Execute tool call action
 * @param {object} action - Action object
 * @param {string} businessId - Business UUID
 * @returns {Promise<object>} - Execution result
 */
async function executeToolCall(action, businessId) {
  const { tool, command, inputs } = action;

  const beforeState = { tool, command, inputs };

  let output = null;

  switch (tool) {
    case 'sms': {
      if (command === 'send_bulk') {
        // Get all customers for this business
        const { data: customers } = await supabase
          .from('customers')
          .select('phone_number')
          .eq('business_id', businessId)
          .not('phone_number', 'is', null);

        const phoneNumbers = customers?.map(c => c.phone_number).filter(Boolean) || [];

        if (phoneNumbers.length === 0) {
          throw new Error('No customers with phone numbers found');
        }

        // Send bulk SMS
        const results = await sendBulkSMS(businessId, phoneNumbers, inputs.message);

        output = {
          recipients_count: phoneNumbers.length,
          sent: results.sent,
          failed: results.failed
        };
      } else {
        throw new Error(`Unsupported SMS command: ${command}`);
      }
      break;
    }

    default:
      throw new Error(`Unsupported tool: ${tool}`);
  }

  return {
    beforeState,
    afterState: { ...beforeState, executed: true },
    output
  };
}

/**
 * Execute query action
 * @param {object} action - Action object
 * @param {string} businessId - Business UUID
 * @returns {Promise<object>} - Execution result
 */
async function executeQuery(action, businessId) {
  const { target, operation } = action;

  let output = null;

  switch (target) {
    case 'business_status': {
      // Get current business/profile status
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('business_id', businessId)
        .eq('status', 'active')
        .single();

      output = {
        status: profile?.structured_fields?.status || 'open',
        hours: profile?.structured_fields?.hours || {},
        last_updated: profile?.updated_at
      };
      break;
    }

    default:
      throw new Error(`Unsupported query target: ${target}`);
  }

  return {
    beforeState: null,
    afterState: null,
    output
  };
}

/**
 * Execute menu update action
 * @param {object} action - Action object
 * @param {string} businessId - Business UUID
 * @param {string} userId - User UUID
 * @returns {Promise<object>} - Execution result
 */
async function executeMenuUpdate(action, businessId, userId) {
  const { operation, item_name, item_id, updates } = action;

  let menuItem = null;
  let beforeState = null;

  // Find menu item by name or ID
  if (item_id) {
    const { data } = await supabase
      .from('menu_items')
      .select('*')
      .eq('id', item_id)
      .eq('business_id', businessId)
      .single();
    menuItem = data;
  } else if (item_name) {
    // Fuzzy search
    const { data: items } = await supabase
      .from('menu_items')
      .select('*')
      .eq('business_id', businessId)
      .ilike('name', `%${item_name}%`)
      .limit(5);

    if (items && items.length > 0) {
      // Sort by best match
      const sorted = items.sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        const searchLower = item_name.toLowerCase();

        if (aLower === searchLower) return -1;
        if (bLower === searchLower) return 1;
        if (aLower.startsWith(searchLower)) return -1;
        if (bLower.startsWith(searchLower)) return 1;
        return 0;
      });

      menuItem = sorted[0];
    }
  }

  if (!menuItem) {
    throw new Error(`Menu item not found: ${item_name || item_id}`);
  }

  beforeState = { ...menuItem };

  let output = null;

  switch (operation) {
    case 'update_price': {
      const { data: updated, error } = await supabase
        .from('menu_items')
        .update({
          price: updates.price,
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('id', menuItem.id)
        .select()
        .single();

      if (error) throw error;

      output = {
        item_id: menuItem.id,
        item_name: menuItem.name,
        old_price: menuItem.price,
        new_price: updates.price
      };

      return {
        beforeState,
        afterState: updated,
        output
      };
    }

    case 'mark_sold_out': {
      const { data: updated, error } = await supabase
        .from('menu_items')
        .update({
          sold_out: true,
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('id', menuItem.id)
        .select()
        .single();

      if (error) throw error;

      output = {
        item_id: menuItem.id,
        item_name: menuItem.name,
        sold_out: true
      };

      return {
        beforeState,
        afterState: updated,
        output
      };
    }

    case 'mark_available': {
      const { data: updated, error } = await supabase
        .from('menu_items')
        .update({
          sold_out: false,
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('id', menuItem.id)
        .select()
        .single();

      if (error) throw error;

      output = {
        item_id: menuItem.id,
        item_name: menuItem.name,
        sold_out: false
      };

      return {
        beforeState,
        afterState: updated,
        output
      };
    }

    case 'update_description': {
      const { data: updated, error } = await supabase
        .from('menu_items')
        .update({
          description: updates.description,
          updated_by: userId,
          updated_at: new Date().toISOString()
        })
        .eq('id', menuItem.id)
        .select()
        .single();

      if (error) throw error;

      output = {
        item_id: menuItem.id,
        item_name: menuItem.name,
        old_description: menuItem.description,
        new_description: updates.description
      };

      return {
        beforeState,
        afterState: updated,
        output
      };
    }

    case 'add_item': {
      const { data: newItem, error } = await supabase
        .from('menu_items')
        .insert({
          business_id: businessId,
          created_by: userId,
          updated_by: userId,
          name: updates.name,
          description: updates.description || null,
          price: updates.price || null,
          category: updates.category || 'other',
          tags: updates.tags || [],
          available: true,
          sold_out: false
        })
        .select()
        .single();

      if (error) throw error;

      output = {
        item_id: newItem.id,
        item_name: newItem.name,
        added: true
      };

      return {
        beforeState: null,
        afterState: newItem,
        output
      };
    }

    default:
      throw new Error(`Unsupported menu operation: ${operation}`);
  }
}

/**
 * Set nested value in object
 * @param {object} obj - Object to update
 * @param {array} path - Path array
 * @param {any} value - Value to set
 */
function setNestedValue(obj, path, value) {
  let current = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }

  current[path[path.length - 1]] = value;
}

/**
 * Calculate diff between before and after state
 * @param {object} before - Before state
 * @param {object} after - After state
 * @returns {object} - Diff
 */
function calculateDiff(before, after) {
  if (!before || !after) return null;

  const diff = {};

  // Simple diff for top-level changes
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diff[key] = {
        before: before[key],
        after: after[key]
      };
    }
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * Confirm action plan (for actions requiring confirmation)
 * @param {string} actionPlanId - Action plan UUID
 * @param {string} businessId - Business UUID
 * @returns {Promise<boolean>} - Success
 */
export async function confirmActionPlan(actionPlanId, businessId) {
  try {
    const { data: plan, error } = await supabase
      .from('action_plans')
      .update({
        confirmed: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', actionPlanId)
      .eq('business_id', businessId)
      .select()
      .single();

    if (error || !plan) {
      throw new Error('Action plan not found');
    }

    logger.info(`Action plan ${actionPlanId} confirmed`);

    return true;
  } catch (error) {
    logger.error('Confirm action plan error:', error);
    throw error;
  }
}

export default {
  executeActionPlan,
  confirmActionPlan
};
