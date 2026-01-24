-- ============================================
-- GHOST AI - FRESH DATABASE SETUP
-- ============================================
-- This will DROP existing tables and recreate them
-- WARNING: This will delete all existing data!
-- ============================================

-- Drop existing tables (in reverse order due to foreign keys)
DROP TABLE IF EXISTS usage_records CASCADE;
DROP TABLE IF EXISTS sms_conversations CASCADE;
DROP TABLE IF EXISTS phone_calls CASCADE;
DROP TABLE IF EXISTS ghost_os_waitlist CASCADE;

-- 1. WAITLIST TABLE
-- Stores user signups from website and SMS
CREATE TABLE ghost_os_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  preferred_ai TEXT DEFAULT 'openai',
  status TEXT DEFAULT 'waiting',
  sms_consent BOOLEAN DEFAULT false,
  welcome_sent BOOLEAN DEFAULT false,
  sms_count INTEGER DEFAULT 0,
  last_sms_at TIMESTAMP,
  notified_at TIMESTAMP,
  notes TEXT,
  preferred_area_code TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ghost_waitlist_phone ON ghost_os_waitlist(phone_number);
CREATE INDEX idx_ghost_waitlist_email ON ghost_os_waitlist(email);
CREATE INDEX idx_ghost_waitlist_created ON ghost_os_waitlist(created_at DESC);

COMMENT ON TABLE ghost_os_waitlist IS 'Ghost AI waitlist signups from website form and SMS';
COMMENT ON COLUMN ghost_os_waitlist.preferred_ai IS 'openai, grok, gemini, or perplexity';
COMMENT ON COLUMN ghost_os_waitlist.status IS 'waiting, invited, active, cancelled';

-- 2. PHONE CALLS TABLE
-- Stores voice call records and transcripts
CREATE TABLE phone_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid TEXT UNIQUE NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT,
  status TEXT NOT NULL,
  direction TEXT DEFAULT 'inbound',
  duration_seconds INTEGER,
  recording_url TEXT,
  transcript TEXT,
  extracted_data JSONB,
  sentiment JSONB,
  summary TEXT,
  metadata JSONB,
  ai_processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_phone_calls_sid ON phone_calls(call_sid);
CREATE INDEX idx_phone_calls_from ON phone_calls(from_number);
CREATE INDEX idx_phone_calls_status ON phone_calls(status);
CREATE INDEX idx_phone_calls_created ON phone_calls(created_at DESC);

COMMENT ON TABLE phone_calls IS 'Voice call records with transcripts and AI processing';
COMMENT ON COLUMN phone_calls.status IS 'queued, ringing, in-progress, completed, failed, busy, no-answer';
COMMENT ON COLUMN phone_calls.direction IS 'inbound or outbound';

-- 3. SMS CONVERSATIONS TABLE
-- Stores SMS-based AI chat history
CREATE TABLE sms_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  waitlist_id UUID REFERENCES ghost_os_waitlist(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  message_sid TEXT,
  ai_provider TEXT DEFAULT 'openai',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sms_conversations_phone ON sms_conversations(phone_number);
CREATE INDEX idx_sms_conversations_waitlist ON sms_conversations(waitlist_id);
CREATE INDEX idx_sms_conversations_created ON sms_conversations(created_at DESC);
CREATE INDEX idx_sms_conversations_role ON sms_conversations(role);

COMMENT ON TABLE sms_conversations IS 'SMS-based AI conversation history for Ghost AI';
COMMENT ON COLUMN sms_conversations.role IS 'Either "user" or "assistant"';
COMMENT ON COLUMN sms_conversations.ai_provider IS 'AI provider used: openai, grok, gemini, perplexity';

-- 4. USAGE RECORDS TABLE
-- Tracks API usage for billing and analytics
CREATE TABLE usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT,
  usage_type TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  cost DECIMAL(10, 4),
  date DATE NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_usage_phone ON usage_records(phone_number);
CREATE INDEX idx_usage_type ON usage_records(usage_type);
CREATE INDEX idx_usage_date ON usage_records(date DESC);

COMMENT ON TABLE usage_records IS 'Tracks API usage and costs for billing';
COMMENT ON COLUMN usage_records.usage_type IS 'voice_call, sms_ai_question, sms_message, etc';
COMMENT ON COLUMN usage_records.cost IS 'Cost in USD';

-- ============================================
-- SUCCESS!
-- ============================================
-- All Ghost AI tables have been created fresh.
-- Next steps:
-- 1. Deploy backend to Railway
-- 2. Configure Twilio webhooks
-- 3. Test SMS and voice calls
-- ============================================
