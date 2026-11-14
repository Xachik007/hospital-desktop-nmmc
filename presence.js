const os = require('os');
const { net } = require('electron');
const { loadOrCreateAppDeviceId } = require('./deviceId');

let activeControl = null;
let activeAppVersion = null;
const pendingLogs = [];
let flushTimer = null;
let flushing = false;

function pickNetworkIdentity() {
  const interfaces = os.networkInterfaces();
  const preferred = [];
  const fallback = [];

  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue;
    for (const item of list) {
      if (item.internal || !item.mac || item.mac === '00:00:00:00:00:00') {
        continue;
      }

      // Prefer IPv4 local addresses for the LAN IP.
      const family = item.family === 'IPv4' || item.family === 4;
      const entry = {
        name,
        mac: item.mac.toUpperCase(),
        localIp: family ? item.address : null,
      };

      if (/en|eth|wi-?fi|wlan|ethernet/i.test(name)) {
        preferred.push(entry);
      } else {
        fallback.push(entry);
      }
    }
  }

  const withIpv4 = [...preferred, ...fallback].find((entry) => entry.localIp);
  const chosen = withIpv4 || preferred[0] || fallback[0] || null;

  return {
    mac: chosen ? chosen.mac : null,
    localIp: chosen ? chosen.localIp : null,
  };
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function fetchPublicIp() {
  try {
    const response = await withTimeout(
      net.fetch('https://api.ipify.org?format=json', {
        method: 'GET',
      }),
      5000
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return typeof data.ip === 'string' ? data.ip : null;
  } catch (_) {
    return null;
  }
}

async function collectDeviceInfo(appVersion) {
  const user = os.userInfo();
  const publicIp = await fetchPublicIp();
  const network = pickNetworkIdentity();
  const appDeviceId = loadOrCreateAppDeviceId();
  activeAppVersion = appVersion || activeAppVersion || '1.0.0';

  return {
    app_device_id: appDeviceId,
    machine_name: os.hostname(),
    windows_username: user.username || process.env.USERNAME || process.env.USER || 'unknown',
    mac_address: network.mac || undefined,
    local_ip: network.localIp || undefined,
    public_ip: publicIp || undefined,
    app_version: activeAppVersion,
  };
}

function setControl(control, appVersion) {
  activeControl = control || null;
  if (appVersion) {
    activeAppVersion = appVersion;
  }
}

function queueContext(context) {
  if (!context || typeof context !== 'object') {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(context));
  } catch (_) {
    return { note: 'context_not_serializable' };
  }
}

function queueLog(entry) {
  const level = String(entry.level || 'error').toLowerCase();
  const category = String(entry.category || 'general').slice(0, 50);
  const message = String(entry.message || 'Unknown error').slice(0, 1000);

  pendingLogs.push({
    level: ['error', 'warn', 'info', 'hang'].includes(level) ? level : 'error',
    category: category || 'general',
    message,
    context: queueContext(entry.context),
    app_version: entry.app_version || activeAppVersion || undefined,
  });

  if (pendingLogs.length > 100) {
    pendingLogs.splice(0, pendingLogs.length - 100);
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushLogs().catch(() => {});
    }, 750);
  }
}

async function flushLogs() {
  if (flushing || !activeControl || pendingLogs.length === 0) {
    return;
  }

  flushing = true;
  const batch = pendingLogs.splice(0, 50);

  try {
    const appDeviceId = loadOrCreateAppDeviceId();
    const base = String(activeControl.url || '').replace(/\/$/, '');
    const response = await net.fetch(`${base}/api/logs`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeControl.token}`,
        'X-Desktop-Token': activeControl.token,
      },
      body: JSON.stringify({
        app_device_id: appDeviceId,
        app_version: activeAppVersion || undefined,
        entries: batch,
      }),
    });

    if (!response.ok && response.status !== 404) {
      // Put failed batch back (keep newest first capacity).
      pendingLogs.unshift(...batch);
      if (pendingLogs.length > 100) {
        pendingLogs.length = 100;
      }
    }
  } catch (_) {
    pendingLogs.unshift(...batch);
    if (pendingLogs.length > 100) {
      pendingLogs.length = 100;
    }
  } finally {
    flushing = false;
    if (pendingLogs.length > 0 && !flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushLogs().catch(() => {});
      }, 5000);
    }
  }
}

function reportLog(level, category, message, context) {
  queueLog({ level, category, message, context });
}

async function postPresence(control, path, payload) {
  setControl(control, payload && payload.app_version);

  const base = String(control.url || '').replace(/\/$/, '');
  const url = `${base}${path}`;
  let response;

  try {
    response = await net.fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${control.token}`,
        'X-Desktop-Token': control.token,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    reportLog('error', 'control_send', `Failed to send ${path} to xlab-projects`, {
      path,
      url,
      error: err && err.message ? err.message : String(err),
      action: path.includes('register') ? 'register' : 'heartbeat',
    });
    throw err;
  }

  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = { message: `Control server returned HTTP ${response.status}` };
  }

  const serverMessage =
    typeof body.message === 'string' && body.message.trim()
      ? body.message.trim()
      : `Control server returned HTTP ${response.status}`;

  // Server misconfig / bad token — do not look like a normal "waiting for approval" state.
  if (response.status === 503 || response.status === 401 || response.status === 403) {
    // 403 with an allowed flag is a normal block/off decision — not a send/save failure.
    const isBusinessDecision = response.status === 403 && body.allowed != null;
    if (!isBusinessDecision) {
      reportLog('error', 'control_save', `Control ${path} rejected: ${serverMessage}`, {
        path,
        http_status: response.status,
        status: body.status || null,
        allowed: body.allowed,
        action: path.includes('register') ? 'register' : 'heartbeat',
      });
    }
    return {
      httpStatus: response.status,
      allowed: false,
      status: isBusinessDecision ? body.status || 'error' : 'error',
      message: serverMessage,
      project: body.project || null,
      body,
    };
  }

  if (!response.ok && body.allowed == null) {
    reportLog('error', 'control_save', `Control ${path} failed: ${serverMessage}`, {
      path,
      http_status: response.status,
      action: path.includes('register') ? 'register' : 'heartbeat',
    });
    return {
      httpStatus: response.status,
      allowed: false,
      status: 'error',
      message: serverMessage,
      project: body.project || null,
      body,
    };
  }

  return {
    httpStatus: response.status,
    allowed: Boolean(body.allowed),
    status: body.status || 'pending',
    message: serverMessage || 'Waiting for permission.',
    project: body.project || null,
    body,
  };
}

async function register(control, payload) {
  return postPresence(control, '/api/register', payload);
}

async function heartbeat(control, payload) {
  return postPresence(control, '/api/heartbeat', payload);
}

module.exports = {
  collectDeviceInfo,
  register,
  heartbeat,
  setControl,
  reportLog,
  flushLogs,
};
