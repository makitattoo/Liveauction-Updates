// LiveAuctioneers Price Monitor - Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const priceEl = document.getElementById('currentPrice');
  const lotIdEl = document.getElementById('lotId');
  const statusEl = document.getElementById('statusText');
  const updateCountEl = document.getElementById('updateCount');
  const lastUpdateEl = document.getElementById('lastUpdate');
  const toggleBtn = document.getElementById('toggleBtn');
  
  let isMonitoring = true;
  
  // Get initial status
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0] && tabs[0].url?.includes('liveauctioneers.com')) {
    try {
      const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' });
      isMonitoring = response.isMonitoring;
      updateUI();
    } catch (e) {}
  }

  function updateUI() {
    toggleBtn.textContent = isMonitoring ? 'Stop Monitoring' : 'Start Monitoring';
    toggleBtn.className = isMonitoring ? 'stop' : '';
    statusEl.textContent = isMonitoring ? 'Active' : 'Stopped';
    statusEl.style.color = isMonitoring ? '#00FF00' : '#FF4D4F';
  }

  toggleBtn.addEventListener('click', async () => {
    isMonitoring = !isMonitoring;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url?.includes('liveauctioneers.com')) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { 
          type: 'TOGGLE_MONITOR', 
          enabled: isMonitoring 
        });
        updateUI();
      } catch (e) {
        console.error('Failed to toggle:', e);
      }
    }
  });

  // Refresh every second from content script
  setInterval(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url?.includes('liveauctioneers.com')) {
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' });
        if (response.lastPrice) {
          priceEl.textContent = '$' + response.lastPrice;
        }
        if (response.lastLotId) {
          lotIdEl.textContent = 'Lot: ' + response.lastLotId;
        }
        updateCountEl.textContent = response.totalUpdates || 0;
        lastUpdateEl.textContent = new Date().toLocaleTimeString();
        isMonitoring = response.isMonitoring;
        updateUI();
      } catch (e) {}
    }
  }, 1000);
});
