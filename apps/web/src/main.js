// The pre-bundled browser build sidesteps Node-only transitive deps
// (bittorrent-dht, fs, etc.) that break when Rollup tries to analyze
// webtorrent's source tree directly for a browser bundle.
import WebTorrent from 'webtorrent/dist/webtorrent.min.js';
import MemoryChunkStore from 'memory-chunk-store';
import { isEncryptedContainer, decryptFiles } from '@icenet/crypto';

// STUN alone can't traverse symmetric NAT (common behind e.g. UniFi routers
// with strict NAT/UDP filtering), which leaves ICE stuck and connections
// stuck at "Couldn't reach the sender". The TURN server is a relay fallback
// for exactly that case; credentials must come from the build env (never
// hardcoded here) so they don't end up committed to the repo.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
if (import.meta.env.ICENET_TURN_URL && import.meta.env.ICENET_TURN_CREDENTIAL) {
  ICE_SERVERS.push({
    urls: import.meta.env.ICENET_TURN_URL.split(','),
    username: import.meta.env.ICENET_TURN_USERNAME || 'icenet',
    credential: import.meta.env.ICENET_TURN_CREDENTIAL,
  });
}

const titleEl = document.getElementById('title');
const filenameEl = document.getElementById('filename');
const barFillEl = document.getElementById('barFill');
const statsEl = document.getElementById('stats');
const downloadAreaEl = document.getElementById('downloadArea');

function magnetFromLocation() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function showMessage(title, message) {
  titleEl.textContent = title;
  titleEl.classList.add('error');
  statsEl.textContent = message;
}

function showError(message) {
  showMessage('Could not connect', message);
}

// How long to wait before telling the user something's wrong, instead of
// leaving them staring at "Connecting…"/a frozen progress bar forever.
const INITIAL_CONNECT_TIMEOUT_MS = 25000;
const PEER_LOSS_GRACE_MS = 6000;
const WATCHDOG_INTERVAL_MS = 1500;

/**
 * Once we have a torrent (metadata already fetched, so a peer was reachable
 * at least once), polls `torrent.numPeers` and surfaces a message if every
 * peer has since dropped (e.g. the sender clicked "Stop sharing"). A short
 * grace period avoids false alarms on a brief reconnect blip.
 */
function watchConnection(torrent) {
  let peerlessSince = null;

  const watchdog = setInterval(() => {
    if (torrent.done) {
      clearInterval(watchdog);
      return;
    }

    if (torrent.numPeers > 0) {
      peerlessSince = null;
      return;
    }

    if (peerlessSince === null) {
      peerlessSince = Date.now();
    } else if (Date.now() - peerlessSince > PEER_LOSS_GRACE_MS) {
      showMessage('Sender stopped sharing', 'Ask them to share the file again, then reopen this link.');
      clearInterval(watchdog);
    }
  }, WATCHDOG_INTERVAL_MS);

  torrent.on('done', () => clearInterval(watchdog));
  torrent.on('error', () => clearInterval(watchdog));
}

function renderDownloadRow(name, blob) {
  const a = saveBlob(name, blob);
  a.textContent = `Save ${name}`;
  downloadAreaEl.appendChild(a);
}

// Builds a nested { folders: Map, files: [] } structure out of `/`-separated paths.
function buildTree(items) {
  const root = { folders: new Map(), files: [] };
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean);
    const fileName = parts.pop() ?? item.path;
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ ...item, fileName });
  }
  return root;
}

function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.className = 'download-btn';
  a.textContent = 'Save';
  return a;
}

