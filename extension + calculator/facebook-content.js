// Facebook Auction Monitor - Shows auction status when LiveAuctioneers is active
(function() {
  'use strict';

  let overlay = null;
  let checkInterval = null;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let handleMouseMove = null;
  let handleMouseUp = null;

  // Feature flags
  let featureFlags = {
    enabled: true,
    disableFacebookNote: false
  };

  // Local popup setting
  let fbNoteEnabled = true;
  let fbNoteMinimized = false;
  let fbNoteClosed = false;
  let settingsLoaded = false;

  // Load feature flags and local settings from storage
  function loadFeatureFlags() {
    chrome.storage.local.get(['featureFlags', 'fbNoteEnabled', 'fbNoteMinimized', 'fbNoteClosed'], (result) => {
      if (result.featureFlags) {
        featureFlags = result.featureFlags;
      }
      if (result.fbNoteEnabled !== undefined) {
        fbNoteEnabled = result.fbNoteEnabled;
      }
      if (result.fbNoteMinimized !== undefined) {
        fbNoteMinimized = result.fbNoteMinimized;
      }
      if (result.fbNoteClosed !== undefined) {
        fbNoteClosed = result.fbNoteClosed;
      }
      settingsLoaded = true;
      applyFeatureFlags();
    });
  }

  // Apply feature flags
  function applyFeatureFlags() {
    const isDisabled = !featureFlags.enabled || featureFlags.disableFacebookNote || !fbNoteEnabled || fbNoteClosed;
    if (isDisabled) {
      log('Facebook note disabled or closed');
      removeOverlay();
    } else {
      // Re-enable if it was disabled
      createOverlay();
    }
  }

  // Listen for feature flag changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.featureFlags) {
        featureFlags = changes.featureFlags.newValue;
      }
      if (changes.fbNoteEnabled !== undefined) {
        fbNoteEnabled = changes.fbNoteEnabled.newValue;
      }
      if (changes.fbNoteMinimized !== undefined) {
        fbNoteMinimized = changes.fbNoteMinimized.newValue;
      }
      if (changes.fbNoteClosed !== undefined) {
        fbNoteClosed = changes.fbNoteClosed.newValue;
      }
      applyFeatureFlags();
    }
  });

  loadFeatureFlags();

  function log(msg) {
    console.log('[FB Auction]', msg);
  }

  // Check if app should be closed (after 3:30PM) or open (after 9:30AM)
  function shouldAppBeOpen() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes(); // Convert to minutes
    
    const openTime = 9 * 60 + 30; // 9:30 AM = 570 minutes
    const closeTime = 15 * 60 + 30; // 3:30 PM = 930 minutes
    
    // If it's before 9:30 AM, app should be closed
    if (currentTime < openTime) {
      return false;
    }
    
    // If it's 3:30 PM or later, app should be closed
    if (currentTime >= closeTime) {
      return false;
    }
    
    // If it's between 9:30 AM and 3:30 PM, app should be open
    return true;
  }

  // Check if app should close
  function shouldCloseApp() {
    return !shouldAppBeOpen();
  }

  // Check if it's a new day (after 12AM) to reset daily flag
  function isNewDay() {
    const now = new Date();
    const today = now.toDateString();
    
    const lastCheck = localStorage.getItem('fbLastDayCheck');
    if (lastCheck !== today) {
      localStorage.setItem('fbLastDayCheck', today);
      return true;
    }
    
    return false;
  }

  // Create the overlay UI
  function createOverlay() {
    if (!settingsLoaded || document.getElementById('fb-auction-overlay') || fbNoteClosed) {
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'fb-auction-overlay';
    overlay.style.cssText = `
      position: fixed;
      left: 20px;
      top: 80px;
      width: 200px;
      padding: 12px;
      background: #1a1a1a;
      border-radius: 10px;
      font-family: system-ui, sans-serif;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      border: 1px solid #00FF00;
      color: #fff;
      cursor: move;
      user-select: none;
    `;

    // Check if app should be open
    if (!shouldAppBeOpen()) {
      // Don't create overlay at all when app should be closed
      return;
    }

    overlay.innerHTML = `
      <div id="fb-note-header" style="
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
        cursor: move;
      ">
        <div style="color:#00FF00;font-weight:bold;font-size:14px;flex:1;text-align:center;margin-left:48px;">Quick Note</div>
        <div style="display:flex;gap:4px;">
          <button id="fb-minimize-btn" title="Minimize" style="
            width: 22px;
            height: 22px;
            border: 1px solid #00FF00;
            border-radius: 4px;
            background: #103010;
            color: #00FF00;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
          ">-</button>
          <button id="fb-close-btn" title="Close" style="
            width: 22px;
            height: 22px;
            border: 1px solid #ff4444;
            border-radius: 4px;
            background: #301010;
            color: #ff4444;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
          ">×</button>
        </div>
      </div>
      <div id="fb-note-body" style="text-align:center;user-select:text;">
        <input type="text" id="fb-note-input" style="
          width: 100%;
          padding: 8px;
          border: 1px solid #00FF00;
          border-radius: 6px;
          background: #2a2a2a;
          color: #fff;
          font-family: system-ui;
          font-size: 14px;
          outline: none;
          box-sizing: border-box;
          cursor: text;
          user-select: text;
          pointer-events: auto;
        " placeholder="Type your note...">
        <div style="margin-top:8px;display:flex;gap:5px;">
          <button id="fb-copy-btn" style="
            flex: 1;
            padding: 6px 12px;
            border: 1px solid #00FF00;
            border-radius: 4px;
            background: #184628;
            color: #00FF00;
            cursor: pointer;
            font-size: 12px;
            font-weight: bold;
          ">Copy</button>
          <button id="fb-clear-btn" style="
            flex: 1;
            padding: 6px 12px;
            border: 1px solid #666;
            border-radius: 4px;
            background: #2a2a2a;
            color: #fff;
            cursor: pointer;
            font-size: 12px;
          ">Clear</button>
        </div>
        <div id="fb-copy-status" style="
          margin-top:4px;
          color: #00FF00;
          font-size: 11px;
          text-align: center;
          min-height: 14px;
        "></div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Add button event listeners
    const copyBtn = overlay.querySelector('#fb-copy-btn');
    const clearBtn = overlay.querySelector('#fb-clear-btn');
    const input = overlay.querySelector('#fb-note-input');
    const status = overlay.querySelector('#fb-copy-status');
    const body = overlay.querySelector('#fb-note-body');
    const minimizeBtn = overlay.querySelector('#fb-minimize-btn');
    const closeBtn = overlay.querySelector('#fb-close-btn');

    // Apply initial minimized state
    if (fbNoteMinimized && body) {
      body.style.display = 'none';
      minimizeBtn.textContent = '+';
      overlay.style.width = '140px'; // Smaller when minimized
    }

    if (minimizeBtn && body) {
      minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fbNoteMinimized = !fbNoteMinimized;
        body.style.display = fbNoteMinimized ? 'none' : 'block';
        minimizeBtn.textContent = fbNoteMinimized ? '+' : '-';
        overlay.style.width = fbNoteMinimized ? '140px' : '200px';
        chrome.storage.local.set({ fbNoteMinimized });
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Close Quick Note? You can re-enable it from the extension popup.')) {
          fbNoteClosed = true;
          chrome.storage.local.set({ fbNoteClosed });
          removeOverlay();
        }
      });
    }

    // Add drag event listeners with improved handling
    const handleMouseDown = (e) => {
      // Don't drag if clicking on input or buttons
      if (e.target.id === 'fb-note-input' || e.target.tagName === 'BUTTON') {
        return;
      }
      
      isDragging = true;
      dragOffset.x = e.clientX - overlay.offsetLeft;
      dragOffset.y = e.clientY - overlay.offsetTop;
      overlay.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    };

    const handleMouseMove = (e) => {
      if (isDragging && overlay) {
        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;
        
        // Keep within viewport
        const maxX = window.innerWidth - overlay.offsetWidth;
        const maxY = window.innerHeight - overlay.offsetHeight;
        
        overlay.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        overlay.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        overlay.style.right = 'auto'; // Prevent right positioning conflicts
        
        // Save position
        chrome.storage.local.set({ 
          facebookNotePosition: { left: overlay.style.left, top: overlay.style.top }
        });
      }
    };

    const handleMouseUp = () => {
      if (isDragging && overlay) {
        isDragging = false;
        overlay.style.cursor = 'move';
      }
    };

    // Add event listeners with capture to ensure they work
    overlay.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);

    // Load saved note and position on startup
    chrome.storage.local.get(['facebookNote', 'facebookNoteCreated', 'facebookNotePosition'], (result) => {
      // Load position
      if (result.facebookNotePosition) {
        overlay.style.left = result.facebookNotePosition.left;
        overlay.style.top = result.facebookNotePosition.top;
      }
      
      // Always load note if it exists (preserves across days)
      if (input && result.facebookNote) {
        input.value = result.facebookNote;
        log('Loaded saved note from previous day');
      }
    });

    // Save note as user types (only when app should be open and input exists)
    if (input) {
      input.addEventListener('input', () => {
        if (shouldAppBeOpen()) {
          const now = new Date().toISOString();
          chrome.storage.local.set({ 
            facebookNote: input.value,
            facebookNoteCreated: now
          });
        }
      });
    }

    if (copyBtn && input && status) {
      copyBtn.addEventListener('click', async () => {
        const text = input.value;
        if (!text) {
          status.textContent = 'Nothing to copy';
          setTimeout(() => status.textContent = '', 2000);
          return;
        }

        try {
          await navigator.clipboard.writeText(text);
          status.textContent = 'Copied!';
          setTimeout(() => status.textContent = '', 2000);
        } catch (err) {
          // Fallback for older browsers
          input.select();
          document.execCommand('copy');
          status.textContent = 'Copied!';
          setTimeout(() => status.textContent = '', 2000);
        }
      });
    }

    if (clearBtn && input && status) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        chrome.storage.local.remove(['facebookNote', 'facebookNoteCreated']);
        status.textContent = 'Cleared';
        setTimeout(() => status.textContent = '', 2000);
      });
    }

    log('Overlay created');
  }

  // Remove the overlay
  function removeOverlay() {
    const existing = document.getElementById('fb-auction-overlay');
    if (existing) {
      // Clean up event listeners to prevent memory leaks
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
      existing.remove();
      overlay = null;
      log('Overlay removed');
    }
  }

  // Update overlay removed - Facebook now works independently

  // Check app status (independent of LiveAuctioneers)
  async function checkStatus() {
    if (!settingsLoaded) return;
    
    try {
      // Check if app should be closed (outside 9:30AM-3:30PM)
      if (shouldCloseApp()) {
        if (overlay) {
          log('App closing (outside 9:30AM-3:30PM), removing overlay completely');
          removeOverlay();
        }
        return;
      }

      // Always show overlay when app should be open
      if (!overlay) {
        createOverlay();
      }
    } catch (err) {
      log('Error checking status: ' + err.message);
    }
  }

  // Initialize
  function init() {
    log('Initializing Facebook Auction Monitor');

    // Check if it's a new day
    if (isNewDay()) {
      log('New day detected, notes preserved from previous day');
    }

    // Check immediately
    checkStatus();

    // Check every 5 seconds
    checkInterval = setInterval(checkStatus, 5000);

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
    });
  }

  // Wait for page to be ready
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
