const tabsEl = document.getElementById('tabs');
const newTabBtn = document.getElementById('new-tab');

function render(state) {
  tabsEl.innerHTML = '';

  state.tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeId ? ' active' : '');
    el.title = tab.title || tab.url || 'New tab';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'tab-reload';
    reload.title = 'Reload tab';
    reload.setAttribute('aria-label', 'Reload tab');
    reload.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path fill="currentColor" d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z"/>' +
      '</svg>';
    reload.addEventListener('click', (e) => {
      e.stopPropagation();
      window.tabsApi.reloadTab(tab.id);
    });

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Loading…';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.title = 'Close tab';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.tabsApi.closeTab(tab.id);
    });

    el.addEventListener('click', () => {
      window.tabsApi.activateTab(tab.id);
    });

    el.appendChild(reload);
    el.appendChild(title);
    el.appendChild(close);
    tabsEl.appendChild(el);
  });
}

window.tabsApi.onState(render);

newTabBtn.addEventListener('click', () => {
  window.tabsApi.createTab();
});