function renderFileRow(item) {
  const row = document.createElement('div');
  row.className = 'file-row';

  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = item.fileName;
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = formatBytes(item.size);
  label.appendChild(size);
  row.appendChild(label);

  const btn = document.createElement('button');
  btn.className = 'download-btn';
  btn.textContent = 'Download';
  row.appendChild(btn);

  let started = false;
  btn.onclick = async () => {
    if (started) return;
    started = true;
    btn.disabled = true;
    btn.textContent = '0%';
    try {
      const blob = await item.fetch((pct) => (btn.textContent = `${pct}%`));
      const link = saveBlob(item.fileName, blob);
      btn.replaceWith(link);
      link.click(); // most browsers allow this; the button stays as a fallback if not
    } catch (err) {
      started = false;
      btn.disabled = false;
      btn.textContent = 'Retry';
      showError(err.message ?? String(err));
    }
  };
  return row;
}

function renderTreeNode(node, container, depth) {
  for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
    const details = document.createElement('details');
    details.open = depth === 0;
    const summary = document.createElement('summary');
    summary.textContent = `📁 ${name}`;
    details.appendChild(summary);
    const children = document.createElement('div');
    children.className = 'children';
    renderTreeNode(child, children, depth + 1);
    details.appendChild(children);
    container.appendChild(details);
  }
  for (const file of [...node.files].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    container.appendChild(renderFileRow(file));
  }
}

/**
 * Renders a browsable folder tree into the download area. Each item is
 * { path, size, fetch(onProgress) -> Promise<Blob> }, so the caller decides
 * whether "download" means pulling just that file from the sender or handing
 * over an already-decrypted blob.
 */
function renderFileTree(items) {
  const tree = document.createElement('div');
  tree.className = 'tree';
  renderTreeNode(buildTree(items), tree, 0);
  downloadAreaEl.replaceChildren(tree);
}

// Shows a password prompt in place of the download area, retrying on a
// wrong password, and resolves with the decrypted files once one works.
function promptForPassword(blob) {
  return new Promise((resolve) => {
    function render(errorMsg) {
      downloadAreaEl.replaceChildren();

      const wrap = document.createElement('div');
      wrap.className = 'password-prompt';

      const label = document.createElement('div');
      label.className = 'stats';
      label.textContent = 'This share is password protected.';
      wrap.appendChild(label);

      if (errorMsg) {
        const err = document.createElement('div');
        err.className = 'error';
        err.textContent = errorMsg;
        wrap.appendChild(err);
      }

      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'Enter password';
      wrap.appendChild(input);

      const btn = document.createElement('button');
      btn.className = 'download-btn';
      btn.textContent = 'Unlock';
      wrap.appendChild(btn);

      const submit = async () => {
        const password = input.value;
        if (!password) return;
        btn.textContent = 'Unlocking…';
        btn.disabled = true;
        try {
          resolve(await decryptFiles(blob, password));
        } catch (err) {
          render(err.message ?? 'Incorrect password.');
        }
      };

      btn.onclick = submit;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });

      downloadAreaEl.appendChild(wrap);
      input.focus();
    }

    render(null);
  });
}

// DOMException names that fsa-chunk-store's OPFS writes/reads can throw when
// the origin's storage is unreliable — notably Safari's in-app browser
// sandboxes (e.g. opened via the iOS Camera app's QR scanner), which impose
// tighter memory limits than full Safari and make createSyncAccessHandle()
// fail with an "unknown transient reason" UnknownError mid-download. These
// aren't real connection failures, so we retry once with an in-memory store
// instead of leaving the user stuck.
const OPFS_ERROR_NAMES = new Set(['UnknownError', 'InvalidStateError', 'NotFoundError']);

