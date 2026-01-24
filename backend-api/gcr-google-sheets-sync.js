/**
 * GCR GOOGLE SHEETS SYNC
 * Read/write Gulf Coast Radar business data from Google Sheets
 */

import dotenv from 'dotenv';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

// Initialize Supabase (optional - only needed for database operations)
let supabase;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
} catch (error) {
  console.warn('Supabase not initialized - database operations will not work');
}

// ============================================
// GOOGLE SHEETS SETUP
// ============================================

// Initialize Google Sheets API
let sheets;
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheets = google.sheets({ version: 'v4', auth });
} catch (error) {
  console.error('Google Sheets auth error:', error);
}

const SPREADSHEET_ID = process.env.GCR_SPREADSHEET_ID;
const SHEET_NAME = process.env.GCR_SHEET_NAME || 'Businesses';

// ============================================
// READ ALL BUSINESSES FROM GOOGLE SHEETS
// ============================================

export async function getAllGCRBusinesses() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`, // Get all columns
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      return [];
    }

    // First row is headers
    const headers = rows[0];
    const businesses = [];

    // Convert each row to object
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const business = {};

      headers.forEach((header, index) => {
        const value = row[index] || '';
        const key = header.toLowerCase().replace(/ /g, '_');
        business[key] = value;
      });

      businesses.push(business);
    }

    return businesses;

  } catch (error) {
    console.error('Error reading Google Sheets:', error);
    throw error;
  }
}

// ============================================
// FIND BUSINESS IN GOOGLE SHEETS
// ============================================

export async function findBusinessInSheets(businessName) {
  const businesses = await getAllGCRBusinesses();

  const matches = businesses.filter(b =>
    b.business_name?.toLowerCase().includes(businessName.toLowerCase()) ||
    b.name?.toLowerCase().includes(businessName.toLowerCase())
  );

  if (matches.length === 0) {
    throw new Error(`Business "${businessName}" not found in GCR`);
  }

  // Return best match (first one)
  return {
    ...matches[0],
    rowNumber: businesses.indexOf(matches[0]) + 2 // +2 for header row and 0-index
  };
}

// ============================================
// UPDATE BUSINESS IN GOOGLE SHEETS
// ============================================

export async function updateBusinessInSheets(businessName, field, value) {
  try {
    // Find the business and its row number
    const business = await findBusinessInSheets(businessName);
    const rowNumber = business.rowNumber;

    // Get headers to find column
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:Z1`,
    });

    const headers = response.data.values[0];
    const fieldHeader = headers.find(h =>
      h.toLowerCase().replace(/ /g, '_') === field.toLowerCase()
    );

    if (!fieldHeader) {
      throw new Error(`Field "${field}" not found in spreadsheet`);
    }

    const columnIndex = headers.indexOf(fieldHeader);
    const columnLetter = String.fromCharCode(65 + columnIndex); // A, B, C, etc.

    // Update the cell
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${columnLetter}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[value]]
      }
    });

    // Log the change
    await logChange(businessName, field, business[field], value, 'sheets_update');

    return {
      success: true,
      business: businessName,
      field,
      oldValue: business[field],
      newValue: value
    };

  } catch (error) {
    console.error('Error updating Google Sheets:', error);
    throw error;
  }
}

// ============================================
// ADD NEW BUSINESS TO GOOGLE SHEETS
// ============================================

