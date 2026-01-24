# Ghost AI Email Notifications Setup

Email notifications are sent to you whenever someone joins the Ghost AI waitlist.

## Required Environment Variables

Add these to your `.env` file:

```env
# SendGrid Configuration
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SENDGRID_FROM_EMAIL=noreply@yourdomain.com
ADMIN_EMAIL=your-email@example.com
```

## How to Get SendGrid API Key

1. **Sign up for SendGrid:**
   - Go to https://sendgrid.com/
   - Create a free account (100 emails/day free forever)

2. **Create API Key:**
   - Go to Settings → API Keys
   - Click "Create API Key"
   - Name it "Ghost AI Waitlist"
   - Select "Restricted Access"
   - Enable "Mail Send" permission
   - Copy the API key (you'll only see it once!)

3. **Verify Sender Email:**
   - Go to Settings → Sender Authentication
   - Click "Verify a Single Sender"
   - Enter your email (e.g., noreply@yourdomain.com)
   - Check your email and click the verification link

4. **Add to Environment Variables:**
   ```env
   SENDGRID_API_KEY=SG.your_api_key_here
   SENDGRID_FROM_EMAIL=noreply@yourdomain.com
   ADMIN_EMAIL=your-email@example.com
   ```

## What You'll Receive

When someone joins the waitlist, you'll receive an email with:
- ✅ Person's name
- ✅ Phone number
- ✅ Email address
- ✅ Preferred AI (ChatGPT, Grok, Gemini, or Perplexity)
- ✅ Whether it's a new signup or update
- ✅ Timestamp

## Email Preview

```
Subject: 🎉 New Ghost AI Waitlist Signup: John Doe

┌─────────────────────────────────┐
│     👻 Ghost AI Waitlist        │
└─────────────────────────────────┘

Name: John Doe
Phone: +1 (555) 123-4567
Email: john@example.com
Preferred AI: ChatGPT 🤖
Status: ✨ New signup
Timestamp: Jan 23, 2026 6:30 PM

Ghost AI - Your Private AI. Just Call.
```

## Testing Email Notifications

1. Make sure environment variables are set
2. Start the server: `npm start`
3. Go to the Ghost AI landing page
4. Fill out the waitlist form
5. Check your email inbox

If emails aren't arriving:
- Check spam folder
- Verify SendGrid API key is correct
- Verify sender email is verified in SendGrid
- Check server logs for errors

## Disable Email Notifications

If you don't want email notifications, simply don't set the environment variables. The system will log a warning and skip sending emails:

```
⚠️  SendGrid not configured - skipping email notification
```

## Alternative: Use Your Own SMTP

If you prefer to use your own email service instead of SendGrid, you can modify the `sendWaitlistEmailNotification` function in `server.js` to use nodemailer or any other email library.

---

**Ghost AI** - Your Private AI. Just Call. 👻
