# Auction Monitor + Saved Calculator Chrome Extension

This project keeps the LiveAuctioneers auction monitor and also includes a calculator in the popup. The calculator stays saved in Chrome storage even if you close Chrome and reopen it.

## Folder

Load this folder in Chrome:

`d:\Users\Administrator\Documents\AutoHotkey\BID\GoogleExtension\extension`

## Files

- `manifest.json` - Chrome extension config
- `content.js` - Reads the auction page
- `background.js` - Stores monitor updates inside the extension
- `popup.html` - Auction monitor plus calculator popup
- `popup.js` - Popup logic and saved calculator state

## Install In Chrome

1. Open `chrome://extensions/`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select `d:\Users\Administrator\Documents\AutoHotkey\BID\GoogleExtension\extension`

## How It Works

- The auction monitor still runs on supported LiveAuctioneers pages.
- The popup shows current auction data and a calculator together.
- The extension saves auction data inside Chrome storage.
- The calculator expression and result are saved with `chrome.storage.local`.
- The calculator values stay there until you press `AC`.

## Notes

- This project keeps your original Desktop extension untouched.
- No Node.js server is required.