export async function addBusinessToSheets(businessData) {
  try {
    // Get headers
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:Z1`,
    });

    const headers = response.data.values[0];

    // Create row in same order as headers
    const newRow = headers.map(header => {
      const key = header.toLowerCase().replace(/ /g, '_');
      return businessData[key] || '';
    });

    // Append row
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [newRow]
      }
    });

    return {
      success: true,
      business: businessData.business_name || businessData.name
    };

  } catch (error) {
    console.error('Error adding to Google Sheets:', error);
    throw error;
  }
}

// ============================================
// BULK UPDATE IN GOOGLE SHEETS
// ============================================

export async function bulkUpdateInSheets(filters, field, value) {
  const businesses = await getAllGCRBusinesses();

  // Filter businesses
  const matching = businesses.filter(b => {
    let match = true;

    if (filters.category) {
      match = match && b.category?.toLowerCase().includes(filters.category.toLowerCase());
    }

    if (filters.location) {
      const location = filters.location.toLowerCase();
      match = match && (
        b.city?.toLowerCase().includes(location) ||
        b.address?.toLowerCase().includes(location)
      );
    }

    return match;
  });

  // Update each one
  const results = [];
  for (const business of matching) {
    try {
      await updateBusinessInSheets(business.business_name || business.name, field, value);
      results.push({ business: business.business_name, success: true });
    } catch (error) {
      results.push({ business: business.business_name, success: false, error: error.message });
    }
  }

  return results;
}

// ============================================
// SYNC GOOGLE SHEETS TO LOCAL DATABASE
// ============================================

export async function syncSheetsToDatabase() {
  try {
    const businesses = await getAllGCRBusinesses();

    console.log(`Syncing ${businesses.length} businesses from Google Sheets...`);

    for (const business of businesses) {
      // Upsert to database
      await supabase.from('gcr_businesses').upsert({
        business_name: business.business_name || business.name,
        slug: (business.business_name || business.name)?.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        category: business.category,
        phone: business.phone,
        email: business.email,
        website: business.website,
        address: business.address,
        city: business.city,
        state: business.state,
        zip: business.zip,
        description: business.description,
        hours: business.hours,
        logo_url: business.logo_url || business.logo,
        status: business.status || 'active',
        synced_from_gcr: true,
        last_synced_at: new Date().toISOString()
      }, {
        onConflict: 'slug'
      });
    }

    console.log(`✓ Synced ${businesses.length} businesses to database`);

    return {
      success: true,
      synced_count: businesses.length
    };

  } catch (error) {
    console.error('Sync error:', error);
    throw error;
  }
}

// ============================================
// LOG CHANGES
// ============================================

async function logChange(businessName, field, oldValue, newValue, method) {
  try {
    // Find business in database
    const { data: business } = await supabase
      .from('gcr_businesses')
      .select('id')
      .eq('business_name', businessName)
      .single();

    if (business) {
      await supabase.from('gcr_business_changes').insert({
        business_id: business.id,
        change_type: 'update',
        field_changed: field,
        old_value: String(oldValue),
        new_value: String(newValue),
        method: method,
        changed_by: 'admin'
      });
    }
  } catch (error) {
    console.error('Error logging change:', error);
  }
}

// ============================================
// READ ADDITIONAL SHEETS (2-29)
// ============================================

/**
 * Generic function to read any sheet and filter by business_id
 */
async function readSheetByBusinessId(sheetName, businessId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return [];

    const headers = rows[0];
    const items = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const item = {};

      headers.forEach((header, index) => {
        const key = header.toLowerCase().replace(/ /g, '_');
        item[key] = row[index] || '';
      });

      // Filter by business_id if it exists
      if (!businessId || item.business_id === businessId || item.businessid === businessId) {
        items.push(item);
      }
    }

    return items;
  } catch (error) {
    console.error(`Error reading ${sheetName}:`, error);
    return [];
  }
}

/**
 * Get business hours from Sheet 2
 */
export async function getBusinessHours(businessId) {
  return readSheetByBusinessId('2_ALL_HOURS', businessId);
}

/**
 * Get menu items from Sheet 3
 */
export async function getBusinessMenuItems(businessId) {
  return readSheetByBusinessId('3_ALL_MENU_ITEMS', businessId);
}

/**
 * Get drink menu from Sheet 4
 */
export async function getBusinessDrinkMenu(businessId) {
  return readSheetByBusinessId('4_ALL_DRINK_MENUS', businessId);
}

/**
 * Get happy hours from Sheet 5
 */
export async function getBusinessHappyHours(businessId) {
  return readSheetByBusinessId('5_ALL_HAPPY_HOURS', businessId);
}

/**
 * Get events from Sheet 6
 */
export async function getBusinessEvents(businessId) {
  return readSheetByBusinessId('6_ALL_EVENTS', businessId);
}

/**
 * Get specials from Sheet 7
 */
export async function getBusinessSpecials(businessId) {
  return readSheetByBusinessId('7_ALL_SPECIALS', businessId);
}

/**
 * Get tags from Sheet 8
 */
export async function getBusinessTags(businessId) {
  return readSheetByBusinessId('8_ALL_TAGS', businessId);
}

/**
 * Get photos from Sheet 9
 */
export async function getBusinessPhotos(businessId) {
  return readSheetByBusinessId('9_ALL_PHOTOS', businessId);
}

/**
 * Get coupons from Sheet 10
 */
export async function getBusinessCoupons(businessId) {
  return readSheetByBusinessId('10_ALL_COUPONS', businessId);
}

/**
 * Get delivery info from Sheet 11
 */
export async function getBusinessDeliveryInfo(businessId) {
  return readSheetByBusinessId('11_ALL_DELIVERY_INFO', businessId);
}

/**
 * Get daily specials from Sheet 12
 */
export async function getBusinessDailySpecials(businessId) {
  return readSheetByBusinessId('12_ALL_DAILY_SPECIALS', businessId);
}

/**
 * Get all business data including all sheets
 */
export async function getCompleteBusinessData(businessId) {
  try {
    const [
      hours,
      menuItems,
      drinkMenu,
      happyHours,
      events,
      specials,
      tags,
      photos,
      coupons,
      deliveryInfo,
      dailySpecials
    ] = await Promise.all([
      getBusinessHours(businessId),
      getBusinessMenuItems(businessId),
      getBusinessDrinkMenu(businessId),
      getBusinessHappyHours(businessId),
      getBusinessEvents(businessId),
      getBusinessSpecials(businessId),
      getBusinessTags(businessId),
      getBusinessPhotos(businessId),
      getBusinessCoupons(businessId),
      getBusinessDeliveryInfo(businessId),
      getBusinessDailySpecials(businessId)
    ]);

    return {
      hours,
      menu_items: menuItems,
      drink_menu: drinkMenu,
      happy_hours: happyHours,
      events,
      specials,
      tags,
      photos,
      coupons,
      delivery_info: deliveryInfo,
      daily_specials: dailySpecials
    };
  } catch (error) {
    console.error('Error getting complete business data:', error);
    return null;
  }
}

// ============================================
// EXPORT ALL (for backup)
// ============================================

export async function exportGCRData() {
  const businesses = await getAllGCRBusinesses();
  return {
    exported_at: new Date().toISOString(),
    count: businesses.length,
    businesses
  };
}
