/**
 * ADMIN AUTH ROUTES
 * Handles admin login and authentication
 */

import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Admin credentials (in production, store in database with hashed passwords)
const ADMIN_USERS = [
  {
    username: 'admin',
    password: 'admin123', // Change this!
    email: 'admin@cybercheck.com',
    name: 'Admin User'
  }
];

// Admin login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Find admin user
    const admin = ADMIN_USERS.find(
      u => u.username === username && u.password === password
    );

    if (!admin) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        username: admin.username,
        email: admin.email,
        role: 'admin'
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      email: admin.email,
      name: admin.name
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verify admin token middleware
export function verifyAdminToken(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    if (decoded.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid token'
    });
  }
}

export default router;
