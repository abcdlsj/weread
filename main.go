package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed inject/reader.js
var readerJS string

//go:embed inject/reader.css
var readerCSS string

const (
	homeURL  = "https://weread.qq.com/web/shelf"
	siteHost = "weread.qq.com"
	// WKWebView 默认 UA 不带 Version/Safari，部分页面会降级，补成桌面 Safari。
	uaSuffix = "Version/18.0 Safari/605.1.15"
	// 老板键：全局隐藏/显示窗口。
	bossKey = "Ctrl+OptionOrAlt+Space"
)

// WEREAD_DEBUG=1 时打印页面消息，便于排查注入脚本。
var debug = os.Getenv("WEREAD_DEBUG") != ""

type shell struct {
	mu   sync.Mutex
	cfg  Config
	app  *application.App
	win  *application.WebviewWindow
	menu *application.Menu

	saveTimer *time.Timer
	quitting  atomic.Bool

	immersiveItem *application.MenuItem
	autoItem      *application.MenuItem
	stealthItem   *application.MenuItem
}

func main() {
	s := &shell{cfg: loadConfig()}

	s.app = application.New(application.Options{
		Name:        "微信读书",
		Description: "WeRead desktop reader",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		RawMessageHandler: s.onMessage,
		// 真正退出（⌘Q）时放行关窗，其余关窗只是隐藏。
		ShouldQuit: func() bool { s.quitting.Store(true); return true },
	})

	s.app.Menu.Set(s.buildMenu())
	s.win = s.newMainWindow()
	// Wails 默认等页面加载完才显示窗口，微信读书首屏要 8 秒以上，这里启动即显示。
	s.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		s.mu.Lock()
		prefs := s.cfg.Prefs
		s.mu.Unlock()
		s.restoreBounds()
		s.ensureOnScreen()
		s.win.Show()
		s.win.Focus()
		applyWindowLook(s.win, prefs)
		// 窗口先停在本地空白页，装好 document-start 脚本再进入微信读书。
		if !s.installScript() {
			log.Printf("install user script failed")
		}
		s.win.SetURL(s.startURL())
	})
	// 关窗后点 Dock 图标，把隐藏的窗口找回来。
	s.app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
		s.win.Show()
		s.win.Focus()
	})
	if err := s.app.GlobalShortcut.Register(bossKey, s.toggleVisible); err != nil {
		log.Printf("register boss key: %v", err)
	}

	if err := s.app.Run(); err != nil {
		log.Fatal(err)
	}
}

// startURL 决定启动页：WEREAD_URL（调试用）> 上次阅读的书 > 书架。
// 直接打开上次的书，避免先加载书架再跳转，多等一整次页面加载。
func (s *shell) startURL() string {
	if u := os.Getenv("WEREAD_URL"); u != "" {
		return u
	}
	if s.cfg.Prefs.RestoreLast && isReaderURL(s.cfg.LastURL) {
		return s.cfg.LastURL
	}
	return homeURL
}

func isReaderURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == siteHost && strings.HasPrefix(u.Path, "/web/reader/")
}

func (s *shell) newMainWindow() *application.WebviewWindow {
	opts := application.WebviewWindowOptions{
		Name:                "main",
		Title:               "微信读书",
		Width:               1100,
		Height:              800,
		MinWidth:            420,
		MinHeight:           360,
		URL:                 "/",
		AlwaysOnTop:         s.cfg.AlwaysOnTop,
		BackgroundColour:    application.NewRGB(255, 255, 255),
		CloseButtonState:    application.ButtonHidden,
		MinimiseButtonState: application.ButtonHidden,
		MaximiseButtonState: application.ButtonHidden,
		Mac: application.MacWindow{
			// 透明窗口 + 透明 webview，平时由 applyWindowLook 恢复为不透明。
			Backdrop: application.MacBackdropTransparent,
			// 内容铺满整窗，原生红绿灯隐藏，由注入的标题条负责拖动和关闭。
			TitleBar: application.MacTitleBar{
				AppearsTransparent: true,
				HideTitle:          true,
				FullSizeContent:    true,
			},
			WebviewPreferences: application.MacWebviewPreferences{
				ApplicationNameForUserAgent: uaSuffix,
			},
		},
	}
	if b := s.cfg.Window; b != nil && b.Width >= opts.MinWidth && b.Height >= opts.MinHeight {
		opts.Width, opts.Height = b.Width, b.Height
		opts.InitialPosition = application.WindowXY
		opts.X, opts.Y = b.X, b.Y
	}

	w := s.app.Window.NewWithOptions(opts)
	// 关窗只隐藏，页面保持加载，再打开不用重新等首屏。
	w.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if s.quitting.Load() {
			return
		}
		e.Cancel()
		s.hide()
	})
	// 退出时窗口已销毁，读不到位置；所以在拖动、缩放时就记下来。
	for _, ev := range []events.WindowEventType{events.Common.WindowDidMove, events.Common.WindowDidResize} {
		w.OnWindowEvent(ev, func(*application.WindowEvent) { s.persistWindowSoon() })
	}
	return w
}

