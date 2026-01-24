# Ghost AI - Real-Time Voice AI Setup Guide

This guide explains how to configure Ghost AI for real-time voice conversations with OpenAI.

## Architecture

Ghost AI uses:
- **Twilio Media Streams** for bidirectional audio streaming
- **OpenAI Realtime API** for voice-to-voice AI conversations
- **WebSocket connections** for real-time audio processing
- **SMS integration** for waitlist management

## Prerequisites

1. **Twilio Account**
   - Account SID
   - Auth Token
   - Phone number (e.g., +12513135464)

2. **OpenAI Account**
   - API key with access to Realtime API
   - Model: `gpt-4o-realtime-preview-2024-10-01`

3. **Environment Variables**
   Add to `.env`:
   ```env
   # Twilio
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   GHOST_OS_WAITLIST_NUMBER=+12513135464

   # OpenAI
   OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxx

   # Supabase
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_KEY=your_service_key
   ```

## Twilio Phone Number Configuration

Configure your Twilio phone number webhooks at:
https://console.twilio.com/us1/develop/phone-numbers/manage/incoming

### Voice Configuration

**When a call comes in:**
- Webhook URL: `https://your-domain.com/api/ghost-ai/voice`
- HTTP Method: `POST`

**Call Status Changes:**
- Webhook URL: `https://your-domain.com/api/ghost-ai/status`
- HTTP Method: `POST`

### Messaging Configuration

**When a message comes in:**
- Webhook URL: `https://your-domain.com/api/ghost-ai/sms`
- HTTP Method: `POST`

## Database Setup

Ensure these tables exist in Supabase:

### `ghost_os_waitlist` table
```sql
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
```

### `phone_calls` table
```sql
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
```

### `usage_records` table
```sql
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
```

## How It Works

### Voice Call Flow

1. **User calls Ghost AI number** → Twilio receives call
2. **Twilio webhook** → POST to `/api/ghost-ai/voice`
3. **Backend initializes session:**
   - Looks up user's AI preference from waitlist
   - Creates session with conversation history
   - Returns TwiML with `<Stream>` instruction
4. **Twilio opens WebSocket** → `wss://your-domain.com/api/ghost-ai/media-stream`
5. **Backend connects to OpenAI Realtime API:**
   - Opens WebSocket to OpenAI
   - Configures voice, instructions, turn detection
   - Sends greeting
6. **Audio streaming:**
   - User audio: Twilio → Backend → OpenAI
   - AI audio: OpenAI → Backend → Twilio
   - Bidirectional real-time conversation
7. **Call ends:**
   - Backend saves transcript and conversation history
   - Tracks usage and costs
   - Updates database

### SMS Flow

1. **User texts Ghost AI number** → Twilio receives SMS
2. **Twilio webhook** → POST to `/api/ghost-ai/sms`
3. **Backend uses existing waitlist handler:**
   - New user: Adds to waitlist, sends welcome SMS
   - Existing user: Handles commands (STATUS, CANCEL, area code, etc.)
   - All responses sent via Twilio SMS

## AI Provider Support

Currently supported:
- ✅ **OpenAI (ChatGPT)** - GPT-4o Realtime API

Coming soon:
- ⏳ **Grok (xAI)** - When realtime API is available
- ⏳ **Gemini (Google)** - When realtime API is available
- ⏳ **Perplexity** - When realtime API is available

The system is designed to be extensible. When a user selects a different AI, the backend will route to the appropriate provider's realtime API.

## Cost Estimation

Per call costs (approximate):
- **OpenAI Realtime API:** ~$0.15/minute
- **Twilio Voice:** ~$0.013/minute
- **Total:** ~$0.163/minute

For a 5-minute call: **$0.82**

Monthly costs for $20/month plan (~10,000 tokens):
- Average 100-200 calls/month
- Average 2-3 minutes per call
- Total: ~$40-50 in API costs (negative margin initially)
- Scale to profitability with higher-tier plans

## Testing

### 1. Test Voice Call
```bash
# Call your Ghost AI number
# You should hear a greeting and be able to have a conversation
```

### 2. Test SMS
```bash
# Text your Ghost AI number with any message
# You should receive a waitlist confirmation
```

### 3. Check Logs
```bash
cd /Users/owner/CLEAN-PLATFORM-BUILD/backend-api
npm start

# Watch for:
# - "📞 Ghost AI call from..."
# - "📡 Media Stream WebSocket connection established"
# - "OpenAI Realtime API connected for call:..."
# - "User said: ..."
# - "AI said: ..."
```

### 4. Check Database
```sql
-- Check calls
SELECT * FROM phone_calls ORDER BY created_at DESC LIMIT 10;

-- Check waitlist
SELECT * FROM ghost_os_waitlist ORDER BY created_at DESC LIMIT 10;

-- Check usage
SELECT * FROM usage_records ORDER BY created_at DESC LIMIT 10;
```

## Troubleshooting

### Call connects but no audio
- Check WebSocket URL in TwiML (must be `wss://`, not `ws://`)
- Verify firewall allows WebSocket connections
- Check OpenAI API key has Realtime API access

### OpenAI connection fails
- Verify `OPENAI_API_KEY` in `.env`
- Check API key has access to `gpt-4o-realtime-preview-2024-10-01`
- Review OpenAI API quotas/limits

### SMS not working
- Verify `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` in `.env`
- Check Twilio messaging webhook is configured
- Ensure Supabase connection is working

### Database errors
- Run SQL migrations for `ghost_os_waitlist`, `phone_calls`, `usage_records`
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correct
- Check table permissions

## Deployment

### Production Checklist

- [ ] SSL certificate installed (required for `wss://`)
- [ ] Domain configured with HTTPS
- [ ] Twilio webhooks updated to production URLs
- [ ] Environment variables set on production server
- [ ] WebSocket proxy configured (Nginx/Cloudflare)
- [ ] Database migrations run
- [ ] OpenAI API rate limits reviewed
- [ ] Monitoring/logging enabled
- [ ] Cost alerts configured

### Nginx WebSocket Configuration

If using Nginx as reverse proxy:

```nginx
location /api/ghost-ai/media-stream {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
}
```

## Monitoring

Key metrics to track:
- Active voice sessions (in-memory count)
- Average call duration
- OpenAI API costs
- Twilio costs
- Call completion rate
- User AI preferences distribution
- Conversation transcript quality

## Next Steps

1. **Configure Twilio webhooks** (see above)
2. **Test voice calls** and verify audio quality
3. **Test SMS** for waitlist signup
4. **Monitor costs** during beta
5. **Gather user feedback** on conversation quality
6. **Optimize prompts** based on transcripts
7. **Add memory features** for personalized experiences
8. **Implement higher-tier plans** for profitability

## Support

For issues:
1. Check server logs: `npm start` output
2. Check Twilio debugger: https://console.twilio.com/us1/monitor/logs/debugger
3. Check OpenAI usage: https://platform.openai.com/usage
4. Review Supabase logs: https://supabase.com/dashboard/project/_/logs

---

**Ghost AI** - Your Private AI. Just Call. 👻
