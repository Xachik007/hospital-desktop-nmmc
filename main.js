const { app, BaseWindow, session, ipcMain, WebContentsView, systemPreferences, Menu } = require('electron');
const path = require('path');

// const YII2_URL = 'http://192.168.1.210';
// const YII2_ORIGIN = 'http://192.168.1.210';
const YII2_URL = 'http://norqmarash.loc';
const YII2_ORIGIN = 'http://norqmarash.loc';
const TAB_BAR_HEIGHT = 40;
const APP_ICON = path.join(
  __dirname,
  'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

// Allow getUserMedia / MediaRecorder on the hospital HTTP origin (not HTTPS)
app.commandLine.appendSwitch(
  'unsafely-treat-insecure-origin-as-secure',
  YII2_ORIGIN
);

let win = null;
let tabBarView = null;
let nfcInstance = null;
let nextTabId = 1;
const tabs = new Map(); // id -> { id, view, title, url }
let activeTabId = null;

function allowMediaPermission(permission) {
  return (
    permission === 'media' ||
    permission === 'microphone' ||
    permission === 'audioCapture' ||
    permission === 'mediaKeySystem'
  );
}

function getContentBounds() {
  if (!win) return { x: 0, y: TAB_BAR_HEIGHT, width: 1280, height: 760 };
  const { width, height } = win.getContentBounds();
  return {
    x: 0,
    y: TAB_BAR_HEIGHT,
    width,
    height: Math.max(0, height - TAB_BAR_HEIGHT),
  };
}

function layoutViews() {
  if (!win || !tabBarView) return;

  const { width } = win.getContentBounds();
  tabBarView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });

  const contentBounds = getContentBounds();
  for (const tab of tabs.values()) {
    if (tab.id === activeTabId) {
      tab.view.setBounds(contentBounds);
      tab.view.setVisible(true);
    } else {
      tab.view.setVisible(false);
      // Keep inactive tabs off-screen so they don't steal clicks
      tab.view.setBounds({ x: 0, y: -10000, width: contentBounds.width, height: contentBounds.height });
    }
  }
}

function sendTabState() {
  if (!tabBarView || tabBarView.webContents.isDestroyed()) return;

  const list = Array.from(tabs.values()).map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
  }));

  tabBarView.webContents.send('tabs:state', {
    tabs: list,
    activeId: activeTabId,
  });
}

/** Tab label from URL path/action, e.g. /patients/view?id=1 → patients/view */
function titleFromUrl(rawUrl) {
  if (!rawUrl) return 'Home';

  try {
    const parsed = new URL(rawUrl, YII2_URL);
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
      createTab(YII2_URL);
    }
    return { action: 'deny' };
  });
}

function createTab(url = YII2_URL) {
  if (!win) return null;

  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const initialUrl = url || YII2_URL;
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
    createTab(YII2_URL);
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

function createWindow() {
  // BaseWindow has no built-in web page — better for WebContentsView tabs
  win = new BaseWindow({
    width: 1280,
    height: 800,
    show: true,
    backgroundColor: '#e8edf2',
    title: 'Hospital Desktop',
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

  createTab(YII2_URL);
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

function handleNFCEvent(msg) {
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
    callback(allowMediaPermission(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return allowMediaPermission(permission);
  });

  ipcMain.on('tabs:create', (_event, url) => {
    createTab(url || YII2_URL);
  });

  ipcMain.on('tabs:activate', (_event, id) => {
    activateTab(id);
  });

  ipcMain.on('tabs:close', (_event, id) => {
    closeTab(id);
  });

  ipcMain.handle('devtools:open', (event) => {
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.openDevTools({ mode: 'detach' });
    }
  });

  // Ask macOS for mic access so the app appears in System Settings
  await requestMicrophoneAccess();

  createWindow();
  startNFC();
});

app.on('window-all-closed', () => {
  nfcInstance = null;
  app.quit();
});
