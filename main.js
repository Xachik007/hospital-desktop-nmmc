const { app, BaseWindow, BrowserWindow, dialog, session, ipcMain, WebContentsView, systemPreferences, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const presence = require('./presence');
const updater = require('./updater');

const TAB_BAR_HEIGHT = 40;

function loadProjectConfig() {
  const candidates = [];

  // Packaged app: editable copy sits next to the .exe (Windows)
  // or in Contents/ (macOS), outside the read-only app bundle.
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    candidates.push(path.join(exeDir, 'config.json'));
    candidates.push(path.join(exeDir, '..', 'config.json'));
  }

  candidates.push(path.join(__dirname, 'config.json'));

  let file = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }

  if (!file) {
    throw new Error('config.json was not found. Put it next to the app, or in the project folder.');
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }

  const width = Number(raw.width);
  const height = Number(raw.height);

  const controlRaw = raw.control && typeof raw.control === 'object' ? raw.control : {};
  const controlUrl = typeof controlRaw.url === 'string' ? controlRaw.url.trim() : '';
  const controlToken = typeof controlRaw.token === 'string' ? controlRaw.token.trim() : '';
  const heartbeatSeconds = Number(controlRaw.heartbeat_seconds);

  if (!controlUrl || !controlToken) {
    throw new Error(
      'config.json must include control.url and control.token for permission checks, for example "http://xlab-projects.loc".'
    );
  }

  const updatesRaw = raw.updates && typeof raw.updates === 'object' ? raw.updates : {};
  const updatesUrl =
    typeof updatesRaw.url === 'string' && updatesRaw.url.trim()
      ? updatesRaw.url.trim().replace(/\/$/, '')
      : `${controlUrl.replace(/\/$/, '')}/desktop-updates`;

  return {
    file,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Desktop',
    url: null,
    origin: null,
    width: Number.isFinite(width) && width >= 400 ? width : 1280,
    height: Number.isFinite(height) && height >= 300 ? height : 800,
    nfc: raw.nfc !== false,
    microphone: raw.microphone !== false,
    control: {
      url: controlUrl.replace(/\/$/, ''),
      token: controlToken,
      heartbeatSeconds:
        Number.isFinite(heartbeatSeconds) && heartbeatSeconds >= 5 ? heartbeatSeconds : 15,
    },
    updates: {
      enabled: updatesRaw.enabled !== false,
      url: updatesUrl,
      checkOnStart: updatesRaw.check_on_start !== false,
    },
  };
}

let project = null;
let configError = null;
try {
  project = loadProjectConfig();
  console.log('Project config:', project.file);
  console.log('Waiting for project assignment from control server.');
} catch (err) {
  configError = err;
  console.error(err.message);
}

function applyAssignedProject(assigned) {
  if (!assigned || !assigned.url) {
    throw new Error('Control server did not return a project URL.');
  }

  let origin;
  try {
    origin = new URL(String(assigned.url).trim()).origin;
  } catch (_) {
    throw new Error(`Assigned project URL is not valid: ${assigned.url}`);
  }

  project.url = String(assigned.url).trim();
  project.origin = origin;
  if (assigned.name) {
    project.title = String(assigned.name);
  }

  if (origin.startsWith('http:')) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', origin);
  }

  console.log('Assigned project:', project.url);
}
const APP_ICON = path.join(
  __dirname,
  'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

let win = null;
let waitingWin = null;
let tabBarView = null;
let nfcChild = null;
let nfcReadyTimer = null;
let nfcStdoutBuffer = '';
let nextTabId = 1;
const tabs = new Map(); // id -> { id, view, title, url }
let activeTabId = null;
let isQuitting = false;
let heartbeatTimer = null;
let devicePayload = null;
let allowQuitOnWaitingClose = true;

function allowMediaPermission(permission) {
  return (
    permission === 'media' ||
    permission === 'microphone' ||
    permission === 'audioCapture' ||
    permission === 'mediaKeySystem'
  );
}

function getContentBounds() {
  if (!win) {
    return {
      x: 0,
      y: TAB_BAR_HEIGHT,
      width: project ? project.width : 1280,
      height: project ? Math.max(0, project.height - TAB_BAR_HEIGHT) : 760,
    };
  }
  const { width, height } = win.getContentBounds();
  return {
    x: 0,
    y: TAB_BAR_HEIGHT,
    width,
    height: Math.max(0, height - TAB_BAR_HEIGHT),
  };
}

function layoutViews() {
  if (isQuitting || !win || win.isDestroyed() || !tabBarView) return;

  try {
    const { width } = win.getContentBounds();
    tabBarView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });

    const contentBounds = getContentBounds();
    for (const tab of tabs.values()) {
      if (!tab.view || tab.view.webContents.isDestroyed()) continue;
      if (tab.id === activeTabId) {
        tab.view.setBounds(contentBounds);
        tab.view.setVisible(true);
      } else {
        tab.view.setVisible(false);
        // Keep inactive tabs off-screen so they don't steal clicks
        tab.view.setBounds({ x: 0, y: -10000, width: contentBounds.width, height: contentBounds.height });
      }
    }
  } catch (_) {
    // Ignore layout during window teardown
  }
}