// injectScript 在每次页面开始加载时执行：先注入偏好与样式，再跑增强脚本。
func (s *shell) injectScript() string {
	s.mu.Lock()
	prefs, _ := json.Marshal(s.cfg.Prefs)
	s.mu.Unlock()
	css, _ := json.Marshal(readerCSS)
	return fmt.Sprintf("window.__WR_PREFS__=%s;window.__WR_CSS__=%s;window.__WR_DEBUG__=%t;\n%s", prefs, css, debug, readerJS)
}

// installScript 用最新偏好重装 document-start 脚本，整页刷新时首帧就是对的样式。
func (s *shell) installScript() bool {
	return setUserScript(s.win, s.injectScript())
}

func (s *shell) buildMenu() *application.Menu {
	m := application.NewMenu()
	m.AddRole(application.AppMenu)
	m.AddRole(application.EditMenu)

	read := m.AddSubmenu("阅读")
	read.Add("书架").SetAccelerator("CmdOrCtrl+L").OnClick(func(*application.Context) {
		s.win.SetURL(homeURL)
	})
	read.Add("后退").SetAccelerator("CmdOrCtrl+[").OnClick(func(*application.Context) {
		s.win.ExecJS("history.back()")
	})
	read.Add("前进").SetAccelerator("CmdOrCtrl+]").OnClick(func(*application.Context) {
		s.win.ExecJS("history.forward()")
	})
	read.AddSeparator()

	s.immersiveItem = read.AddCheckbox("沉浸模式", s.cfg.Prefs.Immersive).SetAccelerator("CmdOrCtrl+E")
	s.immersiveItem.OnClick(func(ctx *application.Context) {
		s.updatePrefs(func(p *Prefs) { p.Immersive = ctx.IsChecked() })
	})
	s.autoItem = read.AddCheckbox("自动滚动", false).SetAccelerator("CmdOrCtrl+Shift+A")
	s.autoItem.OnClick(func(ctx *application.Context) {
		s.callJS("autoScroll", ctx.IsChecked())
	})
	read.AddSeparator()

	read.Add("阅读设置…").SetAccelerator("CmdOrCtrl+,").OnClick(func(*application.Context) {
		s.callJS("panel", nil)
	})
	read.AddSeparator()

	stealth := m.AddSubmenu("伪装")
	s.stealthItem = stealth.AddCheckbox("伪装模式", s.cfg.Prefs.Stealth).SetAccelerator("CmdOrCtrl+Shift+M")
	s.stealthItem.OnClick(func(ctx *application.Context) { s.setStealth(ctx.IsChecked()) })
	stealth.AddSeparator()
	stealth.AddSeparator()
	stealth.Add("隐藏 / 显示窗口（全局 ⌃⌥空格）").OnClick(func(*application.Context) { s.toggleVisible() })

	view := m.AddSubmenu("显示")
	view.AddRole(application.Reload)
	view.AddSeparator()
	view.AddRole(application.ResetZoom)
	view.AddRole(application.ZoomIn)
	view.AddRole(application.ZoomOut)
	view.AddSeparator()
	view.AddRole(application.ToggleFullscreen)

	win := m.AddSubmenu("窗口")
	win.AddRole(application.Minimise)
	win.AddRole(application.Zoom)
	win.AddSeparator()
	win.AddCheckbox("窗口置顶", s.cfg.AlwaysOnTop).SetAccelerator("OptionOrAlt+CmdOrCtrl+T").
		OnClick(func(ctx *application.Context) {
			on := ctx.IsChecked()
			s.win.SetAlwaysOnTop(on)
			s.mu.Lock()
			s.cfg.AlwaysOnTop = on
			cfg := s.cfg
			s.mu.Unlock()
			_ = saveConfig(cfg)
		})

	s.menu = m
	return m
}

func (s *shell) updatePrefs(fn func(*Prefs)) {
	s.mu.Lock()
	fn(&s.cfg.Prefs)
	cfg := s.cfg
	s.mu.Unlock()
	if err := saveConfig(cfg); err != nil {
		log.Printf("save config: %v", err)
	}
	s.callJS("apply", cfg.Prefs)
	s.installScript()
}

func (s *shell) setStealth(on bool) {
	s.updatePrefs(func(p *Prefs) { p.Stealth = on })
	s.mu.Lock()
	prefs := s.cfg.Prefs
	s.mu.Unlock()
	applyWindowLook(s.win, prefs)
	s.stealthItem.SetChecked(on)
	s.menu.Update()
}

func (s *shell) hide() {
	s.callJS("autoScroll", false)
	s.win.Hide()
}

func (s *shell) toggleVisible() {
	if s.win.IsVisible() {
		s.hide()
		return
	}
	s.win.Show()
	s.win.Focus()
}

func (s *shell) callJS(method string, arg any) {
	data, _ := json.Marshal(arg)
	s.win.ExecJS("window.__wr&&window.__wr." + method + "(" + string(data) + ")")
}

