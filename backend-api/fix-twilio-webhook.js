import dotenv from 'dotenv';
dotenv.config();

import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const phoneNumber = process.env.GHOST_OS_WAITLIST_NUMBER;
const correctWebhookUrl = 'https://ghost-ai-production.up.railway.app/api/ghost-ai/voice';

console.log('\n🔍 Checking Twilio webhook configuration...\n');
console.log(`Phone Number: ${phoneNumber}`);
console.log(`Target Webhook: ${correctWebhookUrl}\n`);

async function fixWebhook() {
  try {
    // Get all phone numbers
    const phoneNumbers = await client.incomingPhoneNumbers.list();

    // Find our specific number
    const ourNumber = phoneNumbers.find(num => num.phoneNumber === phoneNumber);

    if (!ourNumber) {
      console.error(`❌ Phone number ${phoneNumber} not found in account!`);
      return;
    }

    console.log('📱 Current Configuration:');
    console.log(`   Voice URL: ${ourNumber.voiceUrl || 'NOT SET'}`);
    console.log(`   Voice Method: ${ourNumber.voiceMethod || 'NOT SET'}`);
    console.log(`   Status Callback: ${ourNumber.statusCallback || 'NOT SET'}\n`);

    // Check if webhook is correct
    if (ourNumber.voiceUrl === correctWebhookUrl && ourNumber.voiceMethod === 'POST') {
      console.log('✅ Webhook is already configured correctly!');
      console.log('\n⚠️  If calls are still failing with busy signal, the issue may be:');
      console.log('   1. Railway deployment not responding (check Railway logs)');
      console.log('   2. Twilio account suspended or number deprovisioned');
      console.log('   3. Network/firewall blocking Twilio requests');
      return;
    }

    console.log('🔧 Updating webhook configuration...\n');

    // Update the webhook
    await client.incomingPhoneNumbers(ourNumber.sid).update({
      voiceUrl: correctWebhookUrl,
      voiceMethod: 'POST',
      statusCallback: 'https://ghost-ai-production.up.railway.app/api/ghost-ai/status',
      statusCallbackMethod: 'POST'
    });

    console.log('✅ Webhook updated successfully!\n');
    console.log('📱 New Configuration:');
    console.log(`   Voice URL: ${correctWebhookUrl}`);
    console.log(`   Voice Method: POST`);
    console.log(`   Status Callback: https://ghost-ai-production.up.railway.app/api/ghost-ai/status\n`);
    console.log('🎉 Try calling the number now: ' + phoneNumber);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code === 20003) {
      console.error('   → Twilio authentication failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    }
  }
}

fixWebhook();