function sendTabState() {
  if (isQuitting || !tabBarView || tabBarView.webContents.isDestroyed()) return;

  try {
    const list = Array.from(tabs.values()).map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
    }));

    tabBarView.webContents.send('tabs:state', {
      tabs: list,
      activeId: activeTabId,
      appTitle: project ? project.title : 'Hospital Desktop',
      appVersion: app.getVersion(),
    });
  } catch (_) {
    // Ignore IPC during window teardown
  }
}

/** Tab label from URL path/action, e.g. /patients/view?id=1 → patients/view */
function titleFromUrl(rawUrl) {
  if (!rawUrl) return 'Home';

  try {
    const parsed = new URL(rawUrl, project.url);
    let pathname = decodeURIComponent(parsed.pathname || '/').replace(/\/+/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/$/, '');

    // Strip index.php / front-controller prefixes
    pathname = pathname
      .replace(/^\/index\.php/i, '')
      .replace(/^\/web/i, '');

    if (!pathname || pathname === '/') {
      return parsed.search ? `home${parsed.search}` : 'Home';
    }

    // Prefer last two segments: controller/action
    const parts = pathname.split('/').filter(Boolean);
    let action = parts.slice(-2).join('/');
    if (!action) action = parts[parts.length - 1] || 'Home';

    // Keep a short useful query hint (id, patient_id, etc.)
    const params = parsed.searchParams;
    const idHint =
      params.get('id') ||
      params.get('patient_id') ||
      params.get('workerid') ||
      params.get('card_id');

    if (idHint) {
      action = `${action} #${idHint}`;
    }

    return action;
  } catch (_) {
    return 'Page';
  }
}

function updateTabFromUrl(tab, rawUrl) {
  tab.url = rawUrl;
  tab.title = titleFromUrl(rawUrl);
  sendTabState();
}

function wireTabWindowOpen(tab) {
  tab.view.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') {
      createTab(url);
    } else {
      createTab(project.url);
    }
    return { action: 'deny' };
  });
}

function reportDesktopLog(level, category, message, context) {
  try {
    if (project && project.control) {
      presence.setControl(project.control, app.getVersion());
    }
    presence.reportLog(level, category, message, context);
  } catch (err) {
    console.warn('Failed to queue desktop log:', err.message);
  }
}

function wireWebContentsDiagnostics(webContents, label) {
  if (!webContents || webContents.isDestroyed()) return;

  let hangStartedAt = null;

  webContents.on('unresponsive', () => {
    hangStartedAt = Date.now();
    const title = windowTitleWithVersion(project && project.title ? project.title : 'Desktop');
    reportDesktopLog('hang', 'not_responding', `${label} not responding (OS may show "${title} (Не отвечает)")`, {
      label,
      url: (() => {
        try {
          return webContents.getURL();
        } catch (_) {
          return null;
        }
      })(),
      title,
    });
  });

  webContents.on('responsive', () => {
    const durationMs = hangStartedAt ? Date.now() - hangStartedAt : null;
    hangStartedAt = null;
    reportDesktopLog('warn', 'not_responding', `${label} became responsive again`, {
      label,
      duration_ms: durationMs,
    });
  });

  webContents.on('render-process-gone', (_event, details) => {
    reportDesktopLog('error', 'renderer', `${label} renderer process gone`, {
      label,
      reason: details && details.reason,
      exit_code: details && details.exitCode,
    });
  });

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted
    reportDesktopLog('error', 'page_load', `${label} failed to load page`, {
      label,
      error_code: errorCode,
      error_description: errorDescription,
      url: validatedURL,
    });
  });
}

