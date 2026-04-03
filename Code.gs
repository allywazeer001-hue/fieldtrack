/**
 * ══════════════════════════════════════════════════════
 *  FieldTrack — Google Apps Script Backend
 *  Paste this entire file into:
 *  Google Sheets → Extensions → Apps Script → Save → Deploy
 * ══════════════════════════════════════════════════════
 *
 *  SETUP STEPS:
 *  1. Open Google Sheets (create a new blank sheet)
 *  2. Extensions → Apps Script
 *  3. Delete the default code, paste this entire file
 *  4. Save (Ctrl+S)
 *  5. Click "Deploy" → "New deployment"
 *  6. Type: Web App
 *  7. Execute as: Me
 *  8. Who has access: Anyone
 *  9. Click Deploy → Authorize → Copy the Web App URL
 * 10. Paste that URL into FieldTrack Settings
 *
 *  The script will auto-create "Devices" and "Assignments" sheets.
 */

const SHEET_DEVICES     = 'Devices';
const SHEET_ASSIGNMENTS = 'Assignments';

const DEVICE_COLS     = ['id','type','notes','createdAt','updatedAt'];
const ASSIGNMENT_COLS = ['id','campName','department','date','notes','deviceIds','createdAt','updatedAt'];

// ── Entry points ──────────────────────────────────────

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'getAll';
  try {
    if (action === 'ping') {
      return json({ ok: true, ts: new Date().toISOString() });
    }
    if (action === 'getAll') {
      return json({
        ok: true,
        devices: readSheet(SHEET_DEVICES, DEVICE_COLS),
        assignments: readSheet(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS)
      });
    }
    return json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    const { action, data } = body;

    switch (action) {
      case 'saveDevice':
        return json({ ok: true, data: upsert(SHEET_DEVICES, DEVICE_COLS, data) });
      case 'saveAssignment':
        return json({ ok: true, data: upsert(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS, data) });
      case 'deleteDevice':
        deleteById(SHEET_DEVICES, data.id);
        return json({ ok: true });
      case 'deleteAssignment':
        deleteById(SHEET_ASSIGNMENTS, data.id);
        return json({ ok: true });
      case 'batchSync':
        // data = { devices: [...], assignments: [...] }
        if (data.devices) {
          data.devices.forEach(d => upsert(SHEET_DEVICES, DEVICE_COLS, d));
        }
        if (data.assignments) {
          data.assignments.forEach(a => upsert(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS, a));
        }
        return json({ ok: true });
      default:
        return json({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return json({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── Sheet Helpers ─────────────────────────────────────

function ensureSheet(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(cols);
    sh.getRange(1, 1, 1, cols.length)
      .setFontWeight('bold')
      .setBackground('#2563EB')
      .setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readSheet(sheetName, cols) {
  const sh = ensureSheet(sheetName, cols);
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  }).filter(r => r.id); // skip blank rows
}

function upsert(sheetName, cols, obj) {
  const sh = ensureSheet(sheetName, cols);
  obj.updatedAt = new Date().toISOString();
  if (!obj.createdAt) obj.createdAt = obj.updatedAt;

  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id') + 1; // 1-based

  // Search existing rows
  for (let r = 2; r <= data.length; r++) {
    if (data[r - 1][idCol - 1] === obj.id) {
      // Update existing row
      const row = cols.map(c => obj[c] !== undefined ? obj[c] : '');
      sh.getRange(r, 1, 1, cols.length).setValues([row]);
      return obj;
    }
  }

  // Append new row
  sh.appendRow(cols.map(c => obj[c] !== undefined ? obj[c] : ''));
  return obj;
}

function deleteById(sheetName, id) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  const idCol = data[0].indexOf('id');
  for (let r = data.length; r >= 2; r--) {
    if (data[r - 1][idCol] === id) {
      sh.deleteRow(r);
      return;
    }
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Utility: Init sheets manually (run once if needed) ─
function initSheets() {
  ensureSheet(SHEET_DEVICES, DEVICE_COLS);
  ensureSheet(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS);
  SpreadsheetApp.getUi().alert('Sheets initialized!');
}