function startDownload(magnetURI, { useMemoryStore = false } = {}) {
  document.title = 'Thawdrop — receive a file';
  titleEl.classList.remove('error');
  titleEl.textContent = 'Connecting to sender…';
  barFillEl.style.width = '0%';
  downloadAreaEl.replaceChildren();

  const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: ICE_SERVERS } } });

  // client.add()'s callback only fires once torrent metadata has actually
  // been fetched from a peer — if we never reach one at all, it never runs,
  // so this timeout (started up front, not inside the callback) is what
  // catches "can't reach the sender in the first place".
  let torrentReady = false;
  let retried = useMemoryStore; // only ever retry the storage fallback once
  const connectTimeoutId = setTimeout(() => {
    if (!torrentReady) {
      showMessage(
        "Couldn't reach the sender",
        'Make sure Thawdrop is still running on their computer, or ask for a new link.'
      );
    }
  }, INITIAL_CONNECT_TIMEOUT_MS);

  // Returns true if the error was a storage-related failure and a retry was
  // kicked off, so the caller should skip showing its own error message.
  function handleStoreFailure(err) {
    if (retried || !OPFS_ERROR_NAMES.has(err?.name)) return false;
    retried = true;
    clearTimeout(connectTimeoutId);
    showMessage('Retrying…', 'Storage on this device rejected the transfer — trying a different method.');
    client.destroy(() => startDownload(magnetURI, { useMemoryStore: true }));
    return true;
  }

  // Start with nothing selected: a multi-file share lets the receiver browse
  // first and pull only the files they pick. Single-file shares select
  // everything below, so they download straight away as before.
  const addOpts = { deselect: true, ...(useMemoryStore ? { store: MemoryChunkStore } : {}) };

  client.add(magnetURI, addOpts, (torrent) => {
    torrentReady = true;
    clearTimeout(connectTimeoutId);

    const files = torrent.files;
    filenameEl.textContent = `${torrent.name} • ${files.length} files • ${formatBytes(torrent.length)}`;

    watchConnection(torrent);

    torrent.on('error', (err) => {
      if (handleStoreFailure(err)) return;
      showError(err.message ?? String(err));
    });

    if (files.length > 1) {
      titleEl.textContent = 'Choose what to download';
      statsEl.textContent = 'Only the files you pick are downloaded from the sender.';
      document.querySelector('.bar').hidden = true;
      renderFileTree(
        files.map((file) => ({
          path: file.path,
          size: file.length,
          fetch: async (onProgress) => {
            const onDownload = () => onProgress(Math.round(file.progress * 100));
            torrent.on('download', onDownload);
            file.select();
            try {
              return await file.blob();
            } catch (err) {
              if (handleStoreFailure(err)) return new Promise(() => {});
              throw err;
            } finally {
              torrent.off('download', onDownload);
            }
          },
        }))
      );
      return;
    }

    // A single file waits for the receiver's click instead of pulling data
    // (and mobile data / memory) the moment the link is opened. Password
    // shares are always one container named share.icenet (see @icenet/crypto),
    // which is how we can tell before downloading anything.
    const barEl = document.querySelector('.bar');
    barEl.hidden = true;
    const isProtected = files[0].name === 'share.icenet';
    filenameEl.textContent = isProtected
      ? `Password-protected share • ${formatBytes(torrent.length)}`
      : `${files[0].name} • ${formatBytes(torrent.length)}`;
    titleEl.textContent = 'Ready to download';
    statsEl.textContent = isProtected
      ? 'The file is downloaded first, then unlocked with the password.'
      : 'Nothing is downloaded until you tap the button.';

    const startBtn = document.createElement('button');
    startBtn.className = 'download-btn';
    startBtn.textContent = 'Download';
    startBtn.onclick = () => {
      startBtn.remove();
      barEl.hidden = false;
      titleEl.textContent = 'Downloading…';
      statsEl.textContent = '';
      torrent.select(0, torrent.pieces.length - 1);
    };
    downloadAreaEl.replaceChildren(startBtn);

    torrent.on('download', () => {
      const pct = Math.round(torrent.progress * 100);
      barFillEl.style.width = `${pct}%`;
      statsEl.textContent = `${pct}% • ${formatBytes(torrent.downloaded)} / ${formatBytes(
        torrent.length
      )} • ${formatBytes(torrent.downloadSpeed)}/s • ${torrent.numPeers} peer(s)`;
    });

    torrent.on('done', async () => {
      titleEl.textContent = 'Ready to save';
      statsEl.textContent = `${formatBytes(torrent.length)} received from ${torrent.numPeers} peer(s)`;

      // A password-protected share is always seeded as a single encrypted
      // container file (see @icenet/crypto), regardless of how many real
      // files it holds — so only a lone file can possibly be one.
      if (files.length === 1) {
        let soleBlob;
        try {
          soleBlob = await files[0].blob();
        } catch (err) {
          if (handleStoreFailure(err)) return;
          showError(err.message ?? String(err));
          return;
        }

        if (await isEncryptedContainer(soleBlob)) {
          const decrypted = await promptForPassword(soleBlob);
          filenameEl.textContent =
            decrypted.length === 1
              ? decrypted[0].name
              : `${decrypted.length} files • ${formatBytes(decrypted.reduce((sum, f) => sum + f.size, 0))}`;
          if (decrypted.length === 1) {
            downloadAreaEl.replaceChildren();
            renderDownloadRow(decrypted[0].name, decrypted[0]);
            return;
          }
          titleEl.textContent = 'Choose what to download';
          renderFileTree(decrypted.map((f) => ({ path: f.name, size: f.size, fetch: async () => f })));
          return;
        }

        renderDownloadRow(files[0].name, soleBlob);
        return;
      }
    });
  });

  client.on('error', (err) => {
    if (handleStoreFailure(err)) return;
    clearTimeout(connectTimeoutId);
    showError(err.message ?? String(err));
  });
}