function createTab(url = project.url) {
  if (isQuitting || !win || win.isDestroyed()) return null;

  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const initialUrl = url || project.url;
  const tab = {
    id,
    view,
    title: titleFromUrl(initialUrl),
    url: initialUrl,
  };

  tabs.set(id, tab);
  win.contentView.addChildView(view);
  wireTabWindowOpen(tab);
  wireWebContentsDiagnostics(view.webContents, `tab:${id}`);

  view.webContents.on('did-navigate', (_event, navigatedUrl) => {
    updateTabFromUrl(tab, navigatedUrl);
  });

  view.webContents.on('did-navigate-in-page', (_event, navigatedUrl) => {
    updateTabFromUrl(tab, navigatedUrl);
  });

  view.webContents.on('did-finish-load', () => {
    updateTabFromUrl(tab, view.webContents.getURL());
  });

  view.webContents.on('destroyed', () => {
    tabs.delete(id);
    if (isQuitting) return;
    if (activeTabId === id) {
      const remaining = Array.from(tabs.keys());
      activeTabId = remaining.length ? remaining[remaining.length - 1] : null;
      layoutViews();
    }
    sendTabState();
  });

  view.webContents.loadURL(tab.url);
  activateTab(id);
  sendTabState();
  return tab;
}

function activateTab(id) {
  if (!tabs.has(id)) return;
  activeTabId = id;
  layoutViews();
  sendTabState();
}

function reloadTab(id) {
  const tab = tabs.get(id);
  if (!tab || tab.view.webContents.isDestroyed()) return;
  tab.view.webContents.reload();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;

  const wasActive = activeTabId === id;
  tabs.delete(id);

  try {
    win.contentView.removeChildView(tab.view);
  } catch (_) {}

  try {
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }
  } catch (_) {}

  if (tabs.size === 0) {
    createTab(project.url);
    return;
  }

  if (wasActive) {
    const remaining = Array.from(tabs.keys());
    activateTab(remaining[remaining.length - 1]);
  } else {
    layoutViews();
    sendTabState();
  }
}

