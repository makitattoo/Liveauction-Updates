// LiveAuctioneers Price Monitor - Content Script
// Monitors the current lot price and sends updates to AuctionHelper AHK

(function() {
  'use strict';

  // Load CLOCK font from extension local assets
  const fontFace = new FontFace('CLOCK', `url(${chrome.runtime.getURL('assets/CLOCK.TTF')})`);
  fontFace.load().then(() => {
    document.fonts.add(fontFace);
  }).catch(err => {
    console.log('[AuctionHelper] Failed to load CLOCK font:', err);
  });

  let lastPrice = '';
  let lastLotId = '';
  let isMonitoring = true;
  const checkInterval = 100;
  const OVERLAY_STORAGE_KEY = 'auctionOverlayState';
  const TIMER_AUDIO_PATH = 'assets/TIMER.mp3';
  let timerAudioContext = null;
  let activeTimerTimeouts = [];
  let activeTimerLabelTimeouts = [];
  let timerAudioElement = null;
  let timerAudioObjectUrl = null;
  let lastLotDisplay = '-';
  let lastSellerName = '-';
  let lastCatalogTitle = '-';
  let lastLotTitle = '-';
  let lastEstimateValue = '-';
  let lastInternetBidPrice = '0';
  let lastProcessedLotId = '';
  let hasLockedPassThisLot = false;
  let lastPassLockLotDisplay = '';

  // Lot verification: LiveAuctioneers can briefly leave the previous lot's
  // estimate in the DOM while the next lot is loading. Do not calculate or
  // display a Bid Estimate until the newly detected lot has been re-checked
  // after a 1-second settling period.
  const LOT_VERIFY_DELAY = 1000;
  let verifiedLotId = '';
  let pendingVerificationLotId = '';
  let lotVerificationToken = 0;

  // Default message for the LiveAuctioneers missive/message box.
  const DEFAULT_MISSIVE_MESSAGE = 'Anyone interested in this lot?';
  let missiveMessageObserver = null;
  let missiveMessageSetupTimer = null;

  function setMissiveMessageIfEmpty() {
    const input = document.querySelector('input[name="missiveText"]');
    if (!input) return false;

    // Always set the default message whenever the message box is found.
    // Use the native setter so frameworks that control the input value
    // (React/Vue/etc.) also receive a real value change.
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, DEFAULT_MISSIVE_MESSAGE);
    } else {
      input.value = DEFAULT_MISSIVE_MESSAGE;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log('Default missive message inserted');
    return true;
  }

  function startMissiveMessageMonitor() {
    // Try immediately in case the message box is already present.
    setMissiveMessageIfEmpty();

    // LiveAuctioneers may create/replace the message box dynamically when
    // changing lots, so watch for it being added to the DOM.
    if (!missiveMessageObserver) {
      missiveMessageObserver = new MutationObserver(() => {
        setMissiveMessageIfEmpty();
      });
      missiveMessageObserver.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true
      });
    }

    // Also retry briefly after page/lot transitions in case the UI is rendered
    // asynchronously without a useful mutation event at the exact moment.
    if (missiveMessageSetupTimer) clearInterval(missiveMessageSetupTimer);
    let attempts = 0;
    missiveMessageSetupTimer = setInterval(() => {
      attempts++;
      setMissiveMessageIfEmpty();
      if (attempts >= 20) {
        clearInterval(missiveMessageSetupTimer);
        missiveMessageSetupTimer = null;
      }
    }, 250);
  }
  const DEFAULT_OVERLAY_STATE = {
    minimized: false,
    calcMinimized: false,
    lotMinimized: false,
    left: 20,
    top: 100,
    calcExpression: '0',
    calcResult: '0',
    passSoldLock: 'enabled'
  };
  let overlayState = { ...DEFAULT_OVERLAY_STATE };
  const DEFAULT_DIVISOR = 1.3;
  let bidEstimateDivisor = DEFAULT_DIVISOR;
  let sellerNameSuffix = '';

  // Load settings from storage
  function loadSettings() {
    chrome.storage.local.get(['bidEstimateDivisor', 'sellerNameSuffix'], (result) => {
      if (result.bidEstimateDivisor && !isNaN(result.bidEstimateDivisor) && result.bidEstimateDivisor > 0) {
        bidEstimateDivisor = result.bidEstimateDivisor;
        log('Loaded divisor: ' + bidEstimateDivisor);
      }
      if (result.sellerNameSuffix !== undefined) {
        sellerNameSuffix = result.sellerNameSuffix;
        log('Loaded seller suffix: ' + sellerNameSuffix);
      }
    });
  }
  
  loadSettings();

  // Listen for setting changes from popup
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.bidEstimateDivisor) {
        bidEstimateDivisor = changes.bidEstimateDivisor.newValue;
        log('Divisor updated: ' + bidEstimateDivisor);
        // Refresh the display if overlay exists
        const overlay = document.getElementById('price-monitor-overlay');
        if (overlay) {
          const estInput = overlay.querySelector('#pm-est-value');
          const beValue = overlay.querySelector('#pm-be-value');
          if (estInput && beValue) {
            const estVal = parseFloat(estInput.value.replace(/,/g, ''));
            if (!isNaN(estVal) && estVal > 0) {
              beValue.textContent = Math.round(estVal / bidEstimateDivisor).toLocaleString();
            }
          }
        }
      }
      if (changes.sellerNameSuffix) {
        sellerNameSuffix = changes.sellerNameSuffix.newValue;
        log('Seller suffix updated: ' + sellerNameSuffix);
      }
    }
    
    // Listen for feature flags changes from background
    if (namespace === 'local' && changes.featureFlags) {
      featureFlags = changes.featureFlags.newValue;
      applyFeatureFlags();
    }
  });

  // Feature flags
  let featureFlags = {
    enabled: true,
    disableOverlay: false,
    disableCalculator: false,
    disableTimer: false,
    disablePriceMonitor: false,
    disableLotInfo: false
  };

  // Load feature flags from storage
  function loadFeatureFlags() {
    chrome.storage.local.get(['featureFlags'], (result) => {
      if (result.featureFlags) {
        featureFlags = result.featureFlags;
        applyFeatureFlags();
      }
    });
  }

  // Apply feature flags (disable features)
  function applyFeatureFlags() {
    if (!featureFlags.enabled) {
      log('Extension disabled by remote config');
      // Remove overlay completely
      const overlay = document.getElementById('price-monitor-overlay');
      if (overlay) {
        overlay.remove();
      }
      return;
    }

    if (featureFlags.disableOverlay) {
      log('Overlay disabled by remote config');
      const overlay = document.getElementById('price-monitor-overlay');
      if (overlay) {
        overlay.style.display = 'none';
      }
    } else {
      let overlay = document.getElementById('price-monitor-overlay');
      if (overlay) {
        overlay.style.display = 'block';
      } else {
        // Overlay was removed, recreate it
        log('Overlay not found, recreating...');
        // Force create overlay directly
        forceCreateOverlay();
        // Trigger immediate price check to get current data
        setTimeout(() => {
          const priceEl = findPriceElement();
          if (priceEl) {
            const price = extractPrice(priceEl.textContent);
            if (price && price !== '0') {
              updateScrollerWithCalculatedPrice(price);
            }
          }
        }, 500);
      }
    }

    if (featureFlags.disableCalculator) {
      log('Calculator disabled by remote config');
      const calcRow = document.getElementById('pm-calc-row');
      if (calcRow) {
        calcRow.style.display = 'none';
      }
    }

    if (featureFlags.disableTimer) {
      log('Timer disabled by remote config');
      const timer = document.getElementById('pm-timer');
      if (timer) {
        // Gray out timer instead of hiding
        timer.style.background = '#3a3a3a';
        timer.style.borderColor = '#666';
        timer.style.color = '#888';
        timer.style.cursor = 'not-allowed';
        timer.disabled = true;
      }
    } else {
      // Re-enable timer styling
      const timer = document.getElementById('pm-timer');
      if (timer) {
        timer.style.background = '#184628';
        timer.style.borderColor = '#00FF00';
        timer.style.color = '#dffff0';
        timer.style.cursor = 'pointer';
        timer.disabled = false;
      }
    }

    if (featureFlags.disableLotInfo) {
      log('Lot info disabled by remote config');
      const lotBox = document.getElementById('pm-lot-box');
      const copyBtn = document.getElementById('pm-copy-info');
      if (lotBox) lotBox.style.display = 'none';
      if (copyBtn) copyBtn.style.display = 'none';
    } else {
      // Re-enable lot info
      const lotBox = document.getElementById('pm-lot-box');
      const copyBtn = document.getElementById('pm-copy-info');
      if (lotBox) lotBox.style.display = 'block';
      if (copyBtn) copyBtn.style.display = 'block';
    }

    if (featureFlags.disablePriceMonitor) {
      log('Price monitor disabled by remote config');
      isMonitoring = false;
    } else {
      isMonitoring = true;
    }
  }

  loadFeatureFlags();

  function log(msg) {
    console.log('[AuctionHelper Ext]', msg);
  }

  log('=== EXTENSION LOADED ===');

  function getLotId() {
    const match = window.location.pathname.match(/\/(\d+)$/);
    return match ? match[1] : null;
  }

  function getLotDisplayValue() {
    const inputEl = document.querySelector('input[aria-label="lotNumber"], input.input_dXLOG.input_kqHIC');
    if (inputEl) {
      const value = (inputEl.value || inputEl.getAttribute('value') || '').trim();
      if (value) {
        lastLotDisplay = value;
        return value;
      }
    }

    const lotId = getLotId();
    if (lotId) {
      lastLotDisplay = lotId;
      return lotId;
    }

    return lastLotDisplay || '-';
  }

  function getAuctionMeta() {
    const sellerEl = document.querySelector('.title_whNwM .sellerName_hIvDc, .sellerName_hIvDc');
    const catalogEl = document.querySelector('.title_whNwM .catalogTitle_rP_S5, .catalogTitle_rP_S5');
    const lotTitleEl = document.querySelector('.lotTitle_KGgrA span, .lotTitle_KGgrA');

    const sellerName = (sellerEl?.textContent || '').trim();
    const catalogTitle = (catalogEl?.textContent || '').trim();
    const lotTitle = (lotTitleEl?.textContent || '').trim();

    if (sellerName) {
      lastSellerName = sellerName;
    }
    if (catalogTitle) {
      lastCatalogTitle = catalogTitle;
    }
    if (lotTitle) {
      lastLotTitle = lotTitle;
    }

    const sName = lastSellerName || '-';
    // Add a space between name and suffix if suffix exists
    const finalSellerName = sellerNameSuffix ? `${sName} ${sellerNameSuffix}` : sName;

    return {
      sellerName: finalSellerName,
      accountNumber: sellerNameSuffix || '-',
      catalogTitle: lastCatalogTitle || '-',
      lotTitle: lastLotTitle || '-'
    };
  }

  function findPriceElement() {
    const el1 = document.querySelector('div[class*="estimate_VL0CI"]');
    if (el1) {
      return el1;
    }

    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const text = div.textContent;
      if (text && text.includes('Estimate:')) {
        return div;
      }
    }

    return null;
  }

  function getCurrentBidPrice() {
    // Try to find the current bid price input
    const bidInput = document.querySelector('input[name="currentAskPrice"], input[aria-label="currentAskPrice"]');
    console.log('[AuctionHelper] Looking for bid input:', bidInput);
    
    if (bidInput) {
      const value = bidInput.value;
      console.log('[AuctionHelper] Bid input found, value:', value);
      if (value) {
        const cleanValue = value.replace(/[$,]/g, '');
        console.log('[AuctionHelper] Cleaned bid value:', cleanValue);
        return cleanValue;
      }
    }

    // Try broader search for any input with currentAskPrice
    const allInputs = document.querySelectorAll('input');
    console.log('[AuctionHelper] All inputs found:', allInputs.length);
    
    for (const input of allInputs) {
      if (input.name === 'currentAskPrice' || input.getAttribute('aria-label') === 'currentAskPrice') {
        console.log('[AuctionHelper] Found bid input in loop:', input.value);
        const value = input.value;
        if (value) {
          return value.replace(/[$,]/g, '');
        }
      }
    }

    // Fallback: try to find any element with current bid info
    const bidElements = [
      'div[class*="current"]',
      'div[class*="ask"]',
      'div[class*="bid"]',
      '[data-testid*="current"]'
    ];

    for (const selector of bidElements) {
      const element = document.querySelector(selector);
      if (element) {
        const price = extractPrice(element.textContent);
        if (price && price !== '0') {
          return price;
        }
      }
    }

    return null;
  }

  function updateBidEstimateColor(currentBid, bidEstimate) {
    const bidEstimateEl = document.getElementById('pm-be-value');
    if (!bidEstimateEl) return;

    // Clean numbers by removing commas and other non-numeric characters
    const cleanCurrentBid = String(currentBid || '').replace(/[$,]/g, '');
    const cleanBidEstimate = String(bidEstimate || '').replace(/[$,]/g, '');
    
    const currentBidNum = parseFloat(cleanCurrentBid) || 0;
    const bidEstimateNum = parseFloat(cleanBidEstimate) || 0;

    console.log('[AuctionHelper] Color check - Current:', currentBidNum, 'Estimate:', bidEstimateNum);

    const ninetyFivePercent = bidEstimateNum * 0.95;
    const ninetyNinePercent = bidEstimateNum * 0.99;

    if (currentBidNum < ninetyFivePercent) {
      // Under 95% - Red warning
      bidEstimateEl.style.color = '#ff4444'; // Red text
      bidEstimateEl.style.borderColor = '#ff4444'; // Red border
      bidEstimateEl.style.backgroundColor = '#2a1a1a'; // Darker red background
    } else if (currentBidNum < ninetyNinePercent) {
      // 95-99% - Yellow warning
      bidEstimateEl.style.color = '#ffff00'; // Yellow text
      bidEstimateEl.style.borderColor = '#ffff00'; // Yellow border
      bidEstimateEl.style.backgroundColor = '#2a2a1a'; // Dark yellow background
    } else {
      // 100%+ - Green success
      bidEstimateEl.style.color = '#00FF00'; // Green text
      bidEstimateEl.style.borderColor = '#00FF00'; // Green border
      bidEstimateEl.style.backgroundColor = '#2a2a2a'; // Normal background
    }
  }

  function updateCurrentAskPriceColor(currentBid, bidEstimate) {
    // Find the currentAskPrice input
    const bidInput = document.querySelector('input[name="currentAskPrice"], input[aria-label="currentAskPrice"]');
    if (!bidInput) return;

    // Check if Pass/Sold buttons are disabled - only apply color if they are
    const { soldBtn, passBtn } = getActionButtons();
    const arePassSoldDisabled = (soldBtn && soldBtn.disabled) || (passBtn && passBtn.disabled);

    if (!arePassSoldDisabled) {
      // Pass/Sold buttons are enabled - don't apply color changes
      bidInput.style.color = '';
      bidInput.style.fontWeight = '';
      bidInput.style.textShadow = '';
      return;
    }

    // Clean numbers by removing commas and other non-numeric characters
    const cleanCurrentBid = String(currentBid || '').replace(/[$,]/g, '');
    const cleanBidEstimate = String(bidEstimate || '').replace(/[$,]/g, '');

    const currentBidNum = parseFloat(cleanCurrentBid) || 0;
    const bidEstimateNum = parseFloat(cleanBidEstimate) || 0;

    if (bidEstimateNum === 0) return; // No estimate to compare against

    const ninetyFivePercent = bidEstimateNum * 0.95;
    const oneHundredTenPercent = bidEstimateNum * 1.10;

    if (currentBidNum < ninetyFivePercent) {
      // Below 95% - Red font
      bidInput.style.color = '#ff0000';
      bidInput.style.fontWeight = 'normal';
      bidInput.style.textShadow = 'none';
    } else if (currentBidNum < oneHundredTenPercent) {
      // 95% to 109% - Black font
      bidInput.style.color = '#000000';
      bidInput.style.fontWeight = 'normal';
      bidInput.style.textShadow = 'none';
    } else {
      // 110% or more - Bright orange (error)
      bidInput.style.color = '#FFA500';
      bidInput.style.fontWeight = 'bold';
      bidInput.style.textShadow = '0 0 3px #FFA500';
    }
  }

  function getActionButtons() {
    const buttons = document.querySelectorAll('button.button_n1T72');
    let soldBtn = null;
    let passBtn = null;
    let competingBidBtn = null;
    let unsoldBtn = null;
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (text === 'Sold') soldBtn = btn;
      if (text === 'Unsold') unsoldBtn = btn;
      if (text === 'Pass') passBtn = btn;
      if (text === 'Competing Bid') competingBidBtn = btn;
    }
    return { soldBtn, passBtn, competingBidBtn, unsoldBtn };
  }

  function updateSoldButtonState() {
    const { soldBtn, passBtn, competingBidBtn, unsoldBtn } = getActionButtons();

    // Reset sticky pass lock when the displayed lot number changes
    const currentLotDisplay = getLotDisplayValue();
    if (currentLotDisplay && currentLotDisplay !== '-' && currentLotDisplay !== lastPassLockLotDisplay) {
      if (lastPassLockLotDisplay !== '') {
        log('Lot display changed from ' + lastPassLockLotDisplay + ' to ' + currentLotDisplay + ' - resetting pass lock');
        hasLockedPassThisLot = false;
      }
      lastPassLockLotDisplay = currentLotDisplay;
    }

    const currentAsk = getCurrentBidPrice();
    const bidEstimateEl = document.getElementById('pm-be-value');
    const bidEstimate = bidEstimateEl ? bidEstimateEl.textContent.replace(/[$,]/g, '').trim() : '';

    const disableButtons = (btn) => {
      if (!btn) return;
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
      btn.style.backgroundColor = '#ff4444';
      btn.style.color = '#ffffff';
      btn.style.borderColor = '#ff4444';
    };

    const enableButtons = (btn) => {
      if (!btn) return;
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      btn.style.backgroundColor = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    };

    if (!currentAsk || !bidEstimate) {
      disableButtons(soldBtn);
      disableButtons(passBtn);
      disableButtons(unsoldBtn);
      disableButtons(competingBidBtn);
      return;
    }

    const currentAskNum = parseFloat(currentAsk);
    const bidEstimateNum = parseFloat(bidEstimate);

    // Check if Pass/Sold/Unsold buttons should bypass bid estimate (disabled)
    if (overlayState.passSoldLock === 'disabled') {
      // Bypass bid estimate - always enable Pass/Sold/Unsold buttons
      enableButtons(soldBtn);
      enableButtons(passBtn);
      enableButtons(unsoldBtn);
    } else {
      const minAcceptablePrice = bidEstimateNum * 0.95;

      // 1. Sold and Unsold buttons logic (using currentAskNum)
      const isAcceptable = currentAskNum >= minAcceptablePrice;
      if (isAcceptable) {
        enableButtons(soldBtn);
        enableButtons(unsoldBtn);
      } else {
        disableButtons(soldBtn);
        disableButtons(unsoldBtn);
      }

      // 2. Pass button logic (using Internet button price)
      const allButtons = document.querySelectorAll('button');
      let internetBtn = null;
      for (const btn of allButtons) {
        if (btn.textContent.includes('Internet')) {
          internetBtn = btn;
          break;
        }
      }

      const isInternetActive = internetBtn && !internetBtn.disabled;
      const internetPrice = getInternetBidPrice();
      const internetPriceNum = parseFloat(internetPrice);

      // Lock Pass button if:
      // - Current ask price is below 95% (old logic)
      // - OR Internet button is enabled and its bid is >= 95% of Bid Estimate (new logic)
      // - OR it was already locked by an internet bid earlier in this lot (sticky lock)
      const shouldLockPass = isInternetActive && !isNaN(internetPriceNum) && (internetPriceNum >= minAcceptablePrice);

      if (shouldLockPass) {
        hasLockedPassThisLot = true;
      }

      if (!isAcceptable || shouldLockPass || hasLockedPassThisLot) {
        disableButtons(passBtn);
      } else {
        enableButtons(passBtn);
      }
    }

    // Still apply competing bid logic
    const maxCompetingBidPrice = bidEstimateNum * 1.10;
    // Only disable competing bid if the estimate is 100 or higher
    const shouldDisableCompetingBid = bidEstimateNum >= 100 && currentAskNum >= maxCompetingBidPrice;

    if (shouldDisableCompetingBid) {
      disableButtons(competingBidBtn);
    } else {
      enableButtons(competingBidBtn);
    }
  }

  // Track gold state to auto-reset on price change
  let lastGoldPrice = '';

  function updateAuctionToolsGold() {
    // Find the bid button
    const bidButton = document.querySelector('button.button_n1T72.sc-fZqnxA.cpnBCy');
    if (!bidButton) return;

    // Check if button is not disabled
    const isButtonEnabled = !bidButton.disabled;
    
    // Get current bid and bid estimate
    const currentBid = getCurrentBidPrice();
    const estimateEl = document.querySelector('#pm-est-value');
    const bidEstimateNum = estimateEl ? parseFloat(estimateEl.value.replace(/,/g, '')) * bidEstimateDivisor : 0;
    
    if (!currentBid || bidEstimateNum === 0) return;

    // Flexible range: 95% to 110%
    const ninetyFivePercent = bidEstimateNum * 0.95;
    const oneHundredTenPercent = bidEstimateNum * 1.10;
    const currentBidNum = parseFloat(currentBid);
    
    // Check if price changed from gold state - reset immediately
    if (lastGoldPrice && currentBid !== lastGoldPrice) {
      resetGoldColors();
      lastGoldPrice = '';
      return; // Exit and wait for next check
    }
    
    const shouldTurnGold = isButtonEnabled && 
                          currentBidNum >= ninetyFivePercent && 
                          currentBidNum <= oneHundredTenPercent;

    // Find auction tools elements
    const estimateLabel = document.querySelector('div[style*="Estimate:"]');
    const estimateInput = document.querySelector('#pm-est-value');

    if (shouldTurnGold) {
      // Turn label and input gold (no container/row background)
      if (estimateLabel) {
        estimateLabel.style.color = '#FFD700'; // Gold text
        estimateLabel.style.fontWeight = 'bold';
      }
      if (estimateInput) {
        estimateInput.style.color = '#FFD700'; // Gold number
        estimateInput.style.borderColor = '#FFD700'; // Gold border
        estimateInput.style.backgroundColor = '#FFD700'; // Gold box background
        estimateInput.style.fontWeight = 'bold';
      }
      
      // Store the price that triggered gold
      lastGoldPrice = currentBid;
    }
  }
  
  function resetGoldColors() {
    const estimateInput = document.querySelector('#pm-est-value');
    const estimateLabel = document.querySelector('div[style*="Estimate:"]');
    
    // Reset to green colors
    if (estimateLabel) {
      estimateLabel.style.color = '#00FF00';
      estimateLabel.style.fontWeight = 'normal';
    }
    if (estimateInput) {
      estimateInput.style.color = '#00FF00';
      estimateInput.style.borderColor = '#00FF00';
      estimateInput.style.backgroundColor = '#2a2a2a';
      estimateInput.style.fontWeight = 'normal';
    }
    
    lastGoldPrice = '';
  }

  function extractPrice(text) {
    if (!text) return null;

    const estimateMatch = text.match(/Estimate:\s*\$\s*([\d,]+)\s*[-–]\s*[\d,]+/i);
    if (estimateMatch) {
      return estimateMatch[1].replace(/,/g, '');
    }

    const singleEstMatch = text.match(/Estimate:\s*\$\s*([\d,]+)/i);
    if (singleEstMatch) {
      return singleEstMatch[1].replace(/,/g, '');
    }

    const match = text.match(/\$([\d,]+)/);
    if (match) {
      return match[1].replace(/,/g, '');
    }

    const numMatch = text.match(/(\d+)/);
    if (numMatch) {
      return numMatch[1];
    }

    return null;
  }
  function getEstimateValue() {
    const estimateEl = document.querySelector('.estimate_VL0CI');
    const estimateText = (estimateEl?.textContent || '').trim();
    const estimateValue = extractPrice(estimateText);

    if (estimateValue) {
      lastEstimateValue = estimateValue;
      return estimateValue;
    }

    return lastEstimateValue || '-';
  }

  function getInternetBidPrice() {
    // Reset if lot changed
    const currentLot = getLotId();
    if (currentLot && currentLot !== lastProcessedLotId) {
      lastProcessedLotId = currentLot;
      lastInternetBidPrice = '0';
    }

    const buttons = document.querySelectorAll('button');
    let internetBtn = null;
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if (text.includes('Internet')) {
        internetBtn = btn;
        break;
      }
    }

    if (!internetBtn) return lastInternetBidPrice;

    if (internetBtn.disabled) {
      lastInternetBidPrice = '0';
      return '0';
    }

    const text = internetBtn.textContent || '';
    const priceMatch = text.match(/\$\s*([\d,]+)/);
    if (priceMatch) {
      lastInternetBidPrice = priceMatch[1].replace(/,/g, '');
    } else {
      // If enabled but no price yet, keep last or use 0
      // Usually if enabled, it should have a price or it's the current ask
    }

    return lastInternetBidPrice;
  }

  function formatCurrencyValue(value) {
    if (value === null || value === undefined || value === '' || value === '-') {
      return '-';
    }

    const numericValue = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
    if (Number.isNaN(numericValue)) {
      return '-';
    }

    return numericValue.toLocaleString();
  }

  function calculateBidEstimate(value) {
    const numericValue = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
    if (Number.isNaN(numericValue) || numericValue <= 0) {
      return '-';
    }

    return Math.round(numericValue / bidEstimateDivisor).toLocaleString();
  }

  function updateClock() {
    const now = new Date();
    
    // Get UTC time and add 8 hours for GMT+8
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const gmtPlus8 = new Date(utcTime + (8 * 3600000));
    
    // Format time in 12-hour AM/PM format
    let hours = gmtPlus8.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // 0 should be 12
    const hoursStr = String(hours).padStart(2, '0');
    const minutes = String(gmtPlus8.getMinutes()).padStart(2, '0');
    const seconds = String(gmtPlus8.getSeconds()).padStart(2, '0');
    
    // Format date MM/DD/YY (use GMT+8 date)
    const month = String(gmtPlus8.getMonth() + 1).padStart(2, '0');
    const day = String(gmtPlus8.getDate()).padStart(2, '0');
    const year = String(gmtPlus8.getFullYear()).slice(-2);
    
    const clockEl = document.getElementById('pm-gmt-clock');
    const dateEl = document.getElementById('pm-date');
    
    if (clockEl) {
      clockEl.textContent = `${hoursStr}:${minutes}:${seconds} ${ampm}`;
    }
    if (dateEl) {
      dateEl.textContent = `${month}/${day}/${year}`;
    }
  }

  function isCurrentLot() {
    const indicators = [
      'div[class*="current"]',
      'div[class*="active"]',
      'div[class*="live"]',
      '[data-testid*="current"]'
    ];

    for (const selector of indicators) {
      if (document.querySelector(selector)) return true;
    }

    const url = window.location.href;
    return url.includes('/console/') || url.includes('/clerk-console/');
  }

  function updateScrollerWithCalculatedPrice(price, forceCreate = false) {
    try {
      const numericPrice = parseFloat(price);
      if (isNaN(numericPrice)) {
        return;
      }
      // Always track all prices including zero

      const calculatedPrice = calculateBidEstimate(numericPrice);
      let overlay = document.getElementById('price-monitor-overlay');

      if (overlay) {
        const estValue = overlay.querySelector('#pm-est-value');
        const beValue = overlay.querySelector('#pm-be-value');
        
        // Skip updates if user is currently editing Estimate input
        const activeElement = document.activeElement;
        const isEditing = activeElement === estValue;
        
        if (!isEditing) {
          // Only update if values changed from site
          if (estValue && parseFloat(estValue.value.replace(/,/g, '')) !== numericPrice) {
            estValue.value = numericPrice.toLocaleString();
          }
          // Update Bid Estimate (non-editable div)
          const newBeValue = Math.round(numericPrice / bidEstimateDivisor).toLocaleString();
          if (beValue && beValue.textContent !== newBeValue) {
            beValue.textContent = newBeValue;
          }
        }
        
        renderOverlayState(overlay, overlayState);
        return;
      }

      // Check if overlay is disabled by remote config
      if (featureFlags.disableOverlay || !featureFlags.enabled) {
        log('Overlay disabled by remote config, not creating');
        return;
      }

      overlay = document.createElement('div');
      overlay.id = 'price-monitor-overlay';
      overlay.style.cssText = `
        position: fixed;
        right: 20px;
        top: 20px;
        width: 220px;
        padding: 12px;
        background: #1a1a1a;
        border-radius: 10px;
        font-family: system-ui, sans-serif;
        z-index: 999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        border: 1px solid #333;
        user-select: none;
        touch-action: none;
      `;

      overlay.innerHTML = `
        <div id="pm-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
          <div style="color:#00FF00;font-weight:bold;font-size:15px;">Auction Tools</div>
        </div>
        <div id="pm-overlay-body">
          <div style="border-top:1px solid #333;padding-top:8px;">
            <div id="pm-estimate-body">
              <!-- Clock and Date (top) -->
              <div style="text-align:center;margin-bottom:10px;">
                <div id="pm-gmt-clock" style="
                  color: #00FF00;
                  font-weight: bold;
                  font-size: 24px;
                  margin-bottom: 4px;
                  font-family: 'CLOCK', monospace;
                ">00:00:00 GMT+8</div>
                <div id="pm-date" style="
                  color: #888;
                  font-size: 18px;
                ">00/00/00</div>
              </div>
              
              <!-- Estimate Box (middle) - editable without scroll -->
              <div style="text-align:center;margin-bottom:10px;">
                <div style="color:#00FF00;font-weight:bold;font-size:12px;margin-bottom:4px;">Estimate:</div>
                <input type="text" id="pm-est-value" value="${numericPrice.toLocaleString()}" style="
                  display: inline-block;
                  padding: 10px 16px;
                  border: 2px solid #00FF00;
                  border-radius: 6px;
                  background: #2a2a2a;
                  color: #00FF00;
                  font-weight: bold;
                  font-size: 18px;
                  min-width: 100px;
                  width: 120px;
                  text-align:center;
                ">
              </div>
              
              <!-- Bid Estimate Box (middle) - non-editable -->
              <div style="text-align:center;margin-bottom:10px;">
                <div style="color:#00FF00;font-weight:bold;font-size:12px;margin-bottom:4px;">Bid Estimate:</div>
                <div id="pm-be-value" style="
                  display: inline-block;
                  padding: 10px 16px;
                  border: 2px solid #00FF00;
                  border-radius: 6px;
                  background: #2a2a2a;
                  color: #00FF00;
                  font-weight: bold;
                  font-size: 18px;
                  min-width: 100px;
                  width: 120px;
                  text-align:center;
                ">${Math.round(numericPrice / bidEstimateDivisor).toLocaleString()}</div>
              </div>
              
              <!-- Timer (bottom) -->
              <div style="text-align:center;">
                <button type="button" id="pm-timer" style="min-height:65px;padding:0 29px;border:1px solid #00FF00;border-radius:6px;background:#184628;color:#dffff0;font-weight:bold;font-size:22px;cursor:pointer;">TIMER</button>
              </div>
              
              <!-- Pass/Sold Lock -->
              <div style="border-top:1px solid #333;padding-top:8px;margin-top:8px;">
                <div style="color:#9fe89f;font-weight:bold;font-size:17px;margin-bottom:6px;text-align:center;">Pass/Sold Lock</div>
                <div style="display:flex;justify-content:center;gap:12px;">
                  <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#d7d7d7;font-size:17px;">
                    <input type="radio" name="pass-sold-lock" value="enabled" id="pass-sold-enabled" checked style="margin:0;transform:scale(1.5);">
                    <span>Enable</span>
                  </label>
                  <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#d7d7d7;font-size:17px;">
                    <input type="radio" name="pass-sold-lock" value="disabled" id="pass-sold-disabled" style="margin:0;transform:scale(1.5);">
                    <span>Disable</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        <div style="border-top:1px solid #333;padding-top:10px;margin-top:10px;display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="color:#9fe89f;font-weight:bold;font-size:12px;">Calculator</div>
            <button type="button" id="pm-toggle-calc" style="${iconButtonStyle()}">&#9650;</button>
          </div>
          <div id="pm-calc-body">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div style="color:#9cc9bb;font-size:11px;">Saved until cleared</div>
              <button type="button" id="pm-clear" style="padding:2px 7px;border:1px solid #666;border-radius:4px;background:#2a2a2a;color:#fff;cursor:pointer;font-size:10px;">Clear</button>
            </div>
            <div id="pm-calc-expression" style="color:#9cc9bb;font-size:11px;text-align:right;min-height:14px;">0</div>
            <div id="pm-calc-result" style="color:#ffffff;font-size:18px;font-weight:bold;text-align:right;min-height:22px;">0</div>
            <div id="pm-calc-status" style="color:#6f8f7f;font-size:10px;text-align:right;min-height:12px;margin-top:2px;">Ready</div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:8px;">
              <button type="button" data-calc="7" style="${calcButtonStyle()}">7</button>
              <button type="button" data-calc="8" style="${calcButtonStyle()}">8</button>
              <button type="button" data-calc="9" style="${calcButtonStyle()}">9</button>
              <button type="button" data-calc="/" style="${calcButtonStyle('#245f52')}">/</button>
              <button type="button" data-calc="4" style="${calcButtonStyle()}">4</button>
              <button type="button" data-calc="5" style="${calcButtonStyle()}">5</button>
              <button type="button" data-calc="6" style="${calcButtonStyle()}">6</button>
              <button type="button" data-calc="*" style="${calcButtonStyle('#245f52')}">*</button>
              <button type="button" data-calc="1" style="${calcButtonStyle()}">1</button>
              <button type="button" data-calc="2" style="${calcButtonStyle()}">2</button>
              <button type="button" data-calc="3" style="${calcButtonStyle()}">3</button>
              <button type="button" data-calc="-" style="${calcButtonStyle('#245f52')}">-</button>
              <button type="button" data-calc="0" style="${calcButtonStyle()}">0</button>
              <button type="button" data-calc="." style="${calcButtonStyle()}">.</button>
              <button type="button" id="pm-equals" style="${calcButtonStyle('#88d498', '#102018')}">=</button>
              <button type="button" data-calc="+" style="${calcButtonStyle('#245f52')}">+</button>
            </div>
          </div>
        </div>
        <div style="border-top:1px solid #333;padding-top:10px;margin-top:10px;">
          <div id="pm-lot-area">
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="text" id="pm-account-suffix" value="${sellerNameSuffix}" placeholder="1" style="
                width: 35px;
                padding: 8px 5px;
                border: 1px solid #3b5a45;
                border-radius: 6px;
                background: #222;
                color: #00FF00;
                font-weight: bold;
                font-size: 13px;
                text-align: center;
              ">
              <div id="pm-lot-box" style="
                flex: 1;
                padding: 8px 10px;
                border: 1px solid #3b5a45;
                border-radius: 6px;
                background: #222;
                color: #dffff0;
                font-size: 13px;
                font-weight: bold;
                text-align: left;
                white-space: nowrap;
                overflow: hidden;
              ">
                <div id="pm-lot-details">Lot: -</div>
              </div>
              <button type="button" id="pm-copy-info" style="padding:8px 10px;border:1px solid #666;border-radius:6px;background:#2a2a2a;color:#fff;cursor:pointer;font-size:10px;">Copy</button>
            </div>
            <div id="pm-copy-status" style="color:#7dbb8f;font-size:10px;text-align:right;min-height:12px;margin-top:4px;">©MAKITATTOO</div>
          </div>
        </div>
      `;
      
      document.body.appendChild(overlay);
      
      // Apply lot info visibility after creation
      if (featureFlags.disableLotInfo) {
        const lotBox = document.getElementById('pm-lot-box');
        const copyBtn = document.getElementById('pm-copy-info');
        if (lotBox) lotBox.style.display = 'none';
        if (copyBtn) copyBtn.style.display = 'none';
      }
      
      // Create toggle button outside of any hidden container
      const toggleBtn = document.createElement('button');
      toggleBtn.id = 'pm-toggle-overlay';
      toggleBtn.textContent = '-';
      toggleBtn.type = 'button';
      toggleBtn.style.cssText = `
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        border: 1px solid #00FF00;
        border-radius: 5px;
        background: #103010;
        color: #00FF00;
        cursor: pointer;
        font-size: 14px;
        font-weight: bold;
        line-height: 1;
        z-index: 1000000;
      `;
      overlay.appendChild(toggleBtn);
      
      // Minimize/Maximize toggle handler
      const headerDiv = overlay.querySelector('#pm-header');
      const overlayBody = overlay.querySelector('#pm-overlay-body');
      
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isCollapsed = toggleBtn.textContent === '+';
        
        if (isCollapsed) {
          // Expand - show everything
          overlay.style.width = '220px';
          overlay.style.height = 'auto';
          overlay.style.padding = '12px';
          toggleBtn.style.top = '8px';
          toggleBtn.style.right = '8px';
          toggleBtn.style.left = 'auto';
          toggleBtn.style.transform = 'none';
          if (headerDiv) headerDiv.style.display = 'flex';
          if (overlayBody) overlayBody.style.display = 'block';
          toggleBtn.textContent = '-';
          toggleBtn.title = 'Minimize';
        } else {
          // Collapse - hide everything except toggle button
          overlay.style.width = '40px';
          overlay.style.height = '40px';
          overlay.style.padding = '8px';
          toggleBtn.style.top = '8px';
          toggleBtn.style.right = '8px';
          toggleBtn.style.left = 'auto';
          toggleBtn.style.transform = 'none';
          if (headerDiv) headerDiv.style.display = 'none';
          if (overlayBody) overlayBody.style.display = 'none';
          toggleBtn.textContent = '+';
          toggleBtn.title = 'Maximize';
        }
      });
      
      hydrateOverlayState().then((state) => {
        overlayState = state;
        overlay.style.left = `${overlayState.left}px`;
        overlay.style.top = `${overlayState.top}px`;
        renderOverlayState(overlay, overlayState);
      });
      wireOverlayControls(overlay);
      makeOverlayDraggable(overlay);

      // Initialize clock
      updateClock();
      setInterval(updateClock, 1000);

      log(`Overlay created - BE: ${calculatedPrice}`);
    } catch (err) {
      log('Overlay error: ' + err.message);
    }
  }

  // Force create overlay (for when re-enabled via remote config)
  function forceCreateOverlay() {
    let overlay = document.getElementById('price-monitor-overlay');
    if (overlay) {
      overlay.style.display = 'block';
      return;
    }
    
    // Check if overlay is disabled
    if (featureFlags.disableOverlay || !featureFlags.enabled) {
      return;
    }
    
    // Create with default price 0, forcing creation
    updateScrollerWithCalculatedPrice('0', true);
  }

  function calcButtonStyle(background = '#2a2a2a', color = '#ffffff') {
    return `min-height:40px;border:none;border-radius:6px;background:${background};color:${color};font-weight:bold;font-size:16px;cursor:pointer;`;
  }

  function iconButtonStyle() {
    return 'width:24px;height:24px;border:1px solid #00FF00;border-radius:5px;background:#103010;color:#00FF00;cursor:pointer;font-size:11px;line-height:1;';
  }

  async function hydrateOverlayState() {
    const data = await chrome.storage.local.get(OVERLAY_STORAGE_KEY);
    return normalizeOverlayState({
      ...DEFAULT_OVERLAY_STATE,
      ...(data[OVERLAY_STORAGE_KEY] || {})
    });
  }

  async function persistOverlayState(nextState) {
    overlayState = normalizeOverlayState(nextState);
    await chrome.storage.local.set({
      [OVERLAY_STORAGE_KEY]: overlayState
    });
  }

  function renderOverlayState(overlay, state) {
    const estimateBody = overlay.querySelector('#pm-estimate-body');
    const calcBody = overlay.querySelector('#pm-calc-body');
    const estimateToggle = overlay.querySelector('#pm-toggle-estimate');
    const calcToggle = overlay.querySelector('#pm-toggle-calc');
    const expression = overlay.querySelector('#pm-calc-expression');
    const result = overlay.querySelector('#pm-calc-result');
    const status = overlay.querySelector('#pm-calc-status');
    const lotBox = overlay.querySelector('#pm-lot-box');
    const lotLineEl = overlay.querySelector('#pm-lot-line');
    const copyStatusEl = overlay.querySelector('#pm-copy-status');
    const enabledRadio = overlay.querySelector('#pass-sold-enabled');
    const disabledRadio = overlay.querySelector('#pass-sold-disabled');

    if (estimateBody) {
      estimateBody.style.display = state.minimized ? 'none' : 'block';
    }
    if (calcBody) {
      calcBody.style.display = state.calcMinimized ? 'none' : 'block';
    }
    if (estimateToggle) {
      estimateToggle.innerHTML = state.minimized ? '&#9660;' : '&#9650;';
      estimateToggle.title = state.minimized ? 'Maximize' : 'Minimize';
    }
    if (calcToggle) {
      calcToggle.innerHTML = state.calcMinimized ? '&#9660;' : '&#9650;';
      calcToggle.title = state.calcMinimized ? 'Maximize' : 'Minimize';
    }
    
    // Lot Info Toggle handling
    const lotToggle = overlay.querySelector('#pm-toggle-lot');
    const lotArea = overlay.querySelector('#pm-lot-area');
    if (lotToggle) {
      lotToggle.innerHTML = state.lotMinimized ? '&#9660;' : '&#9650;';
      lotToggle.title = state.lotMinimized ? 'Maximize' : 'Minimize';
    }
    if (lotArea) {
      lotArea.style.display = state.lotMinimized ? 'none' : 'block';
    }
    if (expression) {
      expression.textContent = state.calcExpression || '0';
    }
    if (result) {
      result.textContent = state.calcResult || '0';
    }
    if (status) {
      status.textContent = state.calcStatus || 'Ready';
    }
    
    // Update radio button state
    if (enabledRadio && disabledRadio) {
      enabledRadio.checked = state.passSoldLock === 'enabled';
      disabledRadio.checked = state.passSoldLock === 'disabled';
    }
    
    if (lotBox) {
      const detailsEl = overlay.querySelector('#pm-lot-details');
      if (detailsEl) {
        detailsEl.innerHTML = `<div style="font-weight:bold;font-size:13px;">Lot: ${getLotDisplayValue() || '-'}</div>`;
      }
      if (copyStatusEl && !copyStatusEl.dataset.locked) {
        copyStatusEl.textContent = '©MAKITATTOO';
      }
    }
    
    // Update account suffix input if not focused
    const accountInput = overlay.querySelector('#pm-account-suffix');
    if (accountInput && document.activeElement !== accountInput) {
      if (accountInput.value !== sellerNameSuffix) {
        accountInput.value = sellerNameSuffix;
      }
    }
  }

  function wireOverlayControls(overlay) {
    const overlayToggle = overlay.querySelector('#pm-toggle-overlay');
    const calcToggle = overlay.querySelector('#pm-toggle-calc');
    const clearButton = overlay.querySelector('#pm-clear');
    const equalsButton = overlay.querySelector('#pm-equals');
    const timerButton = overlay.querySelector('#pm-timer');
    const copyButton = overlay.querySelector('#pm-copy-info');
    const copyStatusEl = overlay.querySelector('#pm-copy-status');
    const calcButtons = Array.from(overlay.querySelectorAll('[data-calc]'));
    const allButtons = Array.from(overlay.querySelectorAll('button'));

    for (const button of allButtons) {
      button.style.pointerEvents = 'auto';
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true);
    }

    const commitOverlayState = async (statusText) => {
      overlayState = normalizeOverlayState(overlayState);
      overlayState.calcStatus = statusText || 'Ready';
      renderOverlayState(overlay, overlayState);
      await persistOverlayState(overlayState);
    };

    // Estimate is editable, Bid Estimate updates automatically
    const estInput = overlay.querySelector('#pm-est-value');
    const beValue = overlay.querySelector('#pm-be-value');

    if (estInput && beValue) {
      // When Estimate changes, update Bid Estimate (Est / Divisor)
      estInput.addEventListener('input', (e) => {
        const rawVal = e.target.value.replace(/,/g, '').replace(/[^0-9]/g, '');
        const estVal = parseFloat(rawVal);
        if (!isNaN(estVal) && estVal > 0) {
          beValue.textContent = Math.round(estVal / bidEstimateDivisor).toLocaleString();
          
          // Update bid estimate color based on current bid
          const currentBid = getCurrentBidPrice();
          if (currentBid) {
            const bidEstimate = Math.round(estVal / bidEstimateDivisor);
            updateBidEstimateColor(currentBid, bidEstimate);
            updateCurrentAskPriceColor(currentBid, bidEstimate);
            updateAuctionToolsGold();
            updateSoldButtonState();
          }
        }
        // Format Estimate with commas
        if (rawVal) {
          e.target.value = parseInt(rawVal).toLocaleString();
        }
      });
    }

    // Keyboard support for calculator
    document.addEventListener('keydown', (e) => {
      // Only handle if overlay is visible and not typing in inputs
      if (overlay.dataset.collapsed === 'true') return;
      if (e.target.tagName === 'INPUT') return;
      
      const key = e.key;
      const validKeys = '0123456789+-*/.=';
      
      if (validKeys.includes(key)) {
        e.preventDefault();
        if (key === '=') {
          overlayState.calcExpression = safelyEvaluate(overlayState.calcExpression);
          overlayState.calcResult = overlayState.calcExpression;
          commitOverlayState('Calculated');
        } else {
          overlayState.calcExpression = appendCalculatorValue(overlayState.calcExpression, key);
          overlayState.calcResult = previewExpression(overlayState.calcExpression);
          commitOverlayState(`Pressed ${key}`);
        }
      } else if (key === 'Enter') {
        e.preventDefault();
        overlayState.calcExpression = safelyEvaluate(overlayState.calcExpression);
        overlayState.calcResult = overlayState.calcExpression;
        commitOverlayState('Calculated');
      } else if (key === 'Escape' || ((key === 'c' || key === 'C') && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        overlayState = { ...DEFAULT_OVERLAY_STATE, calcStatus: 'Cleared' };
        commitOverlayState('Cleared');
      }
    });

    // Minimize/Maximize overlay toggle - fully collapses/restores entire UI
    if (overlayToggle) {
      overlayToggle.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        
        const isCollapsed = overlay.dataset.collapsed === 'true';
        
        if (isCollapsed) {
          // Expand - show everything, change to [-]
          overlay.dataset.collapsed = 'false';
          overlay.style.width = '220px';
          overlay.style.height = 'auto';
          overlay.style.padding = '12px';
          
          // Show all direct children except the toggle button's container
          Array.from(overlay.children).forEach(child => {
            if (child.id !== 'pm-toggle-overlay') {
              child.style.display = 'block';
            }
          });
          
          overlayToggle.textContent = '-';
          overlayToggle.title = 'Minimize';
        } else {
          // Collapse - hide everything except toggle button, change to [+]
          overlay.dataset.collapsed = 'true';
          overlay.style.width = '44px';
          overlay.style.height = '44px';
          overlay.style.padding = '8px';
          
          // Hide all direct children except the toggle button
          Array.from(overlay.children).forEach(child => {
            if (child.id !== 'pm-toggle-overlay') {
              child.style.display = 'none';
            }
          });
          
          // Reposition toggle button to center when collapsed
          overlayToggle.style.position = 'absolute';
          overlayToggle.style.left = '50%';
          overlayToggle.style.top = '50%';
          overlayToggle.style.transform = 'translate(-50%, -50%)';
          
          overlayToggle.textContent = '+';
          overlayToggle.title = 'Maximize';
        }
      });
    }

    if (calcToggle) {
      calcToggle.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        overlayState.calcMinimized = !overlayState.calcMinimized;
        await commitOverlayState(overlayState.calcMinimized ? 'Calculator minimized' : 'Calculator expanded');
      });
    }

    const lotToggle = overlay.querySelector('#pm-toggle-lot');
    if (lotToggle) {
      lotToggle.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        overlayState.lotMinimized = !overlayState.lotMinimized;
        await commitOverlayState(overlayState.lotMinimized ? 'Lot Info minimized' : 'Lot Info expanded');
      });
    }
    
    const accountInput = overlay.querySelector('#pm-account-suffix');
    if (accountInput) {
      accountInput.addEventListener('input', (e) => {
        const val = e.target.value;
        sellerNameSuffix = val;
        chrome.storage.local.set({ sellerNameSuffix: val });
        log('Account suffix changed from UI: ' + val);
      });
      // Prevent drag when interacting with input
      accountInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    if (clearButton) {
      clearButton.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        overlayState = { ...DEFAULT_OVERLAY_STATE, calcStatus: 'Cleared' };
        await commitOverlayState('Cleared');
      });
    }

    if (equalsButton) {
      equalsButton.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        overlayState.calcExpression = safelyEvaluate(overlayState.calcExpression);
        overlayState.calcResult = overlayState.calcExpression;
        await commitOverlayState('Calculated');
      });
    }

    if (timerButton) {
      timerButton.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        
        startTimerLabelCountdown(timerButton);
        
        // Try MP3 first, fallback to beeps
        const playedMP3 = await playBundledTimerAudio();
        if (!playedMP3) {
          playSixSecondTimer();
        }
        
        await persistOverlayState(overlayState);
      });
    }

    // Pass/Sold Lock radio button handlers
    const enabledRadio = overlay.querySelector('#pass-sold-enabled');
    const disabledRadio = overlay.querySelector('#pass-sold-disabled');

    if (enabledRadio) {
      enabledRadio.addEventListener('change', async (event) => {
        if (event.target.checked) {
          overlayState.passSoldLock = 'enabled';
          await persistOverlayState(overlayState);
          updateSoldButtonState(); // Apply the change immediately
        }
      });
    }

    if (disabledRadio) {
      disabledRadio.addEventListener('change', async (event) => {
        if (event.target.checked) {
          overlayState.passSoldLock = 'disabled';
          await persistOverlayState(overlayState);
          updateSoldButtonState(); // Apply the change immediately
        }
      });
    }

    if (copyButton) {
      copyButton.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const copyText = buildInfoCopyText(overlay);
        const copied = await copyTextToClipboard(copyText);

        if (copyStatusEl) {
          copyStatusEl.dataset.locked = 'true';
          copyStatusEl.textContent = copied ? 'Copied' : 'Copy failed';
          setTimeout(() => {
            copyStatusEl.textContent = '©MAKITATTOO';
            delete copyStatusEl.dataset.locked;
          }, 1500);
        }
      });
    }

    for (const button of calcButtons) {
      button.addEventListener('pointerup', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const value = button.getAttribute('data-calc');
        overlayState.calcExpression = appendCalculatorValue(overlayState.calcExpression, value);
        overlayState.calcResult = previewExpression(overlayState.calcExpression);
        await commitOverlayState(`Pressed ${value}`);
      });
    }
  }

  function makeOverlayDraggable(overlay) {
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragRaf = null;

    overlay.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;

      isDragging = true;
      dragOffsetX = e.clientX - overlay.offsetLeft;
      dragOffsetY = e.clientY - overlay.offsetTop;
      overlay.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const x = e.clientX - dragOffsetX;
        const y = e.clientY - dragOffsetY;
        const maxX = window.innerWidth - overlay.offsetWidth;
        const maxY = window.innerHeight - overlay.offsetHeight;

        overlayState.left = Math.max(0, Math.min(x, maxX));
        overlayState.top = Math.max(0, Math.min(y, maxY));

        overlay.style.left = overlayState.left + 'px';
        overlay.style.top = overlayState.top + 'px';
        overlay.style.right = 'auto';
      }
    });

    document.addEventListener('mouseup', async () => {
      if (isDragging) {
        isDragging = false;
        overlay.style.cursor = 'grab';

        if (dragRaf) {
          clearTimeout(dragRaf);
        }
        dragRaf = setTimeout(() => {
          persistOverlayState(overlayState);
          dragRaf = null;
        }, 0);
      }
    });

    overlay.style.cursor = 'grab';
    overlay.title = 'Drag to move';
  }

  function safelyEvaluate(expression) {
    const normalized = sanitizeExpression(expression);
    if (!/^[0-9+\-*/%.()]+$/.test(normalized)) {
      return '0';
    }

    try {
      const result = evaluateMathExpression(normalized);
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        return '0';
      }
      return Number.isInteger(result) ? String(result) : Number(result.toFixed(8)).toString();
    } catch {
      return '0';
    }
  }

  function normalizeOverlayState(state) {
    const nextState = {
      ...DEFAULT_OVERLAY_STATE,
      ...state
    };

    if (!/^[0-9+\-*/%.()]+$/.test(sanitizeExpression(nextState.calcExpression))) {
      nextState.calcExpression = '0';
      nextState.calcResult = '0';
    } else {
      nextState.calcExpression = sanitizeExpression(nextState.calcExpression);
      nextState.calcResult = previewExpression(nextState.calcExpression);
    }

    if (!nextState.calcStatus) {
      nextState.calcStatus = 'Ready';
    }
    return nextState;
  }

  function appendCalculatorValue(expression, value) {
    const current = sanitizeExpression(expression);
    const lastChar = current.slice(-1);
    const isOperator = /[+\-*/%]/.test(value);
    const isLastOperator = /[+\-*/%.]/.test(lastChar);

    if (value === '.') {
      const currentPart = current.split(/[+\-*/%]/).pop();
      if (currentPart.includes('.')) {
        return current;
      }
      return current + '.';
    }

    if (isOperator) {
      if (current === '0' && value !== '-') {
        return current;
      }
      if (isLastOperator) {
        return current.slice(0, -1) + value;
      }
      return current + value;
    }

    if (current === '0') {
      return value;
    }

    return current + value;
  }

  function previewExpression(expression) {
    const safeExpression = sanitizeExpression(expression);
    if (!safeExpression || safeExpression === '0') {
      return '0';
    }

    if (/^\d+(\.\d+)?$/.test(safeExpression)) {
      return safeExpression;
    }

    if (/[+\-*/%.]$/.test(safeExpression)) {
      return '0';
    }

    return safelyEvaluate(safeExpression);
  }

  function sanitizeExpression(expression) {
    return String(expression || '0').replace(/\s+/g, '').replace(/[^0-9+\-*/%.()]/g, '') || '0';
  }

  function evaluateMathExpression(expression) {
    const tokens = tokenizeExpression(expression);
    const values = [];
    const operators = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (isNumericToken(token)) {
        values.push(parseFloat(token));
        continue;
      }

      if (token === '(') {
        operators.push(token);
        continue;
      }

      if (token === ')') {
        while (operators.length && operators[operators.length - 1] !== '(') {
          applyTopOperator(values, operators);
        }
        if (!operators.length) {
          throw new Error('Mismatched parentheses');
        }
        operators.pop();
        continue;
      }

      while (
        operators.length &&
        operators[operators.length - 1] !== '(' &&
        precedenceOf(operators[operators.length - 1]) >= precedenceOf(token)
      ) {
        applyTopOperator(values, operators);
      }
      operators.push(token);
    }

    while (operators.length) {
      if (operators[operators.length - 1] === '(') {
        throw new Error('Mismatched parentheses');
      }
      applyTopOperator(values, operators);
    }

    if (values.length !== 1) {
      throw new Error('Invalid expression');
    }

    return values[0];
  }

  function tokenizeExpression(expression) {
    const tokens = [];
    let current = '';

    for (let i = 0; i < expression.length; i++) {
      const char = expression[i];
      const prev = tokens.length ? tokens[tokens.length - 1] : null;
      const unaryMinus =
        char === '-' &&
        current === '' &&
        (i === 0 || prev === '(' || isOperatorToken(prev));

      if (/[0-9.]/.test(char) || unaryMinus) {
        current += char;
        continue;
      }

      if (current) {
        tokens.push(current);
        current = '';
      }

      tokens.push(char);
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  function applyTopOperator(values, operators) {
    const operator = operators.pop();
    const right = values.pop();
    const left = values.pop();

    if (typeof left !== 'number' || typeof right !== 'number') {
      throw new Error('Missing operand');
    }

    switch (operator) {
      case '+':
        values.push(left + right);
        break;
      case '-':
        values.push(left - right);
        break;
      case '*':
        values.push(left * right);
        break;
      case '/':
        values.push(right === 0 ? NaN : left / right);
        break;
      case '%':
        values.push(right === 0 ? NaN : left % right);
        break;
      default:
        throw new Error('Unknown operator');
    }
  }

  function precedenceOf(operator) {
    return operator === '+' || operator === '-' ? 1 : 2;
  }

  function isOperatorToken(token) {
    return token === '+' || token === '-' || token === '*' || token === '/' || token === '%';
  }

  function isNumericToken(token) {
    return /^-?\d+(\.\d+)?$/.test(token);
  }

  function buildInfoCopyText(overlay) {
    const meta = getAuctionMeta();
    const estimateValue = getEstimateValue();
    const bidEstimate = calculateBidEstimate(estimateValue);
    const internetPrice = getInternetBidPrice();
    const fields = [
      meta.sellerName,
      meta.catalogTitle + '\n', // Adding one extra newline here; join(\n) will add the second
      `Lot: ${getLotDisplayValue() || '-'}`,
      meta.lotTitle,
      `Estimate: $ ${formatCurrencyValue(estimateValue)}`,
      `BE: $${bidEstimate}`,
      `LB: $${formatCurrencyValue(internetPrice)}`
    ];

    return fields.filter((value) => value && value !== '-').join('\n');
  }

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      log('Clipboard API failed: ' + err.message);
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch (err) {
      log('execCommand copy failed: ' + err.message);
      return false;
    }
  }

  async function playSixSecondTimer() {
    stopTimerSound();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      overlayState.timerStatus = 'Audio unsupported';
      return;
    }

    if (!timerAudioContext) {
      timerAudioContext = new AudioContextClass();
    }

    if (timerAudioContext.state === 'suspended') {
      await timerAudioContext.resume();
    }

    const scheduleBeep = (delayMs, durationMs, frequency, gainValue) => {
      const timeoutId = setTimeout(() => {
        if (!timerAudioContext) {
          return;
        }

        const oscillator = timerAudioContext.createOscillator();
        const gain = timerAudioContext.createGain();
        const start = timerAudioContext.currentTime;
        const end = start + durationMs / 1000;

        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        oscillator.connect(gain);
        gain.connect(timerAudioContext.destination);
        oscillator.start(start);
        oscillator.stop(end);
      }, delayMs);

      activeTimerTimeouts.push(timeoutId);
    };

    scheduleBeep(0, 180, 660, 0.05);
    scheduleBeep(1000, 180, 660, 0.05);
    scheduleBeep(2000, 180, 660, 0.05);
    scheduleBeep(3000, 180, 660, 0.05);
    scheduleBeep(4000, 180, 660, 0.05);
    scheduleBeep(5000, 180, 660, 0.05);
    scheduleBeep(5800, 550, 880, 0.08);
  }

  function stopTimerSound() {
    for (const timeoutId of activeTimerTimeouts) {
      clearTimeout(timeoutId);
    }
    activeTimerTimeouts = [];
  }

  async function playBundledTimerAudio() {
    try {
      stopBundledTimerAudio();

      const response = await fetch(chrome.runtime.getURL(TIMER_AUDIO_PATH));
      if (!response.ok) {
        throw new Error(`Audio fetch failed: ${response.status}`);
      }

      const audioBlob = await response.blob();
      timerAudioObjectUrl = URL.createObjectURL(audioBlob);
      timerAudioElement = new Audio(timerAudioObjectUrl);
      timerAudioElement.preload = 'auto';
      timerAudioElement.currentTime = 0;
      timerAudioElement.volume = 1;
      await timerAudioElement.play();
      return true;
    } catch (err) {
      log('Bundled timer audio failed: ' + err.message);
      return false;
    }
  }

  function stopBundledTimerAudio() {
    if (!timerAudioElement) {
      if (timerAudioObjectUrl) {
        URL.revokeObjectURL(timerAudioObjectUrl);
        timerAudioObjectUrl = null;
      }
      return;
    }

    try {
      timerAudioElement.pause();
      timerAudioElement.currentTime = 0;
    } catch (err) {
      log('Stop bundled timer audio failed: ' + err.message);
    }

    if (timerAudioObjectUrl) {
      URL.revokeObjectURL(timerAudioObjectUrl);
      timerAudioObjectUrl = null;
    }
    timerAudioElement = null;
  }

  function startTimerLabelCountdown(timerButton) {
    stopTimerLabelCountdown();

    if (!timerButton) {
      return;
    }

    timerButton.textContent = '6';

    for (let value = 5; value >= 1; value--) {
      const timeoutId = setTimeout(() => {
        timerButton.textContent = String(value);
      }, (6 - value) * 1000);
      activeTimerLabelTimeouts.push(timeoutId);
    }

    const resetId = setTimeout(() => {
      timerButton.textContent = 'TIMER';
    }, 6000);
    activeTimerLabelTimeouts.push(resetId);
  }

  function stopTimerLabelCountdown() {
    for (const timeoutId of activeTimerLabelTimeouts) {
      clearTimeout(timeoutId);
    }
    activeTimerLabelTimeouts = [];
  }

  function clearBidEstimateForLotVerification(lotId) {
    const overlay = document.getElementById('price-monitor-overlay');
    if (!overlay) return;

    const estValue = overlay.querySelector('#pm-est-value');
    const beValue = overlay.querySelector('#pm-be-value');

    if (estValue) {
      estValue.value = '';
      estValue.placeholder = 'Checking lot...';
    }

    if (beValue) {
      beValue.textContent = 'CHECKING...';
      beValue.style.color = '#ffff00';
      beValue.style.borderColor = '#ffff00';
      beValue.style.backgroundColor = '#2a2a1a';
    }

    log('Waiting 1 second to verify price for Lot ' + lotId);
  }

  function startLotVerification(lotId) {
    if (!lotId || lotId === verifiedLotId || pendingVerificationLotId === lotId) {
      return;
    }

    pendingVerificationLotId = lotId;
    const token = ++lotVerificationToken;

    // Prevent the previous lot's estimate from remaining visible while the
    // new lot is settling.
    clearBidEstimateForLotVerification(lotId);

    setTimeout(() => {
      // Ignore an old verification if another lot was detected meanwhile.
      if (token !== lotVerificationToken || pendingVerificationLotId !== lotId) {
        return;
      }

      const currentLotId = getLotId();
      if (currentLotId !== lotId || document.hidden || document.visibilityState !== 'visible') {
        pendingVerificationLotId = '';
        return;
      }

      const priceEl = findPriceElement();
      const verifiedPrice = priceEl ? extractPrice(priceEl.textContent) : null;

      if (!verifiedPrice || verifiedPrice === '0') {
        // The lot is still loading. Leave it in verification state and retry
        // after another second rather than using stale DOM content.
        log('Lot ' + lotId + ' has no valid estimate after 1 second; retrying');
        pendingVerificationLotId = '';
        setTimeout(() => {
          if (getLotId() === lotId) {
            startLotVerification(lotId);
          }
        }, LOT_VERIFY_DELAY);
        return;
      }

      // Verification succeeded. From this point onward this lot's DOM price
      // is allowed to drive the Bid Estimate.
      verifiedLotId = lotId;
      pendingVerificationLotId = '';
      lastPrice = '';
      log('Lot ' + lotId + ' verified after 1 second. Estimate: $' + verifiedPrice);
      checkPrice();
    }, LOT_VERIFY_DELAY);
  }

  function sendPrice(price, lotId) {
    if (price === lastPrice && lotId === lastLotId) return;

    lastPrice = price;
    lastLotId = lotId;

    try {
      chrome.runtime.sendMessage({
        type: 'PRICE_UPDATE',
        price,
        lotId,
        url: window.location.href,
        timestamp: Date.now()
      });
      log(`Price update: $${price} (Lot ${lotId})`);
    } catch (err) {
      log('Extension context invalidated - unable to send message: ' + err.message);
    }
  }

  function checkPrice() {
    if (!isMonitoring) return;
    
    // Check if price monitoring is disabled by remote config
    if (!featureFlags.enabled || featureFlags.disablePriceMonitor) {
      return;
    }

    if (document.hidden || document.visibilityState !== 'visible') {
      setTimeout(checkPrice, checkInterval);
      return;
    }

    const lotId = getLotId();
    if (!lotId) {
      setTimeout(checkPrice, checkInterval);
      return;
    }

    if (lotId !== lastLotId && lastLotId !== '') {
      log('Lot changed from ' + lastLotId + ' to ' + lotId + ' - resetting state');
      lastPrice = '';
      lastLotId = lotId;
      hasLockedPassThisLot = false;
    } else if (lastLotId === '') {
      // First lot after the extension/page loads: verify it too.
      lastLotId = lotId;
      lastPrice = '';
    }

    // Do not trust the DOM immediately after a lot change. Start a one-second
    // verification window and wait for it to complete before reading the
    // estimate or calculating Bid Estimate.
    if (verifiedLotId !== lotId) {
      startLotVerification(lotId);
      setTimeout(checkPrice, checkInterval);
      return;
    }

    if (pendingVerificationLotId === lotId) {
      setTimeout(checkPrice, checkInterval);
      return;
    }

    if (!isCurrentLot()) {
      setTimeout(checkPrice, checkInterval);
      return;
    }

    const priceEl = findPriceElement();
    if (!priceEl) {
      setTimeout(checkPrice, checkInterval);
      return;
    }

    const price = extractPrice(priceEl.textContent);
    const currentBid = getCurrentBidPrice();
    
    // Always send price to background (triggers GitHub check) even when UI disabled
    if (price !== lastPrice) {
      sendPrice(price, lotId);
    }
    
    // Update UI only if overlay is not disabled
    if (!featureFlags.disableOverlay && featureFlags.enabled) {
      updateScrollerWithCalculatedPrice(price);
      
      // Update bid estimate color based on current bid
      if (currentBid) {
        const bidEstimate = calculateBidEstimate(price);
        updateBidEstimateColor(currentBid, bidEstimate);
        updateCurrentAskPriceColor(currentBid, bidEstimate);
        updateAuctionToolsGold();
        updateSoldButtonState();
      }
    }

    setTimeout(checkPrice, checkInterval);
  }

  try {
  chrome.storage.local.get(['isMonitoring']).then((data) => {
    if (typeof data.isMonitoring === 'boolean') {
      isMonitoring = data.isMonitoring;
    }
    checkPrice();
  }).catch(err => {
    log('Storage error - using default monitoring: ' + err.message);
    checkPrice();
  });
} catch (err) {
  log('Extension context invalidated - using default monitoring: ' + err.message);
  checkPrice();
}

  try {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
      sendResponse({
        isMonitoring,
        lastPrice,
        lastLotId,
        url: window.location.href
      });
    } else if (request.type === 'TOGGLE_MONITORING') {
      isMonitoring = !isMonitoring;
      try {
        chrome.storage.local.set({ isMonitoring });
      } catch (err) {
        log('Storage error in toggle monitoring: ' + err.message);
      }
      if (isMonitoring) checkPrice();
      sendResponse({ isMonitoring });
    } else if (request.type === 'FORCE_CHECK') {
      const lotId = getLotId();
      const priceEl = findPriceElement();
      const price = priceEl ? extractPrice(priceEl.textContent) : null;

      if (price && price !== '0') {
        updateScrollerWithCalculatedPrice(price);
        sendPrice(price, lotId);
      }

      sendResponse({ price, lotId, url: window.location.href });
    }
  });
} catch (err) {
  log('Extension context invalidated - message listener failed: ' + err.message);
}

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.visibilityState === 'visible') {
      lastPrice = '';
      // Treat returning to the page like a fresh lot load so the displayed
      // estimate is re-validated against the current DOM.
      verifiedLotId = '';
      pendingVerificationLotId = '';
      lotVerificationToken++;
      checkPrice();
    }
  });

  startMissiveMessageMonitor();

  log('Price monitor started');
})();
