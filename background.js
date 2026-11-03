// Фоновый service worker для расширения «Микшер звука» v2.0
// Минимальный, надёжный, без глобальных побочных эффектов.

chrome.action.onClicked.addListener(() => {
  try {
    if (typeof opr !== 'undefined' && opr.sidebarAction && opr.sidebarAction.open) {
      opr.sidebarAction.open();
      return;
    }
  } catch (e) {}

  try {
    chrome.windows.create({
      url: chrome.runtime.getURL('sidebar.html'),
      type: 'popup',
      width: 360,
      height: 600,
    });
  } catch (e) {}
});

// Восстановление громкости при обновлении вкладки (если пользователь её настраивал)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    try {
      const data = await chrome.storage.session.get('vol:' + tabId);
      const vol = data && data['vol:' + tabId];
      if (typeof vol === 'number') {
        chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: (v) => {
            const list = document.querySelectorAll('video, audio');
            for (const el of list) {
              try { el.volume = v; } catch (e) {}
            }
          },
          args: [vol],
        }).catch(() => {});
      }
    } catch (e) {}
  }
});

// Очистка при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    chrome.storage.session.remove('vol:' + tabId).catch(() => {});
  } catch (e) {}
});