function getActiveWebContents() {
  const tab = tabs.get(activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

function presenceUiPayload(result) {
  const assignedUrl = result && result.project && result.project.url
    ? result.project.url
    : (project && project.url ? project.url : '—');

  return {
    allowed: Boolean(result && result.allowed),
    status: (result && result.status) || 'pending',
    message: (result && result.message) || 'Waiting for permission.',
    httpStatus: result && result.httpStatus ? result.httpStatus : null,
    projectUrl: assignedUrl,
    appVersion: app.getVersion(),
    appTitle: project ? project.title : 'Hospital Desktop',
    machineName: devicePayload ? devicePayload.machine_name : '—',
    windowsUsername: devicePayload ? devicePayload.windows_username : '—',
    appDeviceId: devicePayload ? devicePayload.app_device_id : '—',
    macAddress: devicePayload ? devicePayload.mac_address : '—',
    localIp: devicePayload ? devicePayload.local_ip : '—',
    publicIp: devicePayload ? devicePayload.public_ip : '—',
  };
}

function windowTitleWithVersion(base) {
  const version = app.getVersion();
  const name = base || (project && project.title) || 'Hospital Desktop';
  return `${name}  v${version}`;
}

function sendWaitingUpdate(result) {
  if (!waitingWin || waitingWin.isDestroyed()) return;
  waitingWin.webContents.send('presence:update', presenceUiPayload(result));
}

function createWaitingWindow() {
  waitingWin = new BrowserWindow({
    width: Math.min(560, project.width),
    height: Math.min(460, project.height),
    show: true,
    resizable: false,
    maximizable: false,
    backgroundColor: '#f4f7fb',
    title: windowTitleWithVersion(`${project.title} — թույլտվություն`),
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload-waiting.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  waitingWin.setMenuBarVisibility(false);
  wireWebContentsDiagnostics(waitingWin.webContents, 'waiting');
  waitingWin.loadFile(path.join(__dirname, 'waiting.html'));

  waitingWin.webContents.on('did-finish-load', () => {
    sendWaitingUpdate({
      allowed: false,
      status: 'pending',
      message: 'Checking permission',
    });
  });

  waitingWin.on('closed', () => {
    waitingWin = null;
    if (allowQuitOnWaitingClose && !win && !isQuitting) {
      isQuitting = true;
      stopPresenceHeartbeat();
      app.quit();
    }
  });
}

function closeWaitingWindow() {
  if (!waitingWin || waitingWin.isDestroyed()) {
    waitingWin = null;
    return;
  }
  const current = waitingWin;
  waitingWin = null;
  current.close();
}

function stopPresenceHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function checkPresence(kind) {
  if (!devicePayload) {
    devicePayload = await presence.collectDeviceInfo(app.getVersion());
  }

  presence.setControl(project.control, app.getVersion());

  const result =
    kind === 'register'
      ? await presence.register(project.control, devicePayload)
      : await presence.heartbeat(project.control, devicePayload);

  if (result.status === 'error' || (result.httpStatus && result.httpStatus >= 400 && !result.allowed)) {
    console.warn(
      `Control ${kind} failed (${result.httpStatus || '?'}):`,
      result.message
    );
  } else {
    console.log(`Control ${kind}:`, result.status, result.message);
  }

  sendWaitingUpdate(result);
  return result;
}

async function startHospitalApp(assignedProject) {
  applyAssignedProject(assignedProject || (project.url ? { url: project.url, name: project.title } : null));

  allowQuitOnWaitingClose = false;
  closeWaitingWindow();

  if (project.microphone) {
    await requestMicrophoneAccess();
  }

  createWindow();
  allowQuitOnWaitingClose = true;
  // Defer NFC so the hospital window can paint first. NFC must never run in
  // the main process — pcsclite can hang and Windows shows "(Не отвечает)".
  if (project.nfc) {
    setTimeout(() => {
      if (isQuitting) return;
      startNFC().catch((err) => {
        console.warn('NFC start failed:', err.message);
        reportDesktopLog('error', 'nfc', `NFC start failed: ${err.message}`, {});
      });
    }, 1500);
  }

  updater.setupAutoUpdates(project, {
    appIsPackaged: app.isPackaged,
    onBeforeInstall: () => {
      // Must close BaseWindow too — BrowserWindow.getAllWindows() does not include it,
      // and an open main window blocks quitAndInstall on macOS.
      isQuitting = true;
      allowQuitOnWaitingClose = true;
      stopPresenceHeartbeat();
      stopNFC();

      try {
        if (waitingWin && !waitingWin.isDestroyed()) {
          waitingWin.removeAllListeners('close');
          waitingWin.destroy();
          waitingWin = null;
        }
      } catch (_) {}

      try {
        if (win && !win.isDestroyed()) {
          win.removeAllListeners('close');
          win.removeAllListeners('closed');
          for (const tab of tabs.values()) {
            try {
              if (tab.view && !tab.view.webContents.isDestroyed()) {
                win.contentView.removeChildView(tab.view);
              }
            } catch (_) {}
          }
          tabs.clear();
          activeTabId = null;
          tabBarView = null;
          win.destroy();
          win = null;
        }
      } catch (err) {
        console.warn('Failed to destroy main window before update:', err.message);
      }
    },
  });
  if (project.updates.checkOnStart) {
    setTimeout(() => {
      updater.checkForUpdates({ silent: true }).catch(() => {});
    }, 4000);
  }

  stopPresenceHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (isQuitting || !devicePayload) return;
    presence
      .heartbeat(project.control, devicePayload)
      .then((result) => {
        if (result.allowed) return;
        console.warn('Permission lost:', result.message);
        stopPresenceHeartbeat();
        stopNFC();
        project.url = null;
        project.origin = null;
        allowQuitOnWaitingClose = true;
        createWaitingWindow();
        if (win && !win.isDestroyed()) {
          win.close();
        }
        beginPermissionLoop();
      })
      .catch((err) => {
        console.warn('Heartbeat failed:', err.message);
      });
  }, project.control.heartbeatSeconds * 1000);
}

function beginPermissionLoop() {
  stopPresenceHeartbeat();

  const tick = async () => {
    if (isQuitting) return;
    try {
      const result = await checkPresence('heartbeat');
      if (result.allowed && result.project && result.project.url) {
        stopPresenceHeartbeat();
        await startHospitalApp(result.project);
        return;
      }
      if (result.status === 'blocked') {
        stopPresenceHeartbeat();
      }
    } catch (err) {
      sendWaitingUpdate({
        allowed: false,
        status: 'pending',
        message: `Cannot reach control server: ${err.message}`,
        error: err.message,
      });
    }
  };

  heartbeatTimer = setInterval(tick, project.control.heartbeatSeconds * 1000);
  tick();
}

async function ensurePermissionThenStart() {
  createWaitingWindow();

  try {
    devicePayload = await presence.collectDeviceInfo(app.getVersion());
    const result = await checkPresence('register');

    if (result.allowed && result.project && result.project.url) {
      await startHospitalApp(result.project);
      return;
    }

    beginPermissionLoop();
  } catch (err) {
    console.error('Permission check failed:', err);
    reportDesktopLog('error', 'control_send', `Permission check failed: ${err.message}`, {
      action: 'register',
      error: err.message,
    });
    sendWaitingUpdate({
      allowed: false,
      status: 'pending',
      message: err.message || 'Permission check failed.',
    });
    beginPermissionLoop();
  }
}

function createWindow() {
  // BaseWindow has no built-in web page — better for WebContentsView tabs
  win = new BaseWindow({
    width: project.width,
    height: project.height,
    show: true,
    backgroundColor: '#e8edf2',
    title: windowTitleWithVersion(project.title),
    icon: APP_ICON,
  });

  tabBarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-tabs.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.contentView.addChildView(tabBarView);
  wireWebContentsDiagnostics(tabBarView.webContents, 'tab-bar');
  tabBarView.webContents.loadFile(path.join(__dirname, 'tabs.html'));

  tabBarView.webContents.on('did-finish-load', () => {
    sendTabState();
  });

  win.on('resize', layoutViews);

  win.on('close', () => {
    isQuitting = true;
    stopNFC();
    presence.flushLogs().catch(() => {});
  });

  win.on('closed', () => {
    tabs.clear();
    activeTabId = null;
    tabBarView = null;
    win = null;
  });

  createTab(project.url);
  layoutViews();
  win.show();
  win.focus();
}

function parseNfcWorkerChunk(chunk) {
  nfcStdoutBuffer += chunk.toString('utf8');
  const lines = nfcStdoutBuffer.split(/\r?\n/);
  nfcStdoutBuffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      handleNFCEvent(JSON.parse(trimmed));
    } catch (err) {
      console.warn('Bad NFC worker line:', trimmed, err.message);
    }
  }
}

