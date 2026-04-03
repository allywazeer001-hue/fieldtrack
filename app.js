/* ══════════════════════════════════════════════════════
   FieldTrack — App Logic
   Offline-first PWA with Google Sheets backend sync
══════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────
// BEEP — Web Audio API (no external library needed)
// ─────────────────────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // iOS requires resume after user gesture
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function playBeep(type = 'success') {
  try {
    const ctx = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;

    if (type === 'success') {
      // Two-tone rising beep — satisfying confirm sound
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(1320, t + 0.08);
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.start(t); osc.stop(t + 0.22);
    } else if (type === 'warning') {
      // Double low-high
      osc.frequency.setValueAtTime(500, t);
      osc.frequency.setValueAtTime(700, t + 0.1);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t); osc.stop(t + 0.25);
    } else {
      // Error — low buzz
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t); osc.stop(t + 0.3);
    }
  } catch (e) { /* audio not supported — silent fallback */ }
}

// ─────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────
const Settings = {
  _key: 'ft_settings',
  get() { return JSON.parse(localStorage.getItem(this._key) || '{}'); },
  set(patch) { localStorage.setItem(this._key, JSON.stringify({ ...this.get(), ...patch })); },
  gasUrl() { return this.get().gasUrl || ''; },
  lastSync() { return this.get().lastSync || null; },
  setLastSync(ts) { this.set({ lastSync: ts }); }
};

// ─────────────────────────────────────────────────────
// DB — LocalStorage layer (source of truth for UI)
// ─────────────────────────────────────────────────────
const DB = {
  K: { DEVICES: 'ft_devices', ASSIGNMENTS: 'ft_assignments' },
  get devices()      { return JSON.parse(localStorage.getItem(this.K.DEVICES) || '[]'); },
  set devices(v)     { localStorage.setItem(this.K.DEVICES, JSON.stringify(v)); },
  get assignments()  { return JSON.parse(localStorage.getItem(this.K.ASSIGNMENTS) || '[]'); },
  set assignments(v) { localStorage.setItem(this.K.ASSIGNMENTS, JSON.stringify(v)); },

  addDevice(d) {
    const a = this.devices;
    d.updatedAt = d.updatedAt || d.createdAt;
    a.push(d);
    this.devices = a;
    enqueueOp('saveDevice', { device: d });
  },
  addAssignment(a) {
    const all = this.assignments;
    a.updatedAt = a.updatedAt || a.createdAt;
    all.push(a);
    this.assignments = all;
    enqueueOp('saveAssignment', { assignment: a });
  },
  getDevice(id)     { return this.devices.find(d => d.id === id); },
  getAssignment(id) { return this.assignments.find(a => a.id === id); },

  updateAssignment(id, patch) {
    const all = this.assignments;
    const i = all.findIndex(a => a.id === id);
    if (i >= 0) {
      all[i] = { ...all[i], ...patch, updatedAt: new Date().toISOString() };
      this.assignments = all;
      enqueueOp('saveAssignment', { assignment: all[i] });
      return all[i];
    }
  },
  deleteDevice(id) {
    this.devices = this.devices.filter(d => d.id !== id);
    this.assignments = this.assignments.map(a => ({
      ...a, deviceIds: a.deviceIds.filter(x => x !== id)
    }));
    enqueueOp('deleteDevice', { id });
  },
  deleteAssignment(id) {
    this.assignments = this.assignments.filter(a => a.id !== id);
    enqueueOp('deleteAssignment', { id });
  },

  nextDeviceNum() {
    const nums = this.devices.map(d => d.id).filter(id => /^DEV-\d+$/.test(id))
      .map(id => parseInt(id.replace('DEV-', ''), 10));
    return nums.length ? Math.max(...nums) + 1 : 1;
  },
  nextAssignmentNum() {
    const nums = this.assignments.map(a => a.id).filter(id => /^ASG-\d+$/.test(id))
      .map(id => parseInt(id.replace('ASG-', ''), 10));
    return nums.length ? Math.max(...nums) + 1 : 1;
  }
};

// ─────────────────────────────────────────────────────
// SYNC QUEUE — offline operations waiting to push
// ─────────────────────────────────────────────────────
const Queue = {
  _key: 'ft_sync_queue',
  get() { return JSON.parse(localStorage.getItem(this._key) || '[]'); },
  save(q) { localStorage.setItem(this._key, JSON.stringify(q)); },
  push(op) { const q = this.get(); q.push(op); this.save(q); },
  clear() { localStorage.removeItem(this._key); },
  length() { return this.get().length; }
};

let _drainInProgress = false;

function enqueueOp(action, payload) {
  Queue.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2),
    action,
    payload,
    ts: new Date().toISOString(),
    retries: 0
  });
  updateSyncStatus();
  // Push to Sheets immediately if online
  if (navigator.onLine && Settings.gasUrl()) {
    setTimeout(drainQueue, 200);
  }
}

async function drainQueue() {
  if (_drainInProgress) return;
  const gasUrl = Settings.gasUrl();
  if (!gasUrl || !navigator.onLine) return;

  const queue = Queue.get();
  if (!queue.length) return;

  _drainInProgress = true;
  setSyncState('syncing');

  const failed = [];
  for (const op of queue) {
    try {
      // Build the correct POST body for each action type
      let body;
      if (op.action === 'saveDevice')      body = { action: op.action, device:     op.payload.device };
      else if (op.action === 'saveAssignment') body = { action: op.action, assignment: op.payload.assignment };
      else if (op.action === 'deleteDevice')   body = { action: op.action, id: op.payload.id };
      else if (op.action === 'deleteAssignment') body = { action: op.action, id: op.payload.id };
      else body = { action: op.action, ...op.payload };

      const res = await gasPostRaw(body);
      if (!res.ok) throw new Error(res.error || 'Server error');
    } catch (e) {
      console.warn('[Sync] op failed:', op.action, e.message);
      op.retries = (op.retries || 0) + 1;
      if (op.retries < 5) failed.push(op);
    }
  }

  Queue.save(failed);
  _drainInProgress = false;

  if (failed.length === 0) {
    Settings.setLastSync(new Date().toISOString());
    setSyncState('online');
  } else {
    setSyncState('error');
  }
  updateSyncStatus();
}

