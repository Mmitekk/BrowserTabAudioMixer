// Микшер звука вкладок v2.2 для Opera GX
// Точная двусторонняя синхронизация громкости с плеером (Twitch, YouTube, HTML5)

const tabListEl = document.getElementById('tab-list');
const emptyStateEl = document.getElementById('empty-state');
const subInfoEl = document.getElementById('sub-info');
const chkShowAll = document.getElementById('chk-show-all');
const btnMuteAll = document.getElementById('btn-mute-all');
const btnResetAll = document.getElementById('btn-reset-all');
const btnReload = document.getElementById('btn-reload');
const statusTextEl = document.getElementById('status-text');

let showAllTabs = false;
let currentVolumes = new Map(); // tabId -> volume (0..1)
let isDraggingSlider = new Set(); // tabId
let activeCards = new Map(); // tabId -> { card, slider, pct, muteBtn, title, favBox, favSrc }

if (btnReload) {
  btnReload.addEventListener('click', () => location.reload());
}

if (chkShowAll) {
  chkShowAll.addEventListener('change', () => {
    showAllTabs = chkShowAll.checked;
    render();
  });
}

function setStatus(text) {
  if (statusTextEl) statusTextEl.textContent = text;
}

const SVG_SPEAKER_ON =
  '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const SVG_SPEAKER_OFF =
  '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>';

// Чтение сохранённых уровней громкости
async function loadStoredVolumes() {
  try {
    const all = await chrome.storage.session.get(null);
    const map = new Map();
    for (const [k, v] of Object.entries(all || {})) {
      if (k.startsWith('vol:')) {
        const id = Number(k.replace('vol:', ''));
        if (!isNaN(id)) map.set(id, v);
      }
    }
    return map;
  } catch (e) {
    return new Map();
  }
}

async function saveTabVolume(tabId, vol) {
  try {
    await chrome.storage.session.set({ ['vol:' + tabId]: vol });
  } catch (e) {}
}

// ── ОПРОС РЕАЛЬНОЙ ГРОМКОСТИ ИЗ ПЛЕЕРА НА СТРАНИЦЕ ─────────
function queryVolumeFromPage() {
  // 1. YouTube Player API
  try {
    const yt = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (yt && typeof yt.getVolume === 'function') {
      if (typeof yt.isMuted === 'function' && yt.isMuted()) return 0;
      const v = yt.getVolume();
      if (typeof v === 'number' && !isNaN(v)) return Math.min(1, Math.max(0, v / 100));
    }
  } catch (e) {}

  // 2. Twitch Player
  try {
    if (location.hostname.includes('twitch.tv')) {
      // 2a. Проверка реального DOM-ползунка Twitch
      const twSlider = document.querySelector('[data-a-target="player-volume-slider"]');
      if (twSlider) {
        const max = parseFloat(twSlider.max) || 1;
        const val = parseFloat(twSlider.value);
        if (!isNaN(val) && max > 0) {
          const isTwMuted =
            twSlider.getAttribute('data-a-player-muted') === 'true' ||
            !!document.querySelector('[data-a-target="player-mute-unmute-button"][data-a-player-muted="true"]');
          if (isTwMuted) return 0;
          return Math.min(1, Math.max(0, val / max));
        }
      }

      // 2b. Проверка сохранённого состояния в localStorage Twitch
      try {
        const isMuted = localStorage.getItem('muted') === 'true';
        if (isMuted) return 0;
        const lv = parseFloat(localStorage.getItem('volume'));
        if (!isNaN(lv) && lv >= 0 && lv <= 1) {
          return lv;
        }
      } catch (e) {}

      // 2c. Проверка React Fiber экземпляра плеера Twitch
      const video = document.querySelector('video');
      const root =
        video?.closest('.video-player__container') ||
        document.querySelector('[data-a-target="video-player"]') ||
        video?.parentElement;
      if (root) {
        const fKey = Object.keys(root).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (fKey) {
          let node = root[fKey];
          for (let i = 0; i < 40 && node; i++) {
            const p =
              node.memoizedProps?.player ||
              node.memoizedProps?.mediaPlayer ||
              node.memoizedProps?.mediaPlayerInstance ||
              node.stateNode?.player ||
              node.stateNode?.props?.player;
            if (p) {
              if (typeof p.isMuted === 'function' && p.isMuted()) return 0;
              if (typeof p.getVolume === 'function') {
                const v = p.getVolume();
                if (typeof v === 'number' && !isNaN(v)) return Math.min(1, Math.max(0, v));
              }
            }
            node = node.return;
          }
        }
      }
    }
  } catch (e) {}

  // 3. Стандартные HTML5 Media Elements (включая Shadow DOM)
  try {
    function collectMedia(root) {
      const list = [];
      if (!root) return list;
      if (root.querySelectorAll) {
        try {
          const found = root.querySelectorAll('video, audio');
          for (let i = 0; i < found.length; i++) list.push(found[i]);
        } catch (e) {}
        try {
          const all = root.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) list.push(...collectMedia(all[i].shadowRoot));
          }
        } catch (e) {}
      }
      return list;
    }
    const all = collectMedia(document);
    if (all.length > 0) {
      const playing = all.filter((m) => !m.paused && m.currentTime > 0);
      const target = playing.length ? playing[0] : all.filter((m) => !m.paused)[0] || all[0];
      if (target && typeof target.volume === 'number' && !isNaN(target.volume)) {
        if (target.muted) return 0;
        return Math.min(1, Math.max(0, target.volume));
      }
    }
  } catch (e) {}

  return null;
}

