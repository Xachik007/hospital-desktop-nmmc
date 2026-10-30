const STATUS_HY = {
  pending: 'սպասման մեջ',
  approved: 'թույլատրված',
  blocked: 'արգելափակված',
};

function armenianMessage(data) {
  if (data.status === 'blocked') {
    return 'Այս համակարգիչը արգելափակված է այս նախագծի համար։';
  }

  if (data.status === 'approved' && data.allowed) {
    return 'Այս համակարգիչը թույլատրված է։ Բացվում է նախագիծը…';
  }

  if (data.message && String(data.message).startsWith('Cannot reach')) {
    return 'Հնարավոր չէ միանալ կառավարման սերվերին։ Կրկին փորձում ենք…';
  }

  if (data.message && String(data.message).includes('turned off')) {
    return 'Այս նախագիծը անջատված է։';
  }

  if (data.message && String(data.message).includes('Checking permission')) {
    return 'Ստուգվում է թույլտվությունը կառավարման սերվերի հետ…';
  }

  return 'Այս համակարգիչը սպասում է թույլտվության։';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}

window.presenceUI.onUpdate((data) => {
  const statusEl = document.getElementById('status');
  const spinner = document.getElementById('spinner');
  const statusKey = data.status || 'pending';

  setText('message', armenianMessage(data));
  setText('status', STATUS_HY[statusKey] || statusKey);
  setText('project', data.projectUrl);
  setText('machine', data.machineName);
  setText('user', data.windowsUsername);
  setText('mac', data.macAddress);
  setText('local-ip', data.localIp);
  setText('ip', data.publicIp);

  statusEl.className = 'status';
  if (statusKey === 'blocked') {
    statusEl.classList.add('blocked');
    spinner.style.display = 'none';
  } else if (statusKey === 'approved' && data.allowed) {
    statusEl.classList.add('allowed');
    spinner.style.display = 'none';
  } else {
    spinner.style.display = 'block';
  }
});
