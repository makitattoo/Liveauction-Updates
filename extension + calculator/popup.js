// Popup script for Auction Tools settings
document.addEventListener('DOMContentLoaded', () => {
  const divisorInput = document.getElementById('divisor-input');
  const sellerSuffixInput = document.getElementById('seller-suffix-input');
  const fbNoteToggle = document.getElementById('fb-note-toggle');
  const saveBtn = document.getElementById('save-btn');
  const statusDiv = document.getElementById('status');

  // Load saved settings
  chrome.storage.local.get(['bidEstimateDivisor', 'sellerNameSuffix', 'fbNoteEnabled', 'fbNoteClosed'], (result) => {
    if (result.bidEstimateDivisor) {
      divisorInput.value = result.bidEstimateDivisor;
    }
    if (result.sellerNameSuffix) {
      sellerSuffixInput.value = result.sellerNameSuffix;
    }
    // Note is enabled if explicitly true or if it's never been set
    // Also check closed state - if closed, toggle should be off
    fbNoteToggle.checked = result.fbNoteEnabled !== false && result.fbNoteClosed !== true;
  });

  // Save settings
  saveBtn.addEventListener('click', () => {
    const divisor = parseFloat(divisorInput.value);
    const sellerSuffix = sellerSuffixInput.value.trim();
    const fbNoteEnabled = fbNoteToggle.checked;
    
    if (isNaN(divisor) || divisor <= 0) {
      statusDiv.textContent = 'Please enter a valid number';
      statusDiv.style.color = '#ff4444';
      setTimeout(() => {
        statusDiv.textContent = '';
        statusDiv.style.color = '#00ff66';
      }, 2000);
      return;
    }

    chrome.storage.local.set({
      bidEstimateDivisor: divisor,
      sellerNameSuffix: sellerSuffix,
      fbNoteEnabled: fbNoteEnabled,
      fbNoteClosed: !fbNoteEnabled // If user turns it on, it's not closed
    }, () => {
      statusDiv.textContent = 'Saved!';
      setTimeout(() => {
        statusDiv.textContent = '';
      }, 2000);
    });
  });
});