// ── УСТАНОВКА ГРОМКОСТИ В ПЛЕЕР НА СТРАНИЦЕ ────────────────
function executeVolumeInPage(targetVolume) {
  const v = Math.min(1, Math.max(0, targetVolume));

  function collectMedia(root) {
    const list = [];
    if (!root) return list;
    if (root.querySelectorAll) {
      try {
        const found = root.querySelectorAll('video, audio');
        for (let i = 0; i < found.length; i++) list.push(found[i]);
      } catch (e) {}
      try {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            list.push(...collectMedia(all[i].shadowRoot));
          }
        }
      } catch (e) {}
    }
    return list;
  }

  // 1. Стандартные HTML5 media-элементы
  const media = collectMedia(document);
  for (const el of media) {
    try {
      el.volume = v;
      if (v > 0 && el.muted) el.muted = false;
    } catch (e) {}
  }

  // 2. YouTube Player API
  try {
    const yt = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (yt && typeof yt.setVolume === 'function') {
      yt.setVolume(Math.round(v * 100));
      if (v > 0 && typeof yt.unMute === 'function') yt.unMute();
      if (v === 0 && typeof yt.mute === 'function') yt.mute();
    }
  } catch (e) {}

  // 3. Twitch Player (DOM Slider, React Fiber, Unmute Button, localStorage)
  try {
    if (location.hostname.includes('twitch.tv')) {
      // 3a. DOM-ползунок Twitch: установка через нативный сеттер прототипа для корректного вызова React onChange
      const twSlider = document.querySelector('[data-a-target="player-volume-slider"]');
      if (twSlider) {
        const max = parseFloat(twSlider.max) || 1;
        const targetVal = String(v * max);
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(twSlider, targetVal);
        } else {
          twSlider.value = targetVal;
        }
        twSlider.dispatchEvent(new Event('input', { bubbles: true }));
        twSlider.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 3b. Включение звука, если он был заглушён на Twitch
      if (v > 0) {
        const muteBtn = document.querySelector('[data-a-target="player-mute-unmute-button"]');
        if (
          muteBtn &&
          (muteBtn.getAttribute('data-a-player-muted') === 'true' ||
            muteBtn.getAttribute('aria-label')?.toLowerCase().includes('unmute'))
        ) {
          muteBtn.click();
        }
      }

      // 3c. Обновление localStorage Twitch
      try {
        localStorage.setItem('volume', String(v));
        if (v > 0) localStorage.setItem('muted', 'false');
      } catch (e) {}

      // 3d. React Fiber плеер
      for (const el of media) {
        const root =
          el.closest('.video-player__container') ||
          document.querySelector('[data-a-target="video-player"]') ||
          el.parentElement;
        if (root) {
          const fKey = Object.keys(root).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
          );
          if (fKey) {
            let node = root[fKey];
            for (let i = 0; i < 40 && node; i++) {
              const p =
                node.memoizedProps?.player ||
                node.memoizedProps?.mediaPlayer ||
                node.memoizedProps?.mediaPlayerInstance ||
                node.stateNode?.player ||
                node.stateNode?.props?.player;
              if (p) {
                if (typeof p.setVolume === 'function') p.setVolume(v);
                if (v > 0 && typeof p.setMuted === 'function') p.setMuted(false);
                if (v === 0 && typeof p.setMuted === 'function') p.setMuted(true);
                break;
              }
              node = node.return;
            }
          }
        }
      }
    }
  } catch (e) {}
}

