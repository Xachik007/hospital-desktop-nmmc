const os = require('os');
const { net } = require('electron');
const { loadOrCreateAppDeviceId } = require('./deviceId');

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

async function fetchPublicIp() {
  try {
    const response = await net.fetch('https://api.ipify.org?format=json', {
      method: 'GET',
    });
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

  return {
    app_device_id: appDeviceId,
    machine_name: os.hostname(),
    windows_username: user.username || process.env.USERNAME || process.env.USER || 'unknown',
    mac_address: network.mac || undefined,
    local_ip: network.localIp || undefined,
    public_ip: publicIp || undefined,
    app_version: appVersion || '1.0.0',
  };
}

async function postPresence(control, path, payload) {
  const base = String(control.url || '').replace(/\/$/, '');
  const response = await net.fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${control.token}`,
      'X-Desktop-Token': control.token,
    },
    body: JSON.stringify(payload),
  });

  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = { message: `Control server returned HTTP ${response.status}` };
  }

  return {
    httpStatus: response.status,
    allowed: Boolean(body.allowed),
    status: body.status || 'pending',
    message: body.message || 'Waiting for permission.',
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
};
