import WebSocket from 'ws';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

/**
 * REAL-TIME VOICE AI SERVICE
 * Handles live bidirectional voice conversations with AI providers
 * Supports: OpenAI Realtime API, with extensibility for Grok, Gemini, Perplexity
 */

const OPENAI_REALTIME_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';

// Active sessions: Map<callSid, sessionData>
const activeSessions = new Map();

/**
 * Create a fast in-memory session without database lookups
 * @param {string} callSid - Twilio call SID
 * @param {string} phoneNumber - Caller's phone number
 * @returns {object} - Session data
 */
export function createFastSession(callSid, phoneNumber) {
  const sessionData = {
    callSid,
    phoneNumber,
    aiProvider: 'openai',
    userName: 'there',
    startTime: new Date(),
    conversationHistory: [],
    aiWebSocket: null,
    twilioWebSocket: null
  };

  activeSessions.set(callSid, sessionData);
  logger.info(`Created fast session for call: ${callSid}`);

  return sessionData;
}

// Log API key status on startup
if (!OPENAI_REALTIME_API_KEY) {
  logger.error('❌ CRITICAL: OPENAI_API_KEY environment variable is NOT SET!');
  logger.error('Railway must have OPENAI_API_KEY configured in environment variables');
} else if (OPENAI_REALTIME_API_KEY.startsWith('sk-proj-')) {
  logger.warn('⚠️  WARNING: Using project key (sk-proj-*) - Realtime API requires service account key (sk-svcacct-*)');
} else if (OPENAI_REALTIME_API_KEY.startsWith('sk-svcacct-')) {
  logger.info('✅ OpenAI service account key detected for Realtime API');
} else {
  logger.info(`✅ OpenAI API key configured (starts with: ${OPENAI_REALTIME_API_KEY.substring(0, 10)}...)`);
}

/**
 * Initialize real-time voice session
 * @param {string} callSid - Twilio call SID
 * @param {string} phoneNumber - Caller's phone number
 * @param {string} aiProvider - AI provider (openai, grok, gemini, perplexity)
 * @returns {Promise<object>} - Session initialization result
 */
export async function initializeVoiceSession(callSid, phoneNumber, aiProvider = 'openai') {
  try {
    let preferredAI = aiProvider;
    let userName = 'there';

    // Get user's AI preference from waitlist (if database available)
    if (supabase) {
      try {
        const { data: user, error } = await supabase
          .from('ghost_os_waitlist')
          .select('preferred_ai, name')
          .eq('phone_number', phoneNumber)
          .single();

        if (!error && user) {
          preferredAI = user.preferred_ai || aiProvider;
          userName = user.name || 'there';
        }
      } catch (dbError) {
        logger.warn('Could not fetch user preferences from database:', dbError.message);
        // Continue with defaults
      }
    }

    logger.info(`Initializing voice session for ${callSid} with AI: ${preferredAI}`);

    // Load previous conversation history (last 5 calls)
    let previousHistory = [];
    if (supabase) {
      try {
        const { data: previousCalls } = await supabase
          .from('phone_calls')
          .select('transcript, created_at')
          .eq('from_number', phoneNumber)
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(5);

        if (previousCalls && previousCalls.length > 0) {
          // Parse transcripts and add to history (oldest first)
          previousCalls.reverse().forEach(call => {
            if (call.transcript) {
              const turns = call.transcript.split('\n\n');
              turns.forEach(turn => {
                const colonIndex = turn.indexOf(':');
                if (colonIndex > 0) {
                  const role = turn.substring(0, colonIndex).trim();
                  const content = turn.substring(colonIndex + 1).trim();
                  if (content) {
                    previousHistory.push({
                      role: role === 'assistant' ? 'assistant' : 'user',
                      content: content,
                      timestamp: new Date(call.created_at)
                    });
                  }
                }
              });
            }
          });
          logger.info(`Loaded ${previousHistory.length} previous conversation turns for ${phoneNumber}`);
        }
      } catch (dbError) {
        logger.warn('Could not load conversation history from database:', dbError.message);
        // Continue without history
      }
    }

    // Create session data
    const sessionData = {
      callSid,
      phoneNumber,
      aiProvider: preferredAI,
      userName,
      startTime: new Date(),
      conversationHistory: previousHistory,
      aiWebSocket: null,
      twilioWebSocket: null
    };

    activeSessions.set(callSid, sessionData);

    // Log session start (if database available)
    if (supabase) {
      try {
        await supabase.from('phone_calls').insert({
          call_sid: callSid,
          from_number: phoneNumber,
          status: 'in-progress',
          direction: 'inbound',
          metadata: {
            ai_provider: preferredAI,
            session_type: 'realtime_voice'
          },
          created_at: new Date().toISOString()
        });
      } catch (dbError) {
        logger.warn('Could not log call to database:', dbError.message);
        // Continue anyway - don't let DB errors stop the call
      }
    }

    return {
      success: true,
      callSid,
      aiProvider: preferredAI
    };
  } catch (error) {
    logger.error('Error initializing voice session:', error);
    // Don't throw - return success anyway to keep call alive
    return {
      success: true,
      callSid,
      aiProvider
    };
  }
}

