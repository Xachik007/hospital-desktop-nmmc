/**
 * Separate process: pcsclite must never run in Electron main
 * (on Windows that freezes the UI with "Не отвечает").
 *
 * Exit codes:
 *   0 — clean shutdown
 *   1 — NFC native module / init failed (app continues without NFC)
 */
function emit(payload) {
  try {
    if (typeof process.send === 'function') {
      process.send(payload);
      return;
    }
  } catch (_) {}
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (_) {}
}

let NFC;
try {
  ({ NFC } = require('nfc-pcsc'));
} catch (err) {
  emit({
    event: 'unavailable',
    message: err && err.message ? err.message : String(err),
    reason: 'module_missing',
  });
  process.exit(1);
}

let nfc;
try {
  nfc = new NFC();
} catch (err) {
  emit({
    event: 'unavailable',
    message: err && err.message ? err.message : String(err),
    reason: 'init_failed',
  });
  process.exit(1);
}

nfc.on('reader', (reader) => {
  const name = reader.reader ? reader.reader.name : reader.name;
  emit({ event: 'reader_connected', name });

  reader.on('card', (card) => {
    emit({ event: 'card_on', uid: card && card.uid });
  });

  reader.on('card.off', () => {
    emit({ event: 'card_off' });
  });

  reader.on('end', () => {
    emit({ event: 'reader_disconnected' });
  });

  reader.on('error', (err) => {
    emit({ event: 'error', message: err && err.message ? err.message : String(err) });
  });
});

nfc.on('error', (err) => {
  // PC/SC errors are normal when no reader is plugged — do not crash the app.
  emit({ event: 'error', message: err && err.message ? err.message : String(err) });
});

emit({ event: 'ready' });

function shutdown() {
  try {
    if (nfc && typeof nfc.close === 'function') nfc.close();
  } catch (_) {}
  process.exit(0);
}

process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') shutdown();
});

process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
