/**
 * CHECK GCR DATABASE STATUS
 * Tests if businesses are already imported in Supabase
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('\n🔍 Checking GCR Database Status...\n');

async function checkDatabase() {
  try {
    // Check if table exists and get count
    const { data, error, count } = await supabase
      .from('gcr_businesses')
      .select('*', { count: 'exact', head: false })
      .limit(5);

    if (error) {
      console.log('❌ Error accessing gcr_businesses table:', error.message);
      console.log('\nPossible issues:');
      console.log('  • Table does not exist yet');
      console.log('  • RLS policies blocking access');
      console.log('  • Supabase credentials incorrect\n');
      return;
    }

    console.log(`📊 Database Status:`);
    console.log(`  Table: gcr_businesses`);
    console.log(`  Total businesses: ${count || 0}`);
    console.log('');

    if (count === 0) {
      console.log('⚠️  Table is empty - no businesses imported yet\n');
      console.log('Next steps:');
      console.log('  1. Import businesses from Google Sheets');
      console.log('  2. Run: node import-gcr-businesses.js\n');
    } else {
      console.log(`✅ Found ${count} businesses in database!\n`);

      if (data && data.length > 0) {
        console.log('Sample businesses:');
        data.slice(0, 3).forEach((business, index) => {
          console.log(`\n${index + 1}. ${business.name}`);
          console.log(`   Category: ${business.category || 'N/A'}`);
          console.log(`   Location: ${business.location || business.city || 'N/A'}`);
          console.log(`   Status: ${business.status || 'N/A'}`);
        });
        console.log('');
      }
    }

    // Check Google Sheets count
    console.log('\n📋 Comparing with Google Sheets...');
    const { getAllGCRBusinesses } = await import('./gcr-google-sheets-sync.js');
    const sheetBusinesses = await getAllGCRBusinesses();
    console.log(`  Google Sheets: ${sheetBusinesses.length} businesses`);
    console.log(`  Supabase: ${count || 0} businesses`);

    if (count < sheetBusinesses.length) {
      console.log(`\n⚠️  Missing ${sheetBusinesses.length - (count || 0)} businesses from import\n`);
    } else if (count > sheetBusinesses.length) {
      console.log(`\n✅ Database has more businesses than Google Sheets (includes manual additions)\n`);
    } else {
      console.log(`\n✅ Perfect sync - all businesses imported!\n`);
    }

  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
  }
}

checkDatabase();
