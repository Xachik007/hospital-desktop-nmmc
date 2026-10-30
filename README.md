# Hospital Desktop

Standalone **Electron** desktop shell for the hospital web application (Yii2).  
It opens the hospital site in a native window with:

- Multi-tab browsing (`target="_blank"` opens a new tab, not a new window)
- NFC card reader support (login/logout hooks for the web app)
- Microphone access for hold-to-record voice notes inside the web UI

This project is **not** the hospital backend itself. The real UI and business logic live in the web app; this app wraps that site for desktop PCs.

---

## Requirements

- **Node.js** 24.3.0 (recommended; 24+)
- Access to the web project URL (set in `config.json` as `url`)
- Optional: USB NFC reader (e.g. ACS ACR122U) + drivers
- **Windows:** Windows **10 / 11** (x64) — Windows 7 is **not** supported. Building NFC native modules also needs **Visual Studio 2022 Build Tools** with the C++ workload (VS 2017 is not enough).
- **macOS:** recent macOS for building/running the `.dmg`

---

## Project structure

| File | Purpose |
|------|---------|
| `config.json` | Project settings: site URL, window title, NFC, microphone |
| `main.js` | Electron main process: window, tabs, mic permissions, NFC events |
| `nfc-worker.js` | Separate process that talks to the NFC reader (`nfc-pcsc`) |
| `tabs.html` / `tabs.js` / `tabs.css` | Tab bar UI |
| `preload-tabs.js` | Secure IPC bridge for the tab bar |
| `package.json` | Dependencies and `electron-builder` packaging config |

Project settings live in `config.json`. Change this file, then start the app again. You do not need to edit `main.js` to point the app at another site.

```json
{
  "title": "Hospital Desktop",
  "url": "http://norqmarash.loc",
  "width": 1280,
  "height": 800,
  "nfc": true,
  "microphone": true,
  "control": {
    "url": "http://xlab-projects.loc",
    "token": "your-desktop-api-token",
    "heartbeat_seconds": 15
  }
}
```

| Field | Meaning |
|-------|---------|
| `title` | Window title |
| `url` | Web project to open |
| `width` / `height` | Window size |
| `nfc` | `true` to use the card reader, `false` to turn it off |
| `microphone` | `true` to allow the microphone, `false` to turn it off |
| `control.url` | Xlab control website used for PC permission |
| `control.token` | Desktop API token from the control server `.env` |
| `control.heartbeat_seconds` | How often the app re-checks permission |

On startup the app registers this PC (name, Windows user, MAC, public IP, project URL) with the control server. Until that project dashboard allows the PC, the app shows a waiting screen and does not load the hospital site.

While developing, the app reads `config.json` in this folder. After you install a built app, it reads `config.json` next to the program first, so you can change the site without building again.

For another project, change `url` and `title`. Set `nfc` and `microphone` to `false` if that site does not need them, then run `npm start` again.

The installer name and the icon still come from `package.json` (`productName`, `appId`, and the icon). Those change only when you build a new installer. `config.json` changes the website, the window title, NFC, and the microphone without a new build.

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

Opens Electron and loads the `url` from `config.json`.

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
