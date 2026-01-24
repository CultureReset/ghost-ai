import express from 'express';
import { supabase } from '../../config/supabase.js';
import { authenticateToken } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/tasks
 * Get all tasks for business with filtering and pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      status,
      priority,
      assigned_to,
      contact_id,
      lead_id,
      due_before,
      due_after,
      overdue,
      search,
      sort_by = 'due_at',
      sort_order = 'asc',
      limit = 50,
      offset = 0
    } = req.query;

    let query = supabase
      .from('tasks')
      .select(`
        *,
        contact:contacts(id, first_name, last_name, email),
        lead:leads(id, lead_name, stage),
        assigned_user:users!assigned_to(id, full_name, email),
        created_by_user:users!created_by(id, full_name)
      `, { count: 'exact' })
      .eq('business_id', req.user.business_id);

    // Filters
    if (status) {
      query = query.eq('status', status);
    }

    if (priority) {
      query = query.eq('priority', priority);
    }

    if (assigned_to) {
      query = query.eq('assigned_to', assigned_to);
    }

    if (contact_id) {
      query = query.eq('contact_id', contact_id);
    }

    if (lead_id) {
      query = query.eq('lead_id', lead_id);
    }

    if (due_before) {
      query = query.lte('due_at', due_before);
    }

    if (due_after) {
      query = query.gte('due_at', due_after);
    }

    if (overdue === 'true') {
      query = query.lt('due_at', new Date().toISOString()).neq('status', 'completed');
    }

    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
    }

    // Sorting
    query = query.order(sort_by, { ascending: sort_order === 'asc' });

    // Pagination
    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: tasks, error, count } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: {
        tasks,
        pagination: {
          total: count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    logger.error('Get tasks error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get tasks'
    });
  }
});

/**
 * GET /api/tasks/board
 * Get tasks organized by status for Kanban view
 */
router.get('/board', async (req, res) => {
  try {
    const { assigned_to } = req.query;

    let query = supabase
      .from('tasks')
      .select(`
        *,
        contact:contacts(id, first_name, last_name),
        lead:leads(id, lead_name),
        assigned_user:users!assigned_to(id, full_name)
      `)
      .eq('business_id', req.user.business_id)
      .order('priority_order', { ascending: false })
      .order('due_at', { ascending: true });

    if (assigned_to) {
      query = query.eq('assigned_to', assigned_to);
    }

    const { data: tasks, error } = await query;

    if (error) throw error;

    // Organize by status
    const board = {
      pending: [],
      in_progress: [],
      completed: [],
      cancelled: []
    };

    tasks.forEach(task => {
      const status = task.status || 'pending';
      if (board[status]) {
        board[status].push(task);
      }
    });

    res.json({
      success: true,
      data: {
        board,
        total: tasks.length
      }
    });
  } catch (error) {
    logger.error('Get task board error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task board'
    });
  }
});

/**
 * GET /api/tasks/upcoming
 * Get upcoming tasks due soon
 */
router.get('/upcoming', async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));

    const { data: tasks, error } = await supabase
      .from('tasks')
      .select(`
        *,
        contact:contacts(id, first_name, last_name),
        lead:leads(id, lead_name),
        assigned_user:users!assigned_to(id, full_name)
      `)
      .eq('business_id', req.user.business_id)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .gte('due_at', now.toISOString())
      .lte('due_at', futureDate.toISOString())
      .order('due_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: tasks
    });
  } catch (error) {
    logger.error('Get upcoming tasks error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get upcoming tasks'
    });
  }
});

/**
 * GET /api/tasks/overdue
 * Get overdue tasks
 */
router.get('/overdue', async (req, res) => {
  try {
    const now = new Date().toISOString();

    const { data: tasks, error } = await supabase
      .from('tasks')
      .select(`
        *,
        contact:contacts(id, first_name, last_name),
        lead:leads(id, lead_name),
        assigned_user:users!assigned_to(id, full_name)
      `)
      .eq('business_id', req.user.business_id)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .lt('due_at', now)
      .order('due_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: tasks
    });
  } catch (error) {
    logger.error('Get overdue tasks error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get overdue tasks'
    });
  }
});

