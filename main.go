package main

import (
	"embed"
	"encoding/json"
	"log"
	"net/url"
	"os"
	"sync"

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
)

// WEREAD_DEBUG=1 时打印页面消息，便于排查注入脚本。
var debug = os.Getenv("WEREAD_DEBUG") != ""

type shell struct {
	mu   sync.Mutex
	cfg  Config
	app  *application.App
	win  *application.WebviewWindow
	menu *application.Menu

	immersiveItem *application.MenuItem
	autoItem      *application.MenuItem
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
		OnShutdown:        s.persistWindow,
	})

	s.app.Menu.Set(s.buildMenu())
	s.win = s.newMainWindow()

	if err := s.app.Run(); err != nil {
		log.Fatal(err)
	}
}

func (s *shell) newMainWindow() *application.WebviewWindow {
	opts := application.WebviewWindowOptions{
		Name:             "main",
		Title:            "微信读书",
		Width:            1100,
		Height:           800,
		MinWidth:         420,
		MinHeight:        360,
		URL:              homeURL,
		AlwaysOnTop:      s.cfg.AlwaysOnTop,
		BackgroundColour: application.NewRGB(255, 255, 255),
		JS:               s.injectScript(),
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBar{
				AppearsTransparent: true,
			},
			WebviewPreferences: application.MacWebviewPreferences{
				ApplicationNameForUserAgent: uaSuffix,
			},
		},
	}
	if b := s.cfg.Window; b != nil && b.Width > 0 && b.Height > 0 {
		opts.Width, opts.Height = b.Width, b.Height
		opts.InitialPosition = application.WindowXY
		opts.X, opts.Y = b.X, b.Y
	}

	w := s.app.Window.NewWithOptions(opts)
	w.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		s.persistWindow()
	})
	return w
}

// injectScript 在每次页面导航完成后执行：先注入偏好与样式，再跑增强脚本。
func (s *shell) injectScript() string {
	s.mu.Lock()
	prefs, _ := json.Marshal(s.cfg.Prefs)
	s.mu.Unlock()
	css, _ := json.Marshal(readerCSS)
	return "window.__WR_PREFS__=" + string(prefs) + ";window.__WR_CSS__=" + string(css) + ";\n" + readerJS
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

	width := read.AddSubmenu("版心宽度")
	for i, opt := range []struct{ key, label string }{
		{"narrow", "窄"}, {"medium", "适中"}, {"wide", "宽"}, {"full", "铺满"},
	} {
		key := opt.key
		width.AddRadio(opt.label, s.cfg.Prefs.Width == key).
			SetAccelerator("CmdOrCtrl+" + string(rune('1'+i))).
			OnClick(func(*application.Context) { s.updatePrefs(func(p *Prefs) { p.Width = key }) })
	}

	tint := read.AddSubmenu("纸张底色")
	for _, opt := range []struct{ key, label string }{
		{"none", "原色"}, {"paper", "米黄纸"}, {"green", "护眼绿"}, {"dim", "夜间暗化"},
	} {
		key := opt.key
		tint.AddRadio(opt.label, s.cfg.Prefs.Tint == key).
			OnClick(func(*application.Context) { s.updatePrefs(func(p *Prefs) { p.Tint = key }) })
	}
	read.AddSeparator()
	read.AddCheckbox("启动时回到上次阅读", s.cfg.Prefs.RestoreLast).OnClick(func(ctx *application.Context) {
		s.updatePrefs(func(p *Prefs) { p.RestoreLast = ctx.IsChecked() })
	})

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
		// 整页导航后 options.JS 里的偏好可能已过期，补推一次最新值。
		s.mu.Lock()
		prefs := s.cfg.Prefs
		s.mu.Unlock()
		s.callJS("apply", prefs)
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
	case "immersive":
		on := msg.Value == "on"
		s.mu.Lock()
		s.cfg.Prefs.Immersive = on
		cfg := s.cfg
		s.mu.Unlock()
		_ = saveConfig(cfg)
		s.immersiveItem.SetChecked(on)
		s.menu.Update()
	case "open":
		u, err := url.Parse(msg.Value)
		if err == nil && (u.Scheme == "http" || u.Scheme == "https") {
			_ = s.app.Browser.OpenURL(u.String())
		}
	}
}

func (s *shell) persistWindow() {
	if s.win == nil || s.win.IsMinimised() || s.win.IsFullscreen() {
		return
	}
	b := s.win.Bounds()
	s.mu.Lock()
	s.cfg.Window = &Bounds{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
	cfg := s.cfg
	s.mu.Unlock()
	if err := saveConfig(cfg); err != nil {
		log.Printf("save config: %v", err)
	}
}
