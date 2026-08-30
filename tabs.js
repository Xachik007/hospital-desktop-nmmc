const tabsEl = document.getElementById('tabs');
const newTabBtn = document.getElementById('new-tab');

function render(state) {
  tabsEl.innerHTML = '';

  state.tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeId ? ' active' : '');
    el.title = tab.title || tab.url || 'New tab';

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

    el.appendChild(title);
    el.appendChild(close);
    tabsEl.appendChild(el);
  });
}

window.tabsApi.onState(render);

newTabBtn.addEventListener('click', () => {
  window.tabsApi.createTab();
});
