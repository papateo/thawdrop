import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { shareFilesAtPaths, populateExpiryOptions, collectShareOptions } from './share-core.js';
import { enforceUpdate } from './update-gate.js';
import './disable-context-menu.js';

// Blocks here (never resolves) if an update is required — everything below
// only runs once the app is confirmed to be on a current version.
await enforceUpdate();

const dropzone = document.getElementById('dropzone');
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

function showDropzone() {
  optionsView.hidden = true;
  shareView.hidden = true;
  dropzone.hidden = false;
}

function showOptionsView() {
  dropzone.hidden = true;
  shareView.hidden = true;
  optionsView.hidden = false;
}

function showShareView() {
  dropzone.hidden = true;
  optionsView.hidden = true;
  shareView.hidden = false;
}

async function handleFiles(paths) {
  showOptionsView();
  const fileLabel = paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length} files`;
  document.getElementById('optFileName').textContent = fileLabel;
  optionEls.passwordInput.value = '';
  optionEls.maxDownloadsInput.value = '';

  const { password, expiresInMs, maxDownloads } = await collectShareOptions(optionEls);

  showShareView();
  try {
    await shareFilesAtPaths(paths, els, { onStop: showDropzone, password, expiresInMs, maxDownloads });
  } catch {
    // Error already rendered into statusEl by shareFilesAtPaths; let the
    // user go back to the dropzone instead of getting stuck.
  }
}

dropzone.addEventListener('click', async () => {
  const paths = await invoke('pick_files');
  if (paths?.length) handleFiles(paths);
});

document.getElementById('pickFolderBtn').addEventListener('click', async (event) => {
  event.preventDefault();
  // The button sits inside the dropzone, whose own click opens the file picker.
  event.stopPropagation();
  const path = await invoke('pick_folder');
  if (path) handleFiles([path]);
});

getCurrentWindow().onDragDropEvent((event) => {
  switch (event.payload.type) {
    case 'enter':
    case 'over':
      dropzone.classList.add('drag-over');
      break;
    case 'drop':
      dropzone.classList.remove('drag-over');
      if (event.payload.paths.length > 0) handleFiles(event.payload.paths);
      break;
    default:
      dropzone.classList.remove('drag-over');
  }
});