function execFileText(command, args, timeoutMs = 4000) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? err.message : null,
        });
      }
    );
  });
}

async function ensureWindowsSmartCardService() {
  const query = await execFileText('sc', ['query', 'SCardSvr']);
  if (/STATE\s*:\s*\d+\s+RUNNING/i.test(query.stdout)) {
    return { running: true, started: false };
  }

  // Best-effort start (no admin prompt). If it fails, we simply skip NFC.
  const start = await execFileText('sc', ['start', 'SCardSvr'], 6000);
  const again = await execFileText('sc', ['query', 'SCardSvr']);
  const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(again.stdout);
  return {
    running,
    started: running,
    startError: start.ok ? null : start.error || start.stderr || start.stdout,
  };
}

async function windowsHasSmartCardReader() {
  // Prefer PnP SmartCardReader devices with Status OK.
  const ps = await execFileText(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "(Get-PnpDevice -Class SmartCardReader -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' }).Count",
    ],
    6000
  );

  if (ps.ok) {
    const count = Number(String(ps.stdout).trim());
    if (Number.isFinite(count)) {
      return count > 0;
    }
  }

  // Fallback: winscard.dll present + service running is not enough alone,
  // but if PnP query fails, allow a cautious try (worker has hang timeout).
  return null;
}

/**
 * NFC is optional. App must always open the hospital site.
 * Use NFC only when drivers/service look available; otherwise skip quietly.
 */