// ─────────────────────────────────────────────────────
// API — Google Apps Script
// ─────────────────────────────────────────────────────
async function gasGet(action) {
  const url = Settings.gasUrl();
  if (!url) throw new Error('No Google Sheets URL configured');
  const res = await fetch(`${url}?action=${encodeURIComponent(action)}`, {
    redirect: 'follow',
    cache: 'no-store'
  });
  return res.json();
}

// Post a pre-built body object (drainQueue builds the body)
async function gasPostRaw(bodyObj) {
  const url = Settings.gasUrl();
  if (!url) throw new Error('No Google Sheets URL configured');
  // Content-Type text/plain avoids CORS preflight on GAS
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(bodyObj),
    redirect: 'follow'
  });
  return res.json();
}

let _syncInProgress = false;

async function syncNow(silent = false) {
  const gasUrl = Settings.gasUrl();
  if (!gasUrl) {
    if (!silent) toast('No Google Sheets URL — configure in Settings', 'warning');
    return;
  }
  if (!navigator.onLine) {
    if (!silent) toast('You are offline — changes saved locally', 'warning');
    return;
  }
  if (_syncInProgress) return;
  _syncInProgress = true;
  setSyncState('syncing');

  try {
    // 1. Push any pending local changes first
    await drainQueue();

    // 2. Pull latest from Sheets
    const data = await gasGet('getAll');
    if (!data.ok) throw new Error(data.error || 'Sync failed');

    // 3. Merge remote into local (last updatedAt wins)
    mergeRemote(data.devices || [], data.assignments || []);
    Settings.setLastSync(new Date().toISOString());
    setSyncState('online');
    updateSyncStatus();
    renderCurrentView();
    if (!silent) toast('Synced with Google Sheets', 'success');
  } catch (e) {
    setSyncState('error');
    if (!silent) toast('Sync failed: ' + e.message, 'error');
    console.warn('[Sync] failed:', e);
  } finally {
    _syncInProgress = false;
  }
}

function mergeRemote(remoteDevices, remoteAssignments) {
  // Merge devices: last updatedAt wins
  const localDevs = DB.devices;
  const devMap = {};
  localDevs.forEach(d => { devMap[d.id] = d; });
  remoteDevices.forEach(rd => {
    if (!devMap[rd.id] || (rd.updatedAt || '') >= (devMap[rd.id].updatedAt || '')) {
      devMap[rd.id] = rd;
    }
  });
  DB.devices = Object.values(devMap);

  // Merge assignments
  const localAsgns = DB.assignments;
  const asgnMap = {};
  localAsgns.forEach(a => { asgnMap[a.id] = a; });
  remoteAssignments.forEach(ra => {
    // deviceIds is stored as comma-separated string in Sheets
    if (typeof ra.deviceIds === 'string') {
      ra.deviceIds = ra.deviceIds ? ra.deviceIds.split(',').map(s => s.trim()).filter(Boolean) : [];
    }
    if (!asgnMap[ra.id] || (ra.updatedAt || '') >= (asgnMap[ra.id].updatedAt || '')) {
      asgnMap[ra.id] = ra;
    }
  });
  DB.assignments = Object.values(asgnMap);
}

async function forcePull() {
  if (!confirm('This will overwrite all local data with the data from Google Sheets. Continue?')) return;
  const gasUrl = Settings.gasUrl();
  if (!gasUrl) { toast('No Google Sheets URL configured', 'error'); return; }
  setSyncState('syncing');
  try {
    const data = await gasGet('getAll');
    if (!data.ok) throw new Error(data.error);
    const devs = (data.devices || []);
    const asgns = (data.assignments || []).map(a => ({
      ...a,
      deviceIds: typeof a.deviceIds === 'string'
        ? a.deviceIds.split(',').map(s => s.trim()).filter(Boolean)
        : (a.deviceIds || [])
    }));
    DB.devices = devs;
    DB.assignments = asgns;
    Queue.clear();
    Settings.setLastSync(new Date().toISOString());
    setSyncState('online');
    updateSyncStatus();
    renderCurrentView();
    closeModal('modalSettings');
    toast('Pulled from Google Sheets', 'success');
  } catch (e) {
    setSyncState('error');
    toast('Pull failed: ' + e.message, 'error');
  }
}

async function testConnection() {
  const url = document.getElementById('settingsGasUrl').value.trim();
  if (!url) { toast('Enter a URL first', 'warning'); return; }
  const el = document.getElementById('pingResult');
  el.className = 'ping-result'; el.textContent = 'Testing…'; el.classList.remove('hidden');
  try {
    const res = await fetch(`${url}?action=ping`, { redirect: 'follow', cache: 'no-store' });
    const data = await res.json();
    if (data.ok) {
      el.className = 'ping-result ok'; el.textContent = '✓ Connected! Google Sheets is reachable.';
    } else {
      el.className = 'ping-result err'; el.textContent = '✗ ' + (data.error || 'Unknown error');
    }
  } catch (e) {
    el.className = 'ping-result err'; el.textContent = '✗ ' + e.message;
  }
}

