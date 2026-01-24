import OpenAI from 'openai';
import { supabase } from '../config/supabase.js';
import logger from '../config/logger.js';

// Initialize OpenAI only if configured
const isOpenAIConfigured = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-key';
const openai = isOpenAIConfigured ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

/**
 * Core AI Service - Shared by all AI features
 * - Customer AI Chat
 * - Owner AI Coach
 * - Phone AI
 * - Voice transcription & extraction
 */
class AIService {
  /**
   * Call AI for a specific business profile
   * This is the main entry point that handles fuel gauge, logging, and limits
   */
  async callAIForBusiness(businessId, featureSource, prompt, options = {}) {
    try {
      // 1. Load AI config for this business
      const { data: aiConfig } = await supabase
        .from('ai_configs')
        .select('*')
        .eq('business_id', businessId)
        .single();

      if (!aiConfig || !aiConfig.is_enabled) {
        throw new Error('AI is not enabled for this business');
      }

      // 2. Check fuel gauge (AI token quota)
      const fuelStatus = await this.checkAIFuel(businessId);
      if (fuelStatus.status === 'EXHAUSTED') {
        throw new Error('AI fuel exhausted. Please upgrade your plan or purchase more tokens.');
      }

      // 3. Build system prompt with business context
      const systemPrompt = await this.buildSystemPrompt(businessId, aiConfig, featureSource);

      // 4. Call OpenAI
      const model = options.model || aiConfig.model_name || 'gpt-4-turbo';
      const temperature = options.temperature !== undefined ? options.temperature : aiConfig.temperature || 0.7;
      const maxTokens = options.max_tokens || aiConfig.max_tokens || 500;

      const startTime = Date.now();

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature,
        max_tokens: maxTokens
      });

      const responseTime = Date.now() - startTime;

      const response = completion.choices[0].message.content;
      const tokensInput = completion.usage.prompt_tokens;
      const tokensOutput = completion.usage.completion_tokens;
      const tokensTotal = completion.usage.total_tokens;

      // 5. Log AI usage
      await this.logAIUsage({
        business_id: businessId,
        feature_source: featureSource,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        tokens_total: tokensTotal,
        model_name: model,
        estimated_cost_cents: this.estimateCost(model, tokensTotal)
      });

      // 6. Update usage counters (fuel gauge)
      await this.updateUsageCounters(businessId, tokensTotal);

