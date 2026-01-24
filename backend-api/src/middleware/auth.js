import jwt from 'jsonwebtoken';
import { supabase } from '../config/database.js';
import logger from '../config/logger.js';

/**
 * Middleware to verify JWT token and attach user to request
 */
export async function authenticateToken(req, res, next) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user from database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, role, is_active, business_id')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    // Check if user is active
    if (user.is_active !== true) {
      return res.status(403).json({
        success: false,
        error: 'Account is suspended or inactive'
      });
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }

    logger.error('Auth middleware error:', err);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
}

/**
 * Middleware to check if user is admin
 */
export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    });
  }
  next();
}

/**
 * Middleware to check if user owns the business
 */
export async function requireBusinessOwner(req, res, next) {
  try {
    const businessId = req.params.businessId || req.body.business_id;

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: 'Business ID required'
      });
    }

    // Check if user owns this business or is admin
    if (req.user.role === 'admin') {
      return next();
    }

    const { data: business, error } = await supabase
      .from('businesses')
      .select('owner_id')
      .eq('id', businessId)
      .single();

    if (error || !business) {
      return res.status(404).json({
        success: false,
        error: 'Business not found'
      });
    }

    if (business.owner_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this business'
      });
    }

    next();
  } catch (err) {
    logger.error('Business owner check error:', err);
    return res.status(500).json({
      success: false,
      error: 'Authorization failed'
    });
  }
}

/**
 * Optional auth - doesn't fail if no token, just doesn't attach user
 */
export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user } = await supabase
      .from('users')
      .select('id, email, role, is_active, business_id')
      .eq('id', decoded.userId)
      .single();

    if (user && user.is_active === true) {
      req.user = user;
    }

    next();
  } catch (err) {
    // Silently fail for optional auth
    next();
  }
}

// Export aliases for backwards compatibility
export const authenticate = authenticateToken;
export const requireRole = (role) => (req, res, next) => {
  if (req.user.role !== role) {
    return res.status(403).json({
      success: false,
      error: `${role} access required`
    });
  }
  next();
};

export default { authenticateToken, requireAdmin, requireBusinessOwner, optionalAuth, authenticate, requireRole };
