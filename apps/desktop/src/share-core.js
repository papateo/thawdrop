import { invoke } from '@tauri-apps/api/core';
import QRCode from 'qrcode';
// Pre-bundled browser build sidesteps Node-only transitive deps
// (bittorrent-dht, fs, etc.) that break in a bundled webview build.
import WebTorrent from 'webtorrent/dist/webtorrent.min.js';
import { encryptFiles } from '@icenet/crypto';

export const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never', ms: null },
  { value: '15m', label: '15 minutes', ms: 15 * 60 * 1000 },
  { value: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '6h', label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
];

const WEB_BASE_URL = import.meta.env.ICENET_WEB_URL || 'https://thawdrop.com';

// STUN alone can't traverse symmetric NAT (common behind e.g. UniFi routers
// with strict NAT/UDP filtering) — the TURN server is a relay fallback for
// receivers stuck behind that kind of firewall; credentials must come from
// the build env (never hardcoded here) so they don't end up committed to the repo.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
if (import.meta.env.ICENET_TURN_URL && import.meta.env.ICENET_TURN_CREDENTIAL) {
  ICE_SERVERS.push({
    urls: import.meta.env.ICENET_TURN_URL.split(','),
    username: import.meta.env.ICENET_TURN_USERNAME || 'icenet',
    credential: import.meta.env.ICENET_TURN_CREDENTIAL,
  });
}

function buildShareLink(magnetURI) {
  return `${WEB_BASE_URL}/#${encodeURIComponent(magnetURI)}`;
}

export function populateExpiryOptions(selectEl) {
  selectEl.replaceChildren(
    ...EXPIRY_OPTIONS.map((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      return option;
    })
  );
}

/**
 * Wires up an options form (passwordInput, expirySelect, maxDownloadsInput,
 * startBtn) and resolves with the chosen { password, expiresInMs,
 * maxDownloads } once the user clicks "Start sharing".
 */