// Применение громкости к конкретной вкладке
async function setTabVolume(tabId, volume) {
  currentVolumes.set(tabId, volume);
  saveTabVolume(tabId, volume);

  // 1. Главное окно вкладки (frame 0) — приоритет
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: executeVolumeInPage,
      args: [volume],
    });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: executeVolumeInPage,
        args: [volume],
      });
    } catch (e2) {}
  }

  // 2. Все фреймы (для embedded-плееров)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: executeVolumeInPage,
      args: [volume],
    });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: executeVolumeInPage,
        args: [volume],
      });
    } catch (e2) {}
  }
}

// Опрос текущего уровня громкости из вкладки
async function syncPlayerVolume(tabId) {
  if (isDraggingSlider.has(tabId)) return;

  let volumeFound = null;

  // 1. Сначала опрашиваем главное окно (frame 0)
  try {
    const resTop = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: queryVolumeFromPage,
    });
    if (resTop && resTop[0] && typeof resTop[0].result === 'number' && !isNaN(resTop[0].result)) {
      volumeFound = Math.min(1, Math.max(0, resTop[0].result));
    }
  } catch (eTop) {
    try {
      const resTopIso = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: queryVolumeFromPage,
      });
      if (resTopIso && resTopIso[0] && typeof resTopIso[0].result === 'number' && !isNaN(resTopIso[0].result)) {
        volumeFound = Math.min(1, Math.max(0, resTopIso[0].result));
      }
    } catch (eTopIso) {}
  }

  // 2. Если в главном окне громкость не найдена, опрашиваем остальные фреймы
  if (volumeFound === null) {
    try {
      const resAll = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: queryVolumeFromPage,
      });
      for (const r of resAll || []) {
        if (typeof r?.result === 'number' && !isNaN(r.result)) {
          volumeFound = Math.min(1, Math.max(0, r.result));
          break;
        }
      }
    } catch (eAll) {
      try {
        const resAllIso = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: queryVolumeFromPage,
        });
        for (const r of resAllIso || []) {
          if (typeof r?.result === 'number' && !isNaN(r.result)) {
            volumeFound = Math.min(1, Math.max(0, r.result));
            break;
          }
        }
      } catch (eAllIso) {}
    }
  }

  // 3. Обновляем локальное состояние и интерфейс
  if (volumeFound !== null && !isDraggingSlider.has(tabId)) {
    currentVolumes.set(tabId, volumeFound);
    saveTabVolume(tabId, volumeFound);
    updateCardVolumeUI(tabId, volumeFound);
  }
}

function updateTrackFill(slider, val) {
  const p = Math.round(Math.min(1, Math.max(0, val)) * 100);
  slider.style.setProperty('--track', `linear-gradient(90deg, var(--accent) ${p}%, #2d3140 ${p}%)`);
}

function updateCardVolumeUI(tabId, vol) {
  const c = activeCards.get(tabId);
  if (!c || isDraggingSlider.has(tabId)) return;
  const pctVal = Math.round(vol * 100);
  if (c.slider.value !== String(pctVal)) {
    c.slider.value = pctVal;
    c.pct.textContent = pctVal + '%';
    updateTrackFill(c.slider, vol);
  }
}