/**
 * GET /api/tasks/stats
 * Get task statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { data: tasks, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('business_id', req.user.business_id);

    if (error) throw error;

    const now = new Date();

    const stats = {
      total: tasks.length,
      by_status: {},
      by_priority: {},
      overdue: 0,
      due_today: 0,
      due_this_week: 0,
      completed_this_week: 0
    };

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const endOfWeek = new Date();
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    tasks.forEach(task => {
      // Count by status
      const status = task.status || 'pending';
      stats.by_status[status] = (stats.by_status[status] || 0) + 1;

      // Count by priority
      const priority = task.priority || 'medium';
      stats.by_priority[priority] = (stats.by_priority[priority] || 0) + 1;

      // Count overdue
      if (task.due_at && new Date(task.due_at) < now && task.status !== 'completed' && task.status !== 'cancelled') {
        stats.overdue++;
      }

      // Count due today
      if (task.due_at && new Date(task.due_at) <= endOfToday && new Date(task.due_at) >= now && task.status !== 'completed') {
        stats.due_today++;
      }

      // Count due this week
      if (task.due_at && new Date(task.due_at) <= endOfWeek && new Date(task.due_at) >= now && task.status !== 'completed') {
        stats.due_this_week++;
      }

      // Count completed this week
      if (task.completed_at && new Date(task.completed_at) >= oneWeekAgo) {
        stats.completed_this_week++;
      }
    });

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Get tasks stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task statistics'
    });
  }
});

/**
 * GET /api/tasks/:id
 * Get single task by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: task, error } = await supabase
      .from('tasks')
      .select(`
        *,
        contact:contacts(*),
        lead:leads(*),
        assigned_user:users!assigned_to(id, full_name, email),
        created_by_user:users!created_by(id, full_name, email),
        comments:task_comments(*, user:users(id, full_name))
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    if (!task || task.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Task not found'
      });
    }

    res.json({
      success: true,
      data: task
    });
  } catch (error) {
    logger.error('Get task error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task'
    });
  }
});

/**
 * POST /api/tasks
 * Create new task
 */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      description,
      due_at,
      reminder_at,
      priority = 'medium',
      status = 'todo',
      assigned_to,
      contact_id,
      lead_id
    } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'title is required'
      });
    }

    // Verify related entities if provided
    if (contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('business_id')
        .eq('id', contact_id)
        .single();

      if (!contact || contact.business_id !== req.user.business_id) {
        return res.status(400).json({
          success: false,
          error: 'Invalid contact_id'
        });
      }
    }

    if (lead_id) {
      const { data: lead } = await supabase
        .from('leads')
        .select('business_id')
        .eq('id', lead_id)
        .single();

      if (!lead || lead.business_id !== req.user.business_id) {
        return res.status(400).json({
          success: false,
          error: 'Invalid lead_id'
        });
      }
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        business_id: req.user.business_id,
        title,
        description: description || '',
        due_at: due_at || null,
        reminder_at: reminder_at || null,
        priority,
        priority_order: getPriorityOrder(priority),
        status,
        assigned_to: assigned_to || req.user.id,
        contact_id: contact_id || null,
        lead_id: lead_id || null,
        created_by: req.user.id
      })
      .select(`
        *,
        contact:contacts(id, first_name, last_name),
        lead:leads(id, lead_name),
        assigned_user:users!assigned_to(id, full_name)
      `)
      .single();

    if (error) throw error;

    // Log activity
    await supabase.from('activities').insert({
      business_id: req.user.business_id,
      user_id: req.user.id,
      type: 'task_created',
      description: `Task "${title}" created`,
      metadata: { task_id: task.id }
    });

    logger.info(`Task created: ${task.id} by user: ${req.user.id}`);

    res.status(201).json({
      success: true,
      message: 'Task created successfully',
      data: task
    });
  } catch (error) {
    logger.error('Create task error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create task'
    });
  }
});

