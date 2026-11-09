/**
 * Auto-update helpers (electron-updater + generic HTTP feed on xlab-projects).
 *
 * Windows: download + quitAndInstall (NSIS) works well.
 * macOS (unsigned): ShipIt/quitAndInstall often opens Finder or leaves a 0-byte app.
 *            So on Mac we only download, then ask the user to quit and reopen,
 *            or install the new .dmg manually.
 */
const { app, dialog, BrowserWindow } = require('electron');

let autoUpdater = null;
let checking = false;
let configured = false;
let beforeInstallHook = null;

function getUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false;
    // On Mac unsigned builds, ShipIt install is unreliable — still OK on Windows.
    autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';
  } catch (err) {
    console.warn('electron-updater not available:', err.message);
    return null;
  }
  return autoUpdater;
}

function updatesBaseUrl(project) {
  if (project.updates && project.updates.url) {
    return String(project.updates.url).replace(/\/$/, '');
  }
  return `${project.control.url.replace(/\/$/, '')}/desktop-updates`;
}

function feedUrlForPlatform(project) {
  const base = updatesBaseUrl(project);
  if (process.platform === 'darwin') return `${base}/mac`;
  if (process.platform === 'win32') return `${base}/win`;
  return `${base}/linux`;
}

function closeBrowserWindows() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.removeAllListeners('close');
      w.destroy();
    } catch (_) {}
  }
}

function prepareQuitForUpdate() {
  try {
    if (typeof beforeInstallHook === 'function') {
      beforeInstallHook();
    }
  } catch (err) {
    console.warn('beforeInstallHook failed:', err.message);
  }
  closeBrowserWindows();
}

/** Windows / signed installs: quitAndInstall */
function installUpdateNow(updater) {
  console.log('Installing update (quitAndInstall)…');
  prepareQuitForUpdate();

  setImmediate(() => {
    try {
      updater.quitAndInstall(false, true);
    } catch (err) {
      console.error('quitAndInstall threw:', err);
    }

    setTimeout(() => {
      console.warn('quitAndInstall did not exit — forcing app.exit(0)');
      try {
        app.exit(0);
      } catch (_) {
        process.exit(0);
      }
    }, 1200);
  });
}

/** macOS unsigned: do not run ShipIt — just quit cleanly */
function quitAppForMacUpdate() {
  console.log('Mac update: quitting app (no ShipIt / quitAndInstall)…');
  prepareQuitForUpdate();
  setImmediate(() => {
    try {
      app.quit();
    } catch (_) {
      app.exit(0);
    }
    setTimeout(() => process.exit(0), 800);
  });
}

function wireEvents(updater) {
  updater.on('checking-for-update', () => {
    console.log('Checking for updates…');
  });

  updater.on('update-available', async (info) => {
    console.log('Update available:', info.version);
    const parent = BrowserWindow.getFocusedWindow();
    const result = await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Version ${info.version} is available.`,
      detail: 'Download and install the new Hospital Desktop version?',
    });

    if (result.response === 0) {
      try {
        await updater.downloadUpdate();
      } catch (err) {
        dialog.showErrorBox('Update download failed', err.message || String(err));
      }
    }
  });

  updater.on('update-not-available', (info) => {
    console.log('No update available. Current:', info && info.version);
  });

  updater.on('error', (err) => {
    console.warn('Auto-update error:', err == null ? err : err.message || err);
  });

  updater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent || 0);
    console.log(`Update download: ${pct}%`);
  });

  updater.on('update-downloaded', async (info) => {
    console.log('Update downloaded:', info.version, info.downloadedFile || '');
    const parent = BrowserWindow.getFocusedWindow();

    if (process.platform === 'darwin') {
      const result = await dialog.showMessageBox(parent || undefined, {
        type: 'info',
        buttons: ['Quit app', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update downloaded',
        message: `Version ${info.version} was downloaded.`,
        detail:
          'On Mac (without Apple code signing), automatic replace can break the app.\n\n' +
          '1. Click Quit app\n' +
          '2. Open the new .dmg from desktop-updates/mac or dist/\n' +
          '3. Drag Hospital Desktop into Applications (replace)\n' +
          '4. Open it from Applications\n\n' +
          'Eject any old “Hospital Desktop” disks in Finder first.',
      });

      if (result.response === 0) {
        quitAppForMacUpdate();
      }
      return;
    }

    const result = await dialog.showMessageBox(parent || undefined, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Version ${info.version} was downloaded.`,
      detail: 'Restart the app to finish installing the update.',
    });

    if (result.response === 0) {
      installUpdateNow(updater);
    }
  });
}

function setupAutoUpdates(project, { appIsPackaged, onBeforeInstall } = {}) {
  if (!appIsPackaged) {
    console.log('Auto-update skipped (dev mode).');
    return;
  }
  if (project.updates && project.updates.enabled === false) {
    console.log('Auto-update disabled in config.json.');
    return;
  }

  beforeInstallHook = typeof onBeforeInstall === 'function' ? onBeforeInstall : null;

  const updater = getUpdater();
  if (!updater) return;

  const feed = feedUrlForPlatform(project);
  updater.setFeedURL({
    provider: 'generic',
    url: feed,
  });
  console.log('Update feed:', feed);

  if (!configured) {
    wireEvents(updater);
    configured = true;
  }
}

async function checkForUpdates({ silent } = { silent: true }) {
  const updater = getUpdater();
  if (!updater) {
    if (!silent) {
      dialog.showErrorBox('Updates', 'Updater is not available in this build.');
    }
    return;
  }
  if (checking) return;
  checking = true;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    console.warn('checkForUpdates failed:', err.message || err);
    if (!silent) {
      dialog.showErrorBox('Update check failed', err.message || String(err));
    }
  } finally {
    checking = false;
  }
}

async function checkForUpdatesManual() {
  const updater = getUpdater();
  if (!updater) {
    dialog.showErrorBox('Updates', 'Updater is not available in this build.');
    return;
  }

  checking = true;
  try {
    const result = await updater.checkForUpdates();
    const current = app.getVersion();
    const remote = result && result.updateInfo && result.updateInfo.version;
    if (!remote || remote === current) {
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'No updates',
        message: `You are on the latest version (${current}).`,
      });
    }
  } catch (err) {
    dialog.showErrorBox('Update check failed', err.message || String(err));
  } finally {
    checking = false;
  }
}

module.exports = {
  setupAutoUpdates,
  checkForUpdates,
  checkForUpdatesManual,
  updatesBaseUrl,
  feedUrlForPlatform,
};