/**
 * Handle Twilio Media Stream connection
 * @param {WebSocket} twilioWs - WebSocket from Twilio Media Stream
 * @param {string} callSid - Twilio call SID
 */
export async function handleTwilioMediaStream(twilioWs, callSid) {
  try {
    let session = activeSessions.get(callSid);

    // If session doesn't exist yet (race condition), create a fast one
    if (!session) {
      logger.warn(`⚠️  No session found for call: ${callSid}, creating fast session`);
      // Extract phone number from callSid if available, or use placeholder
      session = createFastSession(callSid, 'unknown');
    }

    session.twilioWebSocket = twilioWs;
    logger.info(`📞 Twilio Media Stream connected for call: ${callSid}`);

    // Connect to AI provider based on preference
    try {
      if (session.aiProvider === 'openai') {
        await connectOpenAIRealtime(session);
        logger.info(`✅ Successfully initialized OpenAI for call: ${callSid}`);
      } else {
        // For other providers, fall back to OpenAI for now
        // TODO: Add Grok, Gemini, Perplexity realtime support
        logger.warn(`Provider ${session.aiProvider} not yet supported for realtime. Falling back to OpenAI.`);
        await connectOpenAIRealtime(session);
      }
    } catch (aiError) {
      logger.error(`❌ CRITICAL: Failed to connect to OpenAI for call ${callSid}:`, aiError.message);
      logger.error('Stack:', aiError.stack);
      // Don't throw - keep Twilio connection alive even if OpenAI fails
      // The call will stay connected but without AI responses
    }

  } catch (error) {
    logger.error('❌ Error handling Twilio Media Stream:', error);
    logger.error('Stack:', error.stack);
    // Don't throw - keep connection alive
  }
}

/**
 * Connect to OpenAI Realtime API
 * @param {object} session - Session data
 */
