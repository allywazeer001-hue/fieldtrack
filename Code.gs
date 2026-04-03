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
 *  After any code change → Deploy → "Manage deployments" → Edit → New version
 */

const SHEET_DEVICES     = 'Devices';
const SHEET_ASSIGNMENTS = 'Assignments';

const DEVICE_COLS     = ['id','type','notes','createdAt','updatedAt'];
const ASSIGNMENT_COLS = ['id','campName','department','date','notes','deviceIds','createdAt','updatedAt'];

// ── GET ───────────────────────────────────────────────

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'getAll';
  try {
    if (action === 'ping') {
      return json({ ok: true, ts: new Date().toISOString() });
    }
    if (action === 'getAll') {
      return json({
        ok: true,
        devices:     readSheet(SHEET_DEVICES, DEVICE_COLS),
        assignments: readSheet(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS)
      });
    }
    return json({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

// ── POST ──────────────────────────────────────────────

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    // Each operation sends its payload at the top level of body
    // e.g. { action: 'saveDevice', device: {...} }
    //      { action: 'saveAssignment', assignment: {...} }
    //      { action: 'deleteDevice', id: 'DEV-001' }

    switch (action) {

      case 'saveDevice': {
        const device = body.device;
        if (!device || !device.id) return json({ ok: false, error: 'Missing device data' });
        return json({ ok: true, data: upsert(SHEET_DEVICES, DEVICE_COLS, device) });
      }

      case 'saveAssignment': {
        const assignment = body.assignment;
        if (!assignment || !assignment.id) return json({ ok: false, error: 'Missing assignment data' });
        return json({ ok: true, data: upsert(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS, assignment) });
      }

      case 'deleteDevice': {
        const id = body.id;
        if (!id) return json({ ok: false, error: 'Missing id' });
        deleteById(SHEET_DEVICES, id);
        return json({ ok: true });
      }

      case 'deleteAssignment': {
        const id = body.id;
        if (!id) return json({ ok: false, error: 'Missing id' });
        deleteById(SHEET_ASSIGNMENTS, id);
        return json({ ok: true });
      }

      case 'batchSync': {
        // body = { action, devices: [...], assignments: [...] }
        (body.devices     || []).forEach(d => upsert(SHEET_DEVICES,     DEVICE_COLS,     d));
        (body.assignments || []).forEach(a => upsert(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS, a));
        return json({ ok: true });
      }

      default:
        return json({ ok: false, error: 'Unknown POST action: ' + action });
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
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
    return obj;
  }).filter(r => r.id && r.id.trim() !== '');
}

function upsert(sheetName, cols, obj) {
  const sh = ensureSheet(sheetName, cols);

  // Serialize deviceIds array → comma-separated string for sheet storage
  const clean = Object.assign({}, obj);
  if (Array.isArray(clean.deviceIds)) {
    clean.deviceIds = clean.deviceIds.join(',');
  }

  clean.updatedAt = new Date().toISOString();
  if (!clean.createdAt) clean.createdAt = clean.updatedAt;

  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idColIdx = headers.indexOf('id'); // 0-based for data array

  // Find existing row and update it
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idColIdx]) === String(clean.id)) {
      const row = cols.map(c => clean[c] !== undefined ? clean[c] : '');
      sh.getRange(r + 1, 1, 1, cols.length).setValues([row]);
      return clean;
    }
  }

  // Not found — append new row
  sh.appendRow(cols.map(c => clean[c] !== undefined ? clean[c] : ''));
  return clean;
}

function deleteById(sheetName, id) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  const idColIdx = data[0].indexOf('id');
  // Delete from bottom to avoid row index shifting
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][idColIdx]) === String(id)) {
      sh.deleteRow(r + 1);
      return;
    }
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Manual init (run once from script editor if needed) ─
function initSheets() {
  ensureSheet(SHEET_DEVICES, DEVICE_COLS);
  ensureSheet(SHEET_ASSIGNMENTS, ASSIGNMENT_COLS);
  SpreadsheetApp.getUi().alert('Sheets ready!');
}
