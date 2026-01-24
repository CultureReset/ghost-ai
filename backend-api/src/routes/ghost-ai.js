import express from 'express';
import twilio from 'twilio';
import { initializeVoiceSession, handleTwilioMediaStream, endVoiceSession } from '../services/realtime-voice.service.js';
import logger from '../config/logger.js';

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * GET/POST /api/ghost-ai/voice
 * Handle incoming calls to Ghost AI
 * This is the main Twilio webhook for Ghost AI calls
 */
router.all('/voice', async (req, res) => {
  // Simple version - just answer the call
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, 'Hi! I am Ghost A I. How can I help you today?');

  // Gather speech input
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/ghost-ai/voice-response',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US'
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * WebSocket route for Twilio Media Streams
 * This is upgraded from HTTP to WebSocket by the server
 */
export function setupMediaStreamWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    logger.info('📡 Media Stream WebSocket connection established');

    let callSid = null;
    let sessionInitialized = false;

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        // Extract call SID from start message
        if (data.event === 'start') {
          callSid = data.start.callSid;
          logger.info(`Media stream started for call: ${callSid}`);

          // Initialize Twilio media stream handler
          if (!sessionInitialized) {
            await handleTwilioMediaStream(ws, callSid);
            sessionInitialized = true;
          }
        }

      } catch (error) {
        logger.error('Media Stream message error:', error);
      }
    });

    ws.on('close', () => {
      logger.info(`Media Stream WebSocket closed: ${callSid}`);
      if (callSid) {
        endVoiceSession(callSid);
      }
    });

    ws.on('error', (error) => {
      logger.error('Media Stream WebSocket error:', error);
      if (callSid) {
        endVoiceSession(callSid);
      }
    });
  });

  logger.info('🎙️  Media Stream WebSocket server initialized');
}

/**
 * GET/POST /api/ghost-ai/voice-response
 * Handle speech input and respond with GPT-4
 */
router.all('/voice-response', async (req, res) => {
  try {
    const params = req.method === 'GET' ? req.query : req.body;
    const speechResult = params.SpeechResult;
    const from = params.From;
    const callSid = params.CallSid;

    logger.info(`🎤 Speech from ${from}: ${speechResult}`);

    // Use GPT-4 to generate response
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are Ghost AI, a helpful voice assistant. Keep responses brief and conversational (2-3 sentences max).'
        },
        {
          role: 'user',
          content: speechResult
        }
      ],
      max_tokens: 150
    });

    const aiResponse = completion.choices[0].message.content;

    // Send response back as voice
    const twiml = new VoiceResponse();
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, aiResponse);

    // Ask if they have another question
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/ghost-ai/voice-response',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US'
    });

    gather.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, 'Is there anything else I can help you with?');

    // If no response, say goodbye
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, 'Goodbye!');

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (error) {
    logger.error('Voice response error:', error);

    const twiml = new VoiceResponse();
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, 'Sorry, I had trouble understanding that. Please try again.');
    twiml.redirect('/api/ghost-ai/voice');

    res.type('text/xml');
    res.send(twiml.toString());
  }
});

/**
 * GET/POST /api/ghost-ai/status
 * Handle call status updates
 */
router.all('/status', async (req, res) => {
  try {
    const params = req.method === 'GET' ? req.query : req.body;
    const callSid = params.CallSid;
    const callStatus = params.CallStatus;

    logger.info(`Ghost AI call status: ${callSid} - ${callStatus}`);

    // If call completed or failed, ensure session is ended
    if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'no-answer') {
      await endVoiceSession(callSid);
    }

    res.json({ received: true });

  } catch (error) {
    logger.error('Ghost AI status callback error:', error);
    res.json({ received: false });
  }
});

/**
 * POST /api/ghost-ai/sms
 * Handle incoming SMS messages to Ghost AI
 * Users can text questions and get AI responses via SMS
 */
router.post('/sms', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body;
    const messageSid = req.body.MessageSid;

    logger.info(`📱 Ghost AI SMS from ${from}: ${body}`);

    // Check if this is a waitlist command (JOIN, STATUS, CANCEL, etc.)
    const lowerBody = body.toLowerCase().trim();
    const waitlistCommands = ['join', 'status', 'cancel', 'stop', 'unsubscribe', 'platforms', 'list'];
    const isWaitlistCommand = waitlistCommands.some(cmd => lowerBody.includes(cmd)) ||
                              lowerBody.startsWith('add ') ||
                              lowerBody.match(/\b\d{3}\b/); // Area code

    if (isWaitlistCommand) {
      // Handle through waitlist system
      const { handleWaitlistSMS } = await import('/Users/owner/CLEAN-PLATFORM-BUILD/ghost-os-frontend/ghost-os-waitlist.js');
      await handleWaitlistSMS(from, body, messageSid);
    } else {
      // Handle as AI question - send to OpenAI and reply via SMS
      const { handleAIQuestion } = await import('../services/sms-ai.service.js');
      await handleAIQuestion(from, body, messageSid);
    }

    // Twilio expects empty response (we send SMS async)
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  } catch (error) {
    logger.error('Ghost AI SMS error:', error);

    // Send error message to user
    try {
      const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      await twilioClient.messages.create({
        from: process.env.GHOST_OS_WAITLIST_NUMBER,
        to: req.body.From,
        body: "Sorry, I'm having trouble right now. Please try calling me instead or text again in a moment."
      });
    } catch (sendError) {
      logger.error('Failed to send error SMS:', sendError);
    }

    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

export default router;
