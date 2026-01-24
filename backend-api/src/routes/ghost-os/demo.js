// ============================================
// Ghost OS Public Demo System
// ============================================

import express from 'express';
import { supabaseAdmin as supabase } from '../../config/database.js';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================
// POST /api/ghost-demo/signup
// Public demo signup form
// ============================================

router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, sms_consent } = req.body;

    // Validate
    if (!name || !email || !phone || !sms_consent) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required and SMS consent must be given'
      });
    }

    // Format phone number (ensure E.164 format)
    const cleanPhone = phone.replace(/\D/g, '');
    let formattedPhone;
    if (cleanPhone.length === 10) {
      formattedPhone = `+1${cleanPhone}`;
    } else if (cleanPhone.length === 11 && cleanPhone[0] === '1') {
      formattedPhone = `+${cleanPhone}`;
    } else {
      formattedPhone = phone;
    }

    // Check if user already in queue
    const { data: existingQueue } = await supabase
      .from('demo_queue')
      .select('*')
      .eq('phone', formattedPhone)
      .eq('status', 'waiting')
      .single();

    if (existingQueue) {
      return res.json({
        success: true,
        message: 'You are already in the queue',
        position_in_queue: existingQueue.position_in_queue,
        estimated_wait_minutes: existingQueue.position_in_queue
      });
    }

    // Get current queue size
    const { count } = await supabase
      .from('demo_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'waiting');

    const positionInQueue = (count || 0) + 1;

    // Add to demo queue
    const { data: queueEntry, error } = await supabase
      .from('demo_queue')
      .insert({
        name,
        email,
        phone: formattedPhone,
        sms_consent,
        position_in_queue: positionInQueue,
        status: 'waiting',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Send SMS confirmation
    try {
      const queueMessage = positionInQueue === 1
        ? "You're next! You'll receive a call from Ghost OS in about 1 minute."
        : `You're #${positionInQueue} in line for your Ghost OS demo. We'll text you when it's your turn!`;

      await twilioClient.messages.create({
        body: `👻 Ghost OS Demo\n\nHi ${name}! ${queueMessage}\n\nExpected wait: ~${positionInQueue} minute${positionInQueue !== 1 ? 's' : ''}.`,
        from: process.env.TWILIO_DEMO_NUMBER,
        to: formattedPhone
      });
    } catch (smsError) {
      console.error('Failed to send SMS:', smsError);
      // Don't fail the request if SMS fails
    }

    // If this is the first person, trigger the call immediately
    if (positionInQueue === 1) {
      // Trigger call after 5 seconds
      setTimeout(() => {
        processNextInQueue();
      }, 5000);
    }

    res.json({
      success: true,
      message: 'Added to demo queue successfully',
      position_in_queue: positionInQueue,
      estimated_wait_minutes: positionInQueue,
      queue_id: queueEntry.id
    });

  } catch (error) {
    console.error('Demo signup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add to demo queue'
    });
  }
});

// ============================================
// Process Next Person in Queue
// ============================================

async function processNextInQueue() {
  try {
    // Get next person in queue
    const { data: nextPerson } = await supabase
      .from('demo_queue')
      .select('*')
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (!nextPerson) {
      console.log('No one in queue');
      return;
    }

    console.log(`Calling next person: ${nextPerson.name} at ${nextPerson.phone}`);

    // Update status to 'calling'
    await supabase
      .from('demo_queue')
      .update({ status: 'calling', called_at: new Date().toISOString() })
      .eq('id', nextPerson.id);

    // Send "Your turn!" SMS
    try {
      await twilioClient.messages.create({
        body: `👻 It's your turn! Calling you now at ${nextPerson.phone}. Get ready for your 1-minute Ghost OS demo!`,
        from: process.env.TWILIO_DEMO_NUMBER,
        to: nextPerson.phone
      });
    } catch (smsError) {
      console.error('Failed to send "your turn" SMS:', smsError);
    }

    // Make outbound call to user
    const call = await twilioClient.calls.create({
      url: `${process.env.API_BASE_URL}/api/ghost-demo/incoming?name=${encodeURIComponent(nextPerson.name)}&queue_id=${nextPerson.id}`,
      to: nextPerson.phone,
      from: process.env.TWILIO_DEMO_NUMBER,
      statusCallback: `${process.env.API_BASE_URL}/api/ghost-demo/call-status`,
      statusCallbackEvent: ['completed'],
      timeout: 30 // Ring for 30 seconds
    });

    console.log(`Call initiated: ${call.sid}`);

    // Update with call SID
    await supabase
      .from('demo_queue')
      .update({ call_sid: call.sid })
      .eq('id', nextPerson.id);

  } catch (error) {
    console.error('Error processing queue:', error);
  }
}

