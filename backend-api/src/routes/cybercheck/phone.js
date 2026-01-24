import express from 'express';
import { query, validationResult } from 'express-validator';
import {
  handleIncomingCall,
  handleRecordingComplete,
  getCallDetails,
  getBusinessCalls,
  getCallStats
} from '../../services/phone.service.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import logger from '../../config/logger.js';

const router = express.Router();

/**
 * POST /api/phone/webhook
 * Handle incoming calls from Twilio
 * This endpoint receives Twilio Voice webhooks
 */
router.post('/webhook',
  [
    query('business_id').isUUID().withMessage('Invalid business ID')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).type('text/xml').send(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request</Say><Hangup/></Response>'
        );
      }

      const businessId = req.query.business_id;
      const callSid = req.body.CallSid;
      const from = req.body.From;
      const callStatus = req.body.CallStatus;

      logger.info(`Incoming call webhook: ${callSid} from ${from} for business: ${businessId}`);

      // Generate TwiML response
      const twiml = await handleIncomingCall(businessId, callSid, from);

      res.type('text/xml');
      res.send(twiml);
    } catch (error) {
      logger.error('Phone webhook error:', error);

      // Return error TwiML
      res.type('text/xml');
      res.send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are experiencing technical difficulties. Please try again later.</Say><Hangup/></Response>'
      );
    }
  }
);

/**
 * POST /api/phone/recording-complete
 * Handle recording complete callback from Twilio
 */
router.post('/recording-complete',
  [
    query('business_id').isUUID().withMessage('Invalid business ID'),
    query('call_sid').notEmpty().withMessage('Call SID required')
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

      const businessId = req.query.business_id;
      const callSid = req.query.call_sid;
      const recordingUrl = req.body.RecordingUrl;
      const recordingDuration = parseInt(req.body.RecordingDuration);

      logger.info(`Recording complete: ${callSid}, duration: ${recordingDuration}s`);

      // Process recording asynchronously (don't wait for AI processing)
      handleRecordingComplete(businessId, callSid, recordingUrl, recordingDuration)
        .catch(error => {
          logger.error('Recording processing error:', error);
        });

      // Respond immediately to Twilio
      res.type('text/xml');
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (error) {
      logger.error('Recording complete callback error:', error);
      res.type('text/xml');
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  }
);

/**
 * POST /api/phone/recording-status
 * Handle recording status callback from Twilio
 */
router.post('/recording-status',
  async (req, res) => {
    try {
      const recordingSid = req.body.RecordingSid;
      const recordingStatus = req.body.RecordingStatus;

      logger.info(`Recording status: ${recordingSid} - ${recordingStatus}`);

      res.json({ received: true });
    } catch (error) {
      logger.error('Recording status callback error:', error);
      res.json({ received: false });
    }
  }
);

/**
 * POST /api/phone/forward-complete
 * Handle call forward completion
 */
router.post('/forward-complete',
  async (req, res) => {
    try {
      const dialCallStatus = req.body.DialCallStatus;

      logger.info(`Call forward complete: ${dialCallStatus}`);

      res.type('text/xml');
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (error) {
      logger.error('Forward complete callback error:', error);
      res.type('text/xml');
      res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  }
);

/**
 * GET /api/phone/calls
 * Get phone calls for business
 */
router.get('/calls',
  authenticate,
  [
    query('status').optional().isIn(['ringing', 'in-progress', 'completed', 'failed', 'no-answer']).withMessage('Invalid status'),
    query('start_date').optional().isISO8601().withMessage('Invalid start date'),
    query('end_date').optional().isISO8601().withMessage('Invalid end date'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('offset').optional().isInt({ min: 0 }).withMessage('Invalid offset')
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

      const options = {
        status: req.query.status,
        start_date: req.query.start_date,
        end_date: req.query.end_date,
        limit: req.query.limit ? parseInt(req.query.limit) : 50,
        offset: req.query.offset ? parseInt(req.query.offset) : 0
      };

      const calls = await getBusinessCalls(businessId, options);

      res.json({
        success: true,
        data: calls
      });
    } catch (error) {
      logger.error('Get calls error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get calls'
      });
    }
  }
);

/**
 * GET /api/phone/calls/:call_sid
 * Get call details
 */
router.get('/calls/:call_sid',
  authenticate,
  async (req, res) => {
    try {
      const { call_sid } = req.params;
      const call = await getCallDetails(call_sid);

      // Verify ownership
      if (call.business_id !== req.user.business_id) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }

      res.json({
        success: true,
        data: call
      });
    } catch (error) {
      logger.error('Get call details error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get call details'
      });
    }
  }
);

/**
 * GET /api/phone/stats
 * Get call statistics
 */
router.get('/stats',
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

      // Default to last 30 days
      const endDate = req.query.end_date || new Date().toISOString();
      const startDate = req.query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const stats = await getCallStats(businessId, startDate, endDate);

      res.json({
        success: true,
        data: {
          period: {
            start: startDate,
            end: endDate
          },
          stats
        }
      });
    } catch (error) {
      logger.error('Get call stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get call statistics'
      });
    }
  }
);

export default router;
