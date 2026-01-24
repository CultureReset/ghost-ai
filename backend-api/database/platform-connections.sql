/**
 * PLATFORM CONNECTIONS - Database Schema
 *
 * Two tables:
 * 1. admin_platform_credentials - YOUR master API keys
 * 2. user_platform_connections - User OAuth connections
 */

-- ============================================
-- ADMIN CREDENTIALS (For YOU)
-- ============================================
CREATE TABLE IF NOT EXISTS admin_platform_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Platform info
  platform_name TEXT NOT NULL UNIQUE, -- 'facebook', 'google_analytics', 'gmail', 'stripe', etc.
  display_name TEXT NOT NULL, -- 'Facebook', 'Google Analytics', etc.

  -- Credentials (encrypted)
  api_key TEXT,
  api_secret TEXT,
  credentials_json JSONB, -- For complex auth (OAuth tokens, etc.)

  -- Metadata
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- USER CONNECTIONS (For customers)
-- ============================================
CREATE TABLE IF NOT EXISTS user_platform_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- User reference
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,

  -- Platform info
  platform_type TEXT NOT NULL, -- 'facebook', 'gmail', 'analytics', 'instagram', etc.
  platform_name TEXT, -- Display name

  -- OAuth credentials
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT[], -- OAuth scopes

  -- Platform-specific IDs
  platform_user_id TEXT, -- User's ID on that platform
  platform_account_name TEXT, -- Email or username
  platform_account_id TEXT, -- For pages, properties, etc.

  -- Additional data
  credentials_data JSONB, -- Platform-specific data

  -- Status
  status TEXT DEFAULT 'active', -- 'active', 'expired', 'error', 'disconnected'
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,

  -- Timestamps
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, platform_type, platform_account_id)
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_user_platforms_user ON user_platform_connections(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_platforms_business ON user_platform_connections(business_id);
CREATE INDEX IF NOT EXISTS idx_user_platforms_type ON user_platform_connections(platform_type);

-- ============================================
-- AUTO-UPDATE TIMESTAMP
-- ============================================
CREATE OR REPLACE FUNCTION update_platform_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_admin_platform_updated_at
  BEFORE UPDATE ON admin_platform_credentials
  FOR EACH ROW
  EXECUTE FUNCTION update_platform_updated_at();

CREATE TRIGGER trigger_user_platform_updated_at
  BEFORE UPDATE ON user_platform_connections
  FOR EACH ROW
  EXECUTE FUNCTION update_platform_updated_at();

-- ============================================
-- GRANT PERMISSIONS
-- ============================================
GRANT ALL ON admin_platform_credentials TO authenticated;
GRANT ALL ON user_platform_connections TO authenticated;

GRANT ALL ON admin_platform_credentials TO service_role;
GRANT ALL ON user_platform_connections TO service_role;
