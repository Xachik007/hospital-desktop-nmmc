const { app, BaseWindow, BrowserWindow, dialog, session, ipcMain, WebContentsView, systemPreferences, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const presence = require('./presence');

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

  if (!raw || typeof raw.url !== 'string' || !raw.url.trim()) {
    throw new Error('config.json must include a "url" string, for example "http://norqmarash.loc".');
  }

  let origin;
  try {
    origin = new URL(raw.url.trim()).origin;
  } catch (_) {
    throw new Error(`config.json "url" is not a valid address: ${raw.url}`);
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

  return {
    file,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Desktop',
    url: raw.url.trim(),
    origin,
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
  };
}

let project = null;
let configError = null;
try {
  project = loadProjectConfig();
  console.log('Project config:', project.file);
  console.log('Loading:', project.url);
} catch (err) {
  configError = err;
  console.error(err.message);
}

// Allow getUserMedia / MediaRecorder on an HTTP site (not HTTPS)
if (project && project.origin.startsWith('http:')) {
  app.commandLine.appendSwitch(
    'unsafely-treat-insecure-origin-as-secure',
    project.origin
  );
}
const APP_ICON = path.join(
  __dirname,
  'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

let win = null;
let waitingWin = null;
let tabBarView = null;
let nfcInstance = null;
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
  return {
    allowed: Boolean(result && result.allowed),
    status: (result && result.status) || 'pending',
    message: (result && result.message) || 'Waiting for permission.',
    projectUrl: project.url,
    machineName: devicePayload ? devicePayload.machine_name : '—',
    windowsUsername: devicePayload ? devicePayload.windows_username : '—',
    macAddress: devicePayload ? devicePayload.mac_address : '—',
    localIp: devicePayload ? devicePayload.local_ip : '—',
    publicIp: devicePayload ? devicePayload.public_ip : '—',
  };
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
    title: `${project.title} — թույլտվություն`,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload-waiting.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  waitingWin.setMenuBarVisibility(false);
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
    devicePayload = await presence.collectDeviceInfo(project.url, app.getVersion());
  }

  const result =
    kind === 'register'
      ? await presence.register(project.control, devicePayload)
      : await presence.heartbeat(project.control, devicePayload);

  sendWaitingUpdate(result);
  return result;
}

async function startHospitalApp() {
  allowQuitOnWaitingClose = false;
  closeWaitingWindow();

  if (project.microphone) {
    await requestMicrophoneAccess();
  }

  createWindow();
  allowQuitOnWaitingClose = true;
  if (project.nfc) startNFC();

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
      if (result.allowed) {
        stopPresenceHeartbeat();
        await startHospitalApp();
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
    devicePayload = await presence.collectDeviceInfo(project.url, app.getVersion());
    const result = await checkPresence('register');

    if (result.allowed) {
      await startHospitalApp();
      return;
    }

    beginPermissionLoop();
  } catch (err) {
    console.error('Permission check failed:', err);
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
    title: project.title,
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
  tabBarView.webContents.loadFile(path.join(__dirname, 'tabs.html'));

  tabBarView.webContents.on('did-finish-load', () => {
    sendTabState();
  });

  win.on('resize', layoutViews);

  win.on('close', () => {
    isQuitting = true;
    stopNFC();
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

/**
 * NFC runs inside the Electron main process so the native pcsclite
 * module matches Electron's ABI (packaged apps cannot use system Node).
 */
function startNFC() {
  if (nfcInstance) return;

  let NFC;
  try {
    ({ NFC } = require('nfc-pcsc'));
  } catch (err) {
    console.warn('NFC not available (native module), manual login only:', err.message);
    return;
  }

  try {
    nfcInstance = new NFC();
  } catch (err) {
    console.warn('NFC init failed, manual login only:', err.message);
    nfcInstance = null;
    return;
  }

  nfcInstance.on('reader', (reader) => {
    handleNFCEvent({ event: 'reader_connected', name: reader.reader ? reader.reader.name : reader.name });

    reader.on('card', (card) => {
      handleNFCEvent({ event: 'card_on', uid: card && card.uid });
    });

    reader.on('card.off', () => {
      handleNFCEvent({ event: 'card_off' });
    });

    reader.on('end', () => {
      handleNFCEvent({ event: 'reader_disconnected' });
    });

    reader.on('error', (err) => {
      handleNFCEvent({ event: 'error', message: err && err.message ? err.message : String(err) });
    });
  });

  nfcInstance.on('error', (err) => {
    handleNFCEvent({ event: 'error', message: err && err.message ? err.message : String(err) });
  });

  handleNFCEvent({ event: 'ready' });
}

function stopNFC() {
  if (!nfcInstance) return;

  try {
    const readers = nfcInstance.readers;
    if (readers) {
      const list = readers instanceof Map ? Array.from(readers.values()) : Object.values(readers);
      for (const reader of list) {
        try {
          if (reader && typeof reader.close === 'function') reader.close();
        } catch (_) {}
      }
    }
  } catch (_) {}

  try {
    if (typeof nfcInstance.close === 'function') nfcInstance.close();
  } catch (_) {}

  try {
    nfcInstance.removeAllListeners();
  } catch (_) {}

  nfcInstance = null;
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
      console.warn('NFC error:', msg.message);
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

  // Electron's default File/Edit/View/Window menu — hide on Windows/Linux
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

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
});

app.on('window-all-closed', () => {
  if (waitingWin && !waitingWin.isDestroyed()) {
    return;
  }
  stopPresenceHeartbeat();
  stopNFC();
  app.quit();
});

// Prevent uncaught NFC/native errors from showing a dialog on quit
process.on('uncaughtException', (err) => {
  if (isQuitting) return;
  console.error('Uncaught exception:', err);
});