async function saveSettings() {
  const url = document.getElementById('settingsGasUrl').value.trim();
  Settings.set({ gasUrl: url });
  closeModal('modalSettings');
  toast('Settings saved — pulling data from Sheets…', 'success');

  if (url && navigator.onLine) {
    // Clear local demo data and pull real data from Sheets
    setSyncState('syncing');
    try {
      const data = await gasGet('getAll');
      if (data.ok) {
        // Full overwrite — this device is now joining the shared dataset
        const devs  = data.devices || [];
        const asgns = (data.assignments || []).map(a => ({
          ...a,
          deviceIds: typeof a.deviceIds === 'string'
            ? a.deviceIds.split(',').map(s => s.trim()).filter(Boolean)
            : (a.deviceIds || [])
        }));
        DB.devices     = devs;
        DB.assignments = asgns;
        Queue.clear(); // local queue is irrelevant after full pull
        Settings.setLastSync(new Date().toISOString());
        setSyncState('online');
        updateSyncStatus();
        renderCurrentView();
        toast(`Loaded ${devs.length} devices, ${asgns.length} assignments from Sheets`, 'success', 4000);
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (e) {
      setSyncState('error');
      toast('Could not pull from Sheets: ' + e.message, 'error');
    }
  }
}

function clearLocalData() {
  if (!confirm('Delete all local data? This cannot be undone.')) return;
  DB.devices = [];
  DB.assignments = [];
  Queue.clear();
  closeModal('modalSettings');
  renderCurrentView();
  toast('Local data cleared', 'success');
}

// ─────────────────────────────────────────────────────
// SYNC STATUS UI
// ─────────────────────────────────────────────────────
function setSyncState(state) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if (!dot || !label) return;
  dot.className = 'sync-dot ' + state;
  const map = {
    online:  'Synced',
    syncing: 'Syncing…',
    offline: 'Offline',
    error:   'Sync error',
    pending: 'Pending'
  };
  label.textContent = map[state] || state;
}

function updateSyncStatus() {
  const qLen = Queue.length();
  const isOnline = navigator.onLine;
  const gasUrl = Settings.gasUrl();
  const lastSync = Settings.lastSync();

  if (!gasUrl) {
    setSyncState('offline');
    document.getElementById('syncLabel').textContent = 'No sync';
  } else if (!isOnline) {
    setSyncState('offline');
    document.getElementById('syncLabel').textContent = qLen ? `Offline (${qLen} pending)` : 'Offline';
  } else if (qLen > 0) {
    setSyncState('pending');
    document.getElementById('syncLabel').textContent = `${qLen} pending`;
  } else if (lastSync) {
    setSyncState('online');
    const mins = Math.round((Date.now() - new Date(lastSync).getTime()) / 60000);
    document.getElementById('syncLabel').textContent = mins < 1 ? 'Just synced' : `${mins}m ago`;
  } else {
    setSyncState('online');
    document.getElementById('syncLabel').textContent = gasUrl ? 'Ready' : 'No sync';
  }

  // Also update settings modal queue status if open
  const qs = document.getElementById('queueStatus');
  if (qs) qs.textContent = qLen > 0
    ? `${qLen} operation${qLen !== 1 ? 's' : ''} pending sync`
    : 'All synced ✓';

  // Sidebar status
  const ss = document.getElementById('sidebarSyncStatus');
  if (ss) ss.textContent = gasUrl
    ? (isOnline ? 'Sheets connected' : 'Offline mode')
    : 'Local only — add Sheets URL';
}

// ─────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────
const State = {
  view: 'dashboard',
  scanSession: null,
  html5Scanner: null,
  cameraActive: false,
  currentDeviceId: null,
  currentAssignmentId: null,
  reportData: null,
  installPrompt: null
};

// ─────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────
function genId(prefix, num) { return `${prefix}-${String(num).padStart(3, '0')}`; }
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function deptColor(dept) {
  const map = {
    Registration: '#2563EB', Diagnosis: '#7C3AED',
    Pharmacy: '#059669',     Triage: '#DC2626',
    Laboratory: '#D97706',   Nursing: '#0891B2', Other: '#64748B'
  };
  return map[dept] || '#64748B';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────
function toast(msg, type = 'default', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${escHtml(msg)}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-fade');
    setTimeout(() => el.remove(), 320);
  }, duration);
}

// ─────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────
const VIEW_TITLES = {
  dashboard: 'Dashboard', devices: 'Devices',
  assignments: 'Assignments', scan: 'Scan Devices', reports: 'Reports'
};

function navigate(view) {
  if (State.view === 'scan' && view !== 'scan') stopScannerCompletely();
  State.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.nav-item, .bn-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  document.getElementById('pageTitle').textContent = VIEW_TITLES[view] || view;
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');

  switch (view) {
    case 'dashboard':   renderDashboard();   break;
    case 'devices':     renderDevices();     break;
    case 'assignments': renderAssignments(); break;
    case 'scan':        renderScanView();    break;
    case 'reports':     renderReports();     break;
  }
}

