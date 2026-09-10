(function() {
  'use strict';
  console.log('[FastBid] Version 2.0 - Storage Removed');
  const EXTENSION_SERVER_URL = 'http://localhost:9999';
  
  let lastPrice = '';
  let lastLotId = '';
  let totalUpdates = 0;
  let isMonitoring = true;
  let lastButtonStatesLotId = '';
  
  let serverOfflineUntil = 0;
  let serverFailureCount = 0;
  let syncTicks = 0;
  let cachedEstimateEl = null;
  let cachedPriceEl = null;

  async function safeFetch(url, options) {
    if (Date.now() < serverOfflineUntil) return null;
    
    try {
      const resp = await fetch(url, options);
      // Reset only if we actually got a response (not 404 or something, but connection worked)
      serverFailureCount = 0; 
      return resp;
    } catch (e) {
      serverFailureCount++;
      if (serverFailureCount > 3) {
        console.warn('[FastBid] Server seems offline. Backing off for 5 seconds...');
        serverOfflineUntil = Date.now() + 5000;
      }
      return null;
    }
  }

  console.log('[FastBid] Monitor Script Initializing...');

  // Force a layout reflow so getBoundingClientRect() returns committed positions.
  // This is critical after Chrome is restored from background/minimized state —
  // without it, coords can be stale from the last painted frame.
  function forceReflow() {
    void document.body.offsetHeight;
  }

  // Track page state to detect when reflow is actually needed
  let lastPageWidth = window.innerWidth;
  let lastPageHeight = window.innerHeight;
  let lastDevicePixelRatio = window.devicePixelRatio || 1;

  function needsPageRecalc() {
    // Only reflow if the page size or zoom changed
    const currentWidth = window.innerWidth;
    const currentHeight = window.innerHeight;
    const currentDPR = window.devicePixelRatio || 1;
    
    if (currentWidth !== lastPageWidth || currentHeight !== lastPageHeight || currentDPR !== lastDevicePixelRatio) {
      lastPageWidth = currentWidth;
      lastPageHeight = currentHeight;
      lastDevicePixelRatio = currentDPR;
      return true;
    }
    return false;
  }

  function forceReflow() {
    void document.body.offsetHeight;
  }

  function getElementInfo(el) {
    if (!el) return { exists: false, enabled: false };
    
    // Only force reflow if page dimensions changed (resize/zoom)
    if (needsPageRecalc()) {
      forceReflow();
    }
    
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      exists: true,
      enabled: !el.disabled && el.style.display !== 'none' && el.style.visibility !== 'hidden',
      centerXDevice: Math.round((r.left + r.width / 2) * dpr),
      centerYDevice: Math.round((r.top + r.height / 2) * dpr),
      centerX: Math.round(r.left + r.width / 2),
      centerY: Math.round(r.top + r.height / 2)
    };
  }

  function findBtn(keywords) {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      const text = (b.textContent || '').toLowerCase();
      for (const k of keywords) {
        if (text.includes(k.toLowerCase())) return b;
      }
    }
    return null;
  }

  function normalizeButtonText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function findBtnExact(labels) {
    const wanted = labels.map(normalizeButtonText);
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (wanted.includes(normalizeButtonText(b.textContent))) return b;
    }
    return null;
  }

  function findBtnsExact(labels) {
    const wanted = labels.map(normalizeButtonText);
    return Array.from(document.querySelectorAll('button'))
      .filter(b => wanted.includes(normalizeButtonText(b.textContent)));
  }

  function installUnsoldClickBlocker() {
    if (window.__fastbidUnsoldClickBlockerInstalled) return;
    window.__fastbidUnsoldClickBlockerInstalled = true;

    const blockIfUnsold = (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('button') : null;
      if (!btn || normalizeButtonText(btn.textContent) !== 'unsold') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type => {
      document.addEventListener(type, blockIfUnsold, true);
    });
  }

  function setUnsoldGuard() {
    installUnsoldClickBlocker();
    for (const btn of document.querySelectorAll('button')) {
      const text = normalizeButtonText(btn.textContent);

      if (text === 'unsold') {
        btn.dataset.fastbidUnsoldGuard = '1';
        btn.setAttribute('aria-disabled', 'true');
      } else if (btn.dataset.fastbidUnsoldGuard) {
        btn.removeAttribute('aria-disabled');
        delete btn.dataset.fastbidUnsoldGuard;
      }
    }
  }

  /**
   * @param {HTMLButtonElement|null} btn
   * @param {ReturnType<typeof getElementInfo>} base
   */
  function buildInternetState(btn, base) {
    if (!btn || !base.exists) {
      return {
        exists: false,
        enabled: false,
        text: '',
        hasPriceInLabel: false,
        ready: false,
        readyReason: 'missing'
      };
    }

    const text = (btn.textContent || '').trim().slice(0, 120);
    const hasPriceInLabel = /\$\s*[\d,]+/.test(text);
    const ready = Boolean(base.enabled);

    return {
      ...base,
      text,
      hasPriceInLabel,
      ready,
      readyReason: ready ? 'enabled_with_price' : (base.enabled ? 'enabled_no_price' : 'disabled')
    };
  }

  async function sync() {
    if (!isMonitoring) return;
    if (Date.now() < serverOfflineUntil) return;
    
    syncTicks++;

    // --- LOT ID MONITOR (Composite Signature) ---
    function findLotId() {
        // 1. Get the Auction ID (The 'Switching Sign' from URL or Page)
        let auctionId = '0';
        
        // Strategy A: Direct URL Hunt (Looking for any 5-10 digit identification number)
        const urlMatches = window.location.href.match(/\/(\d{5,10})(?:\/|\?|#|$)/) 
                        || window.location.href.match(/id=(\d{5,10})/);
        if (urlMatches) {
            auctionId = urlMatches[1];
        }

        // Strategy B: Page Source Hunt (If URL is masked)
        if (auctionId === '0') {
            const bodyId = document.querySelector('[data-auction-id], [id*="auction-id"]');
            if (bodyId) auctionId = bodyId.getAttribute('data-auction-id') || bodyId.innerText.match(/\d+/)[0];
        }

        // 2. Get the Lot Number (The 'Active Lot' from UI)
        let lotNumber = '-';
        const input = document.querySelector('input[name="lotNumber"], input[aria-label="lotNumber"], .lot-number-input');
        if (input && input.value) {
            lotNumber = input.value.trim();
        } else {
            const label = document.querySelector('.lot-label, [class*="lotNumber"], [class*="lot-id"], h1[class*="LotNumber"]');
            if (label && label.textContent) {
                const m = label.textContent.match(/Lot\s*#?([A-Z0-9-]+)/i);
                lotNumber = m ? m[1] : label.textContent.trim().slice(0, 10);
            }
        }

        // 3. Combine them: SwitchingSign_ActiveLot
        return auctionId + '_' + lotNumber;
    }

    let lotId = findLotId() || lastLotId || '-';
    if (lotId && lotId !== '-' && lotId !== lastLotId) {
        lastLotId = lotId;
    }

    // --- 1. ESTIMATE MONITOR ---
    let estText = '';

    // Strategy 1: Known CSS class
    const estEl = document.querySelector('.estimate_VL0CI');
    if (estEl) estText = estEl.textContent.trim();

    // Strategy 2: Any element with data-testid containing "estimate"
    if (!estText) {
        const estAttr = document.querySelector('[data-testid*="estimate"], [class*="estimate"]');
        if (estAttr) estText = estAttr.textContent.trim();
    }

    // Strategy 3: Full text scan for "Estimate:" label on the page
    if (!estText) {
        if (cachedEstimateEl && cachedEstimateEl.isConnected) {
            const txt = cachedEstimateEl.textContent.trim();
            if (/^estimate\s*:/i.test(txt) && txt.includes('$')) {
                estText = txt;
            } else {
                cachedEstimateEl = null;
            }
        }
        
        if (!estText && (syncTicks % 20 === 0)) { // Throttle to 500ms
            const allEls = document.querySelectorAll('span, div, p, li');
            for (const el of allEls) {
                const txt = el.textContent.trim();
                if (/^estimate\s*:/i.test(txt) && txt.includes('$')) {
                    estText = txt;
                    cachedEstimateEl = el;
                    break;
                }
            }
        }
    }

    if (estText) {
        estText = estText.replace(/^estimate\s*:\s*/i, '').trim();
        if (estText.includes('$')) {
            safeFetch(`${EXTENSION_SERVER_URL}/price`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    price: estText, 
                    lotId: lotId,
                    focused: document.hasFocus() && document.visibilityState === 'visible'
                })
            });
        }
    }

    // --- 2. CURRENT PRICE MONITOR ---
    let currentPrice = '';
    
    // Check the primary LiveAuctioneers bid input
    const bidInput = document.querySelector('input[name="currentAskPrice"], input[aria-label="currentAskPrice"]');
    if (bidInput && bidInput.value && bidInput.value !== '$0') {
        currentPrice = bidInput.value.replace(/[$,\s]/g, '');
    }

    // Fallback: Search page for currency patterns
    if (!currentPrice || currentPrice === '0') {
      if (cachedPriceEl && cachedPriceEl.isConnected) {
          const val = cachedPriceEl.textContent.trim();
          if (val.includes('$') && val.length < 15) {
              const clean = val.replace(/[$,\s]/g, '');
              if (clean && clean !== '0') { 
                  currentPrice = clean; 
              } else {
                  cachedPriceEl = null;
              }
          } else {
              cachedPriceEl = null;
          }
      }

      if ((!currentPrice || currentPrice === '0') && (syncTicks % 20 === 0)) {
          const allDivs = document.querySelectorAll('div, span, b, p');
          for (const el of allDivs) {
            const val = el.textContent.trim();
            if (val.includes('$') && val.length < 15) {
              if (/current|bid|ask|price/i.test(el.parentElement.textContent || '')) {
                const clean = val.replace(/[$,\s]/g, '');
                if (clean && clean !== '0') { 
                    currentPrice = clean; 
                    cachedPriceEl = el;
                    break; 
                }
              }
            }
          }
      }
    }

    if (currentPrice && currentPrice !== '0') {
        // ALWAYS update storage and send to server to keep AHK fresh
        lastPrice = currentPrice;
        lastLotId = lotId;
        totalUpdates++;
        

        safeFetch(`${EXTENSION_SERVER_URL}/current-ask-price`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            currentAskPrice: currentPrice, 
            lotId: lotId,
            focused: document.hasFocus() && document.visibilityState === 'visible'
          })
        });
    }

    // --- 3. BUTTON MONITOR ---
    if (lotId !== lastButtonStatesLotId) {
      lastButtonStatesLotId = lotId;
    }

      let progressPct = '';
      let progressText = '';
      const progressEl = document.querySelector('[class*="progress_"]');
      if (progressEl) {
        const divs = progressEl.querySelectorAll('div');
        for (let i = 0; i < divs.length; i++) {
          let t = divs[i].textContent || '';
          if (t.includes('%')) progressPct = t.trim();
          if (t.toLowerCase().includes('remaining')) progressText = t.trim();
        }
      }

      // --- AUCTION LOG MONITOR ---
      let lotIsClosed = false;
      let lotIsLastCall = false;
      let lotIsFairWarning = false;
      let hasErrorMissive = false;
      
      let messages = [];
      let currentLotMessages = [];
      const logContainer = document.querySelector('[class*="auctionInformation"] [class*="scroller"]');
      if (logContainer) {
        const rows = logContainer.querySelectorAll('[class*="row"]');
        messages = Array.from(rows).map(row => row.textContent.trim());
        
        // Check for error_CAQKD class (Failed to send missive)
        hasErrorMissive = Array.from(rows).some(row => 
          row.className.includes('error_CAQKD') || row.textContent.includes('Failed to send missive')
        );
        
        // Find messages for the current lot (after last "opened")
        let lastOpenedIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].includes('opened')) {
            lastOpenedIndex = i;
            break;
          }
        }
        
        if (lastOpenedIndex !== -1) {
          currentLotMessages = messages.slice(lastOpenedIndex);
        } else {
          currentLotMessages = messages; // Fallback
        }
        
        // Extract lot number from lotId (e.g., "12345_946A" -> "946A")
        const lotNumMatch = lotId.match(/_([A-Z0-9-]+)$/);
        const currentLotNum = lotNumMatch ? lotNumMatch[1] : '';
        
        if (currentLotNum) {
          // Check if current lot is closed or passed
          lotIsClosed = currentLotMessages.some(msg => msg.includes(`Lot ${currentLotNum} closed`) || msg.includes(`Lot ${currentLotNum} passed`));
        }
        
        lotIsLastCall = currentLotMessages.some(msg => msg.includes('Last Call') || msg.includes('Last call'));
        lotIsFairWarning = currentLotMessages.some(msg => msg.includes('Fair warning') || msg.includes('Going Once') || msg.includes('going once'));
        
        // Reset log if closed (User request)
        if (lotIsClosed) {
          currentLotMessages = [];
        }
      }

      setUnsoldGuard();
      const internet = findBtn(['Internet']);
      const soldBtn = findBtnExact(['Sold']);
      const internetBase = getElementInfo(internet);
      const states = {
        progress: { pct: progressPct, text: progressText },
        internet: buildInternetState(internet, internetBase),
        currentask: getElementInfo(bidInput),
        competing: getElementInfo(findBtn(['Competing Bid', 'Competing'])),
        next: getElementInfo(findBtn(['Next Lot'])),
        sold: getElementInfo(soldBtn),
        pass: getElementInfo(findBtn(['Pass'])),
        fair: getElementInfo(findBtn(['Fair Warning', 'Fair'])),
        going: getElementInfo(findBtn(['Going Once', 'Going Once...Going Twice', 'Going', 'Once', 'Twice'])),
        lastcall: getElementInfo(findBtn(['Last Call'])),
        sendmessage: getElementInfo(findBtn(['Send Message'])),
        lotIsClosed: lotIsClosed,
        lotIsLastCall: lotIsLastCall,
        lotIsFairWarning: lotIsFairWarning,
        hasErrorMissive: hasErrorMissive,
        auctionLog: currentLotMessages
    };

    safeFetch(`${EXTENSION_SERVER_URL}/button-states`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        states, 
        lotId,
        focused: document.hasFocus() && document.visibilityState === 'visible'
      })
    });
  }

  async function handlePendingCommands() {
    if (Date.now() < serverOfflineUntil) return;
    try {
      const isFocused = document.hasFocus() && document.visibilityState === 'visible';
      const resp = await safeFetch(`${EXTENSION_SERVER_URL}/get-pending-commands`);
      if (!resp) return;
      const data = await resp.json();
      
      if (data.success && data.commands && data.commands.length > 0) {
        for (const cmd of data.commands) {
          // IMPORTANT: Only the focused tab handles commands to avoid conflicts
          if (!isFocused) continue; 

          // NEW: Manual Override - If user is actively typing/focusing the element, don't hijack it
          const activeEl = document.activeElement;
          const isUserInteracting = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

          let success = false;
          if (cmd.type === 'SET_CURRENT_ASK') {
            const el = document.querySelector('input[name="currentAskPrice"], input[aria-label="currentAskPrice"]');
            if (el) {
              // Only inject if the user isn't currently typing in THIS specific element
              if (activeEl !== el) {
                el.focus();
                if (cmd.selectOnly) {
                  el.select();
                  success = true;
                } else {
                  el.value = cmd.value;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  success = true;
                }
              } else {
                // User is in the box! Skip this update but report "success" so it clears from queue
                // or we can wait. Let's report success to clear the stuck command.
                success = true; 
              }
            }
          }
          
          // Report result back to server
          safeFetch(`${EXTENSION_SERVER_URL}/command-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cmd.id, success })
          });
        }
      }
    } catch (e) {}
  }

  // Listen for messages including status requests and toggle commands
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
      sendResponse({
        lastPrice,
        lastLotId,
        totalUpdates,
        isMonitoring
      });
    } else if (request.type === 'TOGGLE_MONITOR') {
      isMonitoring = request.enabled;
      console.log('[FastBid] Monitoring ' + (isMonitoring ? 'ENABLED' : 'DISABLED'));
      sendResponse({ success: true, isMonitoring });
    }
  });

  console.log('[FastBid] Chrome Monitor Active - Auto-Backoff Engaged.');
  setInterval(() => {
    sync();
    handlePendingCommands();
  }, 100);
})();

