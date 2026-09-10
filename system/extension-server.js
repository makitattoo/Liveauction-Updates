const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9999;
const PRICE_FILE = path.join(os.tmpdir(), 'bidhelper_dom_estimate.txt');
const CURRENT_ASK_PRICE_FILE = path.join(os.tmpdir(), 'bidhelper_current_ask_price.txt');
const BUTTON_STATE_FILE = path.join(os.tmpdir(), 'bidhelper_button_state.txt');
const BUTTON_STATES_FILE = path.join(os.tmpdir(), 'bidhelper_button_states.txt');
const INTERNET_BID_PRICE_FILE = path.join(os.tmpdir(), 'bidhelper_internet_bid_price.txt');
const PRICE_SNAPSHOT_FILE = path.join(os.tmpdir(), 'bidhelper_price_snapshot.json');
const LITE_MODE_FLAG_FILE = path.join(os.tmpdir(), 'bidhelper_lite_mode.txt');

// Command Queue for DOM Injection
let pendingCommands = [];
let nextCommandId = 1;
let commandResults = new Map();

let latestLotId = '';
let activeLotId = '';
let lotSnapshots = Object.create(null);
let latestEstimatePrice = '';
let latestInternetText = '';

function writePriceSnapshot(extra = {}) {
  try {
    fs.writeFileSync(PRICE_SNAPSHOT_FILE, JSON.stringify({
      estimate: latestEstimatePrice || '',
      internet: latestInternetText || '',
      activeLotId: activeLotId || latestLotId || '',
      updatedAt: Date.now(),
      ...extra
    }));
  } catch (_) { }
}

function normalizeLotId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function getSelectedLotId(explicitLotId = '') {
  return normalizeLotId(explicitLotId) || activeLotId || latestLotId || '';
}

function getSnapshotForLot(lotId) {
  const selectedLotId = getSelectedLotId(lotId);
  const snapshot = selectedLotId ? lotSnapshots[selectedLotId] : null;

  return {
    states: snapshot?.states || {},
    updatedAt: snapshot?.updatedAt || 0,
    activeLotId: selectedLotId
  };
}

function writeLegacyButtonState(snapshot) {
  try {
    const isVisible = Boolean(snapshot?.states?.internet?.ready);
    fs.writeFileSync(BUTTON_STATE_FILE, isVisible ? 'visible' : 'hidden');
  } catch (_) { }
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = requestUrl.pathname;

  // --- GET ENDPOINTS ---
  if (req.method === 'GET') {
    if (pathname === '/button-states' || pathname === '/active-state') {
      const selectedLotId = requestUrl.searchParams.get('lotId') || requestUrl.searchParams.get('id') || '';
      const snapshot = getSnapshotForLot(selectedLotId);
      res.end(JSON.stringify({ ...snapshot, success: true }));
      return;
    }

    if (pathname === '/get-pending-commands') {
      // Return but DON'T clear immediately (wait for result report)
      res.end(JSON.stringify({ commands: pendingCommands, success: true }));
      return;
    }

    if (pathname === '/set-current-ask-status') {
      const id = requestUrl.searchParams.get('id');
      const result = commandResults.get(id) || { status: 'pending' };
      res.end(JSON.stringify(result));
      return;
    }

    // LITE MODE: check if a LITE AHK script is running via flag file
    if (pathname === '/lite-mode-status') {
      const enabled = fs.existsSync(LITE_MODE_FLAG_FILE);
      res.end(JSON.stringify({ enabled, success: true }));
      return;
    }
  }

  // --- POST ENDPOINTS ---
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const d = JSON.parse(body || '{}');

      if (pathname === '/button-states') {
        const lotId = normalizeLotId(d.lotId);
        if (lotId) {
          latestLotId = lotId;
          // Removed focus restriction since user only uses 1 tab
          activeLotId = lotId;

          lotSnapshots[lotId] = {
            states: d.states || {},
            updatedAt: Date.now()
          };

          if (activeLotId === lotId) {
            console.log(`[Server] Active Lot Updated: ${lotId}`);
            writeLegacyButtonState({ states: d.states || {} });
            fs.writeFileSync(BUTTON_STATES_FILE, JSON.stringify(d.states || {}));
            
            // NEW: PERSISTENT INTERNET PRICE LOGIC
            const internetText = d.states?.internet?.text || '';
            latestInternetText = String(internetText);
            fs.writeFileSync(INTERNET_BID_PRICE_FILE, String(internetText));
            writePriceSnapshot();
          }
        }
      }

      if (pathname === '/set-current-ask') {
        const cmdId = String(nextCommandId++);
        pendingCommands.push({
          id: cmdId,
          type: 'SET_CURRENT_ASK',
          value: d.value,
          selectOnly: !!d.selectOnly
        });
        res.end(JSON.stringify({ success: true, commandId: cmdId }));
        return;
      }

      if (pathname === '/command-result') {
        if (d.id) {
          if (d.success) {
            // Successfully handled, safe to clear from pending
            pendingCommands = pendingCommands.filter(c => c.id !== d.id);
            commandResults.set(String(d.id), { status: 'done', success: true });
          } else {
            commandResults.set(String(d.id), { status: 'failed', success: false });
          }

          if (commandResults.size > 100) commandResults.clear();
        }
      }

      if (pathname === '/set-active-lot' && d.activeLotId) {
        activeLotId = normalizeLotId(d.activeLotId);
        const activeSnapshot = getSnapshotForLot(activeLotId);
        writeLegacyButtonState(activeSnapshot);
      }

      if (pathname === '/current-ask-price' && d.currentAskPrice) {
        const lotId = normalizeLotId(d.lotId);
        activeLotId = lotId || activeLotId;
        fs.writeFileSync(CURRENT_ASK_PRICE_FILE, String(d.currentAskPrice));
      }

      if (pathname === '/price' && d.price) {
        const lotId = normalizeLotId(d.lotId);
        activeLotId = lotId || activeLotId;
        latestEstimatePrice = String(d.price);
        fs.writeFileSync(PRICE_FILE, latestEstimatePrice);
        writePriceSnapshot();
      }

      const activeSnapshot = getSnapshotForLot();
      res.end(JSON.stringify({
        success: true,
        activeLotId: activeSnapshot.activeLotId,
        updatedAt: activeSnapshot.updatedAt
      }));

    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });

}).listen(PORT);

console.log('Server Stable Restored on 9999 with Focus-Optimized Queue');

