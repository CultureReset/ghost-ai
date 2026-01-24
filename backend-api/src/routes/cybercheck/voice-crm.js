// Phase 5: Voice-Activated CRM Assistant
// Call your AI assistant to manage CRM, get briefings, and get AI advice

import OpenAI from 'openai';

const isOpenAIConfigured = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-key';
const openai = isOpenAIConfigured ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Setup Voice CRM Assistant routes
 */
export function setupVoiceCRMRoutes(app, supabase, twilioClient) {

  // ============================================
  // VOICE-TO-CRM: ADD LEADS VIA PHONE
  // ============================================

  /**
   * Handle incoming voice command to add lead
   * Called by Twilio webhook when admin calls
   */
  app.post('/api/voice/crm/add-lead', async (req, res) => {
    try {
      const { From, SpeechResult } = req.body;

      // Verify it's the admin calling
      if (From !== process.env.ADMIN_PHONE_NUMBER) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Sorry, this feature is only available to authorized users.</Say>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      // Parse the speech into structured lead data using AI
      const leadData = await parseLeadFromSpeech(SpeechResult);

      if (leadData.success) {
        // Save lead to database
        const { data: lead, error } = await supabase
          .from('leads')
          .insert({
            name: leadData.name,
            email: leadData.email,
            phone: leadData.phone,
            company: leadData.company,
            platform: leadData.platform || 'ghost_os',
            source_type: 'voice_assistant',
            status: 'new',
            lead_stage: 'new',
            data: {
              voice_transcript: SpeechResult,
              parsed_by: 'ai',
              notes: leadData.notes
            }
          })
          .select()
          .single();

        if (error) throw error;

        // Log activity
        await supabase.from('lead_activities').insert({
          lead_id: lead.id,
          activity_type: 'lead_created',
          activity_description: 'Lead created via voice assistant',
          performed_by: 'voice_assistant',
          metadata: { transcript: SpeechResult }
        });

        // Respond to caller
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Lead added successfully. ${leadData.name} from ${leadData.company || 'the company'} has been saved to your CRM.</Say>
          </Response>`;

        res.type('text/xml').send(twiml);
      } else {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>I couldn't understand the lead information. Please try again with the name, company, and contact details.</Say>
          </Response>`;
        res.type('text/xml').send(twiml);
      }

    } catch (error) {
      console.error('Voice add lead error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, there was an error adding the lead. Please try again later.</Say>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  // ============================================
  // VOICE-TO-CRM: ADD NOTES VIA PHONE
  // ============================================

  /**
   * Handle incoming voice command to add note to existing lead
   */
  app.post('/api/voice/crm/add-note', async (req, res) => {
    try {
      const { From, SpeechResult } = req.body;

      if (From !== process.env.ADMIN_PHONE_NUMBER) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Sorry, this feature is only available to authorized users.</Say>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      // Parse which lead and what note using AI
      const noteData = await parseNoteFromSpeech(SpeechResult, supabase);

      if (noteData.success && noteData.lead_id) {
        // Add note to lead
        await supabase.from('lead_notes').insert({
          lead_id: noteData.lead_id,
          note_text: noteData.note_text,
          note_type: noteData.note_type || 'general',
          created_by: 'voice_assistant'
        });

        // Log activity
        await supabase.from('lead_activities').insert({
          lead_id: noteData.lead_id,
          activity_type: 'note_added',
          activity_description: 'Note added via voice assistant',
          performed_by: 'voice_assistant'
        });

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Note added to ${noteData.lead_name}.</Say>
          </Response>`;
        res.type('text/xml').send(twiml);
      } else {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>I couldn't find that lead or understand the note. Please try again.</Say>
          </Response>`;
        res.type('text/xml').send(twiml);
      }

    } catch (error) {
      console.error('Voice add note error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, there was an error adding the note.</Say>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  // ============================================
  // DAILY BRIEFING
  // ============================================

  /**
   * Get daily briefing: schedule, meetings, follow-ups, priority tasks
   */
  app.post('/api/voice/crm/daily-briefing', async (req, res) => {
    try {
      const { From } = req.body;

      if (From !== process.env.ADMIN_PHONE_NUMBER) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Sorry, this feature is only available to authorized users.</Say>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      // Get today's important items
      const briefing = await generateDailyBriefing(supabase);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>${briefing}</Say>
        </Response>`;

      res.type('text/xml').send(twiml);

    } catch (error) {
      console.error('Daily briefing error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, I couldn't generate your daily briefing.</Say>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  // ============================================
  // AI ADVISOR
  // ============================================

  /**
   * Get AI advice on a specific deal/lead
   */
  app.post('/api/voice/crm/advisor', async (req, res) => {
    try {
      const { From, SpeechResult } = req.body;

      if (From !== process.env.ADMIN_PHONE_NUMBER) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Sorry, this feature is only available to authorized users.</Say>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      // Parse which lead they're asking about
      const leadInfo = await findLeadFromSpeech(SpeechResult, supabase);

      if (leadInfo.success && leadInfo.lead_id) {
        // Get all context about the lead
        const context = await getLeadContext(leadInfo.lead_id, supabase);

        // Ask AI for advice
        const advice = await getAIAdvice(context, SpeechResult);

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>${advice}</Say>
          </Response>`;
        res.type('text/xml').send(twiml);
      } else {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>I couldn't find that lead. Please try again with the full name or company.</Say>
          </Response>`;
        res.type('text/xml').send(twiml);
      }

    } catch (error) {
      console.error('AI advisor error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, I couldn't generate advice for that lead.</Say>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  // ============================================
  // MAIN VOICE MENU
  // ============================================

  /**
   * Main entry point for voice CRM assistant
   */
  app.post('/api/voice/crm/menu', async (req, res) => {
    try {
      const { From } = req.body;

      if (From !== process.env.ADMIN_PHONE_NUMBER) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Sorry, this feature is only available to authorized users.</Say>
            <Hangup/>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Gather input="speech" action="/api/voice/crm/handle-command" method="POST" speechTimeout="3">
            <Say>Welcome to your C R M assistant. Say add lead to create a new lead. Say add note to add a note to an existing lead. Say daily briefing for your schedule. Or say get advice about a specific deal.</Say>
          </Gather>
          <Say>I didn't hear anything. Goodbye.</Say>
          <Hangup/>
        </Response>`;

      res.type('text/xml').send(twiml);

    } catch (error) {
      console.error('Voice menu error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, there was an error. Please call back later.</Say>
          <Hangup/>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  /**
   * Handle voice command routing
   */
  app.post('/api/voice/crm/handle-command', async (req, res) => {
    try {
      const { SpeechResult } = req.body;
      const command = SpeechResult.toLowerCase();

      if (command.includes('add lead') || command.includes('new lead') || command.includes('create lead')) {
        // Route to add lead flow
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Gather input="speech" action="/api/voice/crm/add-lead" method="POST" speechTimeout="5">
              <Say>Please tell me the lead information. Include the person's name, company, phone, email, and which platform they're interested in.</Say>
            </Gather>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      if (command.includes('add note') || command.includes('note to')) {
        // Route to add note flow
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Gather input="speech" action="/api/voice/crm/add-note" method="POST" speechTimeout="5">
              <Say>Tell me the lead name or company, and what note you want to add.</Say>
            </Gather>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      if (command.includes('briefing') || command.includes('schedule') || command.includes('today')) {
        // Route to daily briefing
        return res.redirect(307, '/api/voice/crm/daily-briefing');
      }

      if (command.includes('advice') || command.includes('help') || command.includes('close')) {
        // Route to AI advisor
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Gather input="speech" action="/api/voice/crm/advisor" method="POST" speechTimeout="5">
              <Say>Tell me which lead or deal you need advice on.</Say>
            </Gather>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      if (command.includes('update gcr') || command.includes('gcr business') || command.includes('gulf coast') || command.includes('update business')) {
        // Route to GCR update flow
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Gather input="speech" action="/api/voice/crm/gcr-update" method="POST" speechTimeout="5">
              <Say>Tell me the business name, what field to update, and the new value. For example, update Flora-Bama phone to 2 5 1 9 8 0 5 1 1 8.</Say>
            </Gather>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      // Unknown command
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>I didn't understand that command. Please try again.</Say>
          <Redirect>/api/voice/crm/menu</Redirect>
        </Response>`;
      res.type('text/xml').send(twiml);

    } catch (error) {
      console.error('Handle command error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, there was an error processing your command.</Say>
          <Hangup/>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  /**
   * Handle GCR business update via voice
   */
  app.post('/api/voice/crm/gcr-update', async (req, res) => {
    try {
      const { From, SpeechResult } = req.body;

      // Verify it's the admin calling
      if (From !== process.env.ADMIN_PHONE_NUMBER) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>Sorry, this feature is only available to authorized users.</Say>
          </Response>`;
        return res.type('text/xml').send(twiml);
      }

      // Parse update with AI
      const updateData = await parseGCRUpdate(SpeechResult);

      if (updateData.success) {
        // Import Google Sheets sync
        const { updateBusinessInSheets } = await import('../../../gcr-google-sheets-sync.js');

        // Update in Google Sheets
        await updateBusinessInSheets(
          updateData.business_name,
          updateData.field,
          updateData.value
        );

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>${updateData.field} updated for ${updateData.business_name}. The new value is ${updateData.value}.</Say>
            <Say>Would you like to make another update?</Say>
            <Gather input="speech dtmf" numDigits="1" action="/api/voice/crm/continue-or-finish" method="POST" timeout="3">
              <Say>Press 1 or say yes for another update. Press 2 or say no to hang up.</Say>
            </Gather>
          </Response>`;

        res.type('text/xml').send(twiml);
      } else {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
          <Response>
            <Say>I couldn't understand the update. Please try again.</Say>
            <Redirect>/api/voice/crm/menu</Redirect>
          </Response>`;
        res.type('text/xml').send(twiml);
      }

    } catch (error) {
      console.error('GCR update error:', error);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Sorry, there was an error. ${error.message}</Say>
          <Redirect>/api/voice/crm/menu</Redirect>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });

  /**
   * Handle continue or finish flow
   */
  app.post('/api/voice/crm/continue-or-finish', async (req, res) => {
    const { Digits, SpeechResult } = req.body;
    const input = Digits || SpeechResult;

    if (input === '1' || (input && input.toLowerCase().includes('yes'))) {
      res.redirect(307, '/api/voice/crm/menu');
    } else {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>All done. Your updates have been saved. Goodbye!</Say>
          <Hangup/>
        </Response>`;
      res.type('text/xml').send(twiml);
    }
  });
}

// ============================================
// AI HELPER FUNCTIONS
// ============================================

/**
 * Parse lead information from natural speech using AI
 */
async function parseLeadFromSpeech(speechText) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are an AI assistant that extracts lead information from natural speech.
          Extract: name, email, phone, company, platform (ghost_os, gcr, or cybercheck), and any notes.
          Return as JSON: { "success": true, "name": "", "email": "", "phone": "", "company": "", "platform": "", "notes": "" }
          If you can't extract required info (at least name), return { "success": false }`
        },
        {
          role: 'user',
          content: speechText
        }
      ],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('Parse lead from speech error:', error);
    return { success: false };
  }
}

/**
 * Parse note and identify which lead it's for
 */
async function parseNoteFromSpeech(speechText, supabase) {
  try {
    // First, extract lead identifier and note content
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `Extract: lead_name (person or company name), note_text, note_type (call, meeting, email, or general).
          Return as JSON: { "lead_name": "", "note_text": "", "note_type": "" }`
        },
        {
          role: 'user',
          content: speechText
        }
      ],
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // Find the lead in database
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, name, company')
      .or(`name.ilike.%${parsed.lead_name}%,company.ilike.%${parsed.lead_name}%`)
      .limit(1);

    if (error || !leads || leads.length === 0) {
      return { success: false };
    }

    return {
      success: true,
      lead_id: leads[0].id,
      lead_name: leads[0].name || leads[0].company,
      note_text: parsed.note_text,
      note_type: parsed.note_type || 'general'
    };

  } catch (error) {
    console.error('Parse note from speech error:', error);
    return { success: false };
  }
}

/**
 * Generate daily briefing
 */
async function generateDailyBriefing(supabase) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get follow-ups due today
    const { data: followUps } = await supabase
      .from('leads')
      .select('name, company, next_follow_up, lead_stage')
      .lte('next_follow_up', today)
      .eq('status', 'new')
      .order('next_follow_up');

    // Get new leads from today
    const { data: newLeads } = await supabase
      .from('leads')
      .select('name, company, platform')
      .gte('created_at', today)
      .eq('status', 'new');

    // Get deals in negotiation
    const { data: negotiations } = await supabase
      .from('leads')
      .select('name, company, estimated_value')
      .eq('lead_stage', 'negotiation')
      .eq('status', 'new');

    let briefing = `Good morning. Here's your daily briefing. `;

    if (newLeads && newLeads.length > 0) {
      briefing += `You have ${newLeads.length} new lead${newLeads.length > 1 ? 's' : ''} today. `;
    }

    if (followUps && followUps.length > 0) {
      briefing += `You have ${followUps.length} follow-up${followUps.length > 1 ? 's' : ''} due today. `;
      const topFollow = followUps[0];
      briefing += `Top priority: ${topFollow.name || topFollow.company} at ${topFollow.lead_stage} stage. `;
    }

    if (negotiations && negotiations.length > 0) {
      briefing += `You have ${negotiations.length} deal${negotiations.length > 1 ? 's' : ''} in negotiation. `;
      const totalValue = negotiations.reduce((sum, n) => sum + (n.estimated_value || 0), 0);
      if (totalValue > 0) {
        briefing += `Total pipeline value: $${Math.round(totalValue)}. `;
      }
    }

    if (!newLeads?.length && !followUps?.length && !negotiations?.length) {
      briefing += `You have no urgent tasks today. Great time to prospect!`;
    }

    return briefing;

  } catch (error) {
    console.error('Generate briefing error:', error);
    return 'Sorry, I couldn\'t generate your briefing right now.';
  }
}

/**
 * Find lead from speech
 */
async function findLeadFromSpeech(speechText, supabase) {
  try {
    // Extract lead name/company using AI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'Extract the person or company name being referenced. Return JSON: { "name": "" }'
        },
        {
          role: 'user',
          content: speechText
        }
      ],
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // Find lead
    const { data: leads } = await supabase
      .from('leads')
      .select('id, name, company')
      .or(`name.ilike.%${parsed.name}%,company.ilike.%${parsed.name}%`)
      .limit(1);

    if (!leads || leads.length === 0) {
      return { success: false };
    }

    return {
      success: true,
      lead_id: leads[0].id,
      lead_name: leads[0].name || leads[0].company
    };

  } catch (error) {
    console.error('Find lead from speech error:', error);
    return { success: false };
  }
}

/**
 * Get full context about a lead for AI analysis
 */
async function getLeadContext(leadId, supabase) {
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  const { data: notes } = await supabase
    .from('lead_notes')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: activities } = await supabase
    .from('lead_activities')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(20);

  const { data: communications } = await supabase
    .from('communication_history')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(10);

  return { lead, notes, activities, communications };
}

/**
 * Get AI advice on a lead/deal
 */
async function getAIAdvice(context, question) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are an expert sales advisor. Based on the CRM data provided, give specific, actionable advice.
          Keep responses under 30 seconds when spoken aloud. Be direct and practical.`
        },
        {
          role: 'user',
          content: `Lead: ${JSON.stringify(context.lead)}
          Recent Notes: ${JSON.stringify(context.notes)}
          Recent Activities: ${JSON.stringify(context.activities)}
          Question: ${question}`
        }
      ],
      max_tokens: 200
    });

    return completion.choices[0].message.content;

  } catch (error) {
    console.error('Get AI advice error:', error);
    return 'Sorry, I couldn\'t generate advice right now.';
  }
}

/**
 * Parse GCR business update from natural speech using AI
 */
async function parseGCRUpdate(speechText) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `Extract GCR business update from natural speech.
          Fields available: name, phone, email, website, address, city, state, zip, description, hours, facebook, instagram, category

          Examples:
          - "Update Flora-Bama phone to 251-980-5118"
          - "Change LuLu's address to 200 E 25th Ave"
          - "Update Cobalt hours to Monday through Sunday 11am to 2am"
          - "Set Flora-Bama website to florabama.com"

          Return JSON: { "success": true, "business_name": "Flora-Bama", "field": "phone", "value": "251-980-5118" }
          If you can't extract the information, return { "success": false }`
        },
        {
          role: 'user',
          content: speechText
        }
      ],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('Parse GCR update error:', error);
    return { success: false };
  }
}
