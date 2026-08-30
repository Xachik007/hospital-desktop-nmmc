const { NFC } = require('nfc-pcsc');
const nfc = new NFC();

nfc.on('reader', reader => {
  process.stdout.write(JSON.stringify({ event: 'reader_connected', name: reader.name }) + '\n');

  reader.on('card', card => {
    process.stdout.write(JSON.stringify({ event: 'card_on', uid: card.uid }) + '\n');
  });

  reader.on('card.off', () => {
    process.stdout.write(JSON.stringify({ event: 'card_off' }) + '\n');
  });

  reader.on('end', () => {
    process.stdout.write(JSON.stringify({ event: 'reader_disconnected' }) + '\n');
  });

  reader.on('error', err => {
    process.stdout.write(JSON.stringify({ event: 'error', message: err.message }) + '\n');
  });
});

nfc.on('error', err => {
  process.stdout.write(JSON.stringify({ event: 'error', message: err.message }) + '\n');
});

process.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