async function detectNfcAvailability() {
  if (!project || project.nfc === false) {
    return { available: false, reason: 'disabled_in_config' };
  }

  const workerPath = path.join(__dirname, 'nfc-worker.js');
  if (!fs.existsSync(workerPath)) {
    return { available: false, reason: 'worker_missing' };
  }

  if (process.platform === 'win32') {
    const service = await ensureWindowsSmartCardService();
    if (!service.running) {
      return {
        available: false,
        reason: 'smartcard_service_not_running',
        detail: service.startError || 'SCardSvr not running',
      };
    }

    const readers = await windowsHasSmartCardReader();
    if (readers === false) {
      return { available: false, reason: 'no_smartcard_reader_driver' };
    }
  }

  return { available: true, reason: 'ok' };
}

/**
 * NFC runs in a separate Electron Node process so pcsclite cannot freeze
 * the UI thread (Windows title becomes "… (Не отвечает)").
 * If NFC is unavailable, the app continues without it.
 */
async function startNFC() {
  if (nfcChild || isQuitting) return;

  const availability = await detectNfcAvailability();
  if (!availability.available) {
    console.log(`NFC not used (${availability.reason}). App continues without NFC.`);
    if (availability.reason !== 'disabled_in_config') {
      reportDesktopLog('info', 'nfc', `Running without NFC: ${availability.reason}`, {
        reason: availability.reason,
        detail: availability.detail || null,
      });
    }
    return;
  }

  const workerPath = path.join(__dirname, 'nfc-worker.js');

  try {
    nfcChild = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    console.warn('NFC worker spawn failed — continuing without NFC:', err.message);
    reportDesktopLog('warn', 'nfc', `NFC unavailable, continuing without it: ${err.message}`, {});
    nfcChild = null;
    return;
  }

  nfcStdoutBuffer = '';

  nfcChild.stdout.on('data', (chunk) => parseNfcWorkerChunk(chunk));
  nfcChild.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn('NFC worker stderr:', text);
  });

  nfcChild.on('error', (err) => {
    console.warn('NFC worker error — continuing without NFC:', err.message);
    reportDesktopLog('warn', 'nfc', `NFC worker error, continuing without NFC: ${err.message}`, {});
    nfcChild = null;
  });

  nfcChild.on('exit', (code, signal) => {
    if (nfcReadyTimer) {
      clearTimeout(nfcReadyTimer);
      nfcReadyTimer = null;
    }
    if (!isQuitting && code && code !== 0) {
      console.warn(`NFC worker exited (code ${code}) — app keeps running without NFC`);
      reportDesktopLog('info', 'nfc', `NFC stopped (exit ${code}); app continues without NFC`, {
        code,
        signal,
      });
    }
    nfcChild = null;
  });

  // If pcsclite hangs inside the worker, kill it so NFC fails soft.
  nfcReadyTimer = setTimeout(() => {
    nfcReadyTimer = null;
    if (!nfcChild) return;
    console.warn('NFC worker hung — killing it. App continues without NFC.');
    reportDesktopLog(
      'warn',
      'nfc',
      'NFC driver hang during startup; NFC disabled for this session. Hospital app kept running.',
      {}
    );
    try {
      nfcChild.kill();
    } catch (_) {}
    nfcChild = null;
  }, 8000);
}

function stopNFC() {
  if (nfcReadyTimer) {
    clearTimeout(nfcReadyTimer);
    nfcReadyTimer = null;
  }

  if (!nfcChild) return;

  const child = nfcChild;
  nfcChild = null;

  try {
    child.kill();
  } catch (_) {}

  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch (_) {}
  }, 1500);
}