// Переключение mute вкладки с надёжной защитой от смены активной вкладки Opera GX
async function toggleTabMute(tabId, currentMuted) {
  try {
    const targetMuted = !currentMuted;

    let userActiveId = null;
    try {
      const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (cur) userActiveId = cur.id;
    } catch (e) {}

    await chrome.tabs.update(tabId, { muted: targetMuted });

    if (userActiveId && userActiveId !== tabId) {
      try {
        const [now] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (now && now.id === tabId) {
          await chrome.tabs.update(userActiveId, { active: true });
        }
      } catch (e) {}

      setTimeout(async () => {
        try {
          const [check] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (check && check.id === tabId) {
            await chrome.tabs.update(userActiveId, { active: true });
          }
        } catch (e) {}
      }, 50);
    }

    render();
  } catch (e) {
    console.warn('toggleTabMute error:', e);
  }
}

function ensureCard(tab) {
  let c = activeCards.get(tab.id);
  if (c) {
    updateCard(c, tab);
    return c.card;
  }

  const card = document.createElement('div');
  const top = document.createElement('div');
  top.className = 'card-top';

  const favBox = document.createElement('div');
  favBox.className = 'card-fav-box';

  const title = document.createElement('div');
  title.className = 'card-title';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';

  top.appendChild(favBox);
  top.appendChild(title);
  top.appendChild(muteBtn);

  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.className = 'volume-slider';

  const pct = document.createElement('span');
  pct.className = 'volume-percent';

  bottom.appendChild(slider);
  bottom.appendChild(pct);

  card.appendChild(top);
  card.appendChild(bottom);

  let debounceTimer = null;
  slider.addEventListener('input', () => {
    isDraggingSlider.add(tab.id);
    const v = slider.value / 100;
    pct.textContent = slider.value + '%';
    updateTrackFill(slider, v);
    setStatus(`Громкость ${slider.value}%: ${tab.title || 'вкладка'}`);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      setTabVolume(tab.id, v);
    }, 30);
  });

  slider.addEventListener('change', () => {
    isDraggingSlider.delete(tab.id);
    clearTimeout(debounceTimer);
    setTabVolume(tab.id, slider.value / 100);
  });

  c = { card, slider, pct, muteBtn, title, favBox, favSrc: null };
  activeCards.set(tab.id, c);

  updateCard(c, tab);
  return card;
}

function updateCard(c, tab) {
  const isAudible = !!tab.audible;
  const isMuted = !!tab.mutedInfo?.muted;

  c.card.className = `tab-card ${isAudible ? 'is-playing' : ''} ${isMuted ? 'is-muted' : ''}`;
  c.title.textContent = tab.title || tab.url || 'Вкладка';
  c.title.title = tab.title || tab.url || '';

  // Фавикон
  const f = tab.favIconUrl || '';
  if (c.favSrc !== f) {
    c.favSrc = f;
    c.favBox.textContent = '';
    if (f) {
      const img = document.createElement('img');
      img.className = 'card-fav';
      img.src = f;
      img.onerror = () => {
        c.favBox.innerHTML = `<span class="card-fav-fallback">${(tab.title || '?')[0].toUpperCase()}</span>`;
      };
      c.favBox.appendChild(img);
    } else {
      c.favBox.innerHTML = `<span class="card-fav-fallback">${(tab.title || '?')[0].toUpperCase()}</span>`;
    }
  }

  // Кнопка mute
  c.muteBtn.className = `btn-mute ${!isMuted && isAudible ? 'is-active' : ''}`;
  c.muteBtn.innerHTML = isMuted ? SVG_SPEAKER_OFF : SVG_SPEAKER_ON;
  c.muteBtn.title = isMuted ? 'Включить звук вкладки' : 'Заглушить вкладку';

  c.muteBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTabMute(tab.id, isMuted);
    setStatus(`${isMuted ? 'Включён звук' : 'Заглушена'}: ${tab.title || 'вкладка'}`);
  };

  // Установка громкости (если не перетаскивается прямо сейчас)
  if (!isDraggingSlider.has(tab.id)) {
    const vol = currentVolumes.has(tab.id) ? currentVolumes.get(tab.id) : 1;
    const pctVal = Math.round(vol * 100);
    c.slider.value = pctVal;
    c.pct.textContent = pctVal + '%';
    updateTrackFill(c.slider, vol);
  }
}

