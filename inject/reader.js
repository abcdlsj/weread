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
  };
  const READER_PATH = /^\/web\/reader\//;
  const SHELF_PATH = /^\/web\/shelf/;

  const prefs = Object.assign(
    { width: 'medium', tint: 'none', immersive: true, restoreLast: true, scrollSpeed: 40 },
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
    <tr><td><kbd>⌘L</kbd></td><td>回到书架</td></tr>
    <tr><td><kbd>⌥⌘T</kbd></td><td>窗口置顶</td></tr>
    <tr><td><kbd>?</kbd></td><td>显示 / 关闭本面板</td></tr>
  </table></div>`;
  help.addEventListener('click', (e) => { if (e.target === help) help.classList.remove('wr-show'); });

  const mount = () => {
    if (!document.head || !document.body) return false;
    if (!style.isConnected) document.head.appendChild(style);
    for (const el of [tint, progress, toastEl, help]) {
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
    for (const c of [...root.classList]) {
      if (c.startsWith('wr-w-') || c.startsWith('wr-tint-')) root.classList.remove(c);
    }
    root.classList.add(`wr-w-${prefs.width}`, `wr-tint-${prefs.tint}`);
    updateProgress();
  };

  const relayout = () => {
    // 正文 canvas 按容器宽度排版，改宽度后让官方脚本重排。
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  const apply = (next) => {
    const changed = Object.keys(next || {}).filter((k) => prefs[k] !== next[k]);
    Object.assign(prefs, next);
    render();
    if (changed.includes('width')) {
      relayout();
      toast(`版心：${WIDTH_LABEL[prefs.width] || prefs.width}`);
    }
    if (changed.includes('tint')) toast(`底色：${TINT_LABEL[prefs.tint] || prefs.tint}`);
    if (changed.includes('immersive')) toast(prefs.immersive ? '沉浸模式：开' : '沉浸模式：关');
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

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
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
        apply({ immersive: !prefs.immersive });
        post('immersive', prefs.immersive ? 'on' : 'off');
        break;
      case 'a': case 'A':
        autoScroll(!autoRAF); break;
      case '+': case '=':
        if (!autoRAF) { handled = false; break; }
        speed = Math.min(400, speed + 10); toast(`自动滚动：${speed} px/s`); break;
      case '-': case '_':
        if (!autoRAF) { handled = false; break; }
        speed = Math.max(10, speed - 10); toast(`自动滚动：${speed} px/s`); break;
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

  // ---------- 路由与标题 ----------
  let lastPath = '';
  let lastTitle = '';
  const onRoute = () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
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
      root.classList.toggle('wr-horizontal', isReader() && isHorizontal());
    });
  }).observe(root, { childList: true, subtree: true });

  window.__wr = { apply, autoScroll, toast, page };
  mount();
  onRoute();
  render();
  // 让 Go 侧的 ExecJS 开始投递；随后请求最新偏好。
  try { window.webkit.messageHandlers.external.postMessage('wails:runtime:ready'); } catch (_) {}
  post('ready');
})();