function handleNFCEvent(msg) {
  if (isQuitting) return;

  // Send to every hospital tab — active tab alone can miss the user-edit page
  const targets = [];
  for (const tab of tabs.values()) {
    if (tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
      targets.push(tab.view.webContents);
    }
  }
  if (!targets.length) return;

  const runInTabs = (js) => {
    targets.forEach((wc) => {
      wc.executeJavaScript(js).catch(() => {});
    });
  };

  switch (msg.event) {
    case 'ready':
      console.log('NFC worker ready');
      if (nfcReadyTimer) {
        clearTimeout(nfcReadyTimer);
        nfcReadyTimer = null;
      }
      break;

    case 'unavailable':
      console.log('NFC unavailable — continuing without NFC:', msg.message || msg.reason);
      if (nfcReadyTimer) {
        clearTimeout(nfcReadyTimer);
        nfcReadyTimer = null;
      }
      reportDesktopLog('info', 'nfc', `NFC unavailable (${msg.reason || 'unknown'}), app continues without NFC`, {
        reason: msg.reason || null,
        message: msg.message || null,
      });
      runInTabs(`window.setNFCStatus && window.setNFCStatus(false)`);
      break;

    case 'reader_connected':
      console.log('NFC reader connected:', msg.name);
      runInTabs(`window.setNFCStatus && window.setNFCStatus(true)`);
      break;

    case 'card_on': {
      const uid = String(msg.uid || '').toUpperCase();
      console.log('Card detected:', uid);
      runInTabs(`window.nfcLogin && window.nfcLogin(${JSON.stringify(uid)})`);
      break;
    }

    case 'card_off':
      console.log('Card removed');
      runInTabs(`window.nfcLogout && window.nfcLogout()`);
      break;

    case 'reader_disconnected':
      console.log('NFC reader disconnected');
      runInTabs(`window.setNFCStatus && window.setNFCStatus(false)`);
      break;

    case 'error':
      console.warn('NFC error (ignored, app keeps running):', msg.message);
      break;
  }
}

async function requestMicrophoneAccess() {
  if (process.platform !== 'darwin') return true;
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone access status:', status);
    if (status === 'granted') return true;
    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log('Mic access granted:', granted);
    return granted;
  } catch (err) {
    console.warn('Microphone permission request failed:', err.message);
    return false;
  }
}

app.whenReady().then(async () => {
  if (configError || !project) {
    dialog.showErrorBox(
      'Config error',
      configError ? configError.message : 'config.json could not be loaded.'
    );
    app.quit();
    return;
  }

  try {
    app.setAboutPanelOptions({
      applicationName: project.title,
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
    });
  } catch (_) {}

  // Keep a small menu so users can check for updates manually
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              label: 'Check for Updates…',
              click: () => updater.checkForUpdatesManual(),
            },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => updater.checkForUpdatesManual(),
        },
        ...(process.platform !== 'darwin' ? [{ type: 'separator' }, { role: 'quit' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(APP_ICON);
    } catch (err) {
      console.warn('Failed to set Dock icon:', err.message);
    }
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(project.microphone && allowMediaPermission(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return project.microphone && allowMediaPermission(permission);
  });

  ipcMain.on('tabs:create', (_event, url) => {
    createTab(url || project.url);
  });

  ipcMain.on('tabs:activate', (_event, id) => {
    activateTab(id);
  });

  ipcMain.on('tabs:close', (_event, id) => {
    closeTab(id);
  });

  ipcMain.on('tabs:reload', (_event, id) => {
    reloadTab(id);
  });

  ipcMain.handle('devtools:open', (event) => {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.openDevTools({ mode: 'detach' });
    }
  });

  await ensurePermissionThenStart();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopPresenceHeartbeat();
  stopNFC();
  presence.flushLogs().catch(() => {});
});

app.on('window-all-closed', () => {
  if (waitingWin && !waitingWin.isDestroyed()) {
    return;
  }
  stopPresenceHeartbeat();
  stopNFC();
  app.quit();
});

app.on('child-process-gone', (_event, details) => {
  if (isQuitting) return;
  reportDesktopLog('error', 'process', 'Child process gone', {
    type: details && details.type,
    reason: details && details.reason,
    exit_code: details && details.exitCode,
    name: details && details.name,
  });
});

// Prevent uncaught NFC/native errors from showing a dialog on quit
process.on('uncaughtException', (err) => {
  if (isQuitting) return;
  console.error('Uncaught exception:', err);
  reportDesktopLog('error', 'exception', `Uncaught exception: ${err && err.message ? err.message : String(err)}`, {
    stack: err && err.stack ? String(err.stack).slice(0, 1500) : null,
  });
});

process.on('unhandledRejection', (reason) => {
  if (isQuitting) return;
  const message = reason && reason.message ? reason.message : String(reason);
  console.error('Unhandled rejection:', reason);
  reportDesktopLog('error', 'exception', `Unhandled rejection: ${message}`, {
    stack: reason && reason.stack ? String(reason.stack).slice(0, 1500) : null,
  });
});
