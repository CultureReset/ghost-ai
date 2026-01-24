/**
 * CHECK BUSINESSES TABLE SCHEMA
 * See what columns the table has so we can map Google Sheets data correctly
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('\n📋 Checking "businesses" Table Structure...\n');

async function checkSchema() {
  try {
    // Insert a dummy row to see what columns are expected
    const dummyBusiness = {
      name: '__SCHEMA_TEST__',
      slug: '__test__',
      category: 'test',
      address: 'test',
      city: 'test',
      state: 'AL',
      zip: '00000',
      phone: '000-000-0000',
      website: 'https://test.com',
      description: 'test',
      latitude: 30.0,
      longitude: -87.0,
      rating: 0,
      is_featured: false,
      is_active: true
    };

    // Try to insert
    const { data, error } = await supabase
      .from('businesses')
      .insert(dummyBusiness)
      .select();

    if (error && error.message.includes('column')) {
      console.log('❌ Error gives us column info:', error.message);
      console.log('\nThis tells us which columns exist in the table.\n');
    } else if (error) {
      console.log('❌ Error:', error.message);
    } else {
      console.log('✅ Dummy insert succeeded!');
      console.log('Columns in table:');
      if (data && data.length > 0) {
        Object.keys(data[0]).forEach(col => {
          console.log(`  • ${col}`);
        });
      }

      // Delete the dummy row
      await supabase
        .from('businesses')
        .delete()
        .eq('slug', '__test__');

      console.log('\n✅ Cleaned up test row\n');
    }

    // Try different common structures
    console.log('\n📋 Testing common column names:\n');

    const testColumns = {
      business_id: 'test-id',
      name: 'Test Business',
      slug: 'test-business',
      category: 'Restaurants',
      subcategory: 'Seafood',
      cuisine: 'Seafood',
      address: '123 Main St',
      city: 'Gulf Shores',
      state: 'AL',
      zip: '36542',
      location: 'Gulf Shores',
      phone: '251-555-0100',
      email: 'test@test.com',
      website: 'https://test.com',
      description: 'A test business',
      about: 'More info about test',
      latitude: 30.2460,
      longitude: -87.7008,
      rating: 4.5,
      price_level: '$$',
      is_featured: false,
      is_active: true,
      status: 'active',
      main_image: 'https://example.com/image.jpg',
      logo_image: 'https://example.com/logo.jpg',
      facebook: 'https://facebook.com/test',
      instagram: '@test',
      google_place_id: 'ChIJ123',
      google_maps_url: 'https://maps.google.com/test',
      tags: ['seafood', 'dining'],
      amenities: ['parking', 'wifi']
    };

    const { data: testData, error: testError } = await supabase
      .from('businesses')
      .insert(testColumns)
      .select();

    if (testError) {
      console.log('Error message:', testError.message);

      if (testError.message.includes('null value in column')) {
        const match = testError.message.match(/column "([^"]+)"/);
        if (match) {
          console.log(`\n⚠️  Required column: ${match[1]}`);
        }
      }
    } else {
      console.log('✅ Full test insert succeeded!');
      console.log('\nTable accepts these columns:');
      if (testData && testData.length > 0) {
        Object.keys(testData[0]).sort().forEach(col => {
          console.log(`  • ${col}`);
        });
      }

      // Delete test row
      await supabase
        .from('businesses')
        .delete()
        .eq('slug', 'test-business');

      console.log('\n✅ Cleaned up test row\n');
    }

  } catch (err) {
    console.error('❌ Unexpected error:', err.message);
  }
}

checkSchema();
