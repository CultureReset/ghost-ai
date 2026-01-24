-- SMS Conversations Table for Ghost AI
-- Stores SMS-based AI conversation history

CREATE TABLE IF NOT EXISTS sms_conversations (
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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sms_conversations_phone ON sms_conversations(phone_number);
CREATE INDEX IF NOT EXISTS idx_sms_conversations_waitlist ON sms_conversations(waitlist_id);
CREATE INDEX IF NOT EXISTS idx_sms_conversations_created ON sms_conversations(created_at DESC);

-- RLS policies (optional - enable if using RLS)
-- ALTER TABLE sms_conversations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE sms_conversations IS 'Stores SMS-based AI conversation history for Ghost AI';
COMMENT ON COLUMN sms_conversations.role IS 'Either "user" or "assistant"';
COMMENT ON COLUMN sms_conversations.ai_provider IS 'AI provider used: openai, grok, gemini, perplexity';
