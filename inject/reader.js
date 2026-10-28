// 微信读书阅读增强脚本。由 Go 侧在每次导航完成后注入，
// 依赖 window.__WR_PREFS__ 与 window.__WR_CSS__ 已预先赋值。
(() => {
  if (window.__wr) return;

  // 官方 DOM 一改就在这里修。
  const SEL = {
    content: '.app_content',
    controls: '.readerControls',
    horizontal: '.wr_horizontalReader',
    nextChapter: '.readerFooter_button',
    loginButton: '.navBar_link_Login',
    searchClose: '.search_close_button',
    // 侧栏的目录按钮 click 无效，底栏的可以，两者打开同一个目录面板。
    catalog: '.rbb_item.catalog',
    note: '.readerControls_item.wr_note',
    theme: '.readerControls_item.white, .readerControls_item.dark',
    fontButton: '.fontSizeButton',
    fontPanelMask: '.reader-font-control-panel-mask',
    fontTrack: '.reader_font_control_slider_track',
    fontDots: '.reader_font_control_slider_track_level_dot',
    fontItems: '.font-panel-content-fonts-item',
  };
  const READER_PATH = /^\/web\/reader\//;

  const prefs = Object.assign(
    {
      theme: 'auto', width: 'medium', tint: 'none', immersive: true, restoreLast: true, scrollSpeed: 40,
      stealth: false, stealthAlpha: 70, stealthColor: 'gray',
    },
    window.__WR_PREFS__ || {},
  );
  const root = document.documentElement;
  const $ = (s) => document.querySelector(s);
  const bridge = (m) => {
    try { window.webkit.messageHandlers.external.postMessage(m); } catch (_) { /* 非 wails 环境 */ }
  };
  const post = (type, value = '') => bridge(JSON.stringify({ type, value: String(value) }));

  const el = (tag, attrs = {}, html = '') => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (html) n.innerHTML = html;
    return n;
  };
  const isReader = () => READER_PATH.test(location.pathname);
  const scroller = () => document.scrollingElement || root;
  const isHorizontal = () => !!$(SEL.horizontal) || scroller().scrollHeight <= window.innerHeight + 4;

  // ---------- 图标 ----------
  const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
    catalog: svg('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/>'),
    note: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    ai: svg('<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
    column: svg('<rect x="3" y="5" width="7.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="7.5" height="14" rx="1.5"/>'),
    theme: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
    type: svg('<path d="M4 19l5-14 5 14M5.8 14h6.4"/><path d="M15 19v-6.5a2.5 2.5 0 0 1 5 0V19M15 15.5h5"/>'),
    shelf: svg('<path d="M5 4h3v16H5zM10 4h3v16h-3z"/><path d="M15.5 5.2l2.9-.8 3.9 15.4-2.9.8z"/>'),
    stealth: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10l3 2.5L7 15M12 15h5"/>'),
  };

  // ---------- 注入节点 ----------
  const style = el('style', { id: 'wr-style' });
  style.textContent = window.__WR_CSS__ || '';
  const tint = el('div', { id: 'wr-tint' });
  const progress = el('div', { id: 'wr-progress' });
  const toastEl = el('div', { id: 'wr-toast', role: 'status', 'aria-live': 'polite' });

  // 标题条：拖动窗口、关闭、最小化。原生红绿灯已隐藏。
  const bar = el('div', { id: 'wr-bar' }, `
    <div class="wr-lights">
      <button type="button" data-win="close" aria-label="关闭窗口" title="关闭"></button>
      <button type="button" data-win="minimise" aria-label="最小化" title="最小化"></button>
    </div>
    <div class="wr-title"></div>`);
  const barTitle = bar.querySelector('.wr-title');
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    bridge('wails:drag');
  });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) bridge('wails:drag:doubleclick'); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-win]');
    if (b) post(b.dataset.win);
  });

  // 悬浮 Dock：官方侧边按钮全部收进来。
  const DOCK = [
    { id: 'catalog', label: '目录', icon: ICON.catalog, reader: true },
    { id: 'note', label: '笔记', icon: ICON.note, reader: true },
    { id: 'ai', label: 'AI 问书', icon: ICON.ai, reader: true },
    { id: 'column', label: '单栏 / 双栏', icon: ICON.column, reader: true },
    { id: 'theme', label: '深色 / 浅色', icon: ICON.theme, reader: true },
    { id: 'settings', label: '阅读设置 ⌘,', icon: ICON.type },
    { id: 'stealth', label: '伪装模式 ⌘⇧M', icon: ICON.stealth },
    { id: 'shelf', label: '书架 ⌘L', icon: ICON.shelf },
  ];
  const dock = el('div', { id: 'wr-dock' }, `
    <div class="wr-dock-items" role="toolbar" aria-label="阅读工具">
      ${DOCK.map((d) => `<button type="button" data-dock="${d.id}" ${d.reader ? 'data-reader' : ''} aria-label="${d.label}" data-tip="${d.label}">${d.icon}</button>`).join('')}
    </div>
    <button type="button" class="wr-dock-main" aria-label="阅读工具" aria-expanded="false">${ICON.more}</button>`);
  const dockMain = dock.querySelector('.wr-dock-main');
  let dockOpen = false;
  // 窗口较窄时官方会收起侧栏按钮，对应的 Dock 项也隐藏。
  const DOCK_TARGET = {
    note: () => $(SEL.note) || officialButton(/笔记/),
    ai: () => officialButton(/问书/),
    column: () => officialButton(/栏/),
    theme: () => $(SEL.theme),
  };
  const syncDock = () => {
    dock.querySelectorAll('[data-dock]').forEach((b) => {
      const id = b.dataset.dock;
      let show = !b.hasAttribute('data-reader') || isReader();
      if (show && DOCK_TARGET[id]) {
        const t = DOCK_TARGET[id]();
        show = !!t && t.getBoundingClientRect().width > 0;
      }
      b.hidden = !show;
    });
  };
  const toggleDock = (open = !dockOpen) => {
    if (open) syncDock();
    dockOpen = open;
    root.classList.toggle('wr-dock-open', open);
    dockMain.setAttribute('aria-expanded', String(open));
  };
  dockMain.addEventListener('click', () => toggleDock());
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dock]');
    if (b) runDock(b.dataset.dock);
  });

  // 官方控件按提示文字或 class 定位。
  const officialButton = (match) => {
    for (const c of document.querySelectorAll(`${SEL.controls} .wr_tooltip_container`)) {
      const tip = c.querySelector('.wr_tooltip_item');
      if (tip && match.test(tip.textContent || '')) return c.querySelector('button');
    }
    return null;
  };
  const clickOfficial = (btn, name) => {
    if (btn) { btn.click(); return true; }
    toast(`当前页面没有${name}`);
    return false;
  };
  // 侧栏按钮只认真实点击：临时让它可点，由 Go 侧在按钮中心投递一次原生点击。
  const tapOfficial = (btn, name) => {
    if (!btn) { toast(`当前页面没有${name}`); return false; }
    root.classList.add('wr-tapping');
    const r = btn.getBoundingClientRect();
    const scale = window.outerWidth / window.innerWidth || 1;
    post('tap', JSON.stringify({ X: (r.left + r.width / 2) * scale, Y: (r.top + r.height / 2) * scale }));
    setTimeout(() => root.classList.remove('wr-tapping'), 400);
    return true;
  };
  const runDock = (id) => {
    toggleDock(false);
    switch (id) {
      case 'catalog': clickOfficial($(SEL.catalog), '目录'); break;
      case 'note': tapOfficial($(SEL.note) || officialButton(/笔记/), '笔记'); break;
      case 'ai': tapOfficial(officialButton(/问书/), 'AI 问书'); break;
      case 'column':
        if (tapOfficial(officialButton(/栏/), '双栏切换')) setTimeout(relayout, 500);
        break;
      case 'theme': tapOfficial($(SEL.theme), '主题切换'); setTimeout(render, 500); break;
      case 'settings': togglePanel(); break;
      case 'stealth': setPref({ stealth: !prefs.stealth }); break;
      case 'shelf': post('shelf'); break;
      default:
    }
  };

  // ---------- 设置浮窗 ----------
  const panel = el('aside', { id: 'wr-panel', 'aria-label': '阅读设置', 'aria-hidden': 'true' });
  panel.inert = true;
  const seg = (key, opts) =>
    `<div class="wr-seg" role="group" data-key="${key}">${opts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>`;
  const toggle = (key, label, hint = '') =>
    `<label class="wr-row"><span>${label}${hint ? ` <em>${hint}</em>` : ''}</span><input type="checkbox" role="switch" data-key="${key}"></label>`;
  panel.innerHTML = `
    <header><b>阅读设置</b><button type="button" class="wr-x" aria-label="关闭设置">${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button></header>
    <section data-reader>
      <h3>字号</h3>
      <div class="wr-step">
        <button type="button" data-act="font-" aria-label="减小字号">A<sup>−</sup></button>
        <output data-out="fontSize">–</output>
        <button type="button" data-act="font+" aria-label="增大字号">A<sup>+</sup></button>
      </div>
    </section>
    <section data-reader>
      <h3>字体</h3>
      <div class="wr-fonts" data-out="fonts"><p class="wr-hint">读取中…</p></div>
    </section>
    <section>
      <h3>版心宽度 <em>⌘1–4</em></h3>
      ${seg('width', [['narrow', '窄'], ['medium', '适中'], ['wide', '宽'], ['full', '满']])}
    </section>
    <section>
      <h3>纸张底色</h3>
      <div class="wr-swatches" role="group" data-key="tint">
        <button type="button" data-v="none"><i style="background:#fff"></i>原色</button>
        <button type="button" data-v="paper"><i style="background:#f3e9d2"></i>米黄</button>
        <button type="button" data-v="green"><i style="background:#d6ead8"></i>护眼</button>
        <button type="button" data-v="dim"><i style="background:#5a5a5a"></i>暗化</button>
      </div>
    </section>
    <section>
      <h3>阅读</h3>
      ${toggle('immersive', '沉浸模式', 'F')}
      ${toggle('restoreLast', '启动时回到上次阅读')}
      <label class="wr-row"><span>自动滚动速度 <em>A</em></span><input type="range" min="10" max="200" step="5" data-key="scrollSpeed"></label>
    </section>
    <section>
      <h3>伪装模式 <em>⌘⇧M</em></h3>
      ${toggle('stealth', '开启')}
      <label class="wr-row"><span>背景 <output data-out="alpha"></output></span><input type="range" min="5" max="100" step="5" data-key="stealthAlpha"></label>
      ${seg('stealthColor', [['gray', '灰'], ['green', '绿'], ['amber', '琥珀']])}
      <p class="wr-hint">⌃⌥Space 全局隐藏 / 显示窗口</p>
    </section>
    <footer class="wr-hint">按 ? 查看全部快捷键</footer>`;

  const help = el('div', { id: 'wr-help', role: 'dialog', 'aria-label': '快捷键' }, `<div><h2>快捷键</h2><table>
    <tr><td><kbd>Space</kbd> <kbd>J</kbd> <kbd>PgDn</kbd></td><td>下一屏，章末进入下一章</td></tr>
    <tr><td><kbd>⇧Space</kbd> <kbd>K</kbd> <kbd>PgUp</kbd></td><td>上一屏</td></tr>
    <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>官方翻页 / 切章</td></tr>
    <tr><td><kbd>F</kbd> / <kbd>⌘E</kbd></td><td>沉浸模式</td></tr>
    <tr><td><kbd>A</kbd></td><td>自动滚动，<kbd>+</kbd> <kbd>-</kbd> 调速，<kbd>Esc</kbd> 停止</td></tr>
    <tr><td><kbd>⌘,</kbd></td><td>阅读设置</td></tr>
    <tr><td><kbd>⌘1</kbd>–<kbd>⌘4</kbd></td><td>版心宽度</td></tr>
    <tr><td><kbd>⌘⇧M</kbd></td><td>伪装模式</td></tr>
    <tr><td><kbd>⌃⌥Space</kbd></td><td>全局隐藏 / 显示窗口</td></tr>
    <tr><td><kbd>⌘L</kbd></td><td>书架</td></tr>
    <tr><td><kbd>⌥⌘T</kbd></td><td>窗口置顶</td></tr>
  </table></div>`);
  help.addEventListener('click', (e) => { if (e.target === help) help.classList.remove('wr-show'); });

  const mount = () => {
    if (!document.head || !document.body) return false;
    if (!style.isConnected) document.head.appendChild(style);
    for (const n of [tint, progress, bar, dock, panel, toastEl, help]) {
      if (!n.isConnected) document.body.appendChild(n);
    }
    return true;
  };

  let toastTimer;
  const toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add('wr-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('wr-show'), 1400);
  };

  // ---------- 状态与样式 ----------
  const WIDTH_LABEL = { narrow: '窄', medium: '适中', wide: '宽', full: '满' };
  const TINT_LABEL = { none: '原色', paper: '米黄', green: '护眼', dim: '暗化' };

  // 浮层配色跟随官方页面实际底色，而不是系统外观。
  const pageIsDark = () => {
    const m = getComputedStyle(document.body || root).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!m || (m.length === 4 && Number(m[3]) === 0)) return matchMedia('(prefers-color-scheme: dark)').matches;
    const [r, g, b] = m.map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  };
  const syncDark = () => {
    if (!prefs.stealth && document.body) root.classList.toggle('wr-dark', pageIsDark());
  };

  const render = () => {
    const reader = isReader();
    root.classList.toggle('wr-reader', reader);
    root.classList.toggle('wr-horizontal', reader && isHorizontal());
    root.classList.toggle('wr-immersive', !!prefs.immersive);
    root.classList.toggle('wr-stealth', !!prefs.stealth);
    syncDark();
    for (const c of [...root.classList]) {
      if (/^wr-(w|tint|fg)-/.test(c)) root.classList.remove(c);
    }
    root.classList.add(`wr-w-${prefs.width}`, `wr-tint-${prefs.tint}`, `wr-fg-${prefs.stealthColor}`);
    root.style.setProperty('--wr-alpha', String(Math.max(5, Math.min(100, prefs.stealthAlpha)) / 100));
    syncDock();
    updateProgress();
  };

  // 正文 canvas 按容器宽度排版，改宽度后让官方脚本重排。
  const relayout = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

  let speed = prefs.scrollSpeed || 40;
  const apply = (next) => {
    const changed = Object.keys(next || {}).filter((k) => prefs[k] !== next[k]);
    Object.assign(prefs, next);
    speed = prefs.scrollSpeed || speed;
    render();
    if (panelOpen) syncPanel();
    if (changed.includes('width')) { relayout(); toast(`版心：${WIDTH_LABEL[prefs.width] || prefs.width}`); }
    if (changed.includes('tint')) toast(`底色：${TINT_LABEL[prefs.tint] || prefs.tint}`);
    if (changed.includes('immersive')) toast(prefs.immersive ? '沉浸模式：开' : '沉浸模式：关');
    if (changed.includes('stealth')) toast(prefs.stealth ? '伪装模式：开' : '伪装模式：关');
  };

  // 偏好改动：本地生效 + 回传 Go 落盘。
  const setPref = (patch) => {
    apply(patch);
    post('prefs', JSON.stringify(prefs));
  };

  const updateProgress = () => {
    const s = scroller();
    const max = s.scrollHeight - window.innerHeight;
    progress.style.width = max > 0 ? `${Math.min(100, (s.scrollTop / max) * 100)}%` : '0';
  };

  // ---------- 设置浮窗逻辑 ----------
  const fontDots = () => document.querySelectorAll(SEL.fontDots);
  const currentFontLevel = () => {
    const m = document.body && document.body.className.match(/wr_reader_font_size_level_(\d+)/);
    return m ? Number(m[1]) : -1;
  };

  const syncPanel = () => {
    panel.querySelectorAll('[data-key]').forEach((n) => {
      const v = prefs[n.dataset.key];
      if (n.matches('.wr-seg, .wr-swatches')) {
        n.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      } else if (n.type === 'checkbox') n.checked = !!v;
      else if (n.type === 'range') n.value = v;
    });
    panel.querySelector('[data-out=alpha]').textContent = `${prefs.stealthAlpha}%`;
    panel.querySelectorAll('[data-reader]').forEach((n) => { n.hidden = !isReader(); });
    const level = currentFontLevel();
    panel.querySelector('[data-out=fontSize]').textContent = level < 1 ? '–' : `${level} / ${fontDots().length || 7}`;
  };

  let panelOpen = false;
  const togglePanel = (open = !panelOpen) => {
    panelOpen = open;
    root.classList.toggle('wr-panel-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    if (open) {
      syncPanel();
      loadFonts();
      panel.querySelector('.wr-x').focus({ preventScroll: true });
    }
  };
  panel.addEventListener('click', (e) => {
    const t = e.target instanceof Element && e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('wr-x')) { togglePanel(false); return; }
    const group = t.closest('[data-key]');
    if (group && t.dataset.v) { setPref({ [group.dataset.key]: t.dataset.v }); return; }
    if (t.dataset.font) { pickFont(Number(t.dataset.font)); return; }
    if (t.dataset.act === 'font-') stepFont(-1);
    if (t.dataset.act === 'font+') stepFont(1);
  });
  panel.addEventListener('change', (e) => {
    const n = e.target;
    if (!(n instanceof HTMLInputElement) || !n.dataset.key) return;
    setPref({ [n.dataset.key]: n.type === 'checkbox' ? n.checked : Number(n.value) });
  });
  panel.addEventListener('input', (e) => {
    const n = e.target;
    // 拖动时实时预览，松手再落盘。
    if (n instanceof HTMLInputElement && n.dataset.key === 'stealthAlpha') apply({ stealthAlpha: Number(n.value) });
  });
  document.addEventListener('mousedown', (e) => {
    if (panelOpen && !panel.contains(e.target) && !dock.contains(e.target)) togglePanel(false);
    if (dockOpen && !dock.contains(e.target)) toggleDock(false);
  }, true);

  // ---------- 代理官方字号 / 字体面板 ----------
  // 官方面板藏起来打开，操作完再关掉，用户只看到正文变化。
  const withFontPanel = (fn) => new Promise((resolve) => {
    const btn = $(SEL.fontButton);
    if (!btn) { toast('请在阅读页使用'); resolve(false); return; }
    root.classList.add('wr-proxy');
    btn.click();
    setTimeout(() => {
      try { fn(); } finally {
        setTimeout(() => {
          const mask = $(SEL.fontPanelMask);
          if (mask) mask.click();
          root.classList.remove('wr-proxy');
          resolve(true);
        }, 250);
      }
    }, 200);
  });
  // 官方滑杆只认轨道上的 click，按坐标落到目标档位。
  const clickAt = (n, x, y) => {
    n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
  };
  // 字号档位从 1 开始，与官方 wr_reader_font_size_level_N 一致；点到目标档位的圆点中心。
  const stepFont = (delta) => withFontPanel(() => {
    const track = $(SEL.fontTrack);
    const dots = fontDots();
    const cur = currentFontLevel();
    if (!track || !dots.length || cur < 1) return;
    const next = Math.max(1, Math.min(dots.length, cur + delta));
    if (next === cur) { toast(delta > 0 ? '已是最大字号' : '已是最小字号'); return; }
    const r = dots[next - 1].getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    clickAt(track, r.left + r.width / 2, tr.top + tr.height / 2);
  }).then(() => { setTimeout(syncPanel, 300); setTimeout(syncPanel, 900); });

  // 官方列表在多个分组里重复出现，按字体去重，记下第一次出现的下标用于点击。
  let fonts = [];
  const loadFonts = () => {
    if (!isReader() || fonts.length) { renderFonts(); return; }
    withFontPanel(() => {
      const seen = new Set();
      fonts = [];
      document.querySelectorAll(SEL.fontItems).forEach((n, i) => {
        const family = n.style.fontFamily;
        if (!family || seen.has(family)) return;
        seen.add(family);
        const name = (n.textContent || '').trim() || family.split(',')[0].replace(/["']/g, '').replace(/-min$/, '').trim();
        fonts.push({ i, name, family, selected: n.classList.contains('selected') });
      });
    }).then(renderFonts);
  };
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const renderFonts = () => {
    const box = panel.querySelector('[data-out=fonts]');
    if (!fonts.length) { box.innerHTML = '<p class="wr-hint">未读到官方字体列表</p>'; return; }
    box.innerHTML = fonts.map((f, k) =>
      `<button type="button" data-font="${k}" aria-pressed="${f.selected}" style="font-family:${esc(f.family)}">${esc(f.name)}</button>`).join('');
  };
  const pickFont = (k) => withFontPanel(() => {
    const items = document.querySelectorAll(SEL.fontItems);
    if (fonts[k] && items[fonts[k].i]) items[fonts[k].i].click();
  }).then(() => {
    fonts.forEach((f, j) => { f.selected = j === k; });
    renderFonts();
    if (fonts[k]) toast(`字体：${fonts[k].name}`);
  });

  // ---------- 沉浸：空闲时隐藏光标与浮层 ----------
  let uiTimer;
  let idleTimer;
  const showUI = () => {
    root.classList.add('wr-ui');
    root.classList.remove('wr-idle');
    clearTimeout(uiTimer);
    clearTimeout(idleTimer);
    uiTimer = setTimeout(() => root.classList.remove('wr-ui'), 2000);
    idleTimer = setTimeout(() => root.classList.add('wr-idle'), 2500);
  };
  document.addEventListener('mousemove', showUI, { passive: true });

  // ---------- 翻页 ----------
  const findNextChapter = () => {
    const btn = $(SEL.nextChapter);
    if (btn && /下一章/.test(btn.textContent || '')) return btn;
    return [...document.querySelectorAll('button, a, [role=button]')]
      .find((n) => (n.textContent || '').trim() === '下一章') || null;
  };
  const pressArrow = (key) => {
    const code = key === 'ArrowRight' ? 39 : 37;
    const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => code });
    Object.defineProperty(ev, 'which', { get: () => code });
    document.dispatchEvent(ev);
  };
  const atBottom = () => {
    const s = scroller();
    return s.scrollTop + window.innerHeight >= s.scrollHeight - 4;
  };
  const page = (dir) => {
    if (isHorizontal()) { pressArrow(dir > 0 ? 'ArrowRight' : 'ArrowLeft'); return; }
    if (dir > 0 && atBottom()) {
      const next = findNextChapter();
      if (next) { next.click(); toast('下一章'); } else toast('已到末尾');
      return;
    }
    // 保留一点重叠，翻屏后不丢位置。
    scroller().scrollBy({ top: dir * (window.innerHeight - 64), behavior: 'smooth' });
  };

  // ---------- 自动滚动 ----------
  let autoRAF = 0;
  let autoLast = 0;
  let autoCarry = 0;
  const autoTick = (t) => {
    if (!autoLast) autoLast = t;
    autoCarry += ((t - autoLast) / 1000) * speed;
    autoLast = t;
    const step = Math.floor(autoCarry);
    if (step > 0) {
      autoCarry -= step;
      if (atBottom()) {
        const next = findNextChapter();
        if (!next) { autoScroll(false); toast('已到末尾'); return; }
        next.click();
      } else {
        scroller().scrollTop += step;
      }
    }
    autoRAF = requestAnimationFrame(autoTick);
  };
  const autoScroll = (on) => {
    if (!on && !autoRAF) { post('autoScroll', 'off'); return; }
    if (on && (!isReader() || isHorizontal())) { toast('自动滚动仅支持上下滚动模式'); on = false; }
    cancelAnimationFrame(autoRAF);
    autoRAF = 0;
    autoLast = 0;
    if (on) { autoRAF = requestAnimationFrame(autoTick); toast(`自动滚动：${speed} px/s`); } else toast('自动滚动：关');
    post('autoScroll', autoRAF ? 'on' : 'off');
  };
  window.addEventListener('wheel', () => { if (autoRAF) autoScroll(false); }, { passive: true });
  window.addEventListener('scroll', updateProgress, { passive: true });

  // ---------- 键盘 ----------
  const editable = (n) =>
    n instanceof Element && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
  const WIDTHS = ['narrow', 'medium', 'wide', 'full'];
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-4]$/.test(e.key)) {
      setPref({ width: WIDTHS[Number(e.key) - 1] });
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && (panelOpen || dockOpen)) {
      togglePanel(false);
      toggleDock(false);
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target) || panel.contains(e.target)) return;
    if (help.classList.contains('wr-show')) {
      if (e.key === 'Escape' || e.key === '?') { help.classList.remove('wr-show'); e.preventDefault(); }
      return;
    }
    if (e.key === '?') { help.classList.add('wr-show'); e.preventDefault(); return; }
    if (!isReader()) return;

    let handled = true;
    switch (e.key) {
      case ' ': page(e.shiftKey ? -1 : 1); break;
      case 'PageDown': case 'j': case 'J': page(1); break;
      case 'PageUp': case 'k': case 'K': page(-1); break;
      case 'f': case 'F': setPref({ immersive: !prefs.immersive }); break;
      case 'a': case 'A': autoScroll(!autoRAF); break;
      case '+': case '=':
        if (!autoRAF) { handled = false; break; }
        setPref({ scrollSpeed: Math.min(400, speed + 10) }); toast(`自动滚动：${speed} px/s`); break;
      case '-': case '_':
        if (!autoRAF) { handled = false; break; }
        setPref({ scrollSpeed: Math.max(10, speed - 10) }); toast(`自动滚动：${speed} px/s`); break;
      case 'Escape':
        if (autoRAF) autoScroll(false); else handled = false;
        break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---------- 链接：站内留在窗口，站外交给系统浏览器 ----------
  const route = (href) => {
    let u;
    try { u = new URL(href, location.href); } catch (_) { return false; }
    if (u.origin === location.origin) { location.assign(u.href); return true; }
    if (/^https?:$/.test(u.protocol)) { post('open', u.href); return true; }
    return false;
  };
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element && e.target.closest('a[href]');
    if (!a) return;
    const external = new URL(a.href, location.href).origin !== location.origin;
    if ((a.target === '_blank' || external) && route(a.href)) e.preventDefault();
  }, true);
  const nativeOpen = window.open;
  window.open = function (href, ...rest) {
    if (href && route(String(href))) return null;
    return nativeOpen.call(window, href, ...rest);
  };

  // ---------- 未登录时直接弹出扫码登录 ----------
  let loginShown = false;
  const ensureLogin = () => {
    if (loginShown || isReader()) return;
    const btn = $(SEL.loginButton);
    if (!btn) return;
    loginShown = true;
    // 未登录时官方会默认展开搜索层，先收起再弹登录框。
    document.body.classList.remove('body_search_show');
    const close = $(SEL.searchClose);
    if (close) close.click();
    btn.click();
  };

  // ---------- 路由与标题 ----------
  let lastPath = '';
  let lastTitle = null;
  const onRoute = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      fonts = [];
      if (autoRAF && !isReader()) autoScroll(false);
      // 记下当前书，Go 侧下次启动直接打开。
      if (isReader()) post('last', location.href);
      render();
      if (isReader()) relayout();
    }
    const title = document.title.replace(/\s*[-|–]\s*微信读书.*$/, '').trim();
    if (title !== lastTitle) {
      lastTitle = title;
      barTitle.textContent = isReader() ? title : '微信读书';
      post('title', isReader() ? title : '');
    }
  };
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      queueMicrotask(onRoute);
      return r;
    };
  }
  window.addEventListener('popstate', onRoute);

  // 官方是 SPA，节点和标题会异步出现，节流观察。
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      mount();
      onRoute();
      ensureLogin();
      root.classList.toggle('wr-horizontal', isReader() && isHorizontal());
      syncDark();
    });
  }).observe(root, { childList: true, subtree: true });

  window.__wr = { apply, autoScroll, toast, page, panel: () => togglePanel() };
  mount();
  onRoute();
  render();
  // 让 Go 侧的 ExecJS 开始投递；随后请求最新偏好。
  bridge('wails:runtime:ready');
  post('ready');
})();
