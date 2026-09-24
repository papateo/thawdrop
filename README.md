# Thawdrop

Share files and folders straight from your computer over a peer-to-peer link
or QR code — **no upload, no server storage, no size limit**. Pick a file or
folder in the desktop app (or right-click it → "Share with Thawdrop"), and you
get a link/QR that anyone can open in a plain browser to pull it directly from
your machine over WebRTC.

Web receiver: <https://thawdrop.com>

## How Thawdrop works

### The flow, step by step

```
 SENDER (desktop app)                                RECEIVER (any browser)
 ────────────────────                                ──────────────────────
 1. Pick a file/folder
    (drop, picker, tray menu,
     or right-click)
          │
 2. Choose options (optional):
    password · expiry · max downloads
          │
 3. Rust reads the files from disk
    (folders are walked recursively)
          │
 4. If a password is set, the bytes are
    encrypted (AES-GCM) before seeding
          │
 5. WebTorrent seeds them and produces
    a magnet URI
          │
 6. App shows  https://thawdrop.com/#<magnet>
    as a link + QR code
          │                                           7. Opens the link
          └────────────── link / QR ───────────────▶     (the magnet is in the
                                                          URL #fragment, so it
                                                          never reaches a server)
                                                            │
                                    8. Web page joins the torrent via WebTorrent
                                       and shows the file list / a Download button
                                                            │
        ◀────────── WebRTC data channel ──────────  9. Taps Download → only the
              (file bytes go peer to peer)             chosen file is pulled
                                                            │
                                                     10. Save (password shares are
                                                         unlocked in the browser first)
```

A few things worth knowing about each step:

- **The file never touches a server.** Trackers/DHT/STUN are only used for
  peers to find each other; the bytes flow directly sender → receiver. If a
  direct connection is impossible (strict NAT), an optional TURN relay can
  carry it (see [TURN relay](#turn-relay-for-strict-natsfirewalls)).
- **The link is the secret.** The magnet URI sits in the URL fragment
  (`#…`), which browsers never send to the server hosting the page.
- **Single file:** the receiver sees the name and size first and nothing is
  downloaded until they tap **Download**.
- **Folder / several files:** the receiver gets a browsable folder tree and
  downloads only the files they pick — unselected files are never transferred.
- **Password shares:** the files are bundled and encrypted client-side with a
  key derived from the password (PBKDF2 → AES-GCM), so the network only sees
  an opaque `share.icenet` container. The password is never part of the link;
  share it separately. The receiver downloads the whole container, then
  unlocks it in the browser (so per-file downloading isn't possible there).
- **Expiry / max downloads:** the app stops seeding when the timer runs out or
  when the given number of peers have fully downloaded the share.
- **The sender must stay online.** There is no server holding the file, so
  once the share window is closed or Thawdrop quits, the link stops working.

### Components

| Part | What it is |
|---|---|
| `apps/desktop` | [Tauri](https://tauri.app/) app (Rust backend + native OS webview). Reads files, seeds them with WebTorrent, shows the link/QR, has a tray icon and the share options UI. |
| `apps/web` | Static receiver page (no backend), deployed to Cloudflare. Reads the magnet from the URL, downloads via WebTorrent in the browser. |
| `packages/crypto` | Shared password encryption/decryption used by both apps. |
| `scripts/{macos,windows,linux}` | Installers that hook each OS's right-click menu up to the desktop app. |

Rust side (`apps/desktop/src-tauri/src/main.rs`) only exposes a few commands
(`pick_files`, `pick_folder`, `expand_paths`, `read_file_as_base64`) and
**only reads paths the user actually picked or dropped**, so a compromised
frontend can't read arbitrary files.

## Project layout

```
apps/
  desktop/            Tauri app
    src-tauri/        Rust backend: tray, windows, CLI args, file access, icons
    src/, *.html      Frontend (Vite): WebTorrent seeding, QR, share UI
  web/                Receiver page (Vite)
    public/           Favicon / apple-touch-icon
    wrangler.jsonc    Cloudflare Workers config (custom domain)
packages/
  crypto/             Password encryption shared by desktop + web
scripts/
  macos/  windows/  linux/   Right-click menu installers
```

## Development

### Prerequisites

- Node.js 18+
- [Rust toolchain](https://www.rust-lang.org/tools/install) (`rustc`, `cargo`)
- Tauri's platform build tools: Xcode Command Line Tools (macOS), WebView2 +
  MSVC Build Tools (Windows), `webkit2gtk` (Linux) — see
  [Tauri's prerequisites](https://tauri.app/start/prerequisites/)

Install dependencies once from the repo root:

```bash
npm install
```

### Dev loop (test the whole transfer on one machine)

Use two terminals, so the desktop app generates links that point at your local
receiver instead of production.

**Terminal 1 — web receiver** (http://localhost:5173):

```bash
npm run web
```

**Terminal 2 — desktop app**, pointed at that receiver:

```bash
ICENET_WEB_URL=http://localhost:5173 npm run desktop
```

Then:

1. Drop a file or folder onto the window (or click to browse / "choose a
   folder"), or use the tray menu: **Share a file…** / **Share a folder…**.
2. Set options if you want, click **Start sharing**.
3. Copy the link and open it in a browser tab (`http://localhost:5173/#…`).
4. Download from the page and check the file arrives intact.

The first desktop run compiles the Rust binary and takes a while. In dev mode
the process/Dock name is the Cargo binary (`Thawdrop`, set in
`src-tauri/Cargo.toml`); the built app is named from `productName` in
`tauri.conf.json`.

Handy checks while editing:

```bash
npm run web:build                          # build the receiver
cd apps/desktop/src-tauri && cargo check   # type-check the Rust side
```

### Environment variables

Read at **build time** by Vite (prefix `ICENET_`, defined in each app's
`vite.config.js`). The prefix is a leftover from the project's old name and is
kept so existing setups keep working.

| Variable | Used by | Purpose |
|---|---|---|
| `ICENET_WEB_URL` | desktop | Base URL put in share links. Defaults to `https://thawdrop.com`. |
| `ICENET_TURN_URL` | desktop, web | TURN relay URL(s), comma-separated. |
| `ICENET_TURN_USERNAME` | desktop, web | TURN username. |
| `ICENET_TURN_CREDENTIAL` | desktop, web | TURN password. |

### App icon

Source artwork is `apps/desktop/src-tauri/icons/icon.png` (1024×1024,
transparent corners). Regenerate the desktop set with:

```bash
cd apps/desktop && npx tauri icon src-tauri/icons/icon.png
```

`tauri icon` also creates Android/iOS/Windows-Store files this project doesn't
use — delete those. The web favicons live in `apps/web/public/`.

## Building and releasing

### Desktop app

```bash
npm run desktop:build
```

Produces a platform bundle under
`apps/desktop/src-tauri/target/release/bundle/`
(`macos/Thawdrop.app`, `nsis/Thawdrop_*-setup.exe`, `appimage/*.AppImage`, …).
Build it with the same `ICENET_WEB_URL` / TURN variables you want baked in.

### Signing and notarizing the macOS app

An unsigned build makes macOS show "cannot be opened because the developer
cannot be verified". To avoid that, the app has to be signed with a
**Developer ID Application** certificate and **notarized** by Apple. This needs
a paid [Apple Developer Program](https://developer.apple.com/programs/)
membership.

1. **Create the certificate.** In Xcode: Settings → Accounts → your team →
   Manage Certificates → **+** → *Developer ID Application*. (Or create it at
   developer.apple.com → Certificates.) It lands in your login keychain.
2. **Confirm it's there:**

   ```bash
   security find-identity -v -p codesigning
   # → 1) ABCDEF… "Developer ID Application: Your Name (TEAMID)"
   ```

3. **Create an app-specific password** at <https://account.apple.com> →
   Sign-In and Security → App-Specific Passwords (this is what notarization
   uses instead of your real Apple ID password).
4. **Build with the credentials in the environment.** Tauri reads these and
   signs, notarizes and staples automatically:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   export APPLE_ID="you@example.com"
   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
   export APPLE_TEAM_ID="TEAMID"
   npm run desktop:build
   ```

   Instead of `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` you can use an App
   Store Connect API key: `APPLE_API_ISSUER`, `APPLE_API_KEY` and
   `APPLE_API_KEY_PATH`.

5. **Verify the result:**

   ```bash
   APP=apps/desktop/src-tauri/target/release/bundle/macos/Thawdrop.app
   codesign --verify --deep --strict --verbose=2 "$APP"
   spctl --assess --type execute --verbose "$APP"   # → accepted, source=Notarized Developer ID
   ```

Never commit these values; keep them in your shell, a local untracked env
file, or your CI's secret store. Notarization uploads the app to Apple and can
take a few minutes.

### Right-click menu integration

The context-menu entries call the packaged app binary, so build it first, then
run the installer for your OS:

```bash
# macOS — after moving the built Thawdrop.app to /Applications
./scripts/macos/install.sh /Applications/Thawdrop.app

# Windows (PowerShell) — after installing via the built NSIS installer
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -ExePath "C:\Program Files\Thawdrop\Thawdrop.exe"

# Linux — point at the built AppImage
./scripts/linux/install.sh /path/to/Thawdrop.AppImage
```

On macOS this adds **Share with Thawdrop** under right-click → **Quick
Actions** (enable it in System Settings → Privacy & Security → Extensions →
Finder if it's missing). It does *not* appear inside the system **Share…**
sheet next to AirDrop — that needs a signed native Share Extension, which this
project doesn't have. Each script documents how to verify or undo the install.

### Web receiver (Cloudflare)

The receiver is a static site served by a Cloudflare Worker with the custom
domain `thawdrop.com` (see `apps/web/wrangler.jsonc`).

```bash
cd apps/web
npx wrangler login      # first time only
npm run build
npx wrangler deploy
```

The domain must be an active zone in the same Cloudflare account. To host it
elsewhere, publish `apps/web/dist` to any static host and build the desktop app
with `ICENET_WEB_URL` set to that URL.

### TURN relay for strict NATs/firewalls

By default both apps only use public STUN servers, which can't traverse
symmetric NAT (common on UniFi and corporate routers) — a receiver behind one
sees "Couldn't reach the sender" even though the sender is online. Set a TURN
relay at build time for **both** apps:

```bash
ICENET_TURN_URL='turn:<host>:3478?transport=udp,turn:<host>:3478?transport=tcp' \
ICENET_TURN_USERNAME='<username>' \
ICENET_TURN_CREDENTIAL='<password>' \
npm run web:build
```

Without them the apps silently fall back to STUN only. Never commit real TURN
credentials; pass them as env vars at build time only.

## Limitations

- **The sharer must stay online** for the whole transfer.
- **Anyone with the link can download**, unless a password is set. Treat the
  link/QR as the secret; a password adds real encryption on top.
- **Memory:** the desktop app reads everything being shared into memory before
  seeding, so very large folders are heavy. A folder is capped at 5,000 files
  and symlinks inside it are skipped.
- **NAT/firewall edge cases** can block the direct connection without a TURN
  relay (see above).
- **Password shares can't be downloaded per file** — the receiver must fetch
  the whole encrypted container first.

## License

The code is released under the [MIT License](LICENSE).

The **Thawdrop name, logo and app icon** are not covered by that license —
please don't use them to present a fork as the official app.

### Forking / self-hosting

A few things point at the official deployment and should be changed in a fork:

- **`thawdrop.com`** — the default share-link base (`ICENET_WEB_URL`, see
  `apps/desktop/src/share-core.js`), the Cloudflare route in
  `apps/web/wrangler.jsonc` and the KV namespace id there.
- **Auto-update** — `apps/desktop/src-tauri/tauri.conf.json` has the update
  endpoint and the **public** update-signing key. A fork must generate its own
  key pair (`npx tauri signer generate`), put its own public key there, and keep
  the private key (in `apps/desktop/src-tauri/.updater-keys/`, git-ignored)
  secret: whoever holds it can push updates to every installed copy.
- **Download stats** — `apps/web/worker.js` counts downloads of
  `/download/Thawdrop.dmg` in a Cloudflare KV namespace and serves the totals
  at `/api/stats`. It is public and not rate limited, so treat the numbers as
  approximate (add a Cloudflare rate-limit rule if you care). A fork can drop
  the worker and the `kv_namespaces` entry entirely.
- **Apple signing** — `build-signed-mac.sh` reads your own certificate and
  credentials from environment variables; nothing secret is stored in the repo.