async function render() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }

  const selfId = chrome.runtime.id;
  tabs = tabs.filter((t) => {
    const u = t.url || t.pendingUrl || '';
    return !u.startsWith(`chrome-extension://${selfId}`) && !u.startsWith('devtools:');
  });

  const stored = await loadStoredVolumes();
  for (const [id, v] of stored) {
    if (!currentVolumes.has(id)) currentVolumes.set(id, v);
  }

  const audibleTabs = tabs.filter((t) => t.audible && !t.mutedInfo?.muted);
  const mutedTabs = tabs.filter((t) => t.mutedInfo?.muted);
  const otherTabs = showAllTabs
    ? tabs.filter((t) => !t.audible && !t.mutedInfo?.muted)
    : [];

  if (subInfoEl) {
    subInfoEl.textContent = `${audibleTabs.length} играют · ${mutedTabs.length} заглушены`;
  }
  if (btnMuteAll) {
    btnMuteAll.title = audibleTabs.length ? 'Заглушить все играющие вкладки' : 'Включить звук всех вкладок';
  }

  const hasAny = audibleTabs.length > 0 || mutedTabs.length > 0 || otherTabs.length > 0;
  if (emptyStateEl) {
    emptyStateEl.hidden = hasAny;
  }

  // Удаляем карточки закрытых вкладок
  const currentTabIds = new Set(tabs.map((t) => t.id));
  for (const [id, c] of activeCards) {
    if (!currentTabIds.has(id)) {
      c.card.remove();
      activeCards.delete(id);
      currentVolumes.delete(id);
    }
  }

  // Опрос реальной громкости играющих вкладок ДО первичного построения карточек!
  if (audibleTabs.length > 0) {
    await Promise.all(audibleTabs.map((t) => syncPlayerVolume(t.id)));
  }

  if (!tabListEl) return;
  tabListEl.textContent = '';

  const buildGroup = (groupKey, titleText, hasDot, tabArray) => {
    if (!tabArray.length) return;
    const grp = document.createElement('div');
    grp.className = 'group-header';
    if (hasDot) {
      const dot = document.createElement('span');
      dot.className = 'group-dot';
      grp.appendChild(dot);
    }
    grp.appendChild(document.createTextNode(titleText));
    tabListEl.appendChild(grp);

    for (const t of tabArray) {
      tabListEl.appendChild(ensureCard(t));
    }
  };

  buildGroup('audible', 'Сейчас играет', true, audibleTabs);
  buildGroup('muted', 'Заглушены', false, mutedTabs);
  buildGroup('others', 'Остальные вкладки', false, otherTabs);
}

// ── Мастер-кнопки ──────────────────────────────────────────
if (btnMuteAll) {
  btnMuteAll.addEventListener('click', async () => {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (e) {
      return;
    }
    const audible = tabs.filter((t) => t.audible && !t.mutedInfo?.muted);
    if (audible.length) {
      for (const t of audible) {
        chrome.tabs.update(t.id, { muted: true }).catch(() => {});
      }
      setStatus(`Заглушены все играющие (${audible.length})`);
    } else {
      const muted = tabs.filter((t) => t.mutedInfo?.muted);
      for (const t of muted) {
        chrome.tabs.update(t.id, { muted: false }).catch(() => {});
      }
      setStatus(`Звук включён (${muted.length})`);
    }
    render();
  });
}

if (btnResetAll) {
  btnResetAll.addEventListener('click', async () => {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (e) {
      return;
    }
    for (const t of tabs) {
      if (t.mutedInfo?.muted) {
        chrome.tabs.update(t.id, { muted: false }).catch(() => {});
      }
      setTabVolume(t.id, 1);
    }
    setStatus('Громкость всех вкладок сброшена на 100%');
    render();
  });
}

// ── Слушатели событий браузера ─────────────────────────────
chrome.tabs.onUpdated.addListener(() => render());
chrome.tabs.onCreated.addListener(() => render());
chrome.tabs.onRemoved.addListener(() => render());
chrome.tabs.onReplaced.addListener(() => render());

setInterval(render, 1000);
render();