// onMessage 处理注入脚本发来的消息，只接受微信读书主站主 frame。
func (s *shell) onMessage(_ application.Window, raw string, info *application.OriginInfo) {
	if debug {
		log.Printf("page message: %s %+v", raw, info)
	}
	if info == nil || !info.IsMainFrame {
		return
	}
	if u, err := url.Parse(info.Origin); err != nil || u.Scheme != "https" || u.Host != siteHost {
		return
	}
	var msg struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		return
	}
	switch msg.Type {
	case "ready":
		// 脚本里的偏好是安装时的快照，补推一次最新值。
		s.mu.Lock()
		prefs := s.cfg.Prefs
		s.mu.Unlock()
		s.callJS("setSystemDark", systemDark())
		s.callJS("apply", prefs)
	case "last":
		if !isReaderURL(msg.Value) {
			return
		}
		s.mu.Lock()
		changed := s.cfg.LastURL != msg.Value
		s.cfg.LastURL = msg.Value
		cfg := s.cfg
		s.mu.Unlock()
		if changed {
			_ = saveConfig(cfg)
		}
	case "title":
		title := "微信读书"
		if msg.Value != "" {
			title = msg.Value
		}
		s.win.SetTitle(title)
	case "autoScroll":
		// 页面内按 Esc 或翻到章末会停止自动滚动，同步菜单勾选。
		s.autoItem.SetChecked(msg.Value == "on")
		s.menu.Update()
	case "prefs":
		// 设置浮窗改动后回传完整偏好，这里落盘并同步窗口与菜单。
		var p Prefs
		if err := json.Unmarshal([]byte(msg.Value), &p); err != nil {
			return
		}
		p.sanitize()
		s.mu.Lock()
		old := s.cfg.Prefs
		s.cfg.Prefs = p
		cfg := s.cfg
		s.mu.Unlock()
		_ = saveConfig(cfg)
		s.installScript()
		if old.Stealth != p.Stealth {
			applyWindowLook(s.win, p)
		}
		s.immersiveItem.SetChecked(p.Immersive)
		s.stealthItem.SetChecked(p.Stealth)
		s.menu.Update()
	case "tap":
		var pt struct{ X, Y float64 }
		if err := json.Unmarshal([]byte(msg.Value), &pt); err != nil {
			return
		}
		w, h := s.win.Size()
		if pt.X < 0 || pt.Y < 0 || pt.X > float64(w) || pt.Y > float64(h) {
			return
		}
		windowTap(s.win, pt.X, pt.Y)
	case "bg":
		var c struct{ R, G, B uint8 }
		if err := json.Unmarshal([]byte(msg.Value), &c); err == nil {
			setWindowBase(s.win, c.R, c.G, c.B)
		}
	case "close":
		s.hide()
	case "minimise":
		s.win.Minimise()
	case "shelf":
		s.win.SetURL(homeURL)
	case "open":
		u, err := url.Parse(msg.Value)
		if err == nil && (u.Scheme == "http" || u.Scheme == "https") {
			_ = s.app.Browser.OpenURL(u.String())
		}
	}
}

// persistWindowSoon 在窗口停止移动、缩放 500ms 后保存位置，避免拖动时频繁写盘。
func (s *shell) persistWindowSoon() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saveTimer != nil {
		s.saveTimer.Stop()
	}
	s.saveTimer = time.AfterFunc(500*time.Millisecond, s.persistWindow)
}

func (s *shell) persistWindow() {
	if s.win == nil || s.win.IsMinimised() || s.win.IsFullscreen() || s.win.IsMaximised() {
		return
	}
	b := s.win.Bounds()
	if b.Width <= 0 || b.Height <= 0 {
		return
	}
	s.mu.Lock()
	s.cfg.Window = &Bounds{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
	cfg := s.cfg
	s.mu.Unlock()
	if err := saveConfig(cfg); err != nil {
		log.Printf("save config: %v", err)
	}
}

// restoreBounds 用与 Bounds() 对称的 SetBounds 恢复窗口。
// 只靠创建参数里的 X/Y/宽高，每次重启都会偏移几个像素，越积越多。
func (s *shell) restoreBounds() {
	s.mu.Lock()
	b := s.cfg.Window
	s.mu.Unlock()
	if b == nil || b.Width <= 0 || b.Height <= 0 {
		return
	}
	s.win.SetBounds(application.Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height})
}

// ensureOnScreen 在上次所在的显示器已断开时，把窗口挪回主屏居中。
func (s *shell) ensureOnScreen() {
	b := s.win.Bounds()
	for _, sc := range s.app.Screen.GetAll() {
		wa := sc.WorkArea
		// 标题条区域至少有 100×30 落在某块屏幕里，才算拖得回来。
		if b.X+b.Width-100 > wa.X && b.X+100 < wa.X+wa.Width && b.Y >= wa.Y-10 && b.Y+30 < wa.Y+wa.Height {
			return
		}
	}
	s.win.Center()
}