function renderCurrentView() { navigate(State.view); }

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ─────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────
function renderDashboard() {
  const devices = DB.devices;
  const assignments = DB.assignments;
  const today = todayIso();
  const todayAsgns = assignments.filter(a => a.date === today);
  const todayDevices = todayAsgns.reduce((n, a) => n + a.deviceIds.length, 0);
  const camps = [...new Set(assignments.map(a => a.campName))].length;

  document.getElementById('dashStats').innerHTML = `
    <div class="stat-card">
      <div class="stat-icon blue">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18" stroke-width="3" stroke-linecap="round"/></svg>
      </div>
      <div class="stat-value">${devices.length}</div>
      <div class="stat-label">Total Devices</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon sky">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
      </div>
      <div class="stat-value">${assignments.length}</div>
      <div class="stat-label">Total Assignments</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon green">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="stat-value">${todayDevices}</div>
      <div class="stat-label">Assigned Today</div>
      <div class="stat-sub">${todayAsgns.length} assignment${todayAsgns.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon amber">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      </div>
      <div class="stat-value">${camps}</div>
      <div class="stat-label">Unique Camps</div>
    </div>`;

  const recent = [...assignments].reverse().slice(0, 5);
  const rows = recent.length
    ? recent.map(a => `<tr style="cursor:pointer" onclick="openAssignmentDetail('${a.id}')">
        <td><strong>${escHtml(a.campName)}</strong></td>
        <td><span class="badge badge-blue">${escHtml(a.department)}</span></td>
        <td>${fmtDate(a.date)}</td>
        <td><strong>${a.deviceIds.length}</strong></td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="table-empty">No assignments yet.</td></tr>`;

  document.getElementById('dashRecentAssignments').innerHTML = `
    <table class="table">
      <thead><tr><th>Camp</th><th>Department</th><th>Date</th><th>Devices</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─────────────────────────────────────────────────────
// DEVICES
// ─────────────────────────────────────────────────────
function renderDevices() {
  const q = (document.getElementById('deviceSearch')?.value || '').toLowerCase();
  const t = document.getElementById('deviceTypeFilter')?.value || '';
  let devices = DB.devices;
  if (q) devices = devices.filter(d => d.id.toLowerCase().includes(q) || (d.notes||'').toLowerCase().includes(q));
  if (t) devices = devices.filter(d => d.type === t);

  const grid = document.getElementById('devicesGrid');
  if (!devices.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--text-3)">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 12px;display:block;opacity:.4"><rect x="5" y="2" width="14" height="20" rx="2"/></svg>
      <p>No devices found.</p>
      <button class="btn btn-primary" style="margin-top:12px" onclick="openModal('modalRegisterDevice')">Register first device</button>
    </div>`;
    return;
  }
  grid.innerHTML = devices.map(d => {
    const isAssigned = DB.assignments.some(a => a.deviceIds.includes(d.id));
    return `<div class="device-card" onclick="openDeviceDetail('${d.id}')">
      <div class="device-card-top">
        <div>
          <div class="device-id">${escHtml(d.id)}</div>
          <div class="device-type">${escHtml(d.type)}</div>
        </div>
        <div class="device-qr-thumb" id="qr-thumb-${d.id}"></div>
      </div>
      ${isAssigned
        ? `<span class="badge badge-green">Assigned</span>`
        : `<span class="badge badge-gray">Unassigned</span>`}
      ${d.notes ? `<div style="font-size:12px;color:var(--text-3);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.notes)}</div>` : ''}
    </div>`;
  }).join('');

  devices.forEach(d => {
    const el = document.getElementById(`qr-thumb-${d.id}`);
    if (el && window.QRCode) {
      try { new QRCode(el, { text: d.id, width: 44, height: 44, correctLevel: QRCode.CorrectLevel.L }); }
      catch(e) {}
    }
  });
}

function registerDevice() {
  const type = document.getElementById('regDeviceType').value;
  if (!type) { toast('Please select a device type', 'warning'); return; }
  const qty = Math.max(1, Math.min(100, parseInt(document.getElementById('regQty').value) || 1));
  const customId = document.getElementById('regDeviceId').value.trim();
  const notes = document.getElementById('regNotes').value.trim();

  if (qty === 1 && customId) {
    if (DB.getDevice(customId)) { toast(`Device ID "${customId}" already exists`, 'error'); return; }
    DB.addDevice({ id: customId, type, notes, createdAt: new Date().toISOString() });
    toast(`Device ${customId} registered`, 'success');
  } else {
    for (let i = 0; i < qty; i++) {
      DB.addDevice({ id: genId('DEV', DB.nextDeviceNum()), type, notes, createdAt: new Date().toISOString() });
    }
    toast(`${qty} device${qty > 1 ? 's' : ''} registered`, 'success');
  }
  closeModal('modalRegisterDevice');
  ['regDeviceId','regNotes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('regDeviceType').value = '';
  document.getElementById('regQty').value = '1';
  renderDevices();
  if (State.view === 'dashboard') renderDashboard();
}

function openDeviceDetail(id) {
  const d = DB.getDevice(id);
  if (!d) return;
  State.currentDeviceId = id;
  const assignments = DB.assignments.filter(a => a.deviceIds.includes(id));
  const asgHtml = assignments.length
    ? assignments.map(a => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-light)">
          <span style="width:4px;height:32px;background:${deptColor(a.department)};border-radius:4px;flex-shrink:0"></span>
          <div>
            <div style="font-weight:600;font-size:13px">${escHtml(a.campName)}</div>
            <div style="font-size:11px;color:var(--text-3)">${escHtml(a.department)} · ${fmtDate(a.date)}</div>
          </div>
        </div>`).join('')
    : '<p style="font-size:13px;color:var(--text-3)">Not assigned to any camp yet.</p>';

  document.getElementById('deviceDetailBody').innerHTML = `
    <div class="detail-grid">
      <div>
        <div class="detail-field"><label>Device ID</label><span style="font-size:18px;font-weight:800">${escHtml(d.id)}</span></div>
        <div class="detail-field"><label>Type</label><span><span class="badge badge-blue">${escHtml(d.type)}</span></span></div>
        <div class="detail-field"><label>Registered</label><span>${fmtDate(d.createdAt?.slice(0,10))}</span></div>
        ${d.notes ? `<div class="detail-field"><label>Notes</label><span>${escHtml(d.notes)}</span></div>` : ''}
      </div>
      <div class="detail-qr-wrap">
        <div id="detailQrCode"></div>
        <div class="detail-qr-label">${escHtml(d.id)}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="detail-assignments">
      <h4>Assignment History (${assignments.length})</h4>
      ${asgHtml}
    </div>`;

  openModal('modalDeviceDetail');
  setTimeout(() => {
    const el = document.getElementById('detailQrCode');
    if (el && window.QRCode) {
      el.innerHTML = '';
      try { new QRCode(el, { text: d.id, width: 128, height: 128, correctLevel: QRCode.CorrectLevel.H }); }
      catch(e) {}
    }
  }, 50);
}

function deleteCurrentDevice() {
  if (!State.currentDeviceId) return;
  if (!confirm(`Delete device ${State.currentDeviceId}? This cannot be undone.`)) return;
  DB.deleteDevice(State.currentDeviceId);
  closeModal('modalDeviceDetail');
  toast(`Device ${State.currentDeviceId} deleted`, 'success');
  renderDevices();
  if (State.view === 'dashboard') renderDashboard();
}

function printQR() {
  const id = State.currentDeviceId;
  if (!id) return;
  const win = window.open('', '_blank', 'width=400,height=350');
  win.document.write(`
    <html><head><title>QR — ${id}</title></head>
    <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:10px">
    <div id="pqr"></div>
    <p style="font-size:18px;font-weight:bold;margin:0">${id}</p>
    <p style="font-size:12px;color:#666;margin:0">FieldTrack</p>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
    <script>new QRCode(document.getElementById('pqr'),{text:'${id}',width:200,height:200});setTimeout(()=>window.print(),600);<\/script>
    </body></html>`);
  win.document.close();
}

// ─────────────────────────────────────────────────────
// ASSIGNMENTS
// ─────────────────────────────────────────────────────
function renderAssignments() {
  const q = (document.getElementById('assignSearch')?.value || '').toLowerCase();
  const dateF = document.getElementById('assignDateFilter')?.value || '';
  let asgns = [...DB.assignments].reverse();
  if (q) asgns = asgns.filter(a => a.campName.toLowerCase().includes(q) || a.department.toLowerCase().includes(q));
  if (dateF) asgns = asgns.filter(a => a.date === dateF);

  const list = document.getElementById('assignmentsList');
  if (!asgns.length) {
    list.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-3)">
      <p>No assignments found.</p>
      <button class="btn btn-primary" style="margin-top:12px" onclick="openModal('modalCreateAssignment')">Create first assignment</button>
    </div>`;
    return;
  }
  list.innerHTML = asgns.map(a => `
    <div class="assignment-card" onclick="openAssignmentDetail('${a.id}')">
      <div class="asgn-color-bar" style="background:${deptColor(a.department)}"></div>
      <div class="asgn-info">
        <div class="asgn-title">${escHtml(a.campName)}</div>
        <div class="asgn-meta">${escHtml(a.department)} · ${fmtDate(a.date)}</div>
        ${a.notes ? `<div style="font-size:11px;color:var(--text-3);margin-top:3px">${escHtml(a.notes)}</div>` : ''}
      </div>
      <div class="asgn-count">
        <div class="asgn-count-num">${a.deviceIds.length}</div>
        <div class="asgn-count-label">devices</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-3)"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`).join('');
}

