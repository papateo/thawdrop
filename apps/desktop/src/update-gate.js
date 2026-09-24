import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/**
 * Checks for an update on startup. If one is available, shows a full-screen
 * blocking overlay and never resolves until the user updates — Thawdrop
 * treats every available update as mandatory, there's no "later" option.
 *
 * If the check itself fails (e.g. no network, update server briefly down),
 * this resolves normally instead of locking people out — the lock is for a
 * confirmed outdated version, not for connectivity problems.
 */
export async function enforceUpdate() {
  let update;
  try {
    update = await check();
  } catch {
    return;
  }

  if (!update) return;

  const gate = document.getElementById('updateGate');
  const messageEl = document.getElementById('updateGateMessage');
  const btn = document.getElementById('updateGateBtn');

  gate.hidden = false;
  messageEl.textContent = `Version ${update.version} is available. You need to update before you can keep using Thawdrop.`;

  return new Promise(() => {
    // Deliberately never resolves: relaunch() below replaces the process on
    // success, and on failure the user is stuck at this screen until they
    // retry — there is no path back to the normal app in this run.
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      let downloaded = 0;
      let total = 0;

      try {
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              total = event.data.contentLength ?? 0;
              break;
            case 'Progress':
              downloaded += event.data.chunkLength;
              messageEl.textContent = total
                ? `Downloading… ${Math.round((downloaded / total) * 100)}%`
                : 'Downloading…';
              break;
            case 'Finished':
              messageEl.textContent = 'Installing…';
              break;
          }
        });
        await relaunch();
      } catch (err) {
        messageEl.textContent = `Update failed: ${err.message ?? err}. Check your connection and try again.`;
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    };
  });
}
