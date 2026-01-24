import sgMail from '@sendgrid/mail';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@cybercheck.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'CyberCheck';

/**
 * Send email
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @param {string} html - HTML content
 * @returns {Promise<object>} - Send result
 */
export async function sendEmail(to, subject, text, html) {
  if (!process.env.SENDGRID_API_KEY) {
    logger.warn('SendGrid not configured, skipping email');
    return {
      success: false,
      error: 'SendGrid not configured'
    };
  }

  try {
    const msg = {
      to,
      from: {
        email: FROM_EMAIL,
        name: FROM_NAME
      },
      subject,
      text,
      html
    };

    await sgMail.send(msg);

    logger.info(`Email sent to ${to}: ${subject}`);

    return {
      success: true
    };
  } catch (error) {
    logger.error('Email send error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send welcome email to new user
 * @param {string} email - User email
 * @param {string} name - User name
 * @param {string} businessName - Business name
 * @returns {Promise<object>}
 */
export async function sendWelcomeEmail(email, name, businessName) {
  const subject = `Welcome to CyberCheck, ${name}!`;

  const text = `
Hi ${name},

Welcome to CyberCheck! We're excited to have ${businessName} on board.

Here's what you can do with CyberCheck:

🎙️ Voice AI CRM - Turn voice notes into actionable customer data
⭐ Receipt-Verified Reviews - Build trust with verified customer reviews
📱 SMS Notifications - Get instant alerts about new leads and reviews
📞 Phone AI - Let AI handle your inbound calls 24/7

Get Started:
1. Log in to your dashboard: ${process.env.FRONTEND_URL}/dashboard
2. Upload your first voice note
3. Configure your notification settings

Need help? Reply to this email or visit our help center.

Best regards,
The CyberCheck Team
  `;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #fff; padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 10px 10px; }
    .feature { margin: 20px 0; padding: 15px; background: #f7fafc; border-radius: 8px; }
    .feature-icon { font-size: 24px; margin-right: 10px; }
    .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { text-align: center; color: #718096; font-size: 14px; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Welcome to CyberCheck!</h1>
      <p>Hi ${name}, we're excited to have ${businessName} on board.</p>
    </div>
    <div class="content">
      <h2>Here's what you can do with CyberCheck:</h2>

      <div class="feature">
        <span class="feature-icon">🎙️</span>
        <strong>Voice AI CRM</strong> - Turn voice notes into actionable customer data with AI-powered transcription and extraction
      </div>

      <div class="feature">
        <span class="feature-icon">⭐</span>
        <strong>Receipt-Verified Reviews</strong> - Build trust with customers through verified, authentic reviews
      </div>

      <div class="feature">
        <span class="feature-icon">📱</span>
        <strong>SMS Notifications</strong> - Get instant alerts about new leads, reviews, and urgent inquiries
      </div>

      <div class="feature">
        <span class="feature-icon">📞</span>
        <strong>Phone AI</strong> - Let AI handle your inbound calls 24/7, capturing every opportunity
      </div>

      <h3>Get Started:</h3>
      <ol>
        <li>Log in to your dashboard</li>
        <li>Upload your first voice note</li>
        <li>Configure your notification settings</li>
      </ol>

      <a href="${process.env.FRONTEND_URL}/dashboard" class="button">Go to Dashboard</a>

      <div class="footer">
        <p>Need help? Reply to this email or visit our help center.</p>
        <p>Best regards,<br>The CyberCheck Team</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;

  return await sendEmail(email, subject, text, html);
}

/**
 * Send voice note processed notification email
 * @param {string} email - User email
 * @param {object} voiceNote - Voice note data
 * @returns {Promise<object>}
 */
export async function sendVoiceNoteProcessedEmail(email, voiceNote) {
  const subject = '🎙️ Voice Note Processed';

  const contactName = voiceNote.extracted_data?.contact?.first_name || 'Customer';
  const summary = voiceNote.summary || 'Voice note processed successfully';

  const text = `
Your voice note has been processed!

Title: ${voiceNote.title}
Contact: ${contactName}

Summary:
${summary}

View full details in your dashboard:
${process.env.FRONTEND_URL}/dashboard/voice-notes/${voiceNote.id}

Best regards,
CyberCheck
  `;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #667eea;">🎙️ Voice Note Processed</h2>
    <p>Your voice note has been processed!</p>

    <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p><strong>Title:</strong> ${voiceNote.title}</p>
      <p><strong>Contact:</strong> ${contactName}</p>
      <p><strong>Summary:</strong></p>
      <p>${summary}</p>
    </div>

    <a href="${process.env.FRONTEND_URL}/dashboard/voice-notes/${voiceNote.id}"
       style="display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px;">
      View Full Details
    </a>

    <p style="margin-top: 30px; color: #718096; font-size: 14px;">
      Best regards,<br>CyberCheck
    </p>
  </div>
</body>
</html>
  `;

  return await sendEmail(email, subject, text, html);
}

/**
 * Send review notification email
 * @param {string} email - User email
 * @param {object} review - Review data
 * @returns {Promise<object>}
 */
export async function sendReviewNotificationEmail(email, review) {
  const subject = `⭐ New ${review.overall_rating}-Star Review`;

  const stars = '⭐'.repeat(review.overall_rating);
  const verified = review.receipt_verified ? '✅ Receipt Verified' : '';

  const text = `
You received a new ${review.overall_rating}-star review!

Rating: ${stars} (${review.overall_rating}/5)
${verified}

Review:
${review.review_text || 'No text provided'}

View in dashboard:
${process.env.FRONTEND_URL}/dashboard/reviews/${review.id}

Best regards,
CyberCheck
  `;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #f6ad55;">⭐ New ${review.overall_rating}-Star Review</h2>
    <p>You received a new review!</p>

    <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p style="font-size: 24px;">${stars}</p>
      <p><strong>Rating:</strong> ${review.overall_rating}/5</p>
      ${verified ? '<p style="color: #48bb78;"><strong>✅ Receipt Verified</strong></p>' : ''}
      <p><strong>Review:</strong></p>
      <p>${review.review_text || 'No text provided'}</p>
    </div>

    <a href="${process.env.FRONTEND_URL}/dashboard/reviews/${review.id}"
       style="display: inline-block; padding: 12px 30px; background: #f6ad55; color: white; text-decoration: none; border-radius: 6px;">
      View Review
    </a>

    <p style="margin-top: 30px; color: #718096; font-size: 14px;">
      Best regards,<br>CyberCheck
    </p>
  </div>
</body>
</html>
  `;

  return await sendEmail(email, subject, text, html);
}

/**
 * Send daily summary email
 * @param {string} email - User email
 * @param {object} stats - Daily statistics
 * @returns {Promise<object>}
 */
export async function sendDailySummaryEmail(email, stats) {
  const subject = `📊 Daily Summary - ${stats.date}`;

  const text = `
Daily Summary for ${stats.date}

🎙️ Voice Notes: ${stats.voice_notes_count}
⭐ Reviews: ${stats.reviews_count} (Avg: ${stats.avg_rating}/5)
📞 Phone Calls: ${stats.phone_calls_count}
💰 Revenue Impact: $${stats.estimated_revenue}

View full analytics:
${process.env.FRONTEND_URL}/dashboard

Best regards,
CyberCheck
  `;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #667eea;">📊 Daily Summary</h2>
    <p>${stats.date}</p>

    <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <div style="margin: 10px 0;">
        <span style="font-size: 20px;">🎙️</span>
        <strong>Voice Notes:</strong> ${stats.voice_notes_count}
      </div>
      <div style="margin: 10px 0;">
        <span style="font-size: 20px;">⭐</span>
        <strong>Reviews:</strong> ${stats.reviews_count} (Avg: ${stats.avg_rating}/5)
      </div>
      <div style="margin: 10px 0;">
        <span style="font-size: 20px;">📞</span>
        <strong>Phone Calls:</strong> ${stats.phone_calls_count}
      </div>
      <div style="margin: 10px 0;">
        <span style="font-size: 20px;">💰</span>
        <strong>Revenue Impact:</strong> $${stats.estimated_revenue}
      </div>
    </div>

    <a href="${process.env.FRONTEND_URL}/dashboard"
       style="display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px;">
      View Full Analytics
    </a>

    <p style="margin-top: 30px; color: #718096; font-size: 14px;">
      Best regards,<br>CyberCheck
    </p>
  </div>
</body>
</html>
  `;

  return await sendEmail(email, subject, text, html);
}

/**
 * Send payment receipt email
 * @param {string} email - User email
 * @param {object} payment - Payment data
 * @returns {Promise<object>}
 */
export async function sendPaymentReceiptEmail(email, payment) {
  const subject = `Payment Receipt - $${payment.amount}`;

  const text = `
Payment Receipt

Amount: $${payment.amount} ${payment.currency.toUpperCase()}
Date: ${new Date(payment.paid_at).toLocaleDateString()}
Payment Method: ${payment.payment_method || 'Card'}
Invoice ID: ${payment.stripe_invoice_id}

Thank you for your payment!

View invoice:
${process.env.FRONTEND_URL}/dashboard/billing

Best regards,
CyberCheck
  `;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #48bb78;">Payment Receipt</h2>

    <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p><strong>Amount:</strong> $${payment.amount} ${payment.currency.toUpperCase()}</p>
      <p><strong>Date:</strong> ${new Date(payment.paid_at).toLocaleDateString()}</p>
      <p><strong>Payment Method:</strong> ${payment.payment_method || 'Card'}</p>
      <p><strong>Invoice ID:</strong> ${payment.stripe_invoice_id}</p>
    </div>

    <p>Thank you for your payment!</p>

    <a href="${process.env.FRONTEND_URL}/dashboard/billing"
       style="display: inline-block; padding: 12px 30px; background: #48bb78; color: white; text-decoration: none; border-radius: 6px;">
      View Invoice
    </a>

    <p style="margin-top: 30px; color: #718096; font-size: 14px;">
      Best regards,<br>CyberCheck
    </p>
  </div>
</body>
</html>
  `;

  return await sendEmail(email, subject, text, html);
}

/**
 * Send password reset email
 * @param {string} email - User email
 * @param {string} resetToken - Password reset token
 * @returns {Promise<object>}
 */
export async function sendPasswordResetEmail(email, resetToken) {
  const subject = 'Reset Your Password - CyberCheck';

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  const text = `
You requested to reset your password.

Click the link below to reset your password:
${resetUrl}

This link will expire in 1 hour.

If you didn't request this, please ignore this email.

Best regards,
CyberCheck
  `;

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #667eea;">Reset Your Password</h2>
    <p>You requested to reset your password.</p>

    <p>Click the button below to reset your password:</p>

    <a href="${resetUrl}"
       style="display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0;">
      Reset Password
    </a>

    <p><small>This link will expire in 1 hour.</small></p>

    <p style="color: #718096;">If you didn't request this, please ignore this email.</p>

    <p style="margin-top: 30px; color: #718096; font-size: 14px;">
      Best regards,<br>CyberCheck
    </p>
  </div>
</body>
</html>
  `;

  return await sendEmail(email, subject, text, html);
}

export default {
  sendEmail,
  sendWelcomeEmail,
  sendVoiceNoteProcessedEmail,
  sendReviewNotificationEmail,
  sendDailySummaryEmail,
  sendPaymentReceiptEmail,
  sendPasswordResetEmail
};
