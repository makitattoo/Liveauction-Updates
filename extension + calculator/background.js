// LiveAuctioneers Price Monitor - Background Script
// Stores live price updates locally inside the extension

let lastPrice = '';
let lastLotId = '';
let totalUpdates = 0;
let activeTabId = null;
let liveAuctioneersTabs = new Set(); // Track LiveAuctioneers tab IDs

// Remote kill switch / feature flags
const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/makitattoo/auction-helper-config/refs/heads/main/config.json';
let featureFlags = {
  enabled: true,
  disableOverlay: false,
  disableCalculator: false,
  disableTimer: false,
  disableFacebookNote: false,
  disablePriceMonitor: false
};

// Check remote config for feature flags
async function checkRemoteConfig() {
  try {
    const response = await fetch(REMOTE_CONFIG_URL, {
      method: 'GET',
      cache: 'no-cache',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      log('Remote config fetch failed: ' + response.status);
      return;
    }
    
    const config = await response.json();
    
    // Update feature flags from remote config
    if (config.auctionHelper) {
      featureFlags = {
        enabled: config.auctionHelper.enabled !== false,
        disableOverlay: config.auctionHelper.disableOverlay === true,
        disableCalculator: config.auctionHelper.disableCalculator === true,
        disableTimer: config.auctionHelper.disableTimer === true,
        disableFacebookNote: config.auctionHelper.disableFacebookNote === true,
        disablePriceMonitor: config.auctionHelper.disablePriceMonitor === true
      };
      
      // Store in local storage for content scripts to read
      await chrome.storage.local.set({ 
        featureFlags: featureFlags,
        lastConfigCheck: Date.now()
      });
      
      log('Remote config updated: ' + JSON.stringify(featureFlags));
      
      // Notify all tabs of feature flag changes
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'FEATURE_FLAGS_UPDATE',
              flags: featureFlags
            }).catch(() => {});
          }
        });
      });
    }
  } catch (err) {
    log('Remote config error: ' + err.message);
    // Fallback: use cached flags from storage
    const cached = await chrome.storage.local.get(['featureFlags']);
    if (cached.featureFlags) {
      featureFlags = cached.featureFlags;
    }
  }
}

function log(msg) {
  console.log('[AuctionHelper BG]', msg);
}

// Check remote config periodically (every 5 minutes)
setInterval(checkRemoteConfig, 5 * 60 * 1000);

// Initial check on load
checkRemoteConfig();

// Check if LiveAuctioneers is open in any tab
async function isLiveAuctioneersOpen() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.liveauctioneers.com/*', 'https://partners.liveauctioneers.com/*']
  });
  return tabs.length > 0;
}

// Track LiveAuctioneers tabs
function trackLiveAuctioneersTab(tabId, url) {
  if (url && (url.includes('liveauctioneers.com/console/') || url.includes('liveauctioneers.com/clerk-console/'))) {
    liveAuctioneersTabs.add(tabId);
    log('Tracking LiveAuctioneers tab: ' + tabId);
  }
}

function untrackLiveAuctioneersTab(tabId) {
  if (liveAuctioneersTabs.has(tabId)) {
    liveAuctioneersTabs.delete(tabId);
    log('Untracking LiveAuctioneers tab: ' + tabId);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function updateActiveTab() {
  const tab = await getActiveTab();
  if (tab) {
    activeTabId = tab.id;
    log('Active tab updated: ' + tab.id + ' - ' + tab.url);
  }
  return tab;
}

async function storePrice(price, lotId) {
  await chrome.storage.local.set({
    currentPrice: price,
    currentLotId: lotId,
    lastUpdate: Date.now(),
    totalUpdates
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.tab && sender.tab.id !== activeTabId) {
    log(`Ignoring price from inactive tab ${sender.tab.id}, active is ${activeTabId}`);
    sendResponse({ success: false, reason: 'inactive_tab' });
    return true;
  }

  if (request.type === 'PRICE_UPDATE') {
    const { price, lotId } = request;

    if (price !== lastPrice || lotId !== lastLotId) {
      lastPrice = price;
      lastLotId = lotId;
      totalUpdates++;

      storePrice(price, lotId);

      chrome.action.setBadgeText({ text: price });
      chrome.action.setBadgeBackgroundColor({ color: '#00FF00' });
    }

    sendResponse({ success: true });
  } else if (request.type === 'GET_STATUS') {
    sendResponse({
      lastPrice,
      lastLotId,
      totalUpdates,
      timestamp: Date.now()
    });
  } else if (request.type === 'CHECK_LIVEAUCTIONEERS') {
    // Facebook asking if LiveAuctioneers is open
    const isOpen = liveAuctioneersTabs.size > 0;
    sendResponse({
      isLiveAuctioneersOpen: isOpen,
      lastPrice,
      lastLotId
    });
  }

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  log('Extension installed');

  await chrome.storage.local.set({
    currentPrice: '',
    currentLotId: '',
    lastUpdate: 0,
    totalUpdates: 0,
    isMonitoring: true
  });

  await updateActiveTab();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Track LiveAuctioneers tabs
  trackLiveAuctioneersTab(tabId, tab.url);
  
  if (
    changeInfo.url &&
    (changeInfo.url.includes('liveauctioneers.com/console/') ||
      changeInfo.url.includes('liveauctioneers.com/clerk-console/'))
  ) {
    log('New auction lot detected: ' + changeInfo.url);
    lastPrice = '';
    chrome.action.setBadgeText({ text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  untrackLiveAuctioneersTab(tabId);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  activeTabId = activeInfo.tabId;
  log('Tab activated: ' + activeTabId);

  try {
    const tab = await chrome.tabs.get(activeTabId);

    if (
      tab.url &&
      (tab.url.includes('liveauctioneers.com/console/') ||
        tab.url.includes('liveauctioneers.com/clerk-console/'))
    ) {
      log('Switched to auction tab: ' + tab.url);
      lastPrice = '';

      chrome.tabs.sendMessage(activeTabId, { type: 'FORCE_CHECK' }, (response) => {
        if (chrome.runtime.lastError) {
          log('No content script on tab: ' + chrome.runtime.lastError.message);
          return;
        }

        if (response && response.price) {
          log('Got price from tab switch: $' + response.price);
          lastPrice = response.price;
          lastLotId = response.lotId || '';
          totalUpdates++;

          storePrice(response.price, response.lotId);
          chrome.action.setBadgeText({ text: response.price });
        }
      });
    }
  } catch (err) {
    log('Tab switch error: ' + err.message);
  }
});

setInterval(() => {
  if (lastPrice) {
    chrome.action.setBadgeText({ text: lastPrice });
  }
}, 5000);

updateActiveTab();
log('Background script loaded');
