import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Check if Supabase credentials are configured
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Use service key if anon key not available
const supabaseKey = (supabaseServiceKey && supabaseServiceKey !== 'your-service-key-here')
  ? supabaseServiceKey
  : supabaseAnonKey;

const isSupabaseConfigured =
  supabaseUrl &&
  supabaseUrl !== 'https://your-project.supabase.co' &&
  supabaseKey &&
  supabaseKey !== 'your-anon-key-here';

if (!isSupabaseConfigured) {
  console.warn('⚠️  WARNING: Supabase credentials not configured!');
  console.warn('⚠️  Add your Supabase URL and keys to .env file');
  console.warn('⚠️  Get credentials from: https://app.supabase.com/project/_/settings/api');
}

// Create Supabase clients (will be null if not configured)
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export const supabaseAdmin = supabase;

// Test database connection
export async function testConnection() {
  if (!supabase) {
    console.warn('⚠️  Skipping database connection test - Supabase not configured');
    return false;
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('count')
      .limit(1);

    if (error && error.code !== 'PGRST116') {
      console.error('❌ Database connection failed:', error.message);
      return false;
    }

    console.log('✅ Database connection successful');
    return true;
  } catch (err) {
    console.error('❌ Database connection error:', err.message);
    return false;
  }
}

export default { supabase, supabaseAdmin, testConnection };
