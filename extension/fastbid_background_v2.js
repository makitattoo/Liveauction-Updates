// LiveAuctioneers Price Monitor - Background Script
// Sends prices to local HTTP server for AHK to read

const HTTP_SERVER = 'http://localhost:9999';
let lastPrice = '';
let lastLotId = '';
let totalUpdates = 0;
let activeTabId = null;  // Track which tab is currently active

// Debug logging
function log(msg) {
  console.log('[FastBid BG]', msg);
}

// Get currently active tab
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// Update active tab tracking
async function updateActiveTab() {
  const tab = await getActiveTab();
  if (tab) {
    activeTabId = tab.id;
    log('Active tab updated: ' + tab.id + ' - ' + tab.url);
  }
  return tab;
}

let backgroundBackoffUntil = 0;

async function sendPriceToServer(price, lotId) {
  if (Date.now() < backgroundBackoffUntil) return false;
  log(`Attempting to send price $${price} to ${HTTP_SERVER}`);
  
  try {
    const response = await fetch(`${HTTP_SERVER}/price`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ price: price, lotId: lotId })
    });
    
    log(`Server response: ${response.status}`);
    
    if (response.ok) {
      return true;
    } else {
      return false;
    }
  } catch (err) {
    log(`Fetch failed: ${err.message}. Backing off background sync for 30s.`);
    backgroundBackoffUntil = Date.now() + 30000;
    return false;
  }
}

async function notifyServerActiveLot(lotId) {
  if (!lotId) return;
  try {
    await fetch(`${HTTP_SERVER}/set-active-lot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeLotId: lotId })
    });
    log(`Notified server of active lot: ${lotId}`);
  } catch(e) {}
}

// Store in memory (deprecated storage)
async function storePrice(price, lotId) {
  // Logic removed to prevent TypeError
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Bootstrap active tab tracking so we don't drop valid messages
  // before a tabs.onActivated event has fired.
  if (activeTabId === null && sender.tab) {
    activeTabId = sender.tab.id;
    log(`Initialized active tab from sender: ${activeTabId}`);
  }

  // Only accept PRICE_UPDATE from the currently active tab.
  // Use sender.tab.active as the source of truth to avoid stale activeTabId.
  if (request.type === 'PRICE_UPDATE' && sender.tab && !sender.tab.active) {
    log(`Ignoring price from inactive tab ${sender.tab.id}`);
    sendResponse({ success: false, reason: 'inactive_tab' });
    return true;
  }
  
  if (request.type === 'PRICE_UPDATE') {
    const { price, lotId, url, timestamp } = request;
    
    // Only update if price changed
    if (price !== lastPrice || lotId !== lastLotId) {
      lastPrice = price;
      lastLotId = lotId;
      totalUpdates++;
      
      // Send to HTTP server (for AHK)
      sendPriceToServer(price, lotId);
      
      // Also store locally
      storePrice(price, lotId);
      
      // Update badge
      chrome.action.setBadgeText({ text: price });
      chrome.action.setBadgeBackgroundColor({ color: '#00FF00' });
    }
    
    sendResponse({ success: true });
  }
  
  else if (request.type === 'GET_STATUS') {
    sendResponse({
      lastPrice,
      lastLotId,
      totalUpdates,
      timestamp: Date.now()
    });
  }
  
  return true; // Keep channel open for async
});

// Handle extension install/update
chrome.runtime.onInstalled.addListener(() => {
  log('Extension installed');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && 
      (changeInfo.url.includes('liveauctioneers.com/console/') || 
       changeInfo.url.includes('liveauctioneers.com/clerk-console/'))) {
    log('New auction lot detected:', changeInfo.url);
    
    // Reset for new lot
    lastPrice = '';
    chrome.action.setBadgeText({ text: '' });
    
    // DEPRECATED: Handled by content.js now
    // const match = changeInfo.url.match(/\/(\d+)(?:[\/?&#]|$)/);
    // if (match) notifyServerActiveLot(match[1]);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: windowId });
    if (tabs.length > 0 && tabs[0].url && tabs[0].url.includes('liveauctioneers.com')) {
      // DEPRECATED: Handled by content.js now
      // const match = tabs[0].url.match(/\/(\d+)(?:[\/?&#]|$)/);
      // if (match) notifyServerActiveLot(match[1]);
    }
  } catch(e) {}
});

// Listen for tab activation (user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Update active tab tracking
  activeTabId = activeInfo.tabId;
  log('Tab activated: ' + activeTabId);
  
  try {
    const tab = await chrome.tabs.get(activeTabId);
    
    // Check if it's a LiveAuctioneers page
    if (tab.url && (tab.url.includes('liveauctioneers.com/console/') || 
                    tab.url.includes('liveauctioneers.com/clerk-console/'))) {
      log('Switched to auction tab: ' + tab.url);
      
      // Track this as the last active auction tab
      lastAuctionTabId = activeTabId;
      
      // DEPRECATED: notifyServerActiveLot is now handled by content.js to support 413880_652G format
      // const lotMatch = tab.url.match(/\/(\d+)(?:[\/?&#]|$)/);
      // if (lotMatch) notifyServerActiveLot(lotMatch[1]);
      
      // Clear last price to force update from new tab
      lastPrice = '';
      
      // Notify ALL auction tabs that they might have been activated
      // The content scripts will check if they are the active one
      const allTabs = await chrome.tabs.query({
        url: ['*://*.liveauctioneers.com/console/*', '*://*.liveauctioneers.com/clerk-console/*']
      });
      
      for (const auctionTab of allTabs) {
        chrome.tabs.sendMessage(auctionTab.id, { type: 'TAB_ACTIVATED', activeTabId: activeTabId }, (response) => {
          if (chrome.runtime.lastError) {
            // Content script not loaded on this tab
            return;
          }
          
          // Only process response from the actually active tab
          if (auctionTab.id === activeTabId && response && response.price) {
            log('Got price from activated tab: $' + response.price);
            
            // Always update when switching tabs
            lastPrice = response.price;
            lastLotId = response.lotId || '';
            totalUpdates++;
            
            if (response.lotId) notifyServerActiveLot(response.lotId);
            sendPriceToServer(response.price, response.lotId);
            storePrice(response.price, response.lotId);
            chrome.action.setBadgeText({ text: response.price });
          }
        });
      }
    } else {
      // Switched to non-auction tab (Facebook, etc.)
      log('Switched to non-auction tab: ' + (tab.url || 'unknown'));
    }
  } catch (err) {
    log('Tab switch error:', err.message);
  }
});

// Keep badge updated
setInterval(() => {
  if (lastPrice) {
    chrome.action.setBadgeText({ text: lastPrice });
  }
}, 5000);

log('Background script loaded');
updateActiveTab();
