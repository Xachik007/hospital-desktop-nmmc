const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

function deviceIdPath() {
  return path.join(app.getPath('userData'), 'app-device-id.json');
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function loadOrCreateAppDeviceId() {
  const file = deviceIdPath();

  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && isUuid(raw.app_device_id)) {
        return raw.app_device_id;
      }
    }
  } catch (err) {
    console.warn('Could not read app device id file:', err.message);
  }

  const appDeviceId = crypto.randomUUID();

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ app_device_id: appDeviceId, created_at: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn('Could not save app device id file:', err.message);
  }

  return appDeviceId;
}

module.exports = {
  loadOrCreateAppDeviceId,
  deviceIdPath,
};
