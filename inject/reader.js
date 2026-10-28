// 微信读书阅读增强脚本。由 Go 侧以 document-start 注入，此时只有 <html>，head、body 都还没有。
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
    // 顶栏整体隐藏了，“加入书架”按钮从这里代点。
    addToShelf: '.readerTopBar_addToShelf',
    fontPanelMask: '.reader-font-control-panel-mask',
    fontTrack: '.reader_font_control_slider_track',
    fontDots: '.reader_font_control_slider_track_level_dot',
    fontItems: '.font-panel-content-fonts-item',
    // 官方排版引擎从这个容器里的 <style> 读取段落样式，再画到 canvas 上。
    engineStyleHost: '.renderTargetContainer',
  };
  const READER_PATH = /^\/web\/reader\//;

  const prefs = Object.assign(
    {
      theme: 'auto', width: 'medium', tint: 'none', immersive: true, restoreLast: true, scrollSpeed: 40,
      spacing: 'standard', trimTop: true,
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
  // 正文画出来之前页面本来就矮，不能据此判成左右翻页，否则首屏会按错误宽度排一次版。
  const isHorizontal = () => !!$(SEL.horizontal)
    || (!!$(`${SEL.engineStyleHost} canvas`) && scroller().scrollHeight <= window.innerHeight + 4);

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
    add: svg('<path d="M12 5v14M5 12h14"/>'),
    stealth: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10l3 2.5L7 15M12 15h5"/>'),
  };

  // ---------- 注入节点 ----------
  const style = el('style', { id: 'wr-style' });
  style.textContent = window.__WR_CSS__ || '';
  const tint = el('div', { id: 'wr-tint' });
  const progress = el('div', { id: 'wr-progress' });
  // 上下边缘渐隐，正文滚到标题条下面不会和标题文字叠在一起。
  const fadeTop = el('div', { id: 'wr-fade-top', 'aria-hidden': 'true' });
  const fadeBottom = el('div', { id: 'wr-fade-bottom', 'aria-hidden': 'true' });
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
    { id: 'addShelf', label: '加入书架', icon: ICON.add, reader: true },
    { id: 'catalog', label: '目录', icon: ICON.catalog, reader: true },
    { id: 'note', label: '笔记', icon: ICON.note, reader: true },
    { id: 'ai', label: 'AI 问书', icon: ICON.ai, reader: true },
    { id: 'column', label: '单栏 / 双栏', icon: ICON.column, reader: true },
    { id: 'theme', label: '日间 / 夜间', icon: ICON.theme },
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
  const addShelfButton = () => {
    const b = $(SEL.addToShelf);
    return b && /加入书架/.test(b.textContent || '') ? b : null;
  };
  const DOCK_TARGET = {
    note: () => $(SEL.note) || officialButton(/笔记/),
    ai: () => officialButton(/问书/),
    column: () => officialButton(/栏/),
    // 阅读页用官方主题按钮；其他页面切换窗口外观，不需要官方按钮。
    theme: () => (isReader() ? $(SEL.theme) : document.body),
  };
  const syncDock = () => {
    // 没加入书架时主按钮上亮一个小点，提示展开后可以加入。
    const canAdd = isReader() && !!addShelfButton();
    if (root.classList.contains('wr-can-add') !== canAdd) root.classList.toggle('wr-can-add', canAdd);
    dock.querySelectorAll('[data-dock]').forEach((b) => {
      const id = b.dataset.dock;
      let show = !b.hasAttribute('data-reader') || isReader();
      if (id === 'addShelf') show = canAdd;
      else if (show && DOCK_TARGET[id]) {
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
  // x、y 是页面坐标，按缩放换算成窗口坐标。
  // 代点期间 wr-tapping 让官方按钮可点、设置浮窗和 Dock 让开，否则原生点击会落在它们身上。
  let tapTimer;
  const tapAt = (x, y) => {
    // 标题条上的点击会被当成拖动窗口。
    if (y < 30 || x < 0 || x > window.innerWidth || y > window.innerHeight) return;
    root.classList.add('wr-tapping');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => root.classList.remove('wr-tapping', 'wr-pull'), 400);
    const scale = window.outerWidth / window.innerWidth || 1;
    post('tap', JSON.stringify({ X: x * scale, Y: y * scale }));
  };
  const tapCenter = (n) => {
    const r = n.getBoundingClientRect();
    tapAt(r.left + r.width / 2, r.top + r.height / 2);
  };
  const tapOfficial = (btn, name) => {
    if (!btn) { toast(`当前页面没有${name}`); return false; }
    // 窗口较窄时官方把侧栏按钮排在窗口外面，原生点击点不到，临时把侧栏挪进窗口。
    const r = btn.getBoundingClientRect();
    if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) root.classList.add('wr-pull');
    tapCenter(btn);
    return true;
  };
  const runDock = (id) => {
    toggleDock(false);
    switch (id) {
      case 'addShelf':
        if (clickOfficial(addShelfButton(), '加入书架按钮')) {
          toast('已加入书架');
          setTimeout(syncDock, 600);
        }
        break;
      case 'catalog': clickOfficial($(SEL.catalog), '目录'); break;
      case 'note': tapOfficial($(SEL.note) || officialButton(/笔记/), '笔记'); break;
      case 'ai': tapOfficial(officialButton(/问书/), 'AI 问书'); break;
      case 'column':
        smooth(() => { if (tapOfficial(officialButton(/栏/), '双栏切换')) setTimeout(relayout, 450); }, 600);
        break;
      case 'theme':
        if (isReader()) smooth(() => { tapOfficial($(SEL.theme), '主题切换'); setTimeout(render, 450); }, 500);
        else toggleAppearance();
        break;
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
      <h3>间距</h3>
      ${seg('spacing', [['compact', '紧凑'], ['standard', '标准'], ['loose', '宽松']])}
      ${toggle('trimTop', '收紧章首空白')}
    </section>
    <section data-reader>
      <h3>字体</h3>
      <div class="wr-fonts" data-out="fonts"><p class="wr-hint">读取中…</p></div>
    </section>
    <section>
      <h3>书架等页面 <em>阅读页用官方主题</em></h3>
      ${seg('theme', [['auto', '跟随系统'], ['light', '日间'], ['dark', '夜间']])}
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

  // 样式越早插入越好，没有 head 就先挂在 <html> 下；浮层节点等 body 出现再挂。
  const mount = () => {
    if (!style.isConnected) (document.head || root).appendChild(style);
    if (!document.body) return false;
    for (const n of [fadeTop, fadeBottom, tint, progress, bar, dock, panel, toastEl, help]) {
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
  // 官方阅读页正文栏和两侧底色不同，看起来像一块板子。取正文栏的颜色铺满整页。
  const syncPageColor = () => {
    const col = isReader() && $(SEL.content);
    const c = col && getComputedStyle(col).backgroundColor;
    if (c && !/rgba\(0, 0, 0, 0\)/.test(c)) root.style.setProperty('--wr-page', c);
    else root.style.removeProperty('--wr-page');
  };

  let lastBg = '';
  const syncDark = () => {
    if (prefs.stealth || !document.body) return;
    syncPageColor();
    // 反色时页面实际是浅色，浮层按浅色配，随滤镜一起变暗。
    root.classList.toggle('wr-dark', pageIsDark());
    // 把页面底色告诉 Go，拉伸窗口时新露出的区域就不会闪白。
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!m || (m.length === 4 && Number(m[3]) < 0.5)) return;
    let [R, G, B] = m.map(Number);
    if (root.classList.contains('wr-night')) [R, G, B] = [R, G, B].map((v) => Math.round(255 - v * 0.9));
    const bg = `${R},${G},${B}`;
    if (bg === lastBg) return;
    lastBg = bg;
    post('bg', JSON.stringify({ R, G, B }));
  };

  const render = () => {
    const reader = isReader();
    root.classList.toggle('wr-reader', reader);
    root.classList.toggle('wr-horizontal', reader && isHorizontal());
    root.classList.toggle('wr-immersive', !!prefs.immersive);
    root.classList.toggle('wr-stealth', !!prefs.stealth);
    root.classList.toggle('wr-night', isNight());
    root.classList.toggle('wr-trim', !!prefs.trimTop);
    syncDark();
    for (const c of [...root.classList]) {
      if (/^wr-(w|tint|fg)-/.test(c)) root.classList.remove(c);
    }
    root.classList.add(`wr-w-${prefs.width}`, `wr-tint-${prefs.tint}`, `wr-fg-${prefs.stealthColor}`);
    if (reader) syncTypo();
    root.style.setProperty('--wr-alpha', String(Math.max(5, Math.min(100, prefs.stealthAlpha)) / 100));
    syncDock();
    updateProgress();
  };

  // 正文 canvas 按容器宽度排版，改宽度后让官方脚本重排。
  const relayout = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

  // 外观类切换用 View Transition 做淡入淡出：先拍旧画面，等 wait 毫秒让官方重排完，再过渡到新画面。
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let transitioning = false;
  const smooth = (fn, wait = 0) => {
    if (!document.startViewTransition || reduced.matches || transitioning || document.hidden) { fn(); return; }
    transitioning = true;
    const t = document.startViewTransition(() => new Promise((resolve) => {
      Promise.resolve(fn()).finally(() => setTimeout(resolve, wait));
    }));
    t.finished.finally(() => { transitioning = false; });
  };
  // 改排版要等官方引擎重排完，用 View Transition 会让画面静止一两秒。
  // 这类切换改为：设置立即生效，正文先变淡，重排完再恢复，期间界面照常响应。
  let busyCount = 0;
  let layoutJob = null; // 正在进行的强制重排
  const busy = async (fn, max = 900) => {
    if (!isReader()) { await fn(); return; }
    busyCount++;
    root.classList.add('wr-busy');
    const h0 = scroller().scrollHeight;
    try {
      // fn 返回 false 表示排版不会变，不用等。
      // 左右翻页时页面高度不随排版变化，没法判断重排完成，只短暂等一下。
      if ((await fn()) !== false) await (layoutJob || settle(h0, isHorizontal() ? 300 : max));
    } finally {
      if (--busyCount === 0) root.classList.remove('wr-busy');
    }
  };
  // 等正文总高度变化并稳定下来；max 毫秒内没变就放弃。返回是否变化过。
  const settle = (h0, max) => new Promise((resolve) => {
    const s = scroller();
    const t0 = performance.now();
    let last = h0;
    let stable = 0;
    const tick = () => {
      const h = s.scrollHeight;
      stable = h !== h0 && h === last ? stable + 1 : 0;
      last = h;
      if (stable >= 2) { resolve(true); return; }
      if (performance.now() - t0 > max) { resolve(h !== h0); return; }
      setTimeout(tick, 80);
    };
    setTimeout(tick, 80);
  });

  let booted = false;
  const LAYOUT_KEYS = ['spacing', 'trimTop', 'width'];
  const VISUAL = ['tint', 'stealth', 'stealthColor', 'theme'];

  let speed = prefs.scrollSpeed || 40;
  const apply = (next) => {
    const changed = Object.keys(next || {}).filter((k) => prefs[k] !== next[k]);
    if (booted && changed.some((k) => LAYOUT_KEYS.includes(k))) {
      const col = $(SEL.content);
      const w0 = col && col.getBoundingClientRect().width;
      busy(() => {
        applyNow(next, changed);
        // 窗口太窄时换版心宽度，实际宽度可能没变，不必等重排。
        if (!changed.some((k) => k !== 'width') && col && col.getBoundingClientRect().width === w0) return false;
      }, 700);
      return;
    }
    if (booted && changed.some((k) => VISUAL.includes(k))) {
      smooth(() => applyNow(next, changed), changed.includes('theme') ? 200 : 0);
      return;
    }
    applyNow(next, changed);
  };
  const applyNow = (next, changed) => {
    Object.assign(prefs, next);
    speed = prefs.scrollSpeed || speed;
    render();
    if (panelOpen) syncPanel();
    if (changed.includes('width')) { relayout(); toast(`版心：${WIDTH_LABEL[prefs.width] || prefs.width}`); }
    if (changed.includes('tint')) toast(`底色：${TINT_LABEL[prefs.tint] || prefs.tint}`);
    if (changed.includes('immersive')) toast(prefs.immersive ? '沉浸模式：开' : '沉浸模式：关');
    if (changed.includes('stealth')) toast(prefs.stealth ? '伪装模式：开' : '伪装模式：关');
    if (changed.includes('theme')) toast(`外观：${THEME_LABEL[prefs.theme] || prefs.theme}`);
  };

  // 非阅读页的深浅色由窗口外观驱动（官方 CSS 用 prefers-color-scheme）。
  // 官方非阅读页没有像样的深色版，夜间模式用反色滤镜实现，图片再反回来。
  const THEME_LABEL = { auto: '跟随系统', light: '日间', dark: '夜间' };
  let sysDark = false;
  const isNight = () => !isReader() && !prefs.stealth && (prefs.theme === 'dark' || (prefs.theme === 'auto' && sysDark));
  const toggleAppearance = () => setPref({ theme: isNight() ? 'light' : 'dark' });
  const setSystemDark = (v) => { sysDark = !!v; render(); };

  // 偏好改动：本地生效 + 回传 Go 落盘。
  // apply 可能在过渡回调里延后执行，所以先合并再回传。
  const setPref = (patch) => {
    post('prefs', JSON.stringify({ ...prefs, ...patch }));
    apply(patch);
  };

  // 用 transform 缩放，不触发布局；滚动事件按帧合并。
  let progressRAF = 0;
  const updateProgress = () => {
    if (progressRAF) return;
    progressRAF = requestAnimationFrame(() => {
      progressRAF = 0;
      const s = scroller();
      const max = s.scrollHeight - window.innerHeight;
      progress.style.transform = `scaleX(${max > 0 ? Math.min(1, s.scrollTop / max) : 0})`;
    });
  };

  // ---------- 自定义排版 ----------
  // 正文由官方引擎画在 canvas 上，但它按 .renderTargetContainer 里 <style> 的规则计算行高、段距。
  // 往这个 <style> 末尾追加规则，再让引擎重新排一次，canvas 上的排版就会跟着变。
  const TYPO_MARK = '/*wr-typo*/';
  // 三档间距，单位 em（相对正文字号）。缩进、对齐保留书本身的设定。
  // 行高：中文正文常见 1.5–2 倍；官方网页版约 2.0，偏松。
  // 段距：中文书多靠首行缩进分段，段距只作辅助，取半行到一行。
  const SPACING = {
    compact: { lh: 1.6, para: 0.3, ls: 0 },
    standard: { lh: 1.8, para: 0.6, ls: 0.02 },
    loose: { lh: 2.1, para: 1, ls: 0.04 },
  };
  const typoCSS = () => {
    const v = SPACING[prefs.spacing];
    if (!v) return '';
    // 引擎自己解析这段 CSS，不认 :is() 之类的新语法，只用最基础的选择器列表。
    const p = ['.content', 'p', '.bodyContent', '.text'].map((c) => `.readerChapterContent ${c}`).join(',');
    return `${p}{line-height:${v.lh}em !important;margin-top:0 !important;margin-bottom:${v.para}em !important;letter-spacing:${v.ls}em !important}`;
  };
  // 官方没有对外的重排接口，容器宽度变化会触发重排。
  // 上下滚动时切换 wr-nudge，让正文栏在“版心宽度”和“版心宽度 − 1px”之间交替，一次 resize 就够；
  // 以前是改 1px 再改回，引擎对 resize 有防抖，两次之间得等 600ms。
  // 排版改了总高度必然变化，高度没变就再推一次。
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const forceRelayout = () => {
    const job = (async () => {
      await wait(30); // 合并同一轮里的多次调用
      if (layoutJob !== job) return;
      const col = $(SEL.content);
      if (!col) return;
      const s = scroller();
      const h0 = s.scrollHeight;
      const y = s.scrollTop / Math.max(1, h0);
      if (isHorizontal()) {
        // 左右翻页不用版心宽度规则，只能临时改内联宽度再改回。
        col.style.setProperty('width', `${col.getBoundingClientRect().width - 1}px`, 'important');
        window.dispatchEvent(new Event('resize'));
        await wait(600);
        col.style.removeProperty('width');
        window.dispatchEvent(new Event('resize'));
        await wait(600);
        return;
      }
      const nudge = () => { root.classList.toggle('wr-nudge'); window.dispatchEvent(new Event('resize')); };
      nudge();
      let changed = await settle(h0, 900);
      if (!changed && layoutJob === job) { nudge(); changed = await settle(h0, 900); }
      // 行高变了总高度也变，按比例回到原来读到的位置。
      if (changed) s.scrollTop = y * s.scrollHeight;
    })();
    layoutJob = job;
    job.finally(() => { if (layoutJob === job) layoutJob = null; });
    return job;
  };
  // 有的书在样式表里给章首插图、标题写了很大的上边距（如 margin: 30% auto），
  // 把章首推到屏幕中间。逐条解析书的样式，把过大的上边距压到 1em。
  const TOO_BIG = { '%': 8, em: 2.5, rem: 2.5, px: 48 };
  const firstLen = (v) => {
    const m = String(v).trim().match(/^(-?[\d.]+)(%|em|rem|px)?/);
    return m ? { n: parseFloat(m[1]), u: m[2] || 'px' } : null;
  };
  const isBig = (len) => len && len.n > (TOO_BIG[len.u] ?? Infinity);
  // 引擎不一定按层叠规则用 margin-top 覆盖 margin 简写，所以简写就整条重写，只改第一个值。
  const LEN = /-?[\d.]+(?:%|em|rem|px)?|auto/g;
  const trimCSS = (base) => {
    if (!prefs.trimTop) return '';
    const out = [];
    for (const [, sel, body] of base.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (sel.includes('@')) continue;
      const fix = [];
      for (const prop of ['margin', 'padding']) {
        const small = prop === 'margin' ? '1em' : '0';
        const top = body.match(new RegExp(`(?:^|;)\\s*${prop}-top\\s*:\\s*([^;!]+)`));
        if (top && isBig(firstLen(top[1]))) fix.push(`${prop}-top:${small} !important`);
        const short = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;!]+)`));
        const parts = short ? short[1].match(LEN) || [] : [];
        if (parts.length && isBig(firstLen(parts[0]))) {
          // 简写只有一两个值时，第一个值同时管上下或四边，补全成四值再改上边。
          const [t, r = t, b = t, l = r] = parts;
          fix.push(`${prop}:${small} ${r} ${b} ${l} !important`);
        }
      }
      if (fix.length) out.push(`${sel.trim()}{${fix.join(';')}}`);
    }
    return out.join('');
  };

  let appliedTypo = null;
  const syncTypo = () => {
    const host = $(SEL.engineStyleHost);
    const st = host && host.querySelector(':scope > style');
    if (!st) return;
    const text = st.textContent;
    const i = text.indexOf(TYPO_MARK);
    const base = i < 0 ? text : text.slice(0, i);
    const extra = typoCSS() + trimCSS(base);
    const want = extra ? TYPO_MARK + extra : '';
    if (text === base + want) return;
    st.textContent = base + want;
    // 官方换章时会重写这个 <style>，这时它自己会排版，不用再触发一次。
    if (appliedTypo !== null && appliedTypo !== want) forceRelayout();
    else if (appliedTypo === null && want) forceRelayout();
    appliedTypo = want;
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
    if (t.dataset.font) { const k = Number(t.dataset.font); busy(() => pickFont(k)); return; }
    if (t.dataset.act === 'font-') busy(() => stepFont(-1));
    if (t.dataset.act === 'font+') busy(() => stepFont(1));
  });
  panel.addEventListener('change', (e) => {
    const n = e.target;
    if (!(n instanceof HTMLInputElement) || !n.dataset.key) return;
    setPref({ [n.dataset.key]: n.type === 'checkbox' ? n.checked : parseFloat(n.value) });
  });
  panel.addEventListener('input', (e) => {
    const n = e.target;
    if (!(n instanceof HTMLInputElement)) return;
    // 拖动时实时预览，松手再落盘。
    if (n.dataset.key === 'stealthAlpha') apply({ stealthAlpha: Number(n.value) });
  });
  document.addEventListener('mousedown', (e) => {
    if (root.classList.contains('wr-tapping')) return; // 代点的原生点击不算点在外面
    if (panelOpen && !panel.contains(e.target) && !dock.contains(e.target)) togglePanel(false);
    if (dockOpen && !dock.contains(e.target)) toggleDock(false);
  }, true);

  // ---------- 代理官方字号 / 字体面板 ----------
  // 官方面板藏起来打开，操作完再关掉，用户只看到正文变化。
  const fontPanelShown = () => {
    const dot = $(SEL.fontDots);
    return !!dot && dot.getBoundingClientRect().width > 0;
  };
  const waitFor = (cond, max) => new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (cond()) resolve(true);
      else if (performance.now() - t0 > max) resolve(false);
      else requestAnimationFrame(tick);
    };
    tick();
  });
  // 左右翻页时官方按钮、滑杆、遮罩都不响应合成点击，先合成、不行再投递原生点击。
  // 打开设置时会读字体列表，和紧接着的字号操作排队执行，避免同时开关官方面板。
  let fontQueue = Promise.resolve();
  const withFontPanel = (fn) => {
    const job = fontQueue.then(() => runFontPanel(fn));
    fontQueue = job.catch(() => {});
    return job;
  };
  const runFontPanel = async (fn) => {
    const btn = $(SEL.fontButton);
    if (!btn) { toast('请在阅读页使用'); return false; }
    root.classList.add('wr-proxy');
    try {
      if (!fontPanelShown()) {
        btn.click();
        if (!(await waitFor(fontPanelShown, 150)) && btn.getBoundingClientRect().width > 0) tapOfficial(btn, '字号按钮');
        // 面板排好版就操作，不再固定等 200ms。
        if (!(await waitFor(fontPanelShown, 800))) { toast('没能打开官方字体面板'); return false; }
      }
      fn();
      await new Promise((r) => setTimeout(r, 250));
      const mask = $(SEL.fontPanelMask);
      if (mask) mask.click();
      if (!(await waitFor(() => !fontPanelShown(), 150))) {
        // 合成点击关不掉时，在面板外的遮罩上点一次真的。窄窗口里面板会盖住字号按钮，不能点按钮的位置。
        root.classList.add('wr-tapping'); // 先让我们的浮层让开，再找落点
        const W = window.innerWidth;
        const H = window.innerHeight;
        const spot = [[16, H / 2], [W - 16, H / 2], [W / 2, H - 16], [16, H - 16]].find(([x, y]) => {
          const n = document.elementFromPoint(x, y);
          return n && !n.closest('.font-panel-content') && !bar.contains(n);
        });
        if (spot) tapAt(...spot);
        await waitFor(() => !fontPanelShown(), 400);
      }
      return true;
    } finally {
      root.classList.remove('wr-proxy');
    }
  };
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
    // 左右翻页时滑杆不认合成点击，同一位置再投递一次原生点击；点同一档位两次结果不变。
    tapAt(r.left + r.width / 2, tr.top + tr.height / 2);
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
    const n = fonts[k] && items[fonts[k].i];
    if (n) { n.click(); tapCenter(n); }
  }).then(() => {
    fonts.forEach((f, j) => { f.selected = j === k; });
    renderFonts();
    if (fonts[k]) toast(`字体：${fonts[k].name}`);
  });

  // ---------- 沉浸：空闲时隐藏光标与浮层 ----------
  // mousemove 每帧都会触发；只在状态真正变化时改 class，否则整页每帧都要重算样式。
  let uiTimer;
  let idleTimer;
  let uiOn = false;
  let idle = false;
  let lastMove = 0;
  const showUI = () => {
    const now = performance.now();
    if (uiOn && !idle && now - lastMove < 250) return;
    lastMove = now;
    if (!uiOn) { uiOn = true; root.classList.add('wr-ui'); }
    if (idle) { idle = false; root.classList.remove('wr-idle'); }
    clearTimeout(uiTimer);
    clearTimeout(idleTimer);
    uiTimer = setTimeout(() => { uiOn = false; root.classList.remove('wr-ui'); }, 2000);
    idleTimer = setTimeout(() => { idle = true; root.classList.add('wr-idle'); }, 2500);
  };
  document.addEventListener('mousemove', showUI, { passive: true });

  // ---------- 翻页 ----------
  const findNextChapter = () => {
    const btn = $(SEL.nextChapter);
    // 长章节会分段加载，末尾是“下一页”，读完整章才是“下一章”。
    if (btn && /下一[章页]/.test(btn.textContent || '')) return btn;
    return [...document.querySelectorAll('button, a, [role=button]')]
      .find((n) => /^下一[章页]$/.test((n.textContent || '').trim())) || null;
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
      if (next) { const t = next.textContent.trim(); next.click(); toast(t); } else toast('已到末尾');
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
      appliedTypo = null;
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
  // 读取计算样式、页面高度会强制重算，放到较慢的一档里做。
  let pending = false;
  let heavyTimer = 0;
  const heavy = () => {
    heavyTimer = 0;
    root.classList.toggle('wr-horizontal', isReader() && isHorizontal());
    syncDark();
    syncDock();
  };
  new MutationObserver(() => {
    if (!heavyTimer) heavyTimer = setTimeout(heavy, 250);
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      mount();
      onRoute();
      ensureLogin();
      if (isReader()) syncTypo();
    });
  }).observe(root, { childList: true, subtree: true });

  window.__wr = { apply, autoScroll, toast, page, setSystemDark, panel: () => togglePanel() };
  mount();
  onRoute();
  render();
  // 首次套用偏好不做过渡，之后的切换才淡入淡出。
  setTimeout(() => { booted = true; }, 1500);
  // 让 Go 侧的 ExecJS 开始投递；随后请求最新偏好。
  bridge('wails:runtime:ready');
  post('ready');
})();
