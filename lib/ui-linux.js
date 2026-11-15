// Linux-адаптация интерфейса M HUB (выполняется в странице после загрузки, идемпотентно).
(() => {
  const FLUID_W = 1440;     // уже этого — снимаем жёсткий минимум оригинала
  const COMPACT_W = 1180;   // уже этого — боковая панель ужимается до иконок
  const ROUTINE_COLUMN = false;  // узкое окно, «Стандарт»: настройки колонкой + наушники справа (false — две колонки)
  const NARROW_W = 1060;    // уже этого — сетки страниц перестраиваются в меньшее число колонок
  const root = document.documentElement;

  const applyMode = () => {
    const w = window.innerWidth;
    root.classList.toggle('mhub-fluid', w < FLUID_W);
    root.classList.toggle('mhub-compact', w < COMPACT_W);
    root.classList.toggle('mhub-narrow', w < NARROW_W);
    root.classList.toggle('mhub-col', ROUTINE_COLUMN);
  };

  // Подпись пунктов меню живёт в shadow DOM du-capsule-choice без ::part — добавляем стиль внутрь
  const CAPSULE_CSS = `
    .du-capsule-choice__title { display: inline-block; max-width: 220px; opacity: 1; overflow: hidden; white-space: nowrap;
      transition: max-width .38s cubic-bezier(.2,.8,.2,1), opacity .25s ease; }
    :host(.mhub-compact-item) .du-capsule-choice__title { max-width: 0; opacity: 0; }
    :host(.mhub-compact-item) du-layout { justify-content: center; --du-layout-gap: 0px !important; gap: 0 !important; }`;
  const patchCapsules = () => {
    const compact = root.classList.contains('mhub-compact');
    for (const el of document.querySelectorAll('du-capsule-choice.audio-detail-sidebar__item')) {
      if (el.shadowRoot && !el.shadowRoot.querySelector('style[data-mhub]')) {
        const st = document.createElement('style'); st.dataset.mhub = '1'; st.textContent = CAPSULE_CSS;
        el.shadowRoot.appendChild(st);
      }
      el.classList.toggle('mhub-compact-item', compact);
      // в компактном виде подпись — во всплывающей подсказке
      if (compact) el.setAttribute('title', el.getAttribute('choice-title') || ''); else el.removeAttribute('title');
    }
  };

  // «Звуковое устройство Windows» -> «Настройки звука» с пингвином
  const TUX = `<svg class="mhub-tux" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.6c-2.3 0-3.9 1.9-3.9 4.6 0 1 .2 1.8.1 2.6-.2 1.3-1.4 2.3-2.4 3.8-1.1 1.7-1.6 3.5-1.2 5.2-.6.2-1.2.6-1.4 1.2-.2.7.4 1.3.3 2 .5.8 1.6.4 2.5.7.9.3 1.5 1 2.5.9.7-.1 1.2-.6 1.3-1.2.9.1 2.6.1 3.8 0 .1.6.6 1.1 1.3 1.2 1 .1 1.6-.6 2.5-.9.9-.3 2 .1 2.5-.7-.1-.7.5-1.3.3-2-.2-.6-.8-1-1.4-1.2.4-1.7-.1-3.5-1.2-5.2-1-1.5-2.2-2.5-2.4-3.8-.1-.8.1-1.6.1-2.6 0-2.7-1.6-4.6-3.9-4.6zm-1.3 3.6c.5 0 .8.6.8 1.3 0 .2 0 .4-.1.5-.3-.1-.6-.1-.9 0 0-.2-.1-.3-.1-.5 0-.7.1-1.3.3-1.3zm2.5 0c.3 0 .5.6.5 1.3 0 .2 0 .3-.1.5-.2-.1-.5-.1-.8 0 0-.1-.1-.3-.1-.5 0-.7.2-1.3.5-1.3zM12 7.4c.8 0 2 .6 2 1.1 0 .4-1.1 1.2-2 1.2s-2-.8-2-1.2c0-.5 1.2-1.1 2-1.1zm-2.6 2.9c.7.6 1.6 1 2.6 1s1.9-.4 2.6-1c.4 1.2 1.6 2.2 2.3 3.6.7 1.4 1 2.9.6 4.2l-.1.3c-.5-.2-1.1-.1-1.5.4-.3.4-.4.9-.4 1.4-1 .2-2.5.2-3.5.1-.1-.6-.4-1.1-.9-1.4-.2-.6-.1-1.5.2-2.3-.4.4-.8 1.1-.9 2-.3-.1-.6-.1-.9 0 .2-1.3-.1-2.5-.6-3.4-.3-.6-.5-1.1-.4-1.6.3-1.1 1.2-2.1 1.8-2.9z"/></svg>`;
  const LABEL = { ru: 'Настройки звука', en: 'Sound Settings', zh: '声音设置', ja: 'サウンド設定', ko: '사운드 설정', de: 'Toneinstellungen', fr: 'Paramètres audio', es: 'Configuración de sonido', pl: 'Ustawienia dźwięku' };
  const lang = () => (/lang-([a-z]{2})/.exec(document.body?.className || '') || [, 'en'])[1];
  const patchSoundLink = () => {
    for (const b of document.querySelectorAll('du-button.audio-routine-page__windows-link')) {
      const ic = b.querySelector('du-icon[name^="icon-windows"]');
      if (ic) { const t = document.createElement('span'); t.setAttribute('slot', 'start'); t.innerHTML = TUX; ic.replaceWith(t); }
      const span = b.querySelector(':scope > span:not([slot])');
      const text = LABEL[lang()] || LABEL.en;
      if (span && span.textContent !== text) span.textContent = text;
    }
  };

  // Подписи кнопок шапки: показываем, если вся группа помещается до правой группы кнопок
  // Плашка «RGB синхронизация / Облако» плавно ужимается под наезжающую правую панель:
  // 1) подпись «Облако» уходит под край; 2) иконка облака цепляется за край и едет влево поверх
  //    «RGB синхронизация» (текст гаснет под ней); 3) облако упирается в лампочку — остаются две иконки.
  const PAD = 12, GAP = 16, ICON_BOX = 52;          // отступ плашки, промежуток кнопок, кнопка-иконка
  let nat = null, natKey = '';
  const fitHeader = () => {
    const prim = document.querySelector('.app-header__primary-group');
    const right = document.querySelector('.app-header .app-header__right');
    if (!prim || !right || !prim.shadowRoot) return;
    const btn = v => prim.shadowRoot.querySelector(`.du-segmented-button__item[data-value="${v}"]`);
    const light = btn('lightSync'), cloud = btn('cloud');
    if (!light || !cloud) return;
    const key = document.body.className + '|' + prim.textContent;
    if (key !== natKey || !nat) {                    // естественные размеры — без сжатия
      prim.classList.remove('mh-sq'); prim.style.removeProperty('width');
      nat = { light: light.getBoundingClientRect().width, cloud: cloud.getBoundingClientRect().width };
      natKey = key;
    }
    const natural = PAD + nat.light + GAP + nat.cloud + PAD;
    const minW = PAD + ICON_BOX + GAP + ICON_BOX + PAD;
    const hdr = prim.closest('.app-header'), hr = hdr.getBoundingClientRect();
    const avail = hr.right - parseFloat(getComputedStyle(hdr).paddingRight || 0) - right.getBoundingClientRect().width - 16 - prim.getBoundingClientRect().left;
    if (avail >= natural) {
      if (prim.classList.contains('mh-sq')) { prim.classList.remove('mh-sq'); prim.style.removeProperty('width'); }
      return;
    }
    const W = Math.max(minW, Math.floor(avail));
    const rail = W - 2 * PAD;
    const cl = Math.max(ICON_BOX + GAP, Math.min(nat.light + GAP, rail - ICON_BOX));   // левый край облака
    prim.style.setProperty('width', W + 'px', 'important');
    prim.style.setProperty('--mh-cl', cl + 'px');
    prim.style.setProperty('--mh-lw', (cl - GAP) + 'px');
    // маска подписи «RGB синхронизация»: гаснет под облаком; если от текста осталось <20 px — прячем его сразу за иконкой
    const lw = cl - GAP, TEXT_X = 40;              // текст начинается в 40 px от края кнопки (16 отступ + 20 иконка + 4)
    let mEnd = 400, tEnd = 402;
    if (lw < nat.light) {
      if (lw - TEXT_X < 20) { mEnd = 37; tEnd = 39; } else { mEnd = Math.max(37, lw - 22); tEnd = lw - 2; }
    }
    prim.style.setProperty('--mh-lm', mEnd + 'px');
    prim.style.setProperty('--mh-le', tEnd + 'px');
    prim.style.setProperty('--mh-cw', Math.max(ICON_BOX, rail - cl) + 'px');   // облако не шире остатка плашки
    // пока облако едет (фаза 2) — видна только его иконка, подпись спрятана
    prim.style.setProperty('--mh-cm', (cl < nat.light + GAP ? 37 : 400) + 'px');
    if (!prim.classList.contains('mh-sq')) prim.classList.add('mh-sq');
  };

  // Группы кнопок шапки (du-segmented-button): пункты — кнопки в shadow DOM с data-value.
  // Убираем «Магазин» и «Аккаунт» там, чтобы компонент не оставлял пустых мест; логотипу в узком окне — без минимальной ширины.
  const SEG_CSS = `
    .du-segmented-button__item[data-value="mall"], .du-segmented-button__item[data-value="user"] { display: none !important; }
    :host(.mhub-logo-k) .du-segmented-button__item { min-width: 0 !important; padding-inline: 12px !important; }
    :host(.mh-sq) .du-segmented-button__viewport { overflow: hidden !important; }
    :host(.mh-sq) .du-segmented-button__rail { position: relative; }
    :host(.mh-sq) .du-segmented-button__item[data-value="lightSync"] {
      flex: 0 0 auto; max-width: var(--mh-lw); overflow: hidden; justify-content: flex-start !important;
      -webkit-mask-image: linear-gradient(to right, #000 var(--mh-lm, 400px), transparent var(--mh-le, 402px));
              mask-image: linear-gradient(to right, #000 var(--mh-lm, 400px), transparent var(--mh-le, 402px)); }
    :host(.mh-sq) .du-segmented-button__item[data-value="cloud"] { position: absolute; left: var(--mh-cl); top: 0; bottom: 0;
      max-width: var(--mh-cw); overflow: hidden; justify-content: flex-start !important;
      -webkit-mask-image: linear-gradient(to right, #000 var(--mh-cm, 400px), transparent calc(var(--mh-cm, 400px) + 2px));
              mask-image: linear-gradient(to right, #000 var(--mh-cm, 400px), transparent calc(var(--mh-cm, 400px) + 2px)); }`;
  const patchSegmented = () => {
    const compact = root.classList.contains('mhub-compact');
    for (const g of document.querySelectorAll('.app-header du-segmented-button')) {
      if (g.shadowRoot && !g.shadowRoot.querySelector('style[data-mhub]')) {
        const st = document.createElement('style'); st.dataset.mhub = '1'; st.textContent = SEG_CSS; g.shadowRoot.appendChild(st);
      }
      if (g.classList.contains('app-header__logo-group')) g.classList.toggle('mhub-logo-k', compact);
      // группа, в которой были только скрытые кнопки (аккаунт/магазин), — прячем целиком, без пустой плашки
      const items = [...g.children].filter(c => c.getAttribute('slot'));
      const empty = items.length > 0 && items.every(c => /header-(user|mall)-action/.test(c.className));
      g.style.display = empty ? 'none' : '';
    }
  };

  // Страница 7.1: профиль HRTF, выбор тестового звука («Шаги / Кино») и демо-дорожка
  const T = {
    ru: { hrtf: 'Профиль HRTF', steps: 'Шаги', cinema: 'Кино', demo: 'Демо', stop: 'Стоп', loading: 'загрузка…', title: 'Виртуальный 7.1 объёмный звук' },
    en: { hrtf: 'HRTF profile', steps: 'Footsteps', cinema: 'Cinema', demo: 'Demo', stop: 'Stop', loading: 'downloading…', title: 'Virtual 7.1 Surround Sound' },
  };
  const tr = k => (T[lang()] || T.en)[k];
  const L = window.electronAPI?.linux;
  const linuxState = window.__hhLinux = window.__hhLinux || { settings: null, list: null, demo: false };
  const loadLinux = async () => {
    if (!L || linuxState.loading) return;
    linuxState.loading = true;
    try { linuxState.settings = await L.get(); linuxState.list = await L.hrtfList(); } finally { linuxState.loading = false; }
    window.__mhubUi?.run();
  };
  const patchSurround = () => {
    const page = document.querySelector('.surround-page');
    if (!page || !L) return;
    if (!linuxState.settings) { loadLinux(); return; }
    // Подпись без названия чужой технологии
    const label = page.querySelector('.surround-page__switch-row > span');
    if (label && /Xear/i.test(label.textContent)) label.textContent = label.textContent.replace(/Xear\s*/i, '');
    // Профиль HRTF
    const row = page.querySelector('.surround-page__switch-row');
    let box = row?.querySelector('.hh-hrtf');
    if (row && !box) {
      box = document.createElement('label'); box.className = 'hh-hrtf';
      box.innerHTML = '<span></span><select></select><em></em>';
      box.querySelector('select').addEventListener('change', async e => {
        linuxState.settings = await L.set({ hrtf: e.target.value });
        pollHrtf();
      });
      row.appendChild(box);
    }
    if (box) {
      box.querySelector('span').textContent = tr('hrtf');
      const sel = box.querySelector('select'), list = linuxState.list || [];
      const sig = list.map(x => x.id + x.ready).join();
      if (sel.dataset.sig !== sig) {
        sel.innerHTML = list.map(x => `<option value="${x.id}">${x.name}</option>`).join('');
        sel.dataset.sig = sig;
      }
      sel.value = linuxState.settings.hrtf;
      const cur = list.find(x => x.id === linuxState.settings.hrtf);
      box.querySelector('em').textContent = cur && !cur.ready ? tr('loading') : '';
    }
    // Выбор тестового звука и демо
    const card = page.querySelector('.surround-page__speaker-card');
    if (card && !card.querySelector('.hh-test')) {
      const seg = document.createElement('div'); seg.className = 'hh-test';
      seg.innerHTML = '<button data-k="steps"></button><button data-k="cinema"></button>';
      seg.addEventListener('click', async e => {
        const k = e.target.closest('button')?.dataset.k; if (!k) return;
        linuxState.settings = await L.set({ testSound: k });
        if (linuxState.demo) { await L.testPlay(k); }
        window.__mhubUi.run();
      });
      card.appendChild(seg);
      const demo = document.createElement('du-button'); demo.className = 'hh-demo';
      demo.setAttribute('variant', 'secondary'); demo.setAttribute('size', 'medium');
      demo.addEventListener('click', async () => {
        if (linuxState.demo) { linuxState.demo = false; await L.testStop(); }
        else { linuxState.demo = true; await L.testPlay(linuxState.settings.testSound); clearTimeout(linuxState.demoT); linuxState.demoT = setTimeout(() => { linuxState.demo = false; window.__mhubUi.run(); }, linuxState.settings.testSound === 'cinema' ? 22000 : 16000); }
        window.__mhubUi.run();
      });
      card.appendChild(demo);
    }
    if (card) {
      const k = linuxState.settings.testSound;
      for (const b of card.querySelectorAll('.hh-test button')) { b.textContent = tr(b.dataset.k); b.classList.toggle('is-on', b.dataset.k === k); }
      const demo = card.querySelector('.hh-demo'), start = card.querySelector('.surround-page__test-button');
      const txt = (linuxState.demo ? '■ ' : '▶ ') + tr(linuxState.demo ? 'stop' : 'demo');
      if (demo.textContent !== txt) demo.textContent = txt;
      if (start) {   // справа от «Начать тест», на той же линии
        const cr = card.getBoundingClientRect(), r = start.getBoundingClientRect();
        demo.style.left = (r.right - cr.left + 12) + 'px'; demo.style.top = (r.top - cr.top) + 'px';
      }
    }
  };
  const pollHrtf = () => {
    clearInterval(linuxState.poll);
    linuxState.poll = setInterval(async () => {
      linuxState.list = await L.hrtfList();
      const cur = linuxState.list.find(x => x.id === linuxState.settings?.hrtf);
      window.__mhubUi?.run();
      if (!cur || cur.ready) clearInterval(linuxState.poll);
    }, 1500);
  };

  const run = () => { applyMode(); patchCapsules(); patchSoundLink(); patchSegmented(); fitHeader(); patchSurround(); };
  // Повторная вставка (горячая перезагрузка) подменяет логику, наблюдатели остаются прежними
  if (window.__mhubUi) { window.__mhubUi.run = run; run(); return; }
  window.__mhubUi = { run };
  let pending = false;
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; window.__mhubUi.run(); }); } };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  // контрольная перепроверка после окончания анимаций компонентов
  let settle = null;
  window.addEventListener('resize', () => { schedule(); clearTimeout(settle); settle = setTimeout(() => window.__mhubUi.run(), 450); });
  run();
})();
