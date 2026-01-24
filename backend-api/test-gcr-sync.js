/**
 * TEST GCR GOOGLE SHEETS SYNC
 * Quick test to see if we can read businesses from Google Sheets
 */

import dotenv from 'dotenv';
import { getAllGCRBusinesses } from './gcr-google-sheets-sync.js';

// Load environment variables
dotenv.config();

console.log('\n🌊 Testing GCR Google Sheets Sync...\n');

console.log('Configuration:');
console.log('  SPREADSHEET_ID:', process.env.GCR_SPREADSHEET_ID);
console.log('  SHEET_NAME:', process.env.GCR_SHEET_NAME);
console.log('  KEY_FILE:', process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
console.log('  SYNC_ENABLED:', process.env.ENABLE_GCR_SYNC);
console.log('');

async function testSync() {
  try {
    console.log('📥 Fetching businesses from Google Sheets...\n');

    const businesses = await getAllGCRBusinesses();

    console.log(`✅ SUCCESS! Found ${businesses.length} businesses\n`);

    if (businesses.length > 0) {
      console.log('First 3 businesses:');
      businesses.slice(0, 3).forEach((business, index) => {
        console.log(`\n${index + 1}. ${business.name || business.business_name || 'Unnamed'}`);
        console.log(`   Category: ${business.category || 'N/A'}`);
        console.log(`   Address: ${business.address || 'N/A'}`);
        console.log(`   Phone: ${business.phone || 'N/A'}`);
      });

      console.log(`\n... and ${businesses.length - 3} more businesses\n`);

      console.log('✅ Google Sheets sync is working!\n');
      console.log('Next steps:');
      console.log('  1. Create Supabase table for gcr_businesses');
      console.log('  2. Run import script to load all businesses');
      console.log('  3. Test the GCR frontend\n');
    } else {
      console.log('⚠️  No businesses found in the spreadsheet');
      console.log('   Make sure the sheet name is correct and has data\n');
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    console.error('\nPossible issues:');
    console.error('  • Service account file not found or invalid');
    console.error('  • Service account not granted access to spreadsheet');
    console.error('  • Spreadsheet ID is incorrect');
    console.error('  • Sheet name is incorrect');
    console.error('  • Google Sheets API not enabled\n');

    if (error.message.includes('ENOENT')) {
      console.error('🔍 File not found issue:');
      console.error('   Check that google-service-account.json exists at:');
      console.error(`   ${process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE}\n`);
    }

    if (error.message.includes('permission') || error.message.includes('access')) {
      console.error('🔐 Permission issue:');
      console.error('   1. Open your Google Sheet');
      console.error('   2. Click Share button');
      console.error('   3. Add your service account email');
      console.error('   4. Grant "Viewer" or "Editor" access\n');
    }
  }
}

testSync();
