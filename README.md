# Hospital Desktop

Standalone **Electron** desktop shell for the hospital web application (Yii2).  
It opens the hospital site in a native window with:

- Multi-tab browsing (`target="_blank"` opens a new tab, not a new window)
- NFC card reader support (login/logout hooks for the web app)
- Microphone access for hold-to-record voice notes inside the web UI

This project is **not** the hospital backend itself. The real UI and business logic live in the web app; this app wraps that site for desktop PCs.

---

## Requirements

- **Node.js** 18+ (recommended)
- Access to the hospital web URL (set in `main.js` as `YII2_URL`)
- Optional: USB NFC reader (e.g. ACS ACR122U) + drivers
- **Windows:** Windows **10 / 11** (x64) — Windows 7 is **not** supported
- **macOS:** recent macOS for building/running the `.dmg`

---

## Project structure

| File | Purpose |
|------|---------|
| `main.js` | Electron main process: window, tabs, mic permissions, NFC events |
| `nfc-worker.js` | Separate process that talks to the NFC reader (`nfc-pcsc`) |
| `tabs.html` / `tabs.js` / `tabs.css` | Tab bar UI |
| `preload-tabs.js` | Secure IPC bridge for the tab bar |
| `package.json` | Dependencies and `electron-builder` packaging config |

Default hospital URL (edit before production build):

```js
// main.js
const YII2_URL = 'http://192.168.1.210';
```

---

## Install

```bash
cd /usr/local/var/www/hospital-desktop
npm install
```

---

## Run (development)

```bash
npm start
```

Opens Electron and loads `YII2_URL`.

---

## Build installers

Installers are written to the `dist/` folder.

### Mac only

```bash
npm run dist:mac
```

**Outputs (examples):**

- `dist/Hospital Desktop-1.0.0.dmg` — Mac installer
- `dist/Hospital Desktop-1.0.0-mac.zip` — Mac zip

### Windows only

```bash
npm run dist:win
```

**Outputs (examples):**

- `dist/Hospital Desktop Setup 1.0.0.exe` — Windows installer (NSIS)
- `dist/Hospital Desktop 1.0.0.exe` — Portable (no install)

> Build the Windows `.exe` on a **Windows 10+** machine when you need NFC native modules to work correctly on Windows. Cross-building from Mac creates a runnable UI app, but NFC may not work until rebuilt on Windows.

### Mac + Windows together

```bash
npm run dist
```

Builds both platforms (same outputs as above into `dist/`).

### Unpackaged folder (debug)

```bash
npm run pack
```

Creates an unpacked app directory under `dist/` without a full installer.

---

## Install on PCs

| Platform | File | How |
|----------|------|-----|
| Mac | `.dmg` | Open DMG → drag **Hospital Desktop** to Applications |
| Windows 10/11 | `Setup … .exe` | Run installer on each PC |
| Windows 10/11 | Portable `.exe` | Copy and run (no installer) |

You do **not** need a different build per PC — one installer per OS is enough.

This app does **not** run on iPhone. Use Safari / the mobile web site there.

---

## Features notes

### Tabs

Links with `target="_blank"` or `window.open` open as **new tabs** in the same window. Tab titles are derived from the URL action (e.g. `patients/view #37161`).

### NFC

The NFC worker reports card UID events. The loaded web page should define:

- `window.nfcLogin(uid)`
- `window.nfcLogout()`
- `window.setNFCStatus?.(connected)`

Without those hooks in the Yii2 app, the reader works in the terminal logs but will not log the user in/out.

### Microphone (macOS packaged app)

For voice recording in the packaged Mac app:

1. Rebuild after mic config changes (`npm run dist:mac`)
2. Fully reinstall / replace the old `.app`
3. On first record, approve the macOS microphone prompt
4. Confirm **System Settings → Privacy & Security → Microphone** lists **Hospital Desktop**

Configured via `package.json` → `build.mac.extendInfo` (`NSMicrophoneUsageDescription`) and entitlements under `build/`.

---

## Scripts summary

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm start` | Run app in development |
| `npm run dist:mac` | Build Mac (`.dmg` + `.zip`) |
| `npm run dist:win` | Build Windows (setup + portable `.exe`) |
| `npm run dist` | Build **Mac and Windows** together |
| `npm run pack` | Build unpacked app folder only |

---

## Version

Current version: **1.0.0** (see `package.json`).
