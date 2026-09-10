const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outFile = path.join(os.tmpdir(), 'bidhelper_dom_estimate.txt');

// Match both /console/ and /clerk-console/ followed by any characters
const urlPattern = /liveauctioneers\.com.*\/(?:console|clerk-console)\//;

function parseLowEstimate(text) {
  const rangeMatch = text.match(/\$([\d,]+)\s*[-–]\s*\$([\d,]+)/);
  if (rangeMatch) {
    return rangeMatch[1].replace(/,/g, '');
  }
  
  const singleMatch = text.match(/\$([\d,]+)/);
  if (singleMatch) {
    return singleMatch[1].replace(/,/g, '');
  }
  
  const fallbackMatch = text.match(/\d[\d,]*/);
  return fallbackMatch?.[0]?.replace(/,/g, '') || '';
}

async function getPagePriority(page) {
  try {
    return await page.evaluate(() => {
      if (document.visibilityState === 'visible' && document.hasFocus())
        return 0;
      if (document.visibilityState === 'visible')
        return 1;
      return 2;
    });
  } catch {
    return 3;
  }
}

async function findEstimateText(browser) {
  const candidates = [];

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      
      if (!urlPattern.test(url))
        continue;

      const priority = await getPagePriority(page);
      candidates.push({ page, priority, url });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);

  for (const { page, url } of candidates) {
    try {
      const allText = await page.locator('body').innerText({ timeout: 1000 });
      
      // Only look for Est. $xxx - ignore Current Bid
      const estimateMatch = allText.match(/Est\.?\s*\$([\d,]+)\s*[-–]?\s*(?:\$?)([\d,]*)/);
      if (estimateMatch) {
        console.log(`[${url}] Estimate: ${estimateMatch[0]}`);
        return estimateMatch[0];
      }
    } catch {}
  }

  return '';
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  console.log('Connected - Monitoring with 100ms polling...');

  setInterval(async () => {
    try {
      const text = await findEstimateText(browser);
      const price = parseLowEstimate(text);
      fs.writeFileSync(outFile, price, 'utf8');
    } catch (err) {
      fs.writeFileSync(outFile, '', 'utf8');
    }
  }, 100);

})();