function createAssignment() {
  const camp = document.getElementById('asgCamp').value.trim();
  const dept = document.getElementById('asgDept').value;
  const date = document.getElementById('asgDate').value || todayIso();
  const notes = document.getElementById('asgNotes').value.trim();
  if (!camp) { toast('Camp name is required', 'warning'); return; }
  if (!dept) { toast('Please select a department', 'warning'); return; }

  const id = genId('ASG', DB.nextAssignmentNum());
  DB.addAssignment({ id, campName: camp, department: dept, date, notes, deviceIds: [], createdAt: new Date().toISOString() });
  toast(`Assignment ${id} created`, 'success');
  closeModal('modalCreateAssignment');
  ['asgCamp','asgNotes'].forEach(k => document.getElementById(k).value = '');
  document.getElementById('asgDept').value = '';
  document.getElementById('asgDate').value = '';

  if (State.view === 'assignments') renderAssignments();
  if (State.view === 'dashboard') renderDashboard();
  if (State.view === 'scan') populateScanSelector();
}

function openAssignmentDetail(id) {
  const a = DB.getAssignment(id);
  if (!a) return;
  State.currentAssignmentId = id;
  const deviceRows = a.deviceIds.length
    ? a.deviceIds.map(did => {
        const d = DB.getDevice(did);
        return `<tr><td><strong>${escHtml(did)}</strong></td><td>${escHtml(d?.type||'—')}</td><td>${escHtml(d?.notes||'—')}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="table-empty">No devices assigned yet.</td></tr>';

  document.getElementById('assignmentDetailBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:16px">
      <div class="detail-field"><label>ID</label><span style="font-weight:700">${escHtml(a.id)}</span></div>
      <div class="detail-field"><label>Date</label><span>${fmtDate(a.date)}</span></div>
      <div class="detail-field"><label>Camp</label><span>${escHtml(a.campName)}</span></div>
      <div class="detail-field"><label>Department</label>
        <span class="badge" style="background:${deptColor(a.department)}20;color:${deptColor(a.department)}">${escHtml(a.department)}</span>
      </div>
    </div>
    ${a.notes ? `<div class="detail-field"><label>Notes</label><span>${escHtml(a.notes)}</span></div><div class="divider"></div>` : ''}
    <h4 style="font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
      Assigned Devices (${a.deviceIds.length})
    </h4>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Device ID</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>${deviceRows}</tbody>
      </table>
    </div>`;
  openModal('modalAssignmentDetail');
}

function deleteCurrentAssignment() {
  if (!State.currentAssignmentId) return;
  if (!confirm('Delete this assignment? This cannot be undone.')) return;
  DB.deleteAssignment(State.currentAssignmentId);
  closeModal('modalAssignmentDetail');
  toast('Assignment deleted', 'success');
  renderAssignments();
  if (State.view === 'dashboard') renderDashboard();
}

function scanIntoCurrentAssignment() {
  const id = State.currentAssignmentId;
  if (!id) return;
  closeModal('modalAssignmentDetail');
  navigate('scan');
  setTimeout(() => {
    const sel = document.getElementById('scanAssignmentSelect');
    if (sel) { sel.value = id; onScanAssignmentChange(); }
  }, 100);
}

// ─────────────────────────────────────────────────────
// SCAN
// ─────────────────────────────────────────────────────
function renderScanView() {
  populateScanSelector();
  if (!State.scanSession) showScanIdle();
}

function populateScanSelector() {
  const sel = document.getElementById('scanAssignmentSelect');
  if (!sel) return;
  const current = State.scanSession?.assignmentId || sel.value;
  const asgns = [...DB.assignments].reverse();
  sel.innerHTML = '<option value="">— Select Assignment —</option>' +
    asgns.map(a => `<option value="${a.id}" ${a.id === current ? 'selected' : ''}>
      ${escHtml(a.campName)} · ${escHtml(a.department)} · ${fmtDate(a.date)}
    </option>`).join('');
}

function onScanAssignmentChange() {
  document.getElementById('btnStartScan').disabled = !document.getElementById('scanAssignmentSelect').value;
}

function startScanSession() {
  const aId = document.getElementById('scanAssignmentSelect').value;
  if (!aId) { toast('Select an assignment first', 'warning'); return; }
  const asgn = DB.getAssignment(aId);
  if (!asgn) return;

  State.scanSession = { assignmentId: aId, scannedIds: new Set(asgn.deviceIds) };
  document.getElementById('scanAssignmentContent').classList.add('hidden');
  document.getElementById('scanActiveAssignment').classList.remove('hidden');
  document.getElementById('activeAsgnBadge').innerHTML = `
    <div class="asgn-badge-title">${escHtml(asgn.campName)}</div>
    <div class="asgn-badge-sub">${escHtml(asgn.department)} · ${fmtDate(asgn.date)}</div>`;

  updateScanCounter();
  clearFeed();
  document.getElementById('clearFeedBtn').style.display = '';
  document.getElementById('scanStatusBar').classList.remove('hidden');
  document.getElementById('scanIdle').classList.add('hidden');
  document.getElementById('reader').classList.remove('hidden');
  startCamera();
}

function endScanSession() {
  if (State.scanSession) {
    const count = State.scanSession.scannedIds.size;
    toast(`Session ended — ${count} device${count !== 1 ? 's' : ''} recorded`, 'success');
  }
  stopScannerCompletely();
  State.scanSession = null;
  document.getElementById('scanAssignmentContent').classList.remove('hidden');
  document.getElementById('scanActiveAssignment').classList.add('hidden');
  document.getElementById('btnStartScan').disabled = true;
  const sel = document.getElementById('scanAssignmentSelect');
  if (sel) sel.value = '';
  showScanIdle();
  document.getElementById('scanStatusBar').classList.add('hidden');
  document.getElementById('scanCount').textContent = '0';
}

function showScanIdle() {
  document.getElementById('scanIdle').classList.remove('hidden');
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('reader').innerHTML = '';
}

function startCamera() {
  if (State.cameraActive) return;
  if (!State.scanSession) { toast('Start a session first', 'warning'); return; }
  document.getElementById('reader').innerHTML = '';
  try {
    State.html5Scanner = new Html5Qrcode('reader');
    State.html5Scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      text => handleScan(text),
      () => {}
    ).then(() => {
      State.cameraActive = true;
      document.getElementById('scanStatusText').textContent = 'Camera active — point at QR code';
      document.getElementById('btnStopCamera').style.display = '';
      document.getElementById('btnStartCamera').style.display = 'none';
    }).catch(err => cameraFallback(err));
  } catch (err) {
    cameraFallback(err);
  }
}

function cameraFallback(err) {
  console.warn('Camera unavailable:', err);
  document.getElementById('scanStatusText').textContent = 'Camera unavailable — use manual entry';
  document.getElementById('btnStopCamera').style.display = 'none';
  document.getElementById('btnStartCamera').style.display = '';
  document.getElementById('reader').innerHTML = `
    <div style="padding:30px;text-align:center;color:rgba(255,255,255,.5)">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 10px;display:block"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      <p style="font-size:13px">Camera not available.<br>Use the manual entry field.</p>
    </div>`;
}

function stopCamera() {
  if (State.html5Scanner && State.cameraActive) {
    State.html5Scanner.stop().then(() => {
      State.cameraActive = false;
      document.getElementById('btnStopCamera').style.display = 'none';
      document.getElementById('btnStartCamera').style.display = '';
      document.getElementById('scanStatusText').textContent = 'Camera stopped';
    }).catch(() => {});
  }
}

function stopScannerCompletely() {
  if (State.html5Scanner) {
    try { if (State.cameraActive) State.html5Scanner.stop().catch(() => {}); }
    catch(e) {}
    State.html5Scanner = null;
  }
  State.cameraActive = false;
}

// Debounce: ignore camera re-fires for 2.5s after any scan result
let _lastScanTime = 0;
let _lastScanId   = '';

function handleScan(text) {
  if (!State.scanSession) return;
  const id  = text.trim();
  const now = Date.now();
  // Ignore if same code scanned within 2.5 seconds (camera fires continuously)
  if (id === _lastScanId && (now - _lastScanTime) < 2500) return;
  _lastScanTime = now;
  _lastScanId   = id;
  processScanResult(id);
}

function manualScan() {
  if (!State.scanSession) { toast('Start a session first', 'warning'); return; }
  const input = document.getElementById('manualDeviceId');
  const id = input.value.trim();
  if (!id) return;
  processScanResult(id);
  input.value = '';
  input.focus();
}

function processScanResult(deviceId) {
  if (!State.scanSession) return;

  const device = DB.getDevice(deviceId);
  if (!device) {
    playBeep('error');
    addFeedItem(deviceId, 'err', 'Device not registered');
    showScanFlash('red', `✕  Not found: ${deviceId}`);
    return;
  }

  if (State.scanSession.scannedIds.has(deviceId)) {
    playBeep('warning');
    addFeedItem(deviceId, 'warn', 'Already in this session');
    showScanFlash('orange', `⚠  Already scanned: ${deviceId}`);
    return;
  }

  const otherAsgn = DB.assignments.find(a =>
    a.id !== State.scanSession.assignmentId &&
    a.deviceIds.includes(deviceId) &&
    a.date === todayIso()
  );

  State.scanSession.scannedIds.add(deviceId);
  const asgn = DB.getAssignment(State.scanSession.assignmentId);
  if (!asgn.deviceIds.includes(deviceId)) {
    DB.updateAssignment(State.scanSession.assignmentId, {
      deviceIds: [...asgn.deviceIds, deviceId]
    });
  }

  playBeep('success');
  addFeedItem(deviceId, 'ok', `${device.type} — added`);
  updateScanCounter();

  const msg = otherAsgn
    ? `✓  ${deviceId}  (also in ${otherAsgn.department})`
    : `✓  ${deviceId} — ${device.type}`;
  showScanFlash(otherAsgn ? 'orange' : 'green', msg);
}

// Full-screen flash confirmation — disappears after 1.2s
function showScanFlash(color, message) {
  const colors = {
    green:  { bg: '#10B981', text: '#fff' },
    orange: { bg: '#F59E0B', text: '#fff' },
    red:    { bg: '#EF4444', text: '#fff' }
  };
  const c = colors[color] || colors.green;

  let el = document.getElementById('scanFlash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'scanFlash';
    el.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;
      display:flex;align-items:center;justify-content:center;
      flex-direction:column;gap:10px;pointer-events:none;
      font-size:22px;font-weight:800;letter-spacing:.02em;
      transition:opacity .3s ease;
    `;
    document.body.appendChild(el);
  }

  el.style.background = c.bg;
  el.style.color = c.text;
  el.style.opacity = '1';
  el.textContent = message;

  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => { el.style.background = 'transparent'; }, 300);
  }, 1000);
}

function addFeedItem(id, status, msg) {
  const feed = document.getElementById('scanFeed');
  if (feed.querySelector('p')) feed.innerHTML = '';
  const icons = { ok: '✓', warn: '⚠', err: '✕' };
  const el = document.createElement('div');
  el.className = 'scan-feed-item';
  el.innerHTML = `
    <div class="feed-icon ${status}">${icons[status]}</div>
    <div>
      <div class="feed-id">${escHtml(id)}</div>
      <div class="feed-meta">${escHtml(msg)}</div>
    </div>
    <div class="feed-time">${nowTime()}</div>`;
  feed.insertBefore(el, feed.firstChild);
}

function updateScanCounter() {
  if (!State.scanSession) return;
  const count = State.scanSession.scannedIds.size;
  document.getElementById('scanCount').textContent = count;
  document.getElementById('scanCountSub').textContent = `device${count !== 1 ? 's' : ''} recorded`;
}

function clearFeed() {
  document.getElementById('scanFeed').innerHTML = '<p class="text-muted text-center" style="padding:20px">Scanned devices will appear here</p>';
  document.getElementById('clearFeedBtn').style.display = 'none';
}

// ─────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────
function renderReports() {
  const today = todayIso();
  if (!document.getElementById('repDateFrom').value) document.getElementById('repDateFrom').value = today;
  if (!document.getElementById('repDateTo').value) document.getElementById('repDateTo').value = today;
}

function generateReport() {
  const camp = document.getElementById('repCamp').value.trim().toLowerCase();
  const dept = document.getElementById('repDept').value;
  const from = document.getElementById('repDateFrom').value;
  const to   = document.getElementById('repDateTo').value;

  let data = DB.assignments;
  if (camp) data = data.filter(a => a.campName.toLowerCase().includes(camp));
  if (dept) data = data.filter(a => a.department === dept);
  if (from) data = data.filter(a => a.date >= from);
  if (to)   data = data.filter(a => a.date <= to);
  State.reportData = data;

  const totalDevices = data.reduce((n, a) => n + a.deviceIds.length, 0);
  const camps = [...new Set(data.map(a => a.campName))].length;
  const depts = [...new Set(data.map(a => a.department))].length;

  document.getElementById('reportStats').innerHTML = `
    <div class="stat-card"><div class="stat-icon blue"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg></div><div class="stat-value">${data.length}</div><div class="stat-label">Assignments</div></div>
    <div class="stat-card"><div class="stat-icon green"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/></svg></div><div class="stat-value">${totalDevices}</div><div class="stat-label">Total Devices</div></div>
    <div class="stat-card"><div class="stat-icon amber"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div><div class="stat-value">${camps}</div><div class="stat-label">Camps</div></div>
    <div class="stat-card"><div class="stat-icon sky"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg></div><div class="stat-value">${depts}</div><div class="stat-label">Departments</div></div>`;

  document.getElementById('reportTableBody').innerHTML = data.map(a => `
    <tr>
      <td><strong>${escHtml(a.campName)}</strong></td>
      <td><span class="badge" style="background:${deptColor(a.department)}20;color:${deptColor(a.department)}">${escHtml(a.department)}</span></td>
      <td>${fmtDate(a.date)}</td>
      <td><strong>${a.deviceIds.length}</strong></td>
      <td style="font-size:11px;color:var(--text-3);max-width:200px;word-break:break-all">${a.deviceIds.join(', ')||'—'}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="table-empty">No results.</td></tr>';

  document.getElementById('reportOutput').classList.remove('hidden');
  toast(`Report ready — ${data.length} assignment${data.length !== 1 ? 's' : ''}`, 'success');
}

function exportPDF() {
  if (!State.reportData || !window.jspdf) { toast('Generate report first', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFillColor(37, 99, 235);
  doc.rect(0, 0, 297, 22, 'F');
  doc.setTextColor(255,255,255);
  doc.setFontSize(14); doc.setFont(undefined,'bold');
  doc.text('FieldTrack — Assignment Report', 14, 14);
  doc.setFontSize(9); doc.setFont(undefined,'normal');
  doc.text(`Generated: ${new Date().toLocaleString()}`, 200, 14);
  doc.setTextColor(0);
  doc.autoTable({
    head: [['Camp','Department','Date','Devices','Device IDs']],
    body: State.reportData.map(a => [a.campName, a.department, fmtDate(a.date), a.deviceIds.length.toString(), a.deviceIds.join(', ')||'—']),
    startY: 28,
    headStyles: { fillColor: [37,99,235], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248,250,252] },
    styles: { fontSize: 9, cellPadding: 4 },
    columnStyles: { 4: { cellWidth: 80 } }
  });
  const total = State.reportData.reduce((n, a) => n + a.deviceIds.length, 0);
  doc.text(`Total: ${State.reportData.length} assignments · ${total} devices`, 14, doc.lastAutoTable.finalY + 8);
  doc.save(`FieldTrack_${todayIso()}.pdf`);
  toast('PDF exported', 'success');
}

function exportExcel() {
  if (!State.reportData || !window.XLSX) { toast('Generate report first', 'error'); return; }
  const rows = State.reportData.map(a => ({
    'Assignment ID': a.id, 'Camp Name': a.campName, 'Department': a.department,
    'Date': fmtDate(a.date), 'Device Count': a.deviceIds.length, 'Device IDs': a.deviceIds.join(', ')
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:12},{wch:20},{wch:15},{wch:12},{wch:12},{wch:50}];
  XLSX.utils.book_append_sheet(wb, ws, 'Assignments');
  const total = rows.reduce((n,r) => n + r['Device Count'], 0);
  const ws2 = XLSX.utils.json_to_sheet([
    {Metric:'Total Assignments',Value:rows.length},
    {Metric:'Total Devices',Value:total},
    {Metric:'Report Date',Value:todayIso()}
  ]);
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');
  XLSX.writeFile(wb, `FieldTrack_${todayIso()}.xlsx`);
  toast('Excel exported', 'success');
}

// ─────────────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');

  if (id === 'modalCreateAssignment') {
    const d = document.getElementById('asgDate');
    if (!d.value) d.value = todayIso();
  }
  if (id === 'modalSettings') {
    document.getElementById('settingsGasUrl').value = Settings.gasUrl();
    document.getElementById('pingResult').classList.add('hidden');
    const qs = document.getElementById('queueStatus');
    const q = Queue.length();
    if (qs) qs.textContent = q > 0
      ? `${q} operation${q !== 1 ? 's' : ''} pending sync`
      : 'All synced ✓';
  }
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  const anyOpen = [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
  if (!anyOpen) document.getElementById('modalOverlay').classList.add('hidden');
}

function closeAllModals(e) {
  if (e.target.id === 'modalOverlay') {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.getElementById('modalOverlay').classList.add('hidden');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.getElementById('modalOverlay').classList.add('hidden');
  }
});

// ─────────────────────────────────────────────────────
// PWA INSTALL
// ─────────────────────────────────────────────────────
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  State.installPrompt = e;
  document.getElementById('installBanner').classList.remove('hidden');
});

function triggerInstall() {
  if (!State.installPrompt) return;
  State.installPrompt.prompt();
  State.installPrompt.userChoice.then(() => {
    State.installPrompt = null;
    document.getElementById('installBanner').classList.add('hidden');
  });
}

function dismissInstall() {
  document.getElementById('installBanner').classList.add('hidden');
}

window.addEventListener('appinstalled', () => {
  document.getElementById('installBanner').classList.add('hidden');
  toast('FieldTrack installed on your device!', 'success', 4000);
});

// ─────────────────────────────────────────────────────
// ONLINE / OFFLINE
// ─────────────────────────────────────────────────────
window.addEventListener('online', () => {
  updateSyncStatus();
  toast('Back online — syncing…', 'success', 2000);
  if (Settings.gasUrl()) syncNow();
});

window.addEventListener('offline', () => {
  updateSyncStatus();
  toast('You are offline — changes saved locally', 'warning', 3000);
});

// ─────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────
async function init() {
  // Unlock audio context on first user interaction (required by iOS/Android)
  document.addEventListener('touchstart', () => getAudioCtx(), { once: true });
  document.addEventListener('click',      () => getAudioCtx(), { once: true });

  updateSyncStatus();

  const gasUrl = Settings.gasUrl();

  if (gasUrl && navigator.onLine) {
    // ── Connected mode: pull from Sheets first, THEN render ──
    // This ensures all devices start with the same data (like WhatsApp)
    setSyncState('syncing');
    document.getElementById('pageTitle').textContent = 'Syncing…';
    try {
      const data = await gasGet('getAll');
      if (data.ok) {
        mergeRemote(data.devices || [], data.assignments || []);
        Settings.setLastSync(new Date().toISOString());
        setSyncState('online');
      }
    } catch (e) {
      setSyncState('error');
      console.warn('[Init] initial pull failed:', e.message);
    }
    // Drain any operations queued while offline
    await drainQueue();
  } else if (!gasUrl && DB.devices.length === 0 && DB.assignments.length === 0) {
    // ── No backend configured: load demo data so app isn't empty ──
    seedDemo();
  }

  navigate('dashboard');
  updateSyncStatus();

  // ── Real-time polling: every 15s (like WhatsApp background sync) ──
  setInterval(() => {
    if (navigator.onLine && Settings.gasUrl() && !_syncInProgress) {
      syncNow(true);
    } else {
      updateSyncStatus();
    }
  }, 15000);

  // Sync when user switches back to the tab/app (phone app-switching)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine && Settings.gasUrl()) {
      syncNow(true);
    }
  });

  // Sync when browser window regains focus (desktop)
  window.addEventListener('focus', () => {
    if (navigator.onLine && Settings.gasUrl()) {
      syncNow(true);
    }
  });
}

// Only used when no backend is configured — gives something to explore
function seedDemo() {
  const types = ['Tablet','Tablet','Tablet','Laptop','Scanner'];
  for (let i = 1; i <= 12; i++) {
    const d = { id: genId('DEV', i), type: types[i % types.length], notes: i % 4 === 0 ? 'Spare unit' : '', createdAt: new Date().toISOString() };
    d.updatedAt = d.createdAt;
    const arr = DB.devices; arr.push(d); DB.devices = arr;
  }
  const depts = ['Registration','Diagnosis','Pharmacy','Triage'];
  const camps = ['Camp Alpha','Camp Beta'];
  let aNum = 1;
  camps.forEach(camp => {
    depts.slice(0, 2).forEach(dept => {
      const deviceIds = DB.devices.slice((aNum-1)*3, (aNum-1)*3+3).map(d => d.id);
      const a = { id: genId('ASG', aNum++), campName: camp, department: dept, date: todayIso(), notes: '', deviceIds, createdAt: new Date().toISOString() };
      a.updatedAt = a.createdAt;
      const arr = DB.assignments; arr.push(a); DB.assignments = arr;
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
