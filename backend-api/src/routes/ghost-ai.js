import express from 'express';
import twilio from 'twilio';
import { initializeVoiceSession, handleTwilioMediaStream, endVoiceSession, getSessionInfo } from '../services/realtime-voice.service.js';
import logger from '../config/logger.js';

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * GET/POST /api/ghost-ai/voice
 * Handle incoming calls to Ghost AI
 * This is the main Twilio webhook for Ghost AI calls
 */
router.all('/voice', async (req, res) => {
  const params = req.method === 'GET' ? req.query : req.body;
  const callSid = params.CallSid;
  const from = params.From;

  // Initialize session for conversation tracking
  if (callSid && from) {
    await initializeVoiceSession(callSid, from, 'openai');
    logger.info(`Initialized session for call: ${callSid} from ${from}`);
  }

  // Simple version - just answer the call
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, 'Hi! I am Ghost OS. How can I help you today?');

  // Gather speech input
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/ghost-ai/voice-response',
    method: 'POST',
    speechTimeout: '20',
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

    // Get session to retrieve conversation history
    const session = getSessionInfo(callSid);

    // Build conversation messages array
    const messages = [
      {
        role: 'system',
        content: 'You are Ghost OS, a natural conversational AI assistant. Answer questions directly with real, complete information. Be conversational and natural like talking to someone on the phone. Give actual useful answers, not generic responses. Keep responses clear and to the point, but don\'t artificially limit yourself - if a question needs a full answer, give it.'
      }
    ];

    // Add conversation history if session exists
    if (session && session.conversationHistory) {
      // Add previous conversation turns
      session.conversationHistory.forEach(item => {
        messages.push({
          role: item.role === 'user' ? 'user' : 'assistant',
          content: item.content
        });
      });
    }

    // Add current user message
    messages.push({
      role: 'user',
      content: speechResult
    });

    // Use GPT-3.5-turbo to generate response
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      max_tokens: 500
    });

    const aiResponse = completion.choices[0].message.content;

    // Store conversation in session history
    if (session && session.conversationHistory) {
      session.conversationHistory.push({
        role: 'user',
        content: speechResult,
        timestamp: new Date()
      });
      session.conversationHistory.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date()
      });
    }

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
      speechTimeout: '20',
      language: 'en-US'
    });

    gather.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, 'Is there anything else I can help you with?');

    // If no response after timeout, check if user is still there instead of hanging up
    twiml.redirect('/api/ghost-ai/voice-check');

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
 * GET/POST /api/ghost-ai/voice-check
 * Handle silence timeout - check if user is still there
 */
router.all('/voice-check', async (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, 'Are you still there?');

  // Gather speech input with longer timeout
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/ghost-ai/voice-response',
    method: 'POST',
    speechTimeout: '30',
    language: 'en-US'
  });

  // If still no response after this, redirect back to check again (never auto-hangup)
  twiml.redirect('/api/ghost-ai/voice-check');

  res.type('text/xml');
  res.send(twiml.toString());
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
