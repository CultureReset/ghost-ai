/**
 * INSPECT GOOGLE SHEETS STRUCTURE
 * Shows all sheets/tabs and their data structure
 */

import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

console.log('\n🔍 Inspecting Google Sheets Structure...\n');

async function inspectSheets() {
  try {
    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const SPREADSHEET_ID = process.env.GCR_SPREADSHEET_ID;

    // Get spreadsheet metadata
    console.log('📊 Fetching spreadsheet info...\n');

    const metadata = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });

    const spreadsheet = metadata.data;
    console.log(`📝 Spreadsheet: ${spreadsheet.properties.title}`);
    console.log(`🔗 Spreadsheet ID: ${SPREADSHEET_ID}\n`);

    console.log(`📑 Found ${spreadsheet.sheets.length} sheet(s):\n`);

    // List all sheets
    for (const sheet of spreadsheet.sheets) {
      const sheetName = sheet.properties.title;
      const rowCount = sheet.properties.gridProperties.rowCount;
      const colCount = sheet.properties.gridProperties.columnCount;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`📄 Sheet: "${sheetName}"`);
      console.log(`   Rows: ${rowCount} | Columns: ${colCount}`);
      console.log(`${'='.repeat(60)}\n`);

      // Get data from this sheet
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${sheetName}!A1:ZZ10` // Get first 10 rows
        });

        const rows = response.data.values;

        if (!rows || rows.length === 0) {
          console.log('   ⚠️  No data found in this sheet\n');
          continue;
        }

        // Show headers (first row)
        console.log('   📋 Columns (Headers):');
        const headers = rows[0];
        headers.forEach((header, index) => {
          if (header) {
            console.log(`      ${index + 1}. ${header}`);
          }
        });

        // Count rows with data
        console.log(`\n   📊 Data rows: ${rows.length - 1} (showing first 10)`);

        // Show sample data (first 3 data rows)
        if (rows.length > 1) {
          console.log('\n   🔎 Sample data (first 3 rows):\n');

          for (let i = 1; i <= Math.min(3, rows.length - 1); i++) {
            const row = rows[i];
            console.log(`   Row ${i}:`);
            headers.forEach((header, index) => {
              const value = row[index] || '';
              if (header && value) {
                console.log(`      ${header}: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
              }
            });
            console.log('');
          }
        }

        // Get total row count for this sheet
        const fullRange = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${sheetName}!A:A`
        });

        const totalRows = fullRange.data.values ? fullRange.data.values.length - 1 : 0;
        console.log(`   📈 Total data rows in sheet: ${totalRows}\n`);

      } catch (error) {
        console.error(`   ❌ Error reading sheet "${sheetName}":`, error.message);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Inspection complete!\n');

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    console.error('\nDetails:', error);
  }
}

inspectSheets();