// Without a share link, the site's root is the landing page (how it works +
// comparison) rather than an error, since that's what a plain visit to
// thawdrop.com is.
function showLanding() {
  document.title = 'Thawdrop — share files peer to peer';
  document.body.classList.add('landing');
  document.getElementById('receiver').hidden = true;
  document.getElementById('landing').hidden = false;

  // The updater's own manifest already has the current version — reuse it
  // instead of hand-editing a version number into this page every release.
  fetch('/updates/latest.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((manifest) => {
      if (!manifest?.version) return;
      document.getElementById('downloadMacMeta').textContent = `v${manifest.version} · Apple Silicon`;
    })
    .catch(() => {
      // Leave the generic "Apple Silicon" label if the manifest can't be
      // reached — the download link itself doesn't depend on this.
    });
}

async function showReport() {
  document.title = 'Thawdrop — download report';
  document.body.classList.add('report-page');
  document.getElementById('receiver').hidden = true;
  document.getElementById('report').hidden = false;

  let stats;
  try {
    stats = await fetch('/api/stats').then((res) => res.json());
  } catch {
    document.getElementById('reportEmpty').hidden = false;
    document.getElementById('reportEmpty').textContent = 'Could not load stats right now.';
    return;
  }

  document.getElementById('statTotal').textContent = stats.total.toLocaleString();
  document.getElementById('statToday').textContent = stats.today.toLocaleString();

  if (stats.total === 0) {
    document.getElementById('reportEmpty').hidden = false;
    return;
  }

  const max = Math.max(1, ...stats.daily.map((d) => d.count));
  const chart = document.getElementById('chart');
  for (const { date, count } of stats.daily) {
    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = `${Math.max(2, (count / max) * 100)}%`;
    bar.title = `${date}: ${count}`;

    const label = document.createElement('div');
    label.className = 'chart-date';
    label.textContent = date.slice(5);

    wrap.appendChild(bar);
    wrap.appendChild(label);
    chart.appendChild(wrap);
  }
}

if (window.location.pathname === '/report') {
  showReport();
} else {
  const magnetURI = magnetFromLocation();
  if (!magnetURI) {
    showLanding();
  } else {
    startDownload(magnetURI);
  }
}

// A link pasted into the same tab only changes the #fragment.
window.addEventListener('hashchange', () => window.location.reload());