// ============================================
// POST /api/ghost-demo/incoming
// Twilio webhook when demo call connects
// ============================================

router.post('/incoming', async (req, res) => {
  const { name, queue_id } = req.query;
  const twiml = new twilio.twiml.VoiceResponse();

  // Personal greeting
  const greeting = `<speak>
    Hello <emphasis>${name || 'there'}</emphasis>!
    Welcome to <emphasis>Ghost OS</emphasis>.

    I'm your AI assistant. For the next <emphasis>one minute</emphasis>,
    you can ask me anything. Try asking about the weather,
    your calendar, or what Ghost OS can do!

    Go ahead, what would you like to know?
  </speak>`;

  twiml.say({
    voice: 'Polly.Joanna'
  }, greeting);

  // Listen for user's question with 1 minute timeout
  twiml.gather({
    input: 'speech',
    timeout: 3,
    speechTimeout: 'auto',
    action: `/api/ghost-demo/respond?name=${encodeURIComponent(name)}&queue_id=${queue_id}&time_left=60`,
    method: 'POST'
  });

  // If no input
  twiml.say({
    voice: 'Polly.Joanna'
  }, "I didn't catch that. Feel free to ask me anything!");

  twiml.redirect(`/api/ghost-demo/respond?name=${encodeURIComponent(name)}&queue_id=${queue_id}&time_left=60`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ============================================
// POST /api/ghost-demo/respond
// Handle demo conversation (1 minute limit)
// ============================================

router.post('/respond', async (req, res) => {
  const { name, queue_id, time_left: timeLeftStr, interview_mode: interviewModeStr, question_num: questionNumStr } = req.query;
  const { SpeechResult } = req.body;
  const timeLeft = parseInt(timeLeftStr) || 60;
  const interviewMode = interviewModeStr === 'true';
  const questionNum = parseInt(questionNumStr) || 0;

  const twiml = new twilio.twiml.VoiceResponse();

  // Check if demo time expired - switch to interview mode
  if (timeLeft <= 5 && !interviewMode) {
    const transition = `<speak>
      ${name}, that was just a taste of what Ghost OS can do!

      Before you go, I have a few quick questions to help me understand
      how Ghost OS could help YOUR business specifically.

      This will only take a minute. Sound good?
    </speak>`;

    twiml.say({ voice: 'Polly.Joanna' }, transition);

    // Wait for response
    twiml.gather({
      input: 'speech',
      timeout: 3,
      speechTimeout: 'auto',
      action: `/api/ghost-demo/interview?name=${encodeURIComponent(name)}&queue_id=${queue_id}&question=0`,
      method: 'POST'
    });

    // If no response, start interview anyway
    twiml.redirect(`/api/ghost-demo/interview?name=${encodeURIComponent(name)}&queue_id=${queue_id}&question=0`);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  if (SpeechResult) {
    console.log(`Demo user ${name} said: ${SpeechResult}`);

    // Simple demo responses
    let response = '';
    const query = SpeechResult.toLowerCase();

    if (query.includes('weather')) {
      response = `The weather today is sunny and 72 degrees. Ghost OS can check weather,
                  calendars, emails, and control your connected apps - all by voice!`;
    } else if (query.includes('calendar') || query.includes('schedule')) {
      response = `I can check your Google Calendar, add events, and remind you of meetings.
                  Connect your calendar to get started!`;
    } else if (query.includes('email')) {
      response = `I can read your emails, send messages, and manage your inbox hands-free.
                  Just connect your Gmail or Outlook account!`;
    } else if (query.includes('what can you do') || query.includes('capabilities')) {
      response = `I can control Gmail, Shopify, Stripe, calendars, and more - all by voice.
                  Think of me as Siri, but for your business apps!`;
    } else if (query.includes('price') || query.includes('cost') || query.includes('how much')) {
      response = `Ghost OS starts at just $50 per month. You get 100 credits,
                  which is about 200 minutes of calls. Visit our website to sign up!`;
    } else {
      response = `That's a great question! Ghost OS can do that and much more.
                  With full access, you can control all your business tools by voice.`;
    }

    twiml.say({ voice: 'Polly.Joanna' }, response);

    // Ask for another question
    const newTimeLeft = timeLeft - 15; // Estimate 15 seconds per exchange

    if (newTimeLeft > 10) {
      twiml.say({
        voice: 'Polly.Joanna'
      }, `You have about ${Math.floor(newTimeLeft / 10) * 10} seconds left. What else would you like to know?`);

      twiml.gather({
        input: 'speech',
        timeout: 3,
        speechTimeout: 'auto',
        action: `/api/ghost-demo/respond?name=${encodeURIComponent(name)}&queue_id=${queue_id}&time_left=${newTimeLeft}`,
        method: 'POST'
      });
    } else {
      // Time's up
      twiml.say({
        voice: 'Polly.Joanna'
      }, `Thank you for trying Ghost OS, ${name}! Text SIGNUP to this number to get started!`);
      twiml.hangup();

      // Mark completed
      await supabase
        .from('demo_queue')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', queue_id);

      // Process next
      setTimeout(() => processNextInQueue(), 2000);
    }

  } else {
    twiml.say({
      voice: 'Polly.Joanna'
    }, "I didn't hear anything. Try asking me about the weather or what Ghost OS can do!");

    twiml.gather({
      input: 'speech',
      timeout: 3,
      action: `/api/ghost-demo/respond?name=${encodeURIComponent(name)}&queue_id=${queue_id}&time_left=${timeLeft}`,
      method: 'POST'
    });
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ============================================
// POST /api/ghost-demo/call-status
// Twilio callback when call ends
// ============================================

router.post('/call-status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  console.log(`Demo call ${CallSid} ended with status: ${CallStatus}, duration: ${CallDuration}s`);

  // Update demo queue entry
  const { data: queueEntry } = await supabase
    .from('demo_queue')
    .select('*')
    .eq('call_sid', CallSid)
    .single();

  if (queueEntry && queueEntry.status !== 'completed') {
    await supabase
      .from('demo_queue')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        call_duration: parseInt(CallDuration)
      })
      .eq('call_sid', CallSid);

    // Send thank you SMS
    try {
      await twilioClient.messages.create({
        body: `Thanks for trying Ghost OS! 🎉\n\nReady for unlimited access? Text SIGNUP or visit ghostos.ai to get started.\n\nQuestions? Reply to this message anytime!`,
        from: process.env.TWILIO_DEMO_NUMBER,
        to: queueEntry.phone
      });
    } catch (error) {
      console.error('Failed to send thank you SMS:', error);
    }

    // Process next person in queue after 5 second delay
    setTimeout(() => {
      processNextInQueue();
    }, 5000);
  }

  res.sendStatus(200);
});

// ============================================
// GET /api/ghost-demo/queue-status
// Get current queue status (for admin)
// ============================================

router.get('/queue-status', async (req, res) => {
  try {
    const { data: waiting } = await supabase
      .from('demo_queue')
      .select('*')
      .eq('status', 'waiting')
      .order('created_at', { ascending: true });

    const { data: calling } = await supabase
      .from('demo_queue')
      .select('*')
      .eq('status', 'calling')
      .order('called_at', { ascending: false })
      .limit(1);

    const { count: totalToday } = await supabase
      .from('demo_queue')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', new Date().toISOString().split('T')[0]);

    res.json({
      success: true,
      queue_length: waiting?.length || 0,
      waiting_users: waiting || [],
      currently_calling: calling?.[0] || null,
      total_demos_today: totalToday || 0
    });

  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ success: false, error: 'Failed to get queue status' });
  }
});

// ============================================
// POST /api/ghost-demo/interview
// AI-powered sales interview after demo
// ============================================

router.post('/interview', async (req, res) => {
  const { name, queue_id, question: questionNumStr } = req.query;
  const { SpeechResult } = req.body;
  const questionNum = parseInt(questionNumStr) || 0;

  const twiml = new twilio.twiml.VoiceResponse();

  // Interview questions (progressive qualification)
  const questions = [
    {
      ask: `<speak>
        Great! First question: What type of business do you run?
        For example, are you in retail, restaurants, professional services, or something else?
      </speak>`,
      field: 'business_type'
    },
    {
      ask: `<speak>
        Perfect! And how many hours per week would you say you spend on
        repetitive tasks like checking emails, scheduling, or managing orders?
      </speak>`,
      field: 'hours_spent_on_tasks'
    },
    {
      ask: `<speak>
        I see. Now, which of these would help your business the most:
        Managing customer communications, tracking sales and inventory,
        or automating appointment scheduling?
      </speak>`,
      field: 'biggest_pain_point'
    },
    {
      ask: `<speak>
        That's really helpful. Last question:
        If Ghost OS could save you 10 to 20 hours per week,
        what would that time savings be worth to you per month?
      </speak>`,
      field: 'value_estimate'
    }
  ];

  // Store the answer from previous question
  if (SpeechResult && questionNum > 0) {
    const previousQuestion = questions[questionNum - 1];

    // Store answer in database
    await supabase
      .from('demo_queue')
      .update({
        interview_data: {
          [previousQuestion.field]: SpeechResult
        }
      })
      .eq('id', queue_id);
  }

  // Check if interview complete
  if (questionNum >= questions.length) {
    // Interview done - deliver personalized pitch
    const { data: demoData } = await supabase
      .from('demo_queue')
      .select('interview_data')
      .eq('id', queue_id)
      .single();

    const interviewAnswers = demoData?.interview_data || {};

    // Personalized closing based on their answers
    const businessType = interviewAnswers.business_type || 'your business';
    const painPoint = interviewAnswers.biggest_pain_point || 'your daily operations';
    const valueEstimate = interviewAnswers.value_estimate || '500 dollars';

    const personalizedPitch = `<speak>
      Thank you ${name}! Based on what you shared,
      Ghost OS would be perfect for ${businessType}.

      <break time="0.5s"/>

      Here's what I recommend:

      <break time="0.3s"/>

      Our Professional Plan at just $99 per month gives you unlimited voice calls,
      connects to all your business tools, and works 24/7.

      <break time="0.5s"/>

      You mentioned ${painPoint} is your biggest challenge.
      Ghost OS handles that automatically - saving you hours every single day.

      <break time="0.5s"/>

      Plus, with your time valued at around ${valueEstimate} per month in savings,
      Ghost OS pays for itself in the first week!

      <break time="0.5s"/>

      I'm texting you a special demo discount code right now.
      Sign up in the next 24 hours and get 50% off your first 3 months.

      <break time="0.5s"/>

      That's just $49 per month to get started.

      <break time="0.5s"/>

      Questions? Just text HELP to this number anytime.

      Thanks for trying Ghost OS, ${name}! Talk soon!
    </speak>`;

    twiml.say({ voice: 'Polly.Joanna' }, personalizedPitch);
    twiml.hangup();

    // Mark as completed with interview data
    await supabase
      .from('demo_queue')
      .update({
        status: 'completed_with_interview',
        completed_at: new Date().toISOString()
      })
      .eq('id', queue_id);

    // Send personalized follow-up SMS
    try {
      const { data: demoUser } = await supabase
        .from('demo_queue')
        .select('*')
        .eq('id', queue_id)
        .single();

      const discountCode = `DEMO${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      await twilioClient.messages.create({
        body: `Hi ${name}! 🎉

Ghost OS Special Offer:
50% OFF for 3 months!

Your Code: ${discountCode}
Valid: 24 hours

Professional Plan:
✓ Unlimited voice calls
✓ All integrations
✓ 24/7 AI assistant
✓ Priority support

Was: $99/mo → Now: $49/mo

Sign up: ghostos.ai/signup?code=${discountCode}

Questions? Reply to this message!

- Your Ghost OS Team`,
        from: process.env.TWILIO_DEMO_NUMBER,
        to: demoUser.phone
      });

      // Store discount code
      await supabase
        .from('demo_queue')
        .update({
          discount_code: discountCode,
          discount_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })
        .eq('id', queue_id);

    } catch (error) {
      console.error('Failed to send discount SMS:', error);
    }

    // Process next person
    setTimeout(() => processNextInQueue(), 2000);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Ask next question
  const currentQuestion = questions[questionNum];
  twiml.say({ voice: 'Polly.Joanna' }, currentQuestion.ask);

  // Listen for answer
  twiml.gather({
    input: 'speech',
    timeout: 5,
    speechTimeout: 'auto',
    action: `/api/ghost-demo/interview?name=${encodeURIComponent(name)}&queue_id=${queue_id}&question=${questionNum + 1}`,
    method: 'POST'
  });

  // If no answer, repeat question once
  twiml.say({
    voice: 'Polly.Joanna'
  }, "I didn't catch that. Let me ask again.");

  twiml.redirect(`/api/ghost-demo/interview?name=${encodeURIComponent(name)}&queue_id=${queue_id}&question=${questionNum}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Manual trigger to process queue (for testing)
router.post('/process-queue', async (req, res) => {
  await processNextInQueue();
  res.json({ success: true, message: 'Queue processing triggered' });
});

// ============================================
// GET /api/ghost-demo/completed-today
// Get completed demos with interview data (admin only)
// ============================================

router.get('/completed-today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: completed } = await supabase
      .from('demo_queue')
      .select('*')
      .in('status', ['completed', 'completed_with_interview'])
      .gte('created_at', today)
      .order('completed_at', { ascending: false });

    res.json({
      success: true,
      completed: completed || []
    });

  } catch (error) {
    console.error('Error getting completed demos:', error);
    res.status(500).json({ success: false, error: 'Failed to get completed demos' });
  }
});

// ============================================
// GET /api/ghost-demo/config
// Get demo configuration (admin only)
// ============================================

router.get('/config', async (req, res) => {
  try {
    const { data: config } = await supabase
      .from('demo_config')
      .select('*')
      .single();

    res.json({
      success: true,
      config: config || {
        demo_enabled: true,
        demo_number: '',
        max_queue_size: 100,
        demo_duration_seconds: 60
      }
    });

  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({ success: false, error: 'Failed to get config' });
  }
});

// ============================================
// PUT /api/ghost-demo/config
// Update demo configuration (admin only)
// ============================================

router.put('/config', async (req, res) => {
  try {
    const {
      demo_number,
      demo_enabled,
      max_queue_size,
      demo_duration_seconds
    } = req.body;

    const updates = {
      updated_at: new Date().toISOString()
    };

    if (demo_number !== undefined) updates.demo_number = demo_number;
    if (demo_enabled !== undefined) updates.demo_enabled = demo_enabled;
    if (max_queue_size !== undefined) updates.max_queue_size = max_queue_size;
    if (demo_duration_seconds !== undefined) updates.demo_duration_seconds = demo_duration_seconds;

    const { data, error } = await supabase
      .from('demo_config')
      .update(updates)
      .eq('id', (await supabase.from('demo_config').select('id').single()).data.id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: 'Configuration updated successfully',
      config: data
    });

  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({ success: false, error: 'Failed to update config' });
  }
});

export default router;
