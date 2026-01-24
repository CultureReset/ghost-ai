/**
 * LIST ALL TABLES IN SUPABASE
 * Check what tables exist in the database
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('\n📋 Checking Supabase Tables...\n');

async function listTables() {
  try {
    // Query the information schema to get all tables
    const { data, error } = await supabase.rpc('exec_sql', {
      query: `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
      `
    });

    if (error) {
      console.log('⚠️  Could not query tables directly, trying alternative method...\n');

      // Try checking for common table names
      const tablesToCheck = [
        'gcr_businesses',
        'businesses',
        'gcr_business',
        'gcr_data',
        'gulf_coast_businesses'
      ];

      console.log('Checking for common GCR table names:\n');
      for (const tableName of tablesToCheck) {
        const { error } = await supabase
          .from(tableName)
          .select('*', { count: 'exact', head: true });

        if (!error) {
          console.log(`  ✅ Found: ${tableName}`);
        } else {
          console.log(`  ❌ Not found: ${tableName}`);
        }
      }
    } else {
      console.log('📊 Tables in public schema:');
      data.forEach(row => {
        console.log(`  • ${row.table_name}`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

listTables();
