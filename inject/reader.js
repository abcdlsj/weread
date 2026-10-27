// 微信读书阅读增强脚本。由 Go 侧在每次导航完成后注入，
// 依赖 window.__WR_PREFS__ 与 window.__WR_CSS__ 已预先赋值。
(() => {
  if (window.__wr) return;

  // 官方 DOM 一改就在这里修。
  const SEL = {
    topBar: '.readerTopBar',
    controls: '.readerControls',
    content: '.app_content',
    horizontal: '.wr_horizontalReader',
    nextChapter: '.readerFooter_button',
    loginButton: '.navBar_link_Login',
    searchClose: '.search_close_button',
    fontButton: '.fontSizeButton',
    fontPanelMask: '.reader-font-control-panel-mask',
    fontTrack: '.reader_font_control_slider_track',
    fontDots: '.reader_font_control_slider_track_level_dot',
    fontItems: '.font-panel-content-fonts-item',
    themeButton: '.readerControls_item.white, .readerControls_item.dark',
  };
  const READER_PATH = /^\/web\/reader\//;
  const SHELF_PATH = /^\/web\/shelf/;

  const prefs = Object.assign(
    {
      theme: 'auto', width: 'medium', tint: 'none', immersive: true, restoreLast: true, scrollSpeed: 40,
      stealth: false, stealthAlpha: 70, stealthColor: 'gray',
    },
    window.__WR_PREFS__ || {},
  );
  const root = document.documentElement;
  const $ = (s) => document.querySelector(s);

  const post = (type, value = '') => {
    try {
      window.webkit.messageHandlers.external.postMessage(JSON.stringify({ type, value: String(value) }));
    } catch (_) { /* 非 wails 环境 */ }
  };

  // ---------- 启动时回到上次阅读 ----------
  const LAST_KEY = 'wr:last';
  if (!sessionStorage.getItem('wr:booted')) {
    sessionStorage.setItem('wr:booted', '1');
    const last = localStorage.getItem(LAST_KEY);
    if (prefs.restoreLast && last && SHELF_PATH.test(location.pathname)) {
      location.replace(last);
      return;
    }
  }

  // ---------- 注入节点 ----------
  const style = document.createElement('style');
  style.id = 'wr-style';
  style.textContent = window.__WR_CSS__ || '';
  const tint = Object.assign(document.createElement('div'), { id: 'wr-tint' });
  const progress = Object.assign(document.createElement('div'), { id: 'wr-progress' });
  const toastEl = Object.assign(document.createElement('div'), { id: 'wr-toast' });
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  const help = Object.assign(document.createElement('div'), { id: 'wr-help' });
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', '快捷键');
  help.innerHTML = `<div><h2>快捷键</h2><table>
    <tr><td><kbd>空格</kbd> <kbd>J</kbd> <kbd>PgDn</kbd></td><td>下一屏，章末自动进入下一章</td></tr>
    <tr><td><kbd>⇧ 空格</kbd> <kbd>K</kbd> <kbd>PgUp</kbd></td><td>上一屏</td></tr>
    <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>官方翻页 / 切章</td></tr>
    <tr><td><kbd>F</kbd> 或 <kbd>⌘E</kbd></td><td>沉浸模式</td></tr>
    <tr><td><kbd>A</kbd> 或 <kbd>⌘⇧A</kbd></td><td>自动滚动，<kbd>+</kbd> <kbd>-</kbd> 调速，<kbd>Esc</kbd> 停止</td></tr>
    <tr><td><kbd>⌘1</kbd> … <kbd>⌘4</kbd></td><td>版心宽度</td></tr>
    <tr><td><kbd>⌘⇧M</kbd></td><td>伪装模式：半透明 + 终端配色</td></tr>
    <tr><td><kbd>⌃⌥空格</kbd></td><td>全局隐藏 / 显示窗口</td></tr>
    <tr><td><kbd>⌘L</kbd></td><td>回到书架</td></tr>
    <tr><td><kbd>⌥⌘T</kbd></td><td>窗口置顶</td></tr>
    <tr><td><kbd>⌘,</kbd></td><td>阅读设置浮窗（字号、字体、底色、伪装）</td></tr>
    <tr><td><kbd>?</kbd></td><td>显示 / 关闭本面板</td></tr>
  </table></div>`;
  help.addEventListener('click', (e) => { if (e.target === help) help.classList.remove('wr-show'); });

  // ---------- 设置浮窗 ----------
  const fab = Object.assign(document.createElement('button'), { id: 'wr-fab', textContent: 'Aa', title: '阅读设置 (⌘,)' });
  fab.setAttribute('aria-label', '阅读设置');
  const panel = document.createElement('aside');
  panel.id = 'wr-panel';
  panel.setAttribute('aria-label', '阅读设置');
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;
  const seg = (key, opts) =>
    `<div class="wr-seg" role="group" data-key="${key}">${opts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('')}</div>`;
  panel.innerHTML = `
    <header><b>阅读设置</b><button type="button" class="wr-x" aria-label="关闭">×</button></header>
    <section data-reader>
      <h3>字号</h3>
      <div class="wr-step"><button type="button" data-act="font-" aria-label="减小字号">A−</button><span data-out="fontSize">–</span><button type="button" data-act="font+" aria-label="增大字号">A+</button></div>
    </section>
    <section data-reader>
      <h3>字体</h3>
      <div class="wr-fonts" data-out="fonts"><p class="wr-hint">打开后加载官方字体列表</p></div>
    </section>
    <section>
      <h3>版心宽度 <span class="wr-hint">⌘1–⌘4</span></h3>
      ${seg('width', [['narrow', '窄'], ['medium', '适中'], ['wide', '宽'], ['full', '铺满']])}
    </section>
    <section>
      <h3>纸张底色</h3>
      <div class="wr-swatches" role="group" data-key="tint">
        <button type="button" data-v="none" title="原色" aria-label="原色" style="background:#fff"></button>
        <button type="button" data-v="paper" title="米黄纸" aria-label="米黄纸" style="background:#f3e9d2"></button>
        <button type="button" data-v="green" title="护眼绿" aria-label="护眼绿" style="background:#d6ead8"></button>
        <button type="button" data-v="dim" title="夜间暗化" aria-label="夜间暗化" style="background:#555"></button>
      </div>
    </section>
    <section data-reader>
      <h3>官方主题</h3>
      <button type="button" class="wr-btn" data-act="theme">切换深色 / 浅色</button>
    </section>
    <section>
      <h3>阅读</h3>
      <label class="wr-row"><span>沉浸模式 <span class="wr-hint">F</span></span><input type="checkbox" data-key="immersive"></label>
      <label class="wr-row"><span>启动时回到上次阅读</span><input type="checkbox" data-key="restoreLast"></label>
      <label class="wr-row"><span>自动滚动速度</span><input type="range" min="10" max="200" step="5" data-key="scrollSpeed"></label>
    </section>
    <section>
      <h3>伪装模式 <span class="wr-hint">⌘⇧M</span></h3>
      <label class="wr-row"><span>开启</span><input type="checkbox" data-key="stealth"></label>
      <label class="wr-row"><span>背景不透明度 <span data-out="alpha"></span></span><input type="range" min="0" max="100" step="5" data-key="stealthAlpha"></label>
      <div class="wr-row"><span>文字颜色</span></div>
      ${seg('stealthColor', [['gray', '终端灰'], ['green', '绿色'], ['amber', '琥珀']])}
      <p class="wr-hint">⌃⌥空格 全局隐藏 / 显示窗口</p>
    </section>`;

  const syncPanel = () => {
    panel.querySelectorAll('[data-key]').forEach((el) => {
      const v = prefs[el.dataset.key];
      if (el.matches('.wr-seg, .wr-swatches')) {
        el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      } else if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'range') el.value = v;
    });
    panel.querySelector('[data-out=alpha]').textContent = `${prefs.stealthAlpha}%`;
    panel.querySelectorAll('[data-reader]').forEach((el) => { el.hidden = !isReader(); });
    const level = currentFontLevel();
    panel.querySelector('[data-out=fontSize]').textContent = level < 1 ? '–' : `${level} / ${fontDots().length || 7}`;
  };

  // 偏好改动：本地生效 + 回传 Go 落盘。
  const setPref = (patch) => {
    apply(patch);
    post('prefs', JSON.stringify(prefs));
    syncPanel();
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
      panel.querySelector('button, input').focus({ preventScroll: true });
    }
  };
  fab.addEventListener('click', () => togglePanel(true));
  panel.addEventListener('click', (e) => {
    const t = e.target instanceof Element && e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('wr-x')) return togglePanel(false);
    const group = t.closest('[data-key]');
    if (group && t.dataset.v) return setPref({ [group.dataset.key]: t.dataset.v });
    if (t.dataset.font) return pickFont(Number(t.dataset.font));
    if (t.dataset.act === 'font-') return stepFont(-1);
    if (t.dataset.act === 'font+') return stepFont(1);
    if (t.dataset.act === 'theme') {
      const b = $(SEL.themeButton);
      if (b) b.click(); else toast('当前页面没有主题按钮');
    }
  });
  panel.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.dataset.key) return;
    setPref({ [el.dataset.key]: el.type === 'checkbox' ? el.checked : Number(el.value) });
  });
  panel.addEventListener('input', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.dataset.key === 'stealthAlpha') {
      // 拖动时实时预览，松手再落盘。
      apply({ stealthAlpha: Number(el.value) });
      panel.querySelector('[data-out=alpha]').textContent = `${el.value}%`;
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (panelOpen && !panel.contains(e.target) && e.target !== fab) togglePanel(false);
  }, true);

  // ---------- 代理官方字号 / 字体面板 ----------
  // 官方面板藏起来打开，操作完再关掉，用户只看到正文变化。
  const fontDots = () => document.querySelectorAll(SEL.fontDots);
  const currentFontLevel = () => {
    const m = document.body && document.body.className.match(/wr_reader_font_size_level_(\d+)/);
    return m ? Number(m[1]) : -1;
  };
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
  const clickAt = (el, x, y) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
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

  let fontNames = [];
  const loadFonts = () => {
    if (!isReader() || fontNames.length) return renderFonts();
    withFontPanel(() => {
      fontNames = [...document.querySelectorAll(SEL.fontItems)].map((el) => {
        const name = (el.textContent || '').trim() || el.style.fontFamily.split(',')[0].replace(/["']/g, '').replace(/-min$/, '');
        return { name, family: el.style.fontFamily, selected: el.classList.contains('selected') };
      });
    }).then(renderFonts);
  };
  const renderFonts = () => {
    const box = panel.querySelector('[data-out=fonts]');
    if (!fontNames.length) { box.innerHTML = '<p class="wr-hint">未读到官方字体列表</p>'; return; }
    box.innerHTML = fontNames.map((f, i) =>
      `<button type="button" data-font="${i}" aria-pressed="${f.selected}" style="font-family:${f.family.replace(/"/g, '&quot;')}">${f.name.replace(/</g, '&lt;')}</button>`).join('');
  };
  const pickFont = (i) => withFontPanel(() => {
    const items = document.querySelectorAll(SEL.fontItems);
    if (items[i]) items[i].click();
  }).then(() => {
    fontNames.forEach((f, j) => { f.selected = j === i; });
    renderFonts();
    toast(`字体：${fontNames[i] ? fontNames[i].name : ''}`);
  });

  const mount = () => {
    if (!document.head || !document.body) return false;
    if (!style.isConnected) document.head.appendChild(style);
    for (const el of [tint, progress, toastEl, help, fab, panel]) {
      if (!el.isConnected) document.body.appendChild(el);
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
  const isReader = () => READER_PATH.test(location.pathname);
  const scroller = () => document.scrollingElement || root;
  const isHorizontal = () =>
    !!$(SEL.horizontal) || scroller().scrollHeight <= window.innerHeight + 4;

  const WIDTH_LABEL = { narrow: '窄', medium: '适中', wide: '宽', full: '铺满' };
  const TINT_LABEL = { none: '原色', paper: '米黄纸', green: '护眼绿', dim: '夜间暗化' };

  const render = () => {
    const reader = isReader();
    root.classList.toggle('wr-reader', reader);
    root.classList.toggle('wr-horizontal', reader && isHorizontal());
    root.classList.toggle('wr-immersive', !!prefs.immersive);
    root.classList.toggle('wr-stealth', !!prefs.stealth);
    for (const c of [...root.classList]) {
      if (c.startsWith('wr-w-') || c.startsWith('wr-tint-') || c.startsWith('wr-fg-')) root.classList.remove(c);
    }
    root.classList.add(`wr-w-${prefs.width}`, `wr-tint-${prefs.tint}`, `wr-fg-${prefs.stealthColor}`);
    root.style.setProperty('--wr-alpha', String(Math.max(0, Math.min(100, prefs.stealthAlpha)) / 100));
    updateProgress();
  };

  const relayout = () => {
    // 正文 canvas 按容器宽度排版，改宽度后让官方脚本重排。
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  const apply = (next) => {
    const changed = Object.keys(next || {}).filter((k) => prefs[k] !== next[k]);
    Object.assign(prefs, next);
    if (typeof prefs.scrollSpeed === 'number') speed = prefs.scrollSpeed;
    render();
    if (panelOpen) syncPanel();
    if (changed.includes('width')) {
      relayout();
      toast(`版心：${WIDTH_LABEL[prefs.width] || prefs.width}`);
    }
    if (changed.includes('tint')) toast(`底色：${TINT_LABEL[prefs.tint] || prefs.tint}`);
    if (changed.includes('immersive')) toast(prefs.immersive ? '沉浸模式：开' : '沉浸模式：关');
    if (changed.includes('stealth')) toast(prefs.stealth ? '伪装模式：开' : '伪装模式：关');
    if (changed.includes('stealthAlpha')) toast(`背景不透明度：${prefs.stealthAlpha}%`);
    if (changed.includes('restoreLast')) toast(prefs.restoreLast ? '启动时回到上次阅读' : '启动时打开书架');
  };

  const updateProgress = () => {
    const el = scroller();
    const max = el.scrollHeight - window.innerHeight;
    progress.style.width = max > 0 ? `${Math.min(100, (el.scrollTop / max) * 100)}%` : '0';
  };

  // ---------- 沉浸模式：工具栏与光标 ----------
  let uiTimer;
  let idleTimer;
  const showUI = (ms = 1800) => {
    root.classList.add('wr-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => root.classList.remove('wr-ui'), ms);
  };
  const nearChrome = (e) => {
    if (e.clientY < 72) return true;
    if (e.target instanceof Element && e.target.closest(`${SEL.topBar},${SEL.controls}`)) return true;
    const content = $(SEL.content);
    if (!content) return false;
    const r = content.getBoundingClientRect();
    return e.clientX > r.right + 8;
  };
  document.addEventListener('mousemove', (e) => {
    root.classList.remove('wr-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('wr-idle'), 2500);
    if (nearChrome(e)) showUI();
  }, { passive: true });

  // ---------- 翻页 ----------
  const findNextChapter = () => {
    const btn = $(SEL.nextChapter);
    if (btn && /下一章/.test(btn.textContent || '')) return btn;
    return [...document.querySelectorAll('button, a, div[role=button]')]
      .find((el) => (el.textContent || '').trim() === '下一章') || null;
  };

  const pressArrow = (key) => {
    const code = key === 'ArrowRight' ? 39 : 37;
    const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => code });
    Object.defineProperty(ev, 'which', { get: () => code });
    document.dispatchEvent(ev);
  };

  const atBottom = () => {
    const el = scroller();
    return el.scrollTop + window.innerHeight >= el.scrollHeight - 4;
  };

  const page = (dir) => {
    if (isHorizontal()) {
      pressArrow(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
      return;
    }
    if (dir > 0 && atBottom()) {
      const next = findNextChapter();
      if (next) { next.click(); toast('下一章'); } else toast('已到末尾');
      return;
    }
    // 保留两行重叠，避免翻屏后找不到读到哪了。
    scroller().scrollBy({ top: dir * (window.innerHeight - 64), behavior: 'smooth' });
  };

  // ---------- 自动滚动 ----------
  let autoRAF = 0;
  let autoLast = 0;
  let autoCarry = 0;
  let speed = prefs.scrollSpeed || 40;
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
    if (on && (!isReader() || isHorizontal())) {
      toast('自动滚动仅支持上下滚动模式');
      on = false;
    }
    cancelAnimationFrame(autoRAF);
    autoRAF = 0;
    autoLast = 0;
    if (on) {
      autoRAF = requestAnimationFrame(autoTick);
      toast(`自动滚动：${speed} px/s`);
    } else if (on === false) {
      toast('自动滚动：关');
    }
    post('autoScroll', autoRAF ? 'on' : 'off');
  };

  // ---------- 键盘 ----------
  const editable = (el) =>
    el instanceof Element && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  const WIDTHS = ['narrow', 'medium', 'wide', 'full'];
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-4]$/.test(e.key)) {
      setPref({ width: WIDTHS[Number(e.key) - 1] });
      e.preventDefault();
      return;
    }
    if (panelOpen && e.key === 'Escape') { togglePanel(false); e.preventDefault(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target) || panel.contains(e.target)) return;
    if (help.classList.contains('wr-show')) {
      if (e.key === 'Escape' || e.key === '?') { help.classList.remove('wr-show'); e.preventDefault(); }
      return;
    }
    if (e.key === '?') { help.classList.add('wr-show'); e.preventDefault(); return; }
    if (!isReader()) return;

    let handled = true;
    switch (e.key) {
      case ' ':
        page(e.shiftKey ? -1 : 1); break;
      case 'PageDown': case 'j': case 'J':
        page(1); break;
      case 'PageUp': case 'k': case 'K':
        page(-1); break;
      case 'f': case 'F':
        setPref({ immersive: !prefs.immersive }); break;
      case 'a': case 'A':
        autoScroll(!autoRAF); break;
      case '+': case '=':
        if (!autoRAF) { handled = false; break; }
        speed = Math.min(400, speed + 10); toast(`自动滚动：${speed} px/s`); setPref({ scrollSpeed: speed }); break;
      case '-': case '_':
        if (!autoRAF) { handled = false; break; }
        speed = Math.max(10, speed - 10); toast(`自动滚动：${speed} px/s`); setPref({ scrollSpeed: speed }); break;
      case 'Escape':
        if (autoRAF) autoScroll(false); else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // 手动滚轮或拖动时暂停自动滚动，避免和用户抢。
  window.addEventListener('wheel', () => { if (autoRAF) autoScroll(false); }, { passive: true });
  window.addEventListener('scroll', updateProgress, { passive: true });

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
    if (a.target === '_blank' || external) {
      if (route(a.href)) e.preventDefault();
    }
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
  let lastTitle = '';
  const onRoute = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      fontNames = [];
      if (autoRAF && !isReader()) autoScroll(false);
      if (isReader()) localStorage.setItem(LAST_KEY, location.href);
      render();
      if (isReader()) relayout();
    }
    const title = document.title.replace(/\s*[-|–]\s*微信读书.*$/, '').trim();
    if (title !== lastTitle) {
      lastTitle = title;
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
    });
  }).observe(root, { childList: true, subtree: true });

  // 调试：回传 DOM 摘要，用于维护 SEL。
  const probe = () => {
    const classes = new Set();
    document.querySelectorAll('[class]').forEach((el) => el.classList.forEach((c) => classes.add(c)));
    const clickable = [...document.querySelectorAll('a,button,[role=button]')]
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}:${(el.textContent || '').trim().slice(0, 12)}`)
      .slice(0, 60);
    const canvases = [...document.querySelectorAll('canvas')].map((c) => {
      let px = '';
      try { const d = c.getContext('2d').getImageData(2, 2, 1, 1).data; px = [...d].join('/'); } catch (e) { px = 'err:' + e.name; }
      const cs = (el) => el ? getComputedStyle(el).backgroundColor : '';
      return `${c.className}|${c.width}x${c.height}|${c.parentElement && c.parentElement.className}|px=${px}|bg=${cs(c.parentElement)}/${cs(document.querySelector('.readerContent'))}/${cs(document.body)}/${cs(document.querySelector('.app_content'))}`;
    });
    post('probe', JSON.stringify({ path: location.pathname, cookie: document.cookie.split(';').map((c) => c.split('=')[0].trim()), classes: [...classes].sort(), clickable, canvases }));
  };
  if (window.__WR_DEBUG__) setTimeout(probe, 4000);

  window.__wr = { probe, panel: () => togglePanel(), apply, autoScroll, toast, page };
  mount();
  onRoute();
  render();
  // 让 Go 侧的 ExecJS 开始投递；随后请求最新偏好。
  try { window.webkit.messageHandlers.external.postMessage('wails:runtime:ready'); } catch (_) {}
  post('ready');
})();