async function connectOpenAIRealtime(session) {
  return new Promise((resolve, reject) => {
    try {
      // Validate API key exists
      if (!OPENAI_REALTIME_API_KEY) {
        logger.error('❌ Cannot connect to OpenAI: OPENAI_API_KEY environment variable is not set');
        reject(new Error('OpenAI API key not configured'));
        return;
      }

      logger.info(`🔌 Connecting to OpenAI Realtime API for call: ${session.callSid}`);
      logger.info(`🔑 Using API key: ${OPENAI_REALTIME_API_KEY.substring(0, 15)}...`);
      logger.info(`🌐 URL: ${OPENAI_REALTIME_URL}`);

      // Create WebSocket connection to OpenAI
      const aiWs = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          'Authorization': `Bearer ${OPENAI_REALTIME_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      session.aiWebSocket = aiWs;

      // Set connection timeout
      const connectionTimeout = setTimeout(() => {
        logger.error('❌ OpenAI connection timeout after 10 seconds');
        aiWs.close();
        reject(new Error('OpenAI connection timeout'));
      }, 10000);

    aiWs.on('open', () => {
      clearTimeout(connectionTimeout);
      logger.info(`✅ OpenAI Realtime API CONNECTED for call: ${session.callSid}`);

      // Configure session
      aiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `You are Ghost AI, a helpful and friendly AI assistant. The user's name is ${session.userName}. You're having a phone conversation, so keep responses concise and natural. Remember context from previous parts of the conversation. Be warm, helpful, and conversational.`,
          voice: 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.3,  // Lower = more sensitive to voice (easier to detect)
            prefix_padding_ms: 500,  // Capture more of the start of speech
            silence_duration_ms: 1200  // Wait longer before assuming user is done talking
          },
          temperature: 0.8
        }
      }));

      // Send initial greeting with clear confirmation
      aiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          instructions: `Say exactly: "Hello ${session.userName}, Ghost AI is connected and listening. I can hear you clearly. How can I help you today?"`
        }
      }));

      resolve();
    });

    aiWs.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleOpenAIMessage(session, data);
      } catch (error) {
        logger.error('Error parsing OpenAI message:', error);
      }
    });

    aiWs.on('close', (code, reason) => {
      clearTimeout(connectionTimeout);
      logger.warn(`⚠️  OpenAI connection closed for call: ${session.callSid} - Code: ${code}, Reason: ${reason}`);
    });

    aiWs.on('error', (error) => {
      clearTimeout(connectionTimeout);
      logger.error('❌ OpenAI WebSocket error:', error);
      reject(error);
    });

    } catch (error) {
      clearTimeout(connectionTimeout);
      logger.error('❌ Error creating OpenAI WebSocket:', error);
      reject(error);
    }
  });
}


/**
 * Handle messages from OpenAI Realtime API
 * @param {object} session - Session data
 * @param {object} data - Message data from OpenAI
 */
function handleOpenAIMessage(session, data) {
  switch (data.type) {
    case 'response.audio.delta':
      // Stream audio back to Twilio
      if (session.twilioWebSocket && session.twilioWebSocket.readyState === WebSocket.OPEN) {
        session.twilioWebSocket.send(JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: {
            payload: data.delta
          }
        }));
      }
      break;

    case 'conversation.item.input_audio_transcription.completed':
      // Log user's transcription
      logger.info(`User said: ${data.transcript}`);
      session.conversationHistory.push({
        role: 'user',
        content: data.transcript,
        timestamp: new Date()
      });
      break;

    case 'response.done':
      // Log AI's response
      if (data.response && data.response.output) {
        const aiText = data.response.output
          .filter(item => item.type === 'message')
          .map(item => item.content.map(c => c.text || c.transcript).join(' '))
          .join(' ');

        if (aiText) {
          logger.info(`AI said: ${aiText}`);
          session.conversationHistory.push({
            role: 'assistant',
            content: aiText,
            timestamp: new Date()
          });
        }
      }
      break;

    case 'error':
      logger.error('OpenAI error:', data.error);
      break;

    default:
      // Log other events for debugging
      // logger.debug(`OpenAI event: ${data.type}`);
      break;
  }
}

/**
 * End voice session and cleanup
 * @param {string} callSid - Twilio call SID
 */
export async function endVoiceSession(callSid) {
  try {
    const session = activeSessions.get(callSid);

    if (!session) {
      return;
    }

    logger.info(`Ending voice session for call: ${callSid}`);

    // Close WebSocket connections
    if (session.aiWebSocket) {
      session.aiWebSocket.close();
    }
    if (session.twilioWebSocket) {
      session.twilioWebSocket.close();
    }

    // Calculate duration
    const duration = Math.floor((new Date() - session.startTime) / 1000);

    // Save conversation to database (if available)
    if (supabase) {
      try {
        await supabase
          .from('phone_calls')
          .update({
            status: 'completed',
            duration_seconds: duration,
            transcript: session.conversationHistory.map(item =>
              `${item.role}: ${item.content}`
            ).join('\n\n'),
            metadata: {
              ai_provider: session.aiProvider,
              session_type: 'realtime_voice',
              conversation_turns: session.conversationHistory.length
            },
            updated_at: new Date().toISOString()
          })
          .eq('call_sid', callSid);

        // Track usage
        await supabase.from('usage_records').insert({
          phone_number: session.phoneNumber,
          usage_type: 'realtime_voice_call',
          quantity: 1,
          cost: calculateRealtimeCost(duration),
          date: new Date().toISOString().split('T')[0],
          metadata: {
            call_sid: callSid,
            duration_seconds: duration,
            ai_provider: session.aiProvider,
            conversation_turns: session.conversationHistory.length
          }
        });
      } catch (dbError) {
        logger.warn('Could not save call data to database:', dbError.message);
        // Continue anyway
      }
    }

    // Remove from active sessions
    activeSessions.delete(callSid);

    logger.info(`Voice session ended: ${callSid}, duration: ${duration}s`);

  } catch (error) {
    logger.error('Error ending voice session:', error);
  }
}

/**
 * Calculate cost for realtime voice call
 * @param {number} durationSeconds - Call duration in seconds
 * @returns {number} - Cost in dollars
 */
function calculateRealtimeCost(durationSeconds) {
  const minutes = Math.ceil(durationSeconds / 60);

  // OpenAI Realtime API: ~$0.06/min input, ~$0.24/min output (average ~$0.15/min)
  // Twilio: ~$0.013/min
  // Total: ~$0.163/min
  const costPerMinute = 0.163;

  return minutes * costPerMinute;
}

/**
 * Get active session count
 * @returns {number} - Number of active sessions
 */
export function getActiveSessionCount() {
  return activeSessions.size;
}

/**
 * Get session info
 * @param {string} callSid - Twilio call SID
 * @returns {object|null} - Session data or null
 */
export function getSessionInfo(callSid) {
  return activeSessions.get(callSid) || null;
}

export default {
  createFastSession,
  initializeVoiceSession,
  handleTwilioMediaStream,
  endVoiceSession,
  getActiveSessionCount,
  getSessionInfo
};