      return {
        response,
        usage: {
          tokens_input: tokensInput,
          tokens_output: tokensOutput,
          tokens_total: tokensTotal
        },
        response_time_ms: responseTime,
        fuel_status: await this.checkAIFuel(businessId) // updated status
      };
    } catch (error) {
      logger.error('AI Service error:', error);
      throw error;
    }
  }

  /**
   * Build system prompt with business context
   */
  async buildSystemPrompt(businessId, aiConfig, featureSource) {
    // Load business data
    const { data: business } = await supabase
      .from('businesses')
      .select('name, industry, description, phone, email')
      .eq('id', businessId)
      .single();

    const allowedDomains = aiConfig.allowed_domains || {};
    let contextData = '';

    // Add business basics
    contextData += `Business: ${business.name}\n`;
    contextData += `Industry: ${business.industry}\n`;
    if (business.description) {
      contextData += `About: ${business.description}\n`;
    }
    contextData += `\n`;

    // Load knowledge items if allowed
    if (allowedDomains.use_profile !== false) {
      const { data: knowledgeItems } = await supabase
        .from('ai_knowledge_items')
        .select('type, title, content, short_answer')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('priority', { ascending: false })
        .limit(20);

      if (knowledgeItems && knowledgeItems.length > 0) {
        contextData += `Knowledge Base:\n`;
        knowledgeItems.forEach(item => {
          contextData += `- ${item.title}: ${item.short_answer || item.content}\n`;
        });
        contextData += `\n`;
      }
    }

    // Feature-specific instructions
    let instructions = '';
    switch (featureSource) {
      case 'customer_chat':
        instructions = `You are a helpful AI assistant for ${business.name}.
Answer customer questions using the knowledge base provided.
Be friendly, concise, and helpful.
If you don't know the answer, say "I'm not sure about that - please contact us directly at ${business.phone || business.email}".
Never make up information or promise things not in the knowledge base.`;
        break;

      case 'owner_coach':
        instructions = `You are a business analytics AI assistant for ${business.name}.
Help the owner understand their business metrics and make data-driven decisions.
Be insightful, actionable, and positive.
Focus on practical advice based on the data provided.`;
        break;

      case 'phone_ai':
        instructions = `You are an AI phone assistant for ${business.name}.
You are speaking to a caller on the phone.
Be natural, conversational, and helpful.
Keep responses brief (1-2 sentences when possible).
Use the available tools to book appointments, answer questions, or transfer calls.`;
        break;

      default:
        instructions = aiConfig.system_prompt || `You are an AI assistant for ${business.name}.`;
    }

    return `${instructions}\n\n${contextData}`;
  }

  /**
   * Transcribe audio using OpenAI Whisper
   */
  async transcribeAudio(audioUrl, options = {}) {
    try {
      // Download audio file
      const response = await fetch(audioUrl);
      const audioBuffer = await response.arrayBuffer();
      const audioFile = new File([audioBuffer], 'audio.mp3', { type: 'audio/mpeg' });

      // Call Whisper API
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: options.language || 'en',
        response_format: options.response_format || 'verbose_json'
      });

      return {
        text: transcription.text,
        segments: transcription.segments || [],
        language: transcription.language,
        duration: transcription.duration
      };
    } catch (error) {
      logger.error('Transcription error:', error);
      throw error;
    }
  }

  /**
   * Extract structured data from text using AI
   * Used by Voice CRM to extract contacts, tasks, calendar events
   */
  async extractStructuredData(transcript, businessId, extractionType = 'sales_voice_note') {
    try {
      const { data: business } = await supabase
        .from('businesses')
        .select('name, industry')
        .eq('id', businessId)
        .single();

      let systemPrompt = '';
      let responseFormat = {};

      switch (extractionType) {
        case 'sales_voice_note':
          systemPrompt = `You are an AI that extracts structured CRM data from sales voice notes.
Extract: contact information, lead details, tasks, calendar events, and next steps.
Return JSON only.`;

          responseFormat = {
            type: 'json_schema',
            json_schema: {
              name: 'sales_extraction',
              schema: {
                type: 'object',
                properties: {
                  contact: {
                    type: 'object',
                    properties: {
                      full_name: { type: 'string' },
                      company_name: { type: 'string' },
                      phone: { type: 'string' },
                      email: { type: 'string' }
                    }
                  },
                  lead: {
                    type: 'object',
                    properties: {
                      lead_name: { type: 'string' },
                      stage: { type: 'string', enum: ['new', 'qualified', 'demo', 'proposal', 'won', 'lost'] },
                      estimated_value_cents: { type: 'integer' },
                      product_interest: { type: 'array', items: { type: 'string' } }
                    }
                  },
                  tasks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        due_at: { type: 'string' },
                        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }
                      }
                    }
                  },
                  calendar_events: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        starts_at: { type: 'string' },
                        ends_at: { type: 'string' },
                        location: { type: 'string' }
                      }
                    }
                  },
                  notes: { type: 'string' }
                }
              }
            }
          };
          break;

        case 'business_update':
          systemPrompt = `You are an AI that extracts business updates from owner voice notes.
Extract: menu item changes, service updates, hour changes, policy updates.
Return JSON only.`;

          responseFormat = {
            type: 'json_schema',
            json_schema: {
              name: 'business_update_extraction',
              schema: {
                type: 'object',
                properties: {
                  update_type: { type: 'string', enum: ['menu', 'services', 'hours', 'policy', 'general'] },
                  changes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        action: { type: 'string', enum: ['add', 'update', 'remove'] },
                        category: { type: 'string' },
                        item_name: { type: 'string' },
                        description: { type: 'string' },
                        price: { type: 'number' }
                      }
                    }
                  },
                  summary: { type: 'string' }
                }
              }
            }
          };
          break;
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript }
        ],
        response_format: responseFormat,
        temperature: 0.3
      });

      const extracted = JSON.parse(completion.choices[0].message.content);

      return {
        extracted_data: extracted,
        tokens_used: completion.usage.total_tokens
      };
    } catch (error) {
      logger.error('Extraction error:', error);
      throw error;
    }
  }

  /**
   * Check AI fuel (token quota) for a business
   */
  async checkAIFuel(businessId) {
    const currentMonth = new Date().toISOString().slice(0, 7); // "2025-12"

    const { data: counter } = await supabase
      .from('usage_counters')
      .select('*')
      .eq('business_id', businessId)
      .eq('year_month', currentMonth)
      .single();

    if (!counter) {
      // No counter yet - create one
      const { data: business } = await supabase
        .from('businesses')
        .select('plan_tier')
        .eq('id', businessId)
        .single();

      const quota = this.getTokenQuota(business.plan_tier);

      await supabase.from('usage_counters').insert({
        business_id: businessId,
        year_month: currentMonth,
        ai_tokens_used: 0,
        ai_tokens_monthly: quota,
        sms_messages_sent: 0,
        sms_messages_monthly: this.getSMSQuota(business.plan_tier)
      });

      return {
        status: 'OK',
        tokens_used: 0,
        tokens_monthly: quota,
        percentage: 0
      };
    }

    const percentage = (counter.ai_tokens_used / counter.ai_tokens_monthly) * 100;

    let status = 'OK';
    if (percentage > 100) status = 'EXHAUSTED';
    else if (percentage > 90) status = 'WARNING';

    return {
      status,
      tokens_used: counter.ai_tokens_used,
      tokens_monthly: counter.ai_tokens_monthly,
      percentage: Math.round(percentage)
    };
  }

  /**
   * Log AI usage to database
   */
  async logAIUsage(usageData) {
    await supabase.from('ai_usage_log').insert(usageData);
  }

  /**
   * Update monthly usage counters (fuel gauge)
   */
  async updateUsageCounters(businessId, tokensUsed) {
    const currentMonth = new Date().toISOString().slice(0, 7);

    const { data: existing } = await supabase
      .from('usage_counters')
      .select('*')
      .eq('business_id', businessId)
      .eq('year_month', currentMonth)
      .single();

    if (existing) {
      await supabase
        .from('usage_counters')
        .update({
          ai_tokens_used: existing.ai_tokens_used + tokensUsed,
          last_updated_at: new Date()
        })
        .eq('id', existing.id);
    }
  }

  /**
   * Get token quota based on plan tier
   */
  getTokenQuota(planTier) {
    const quotas = {
      free: 25000,
      basic: 100000,
      pro: 500000,
      premium: 2000000,
      ai: 1000000
    };
    return quotas[planTier] || 25000;
  }

  /**
   * Get SMS quota based on plan tier
   */
  getSMSQuota(planTier) {
    const quotas = {
      free: 50,
      basic: 200,
      pro: 1000,
      premium: 5000,
      ai: 2000
    };
    return quotas[planTier] || 50;
  }

  /**
   * Estimate cost in cents based on model and tokens
   */
  estimateCost(model, tokens) {
    const costPer1kTokens = {
      'gpt-4-turbo': 0.01, // $0.01 per 1k tokens (average of input/output)
      'gpt-4': 0.03,
      'gpt-3.5-turbo': 0.001
    };

    const rate = costPer1kTokens[model] || 0.01;
    return Math.ceil((tokens / 1000) * rate * 100); // in cents
  }
}

export default new AIService();
