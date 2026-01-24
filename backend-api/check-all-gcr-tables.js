/**
 * CHECK ALL GCR TABLES
 * See which tables have data and what structure they have
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('\n📊 Checking All GCR Tables...\n');

const tablesToCheck = [
  'gcr_businesses',
  'businesses',
  'gcr_business',
  'gcr_data',
  'gulf_coast_businesses'
];

async function checkAllTables() {
  for (const tableName of tablesToCheck) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📋 Table: ${tableName}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    try {
      // Get count and sample data
      const { data, error, count } = await supabase
        .from(tableName)
        .select('*', { count: 'exact' })
        .limit(2);

      if (error) {
        console.log(`❌ Error: ${error.message}`);
        continue;
      }

      console.log(`  Total rows: ${count || 0}`);

      if (count > 0 && data && data.length > 0) {
        console.log(`  ✅ HAS DATA!`);
        console.log(`\n  Columns:`);
        const columns = Object.keys(data[0]);
        columns.slice(0, 15).forEach(col => {
          console.log(`    • ${col}`);
        });
        if (columns.length > 15) {
          console.log(`    ... and ${columns.length - 15} more columns`);
        }

        console.log(`\n  Sample business:`);
        console.log(`    Name: ${data[0].name || data[0].business_name || 'N/A'}`);
        console.log(`    Category: ${data[0].category || 'N/A'}`);
        console.log(`    Location: ${data[0].location || data[0].city || 'N/A'}`);
        console.log(`    Address: ${data[0].address || 'N/A'}`);
      } else {
        console.log(`  ⚠️  EMPTY - No data`);
      }

    } catch (err) {
      console.log(`❌ Unexpected error: ${err.message}`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Check Google Sheets count
  console.log('📋 Google Sheets Status:');
  try {
    const { getAllGCRBusinesses } = await import('./gcr-google-sheets-sync.js');
    const sheetBusinesses = await getAllGCRBusinesses();
    console.log(`  Businesses in Google Sheets: ${sheetBusinesses.length}`);
  } catch (err) {
    console.log(`  Could not fetch Google Sheets data: ${err.message}`);
  }

  console.log('\n✅ Table scan complete!\n');
}

checkAllTables();