/**
 * PUT /api/tasks/:id
 * Update task
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      due_at,
      reminder_at,
      priority,
      status,
      assigned_to,
      contact_id,
      lead_id
    } = req.body;

    // Verify task belongs to business
    const { data: existingTask } = await supabase
      .from('tasks')
      .select('business_id, status')
      .eq('id', id)
      .single();

    if (!existingTask || existingTask.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Task not found'
      });
    }

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (due_at !== undefined) updates.due_at = due_at;
    if (priority !== undefined) {
      updates.priority = priority;
      updates.priority_order = getPriorityOrder(priority);
    }
    if (status !== undefined) {
      updates.status = status;
      if (status === 'completed' && existingTask.status !== 'completed') {
        updates.completed_at = new Date();
      }
    }
    if (assigned_to !== undefined) updates.assigned_to = assigned_to;
    if (contact_id !== undefined) updates.contact_id = contact_id;
    if (lead_id !== undefined) updates.lead_id = lead_id;
    if (reminder_at !== undefined) updates.reminder_at = reminder_at;

    updates.updated_at = new Date();

    const { data: task, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select(`
        *,
        contact:contacts(id, first_name, last_name),
        lead:leads(id, lead_name),
        assigned_user:users!assigned_to(id, full_name)
      `)
      .single();

    if (error) throw error;

    logger.info(`Task updated: ${id} by user: ${req.user.id}`);

    res.json({
      success: true,
      message: 'Task updated successfully',
      data: task
    });
  } catch (error) {
    logger.error('Update task error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update task'
    });
  }
});

/**
 * PATCH /api/tasks/:id/status
 * Quick status update
 */
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'status is required'
      });
    }

    // Verify task belongs to business
    const { data: existingTask } = await supabase
      .from('tasks')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!existingTask || existingTask.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Task not found'
      });
    }

    const updates = {
      status,
      updated_at: new Date()
    };

    if (status === 'completed') {
      updates.completed_at = new Date();
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Task status updated',
      data: task
    });
  } catch (error) {
    logger.error('Update task status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update task status'
    });
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete task
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify task belongs to business
    const { data: existingTask } = await supabase
      .from('tasks')
      .select('business_id, title')
      .eq('id', id)
      .single();

    if (!existingTask || existingTask.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Task not found'
      });
    }

    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', id);

    if (error) throw error;

    logger.info(`Task deleted: ${id} by user: ${req.user.id}`);

    res.json({
      success: true,
      message: 'Task deleted successfully'
    });
  } catch (error) {
    logger.error('Delete task error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete task'
    });
  }
});

/**
 * POST /api/tasks/:id/comments
 * Add comment to task
 */
router.post('/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    if (!comment) {
      return res.status(400).json({
        success: false,
        error: 'comment is required'
      });
    }

    // Verify task belongs to business
    const { data: task } = await supabase
      .from('tasks')
      .select('business_id')
      .eq('id', id)
      .single();

    if (!task || task.business_id !== req.user.business_id) {
      return res.status(404).json({
        success: false,
        error: 'Task not found'
      });
    }

    const { data: taskComment, error } = await supabase
      .from('task_comments')
      .insert({
        task_id: id,
        user_id: req.user.id,
        comment
      })
      .select('*, user:users(id, full_name)')
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      data: taskComment
    });
  } catch (error) {
    logger.error('Add task comment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add comment'
    });
  }
});

// Helper function
function getPriorityOrder(priority) {
  const order = {
    urgent: 4,
    high: 3,
    medium: 2,
    low: 1
  };
  return order[priority] || 2;
}

export default router;