export function collectShareOptions({ passwordInput, expirySelect, maxDownloadsInput, startBtn }) {
  return new Promise((resolve) => {
    startBtn.onclick = () => {
      const password = passwordInput.value.trim() || null;
      const expiresInMs = EXPIRY_OPTIONS.find((o) => o.value === expirySelect.value)?.ms ?? null;
      const parsed = parseInt(maxDownloadsInput.value, 10);
      const maxDownloads = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      resolve({ password, expiresInMs, maxDownloads });
    };
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A remote peer announces pieces it holds via 'have'/'bitfield' messages as
// it downloads from us; once every piece is announced back, that peer has
// finished a full download. This relies on the peer's client behaving
// normally (announcing pieces as BitTorrent expects), which is true for
// WebTorrent/standard BT peers but isn't a hard guarantee.
function isWireComplete(wire, numPieces) {
  for (let i = 0; i < numPieces; i++) {
    if (!wire.peerPieces.get(i)) return false;
  }
  return true;
}

/**
 * Reads the files (and the contents of any folders) at `paths`, seeds them as a single WebTorrent bundle, and
 * wires up the given elements (fileNameEl, statusEl, qrEl, linkEl, copyBtn,
 * stopBtn, and optionally expiryEl/downloadsEl) to show progress and the
 * share link. `onStop` runs when the user stops sharing (or it stops itself,
 * e.g. from expiry).
 *
 * `password`, if set, encrypts the real file bytes client-side before
 * they're seeded — see @icenet/crypto for why this matters. `expiresInMs`
 * auto-stops the share after that much time. `maxDownloads` auto-stops it
 * once that many distinct peers have fully downloaded the file.
 */
export async function shareFilesAtPaths(
  paths,
  els,
  { onStop, password = null, expiresInMs = null, maxDownloads = null } = {}
) {
  const { fileNameEl, statusEl, qrEl, linkEl, copyBtn, stopBtn, expiryEl, downloadsEl } = els;

  const showError = (message) => {
    statusEl.textContent = '';
    const span = document.createElement('span');
    span.className = 'error';
    span.textContent = message;
    statusEl.appendChild(span);
  };

  statusEl.textContent = 'Reading files…';

  let files;
  try {
    // A folder is expanded into its files; each keeps its path relative to
    // (and including) the folder, which WebTorrent turns into a real
    // folder structure for the receiver.
    const entries = await invoke('expand_paths', { paths });
    files = [];
    for (const [i, { path, name }] of entries.entries()) {
      if (entries.length > 1) statusEl.textContent = `Reading files… ${i + 1}/${entries.length}`;
      const { data } = await invoke('read_file_as_base64', { path });
      // A lone file has no folder to keep, so it goes in by its plain name.
      files.push(new File([base64ToBytes(data)], entries.length === 1 ? name.split('/').pop() : name));
    }
  } catch (err) {
    showError(String(err));
    throw err;
  }

  const topFolder = files[0].name.includes('/') ? files[0].name.split('/')[0] : null;
  const isSingleFolder = topFolder && files.every((f) => f.name.startsWith(`${topFolder}/`));
  fileNameEl.textContent = isSingleFolder
    ? `${topFolder} • ${files.length} files`
    : files.length === 1
      ? files[0].name
      : `${files.length} files`;

  let seedFiles = files;
  if (password) {
    statusEl.textContent = 'Encrypting…';
    try {
      seedFiles = [await encryptFiles(files, password)];
    } catch (err) {
      showError(err.message ?? String(err));
      throw err;
    }
  }

  statusEl.textContent =
    files.length > 1 ? `Seeding ${files.length} files over WebTorrent…` : 'Seeding file over WebTorrent…';

  const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: ICE_SERVERS } } });
  client.on('error', (err) => showError(err.message ?? String(err)));

  return new Promise((resolve) => {
    // Several loose files have no shared folder, and WebTorrent would name the
    // torrent after the first file — which the receiver then sees as a folder.
    const seedOpts = !password && files.length > 1 && !isSingleFolder ? { name: 'Shared files' } : {};
    client.seed(seedFiles, seedOpts, async (torrent) => {
      const link = buildShareLink(torrent.magnetURI);
      qrEl.src = await QRCode.toDataURL(link, { margin: 1, width: 320 });
      linkEl.value = link;
      statusEl.textContent = password ? 'Live — ready to share (password protected)' : 'Live — ready to share';

      let stopped = false;
      let countdownIntervalId = null;
      const stopSharing = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(countdownIntervalId);
        torrent.destroy();
        onStop?.();
      };

      copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(link);
        const original = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = original), 1200);
      };

      stopBtn.onclick = stopSharing;

      if (expiresInMs) {
        const deadline = Date.now() + expiresInMs;
        if (expiryEl) {
          expiryEl.textContent = `Expires in ${formatCountdown(expiresInMs)}`;
          countdownIntervalId = setInterval(() => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              expiryEl.textContent = 'Expired';
              stopSharing();
              return;
            }
            expiryEl.textContent = `Expires in ${formatCountdown(remaining)}`;
          }, 1000);
        } else {
          setTimeout(stopSharing, expiresInMs);
        }
      }

      if (maxDownloads) {
        const completedWires = new WeakSet();
        let completedCount = 0;
        const updateDownloadsLabel = () => {
          if (downloadsEl) downloadsEl.textContent = `${completedCount}/${maxDownloads} downloads used`;
        };
        updateDownloadsLabel();

        torrent.on('wire', (wire) => {
          const checkComplete = () => {
            if (stopped || completedWires.has(wire)) return;
            if (!isWireComplete(wire, torrent.pieces.length)) return;
            completedWires.add(wire);
            completedCount += 1;
            updateDownloadsLabel();
            if (completedCount >= maxDownloads) stopSharing();
          };
          wire.on('have', checkComplete);
          wire.on('bitfield', checkComplete);
        });
      }

      resolve(torrent);
    });
  });
}
