import { getCurrentWindow } from '@tauri-apps/api/window';
import { shareFilesAtPaths, populateExpiryOptions, collectShareOptions } from './share-core.js';
import './disable-context-menu.js';

const optionsView = document.getElementById('optionsView');
const shareView = document.getElementById('shareView');

const els = {
  fileNameEl: document.getElementById('fileName'),
  statusEl: document.getElementById('status'),
  qrEl: document.getElementById('qr'),
  linkEl: document.getElementById('link'),
  copyBtn: document.getElementById('copyBtn'),
  stopBtn: document.getElementById('stopBtn'),
  expiryEl: document.getElementById('expiryEl'),
  downloadsEl: document.getElementById('downloadsEl'),
};

const optionEls = {
  passwordInput: document.getElementById('password'),
  expirySelect: document.getElementById('expiry'),
  maxDownloadsInput: document.getElementById('maxDownloads'),
  startBtn: document.getElementById('startBtn'),
};

populateExpiryOptions(optionEls.expirySelect);

async function main() {
  const params = new URLSearchParams(window.location.search);
  const filePath = params.get('path');
  if (!filePath) {
    optionsView.hidden = true;
    shareView.hidden = false;
    els.statusEl.innerHTML = '<span class="error">No file path provided.</span>';
    return;
  }

  optionsView.hidden = false;
  document.getElementById('optFileName').textContent = filePath.split(/[\\/]/).pop();

  const { password, expiresInMs, maxDownloads } = await collectShareOptions(optionEls);

  optionsView.hidden = true;
  shareView.hidden = false;

  try {
    await shareFilesAtPaths([filePath], els, {
      onStop: () => getCurrentWindow().close(),
      password,
      expiresInMs,
      maxDownloads,
    });
  } catch {
    // Error already rendered into statusEl by shareFileAtPath.
  }
}

main();
