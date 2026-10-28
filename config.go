package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Prefs 是注入脚本使用的阅读偏好，原样序列化给页面。
type Prefs struct {
	Theme       string `json:"theme"`       // auto | light | dark，通过窗口外观驱动官方主题
	Width       string `json:"width"`       // narrow | medium | wide | full
	Tint        string `json:"tint"`        // none | paper | green | dim
	Immersive   bool   `json:"immersive"`   // 阅读页自动隐藏工具栏和光标
	RestoreLast bool   `json:"restoreLast"` // 启动时回到上次阅读的书
	ScrollSpeed int    `json:"scrollSpeed"` // 自动滚动速度，像素/秒

	// 间距三档：compact | standard | loose，写进官方排版引擎读取的 CSS。
	Spacing string `json:"spacing"`
	TrimTop bool   `json:"trimTop"` // 压缩章首空白

	// 伪装模式：窗口半透明、深色背景、终端配色，可贴在终端旁边。
	Stealth      bool   `json:"stealth"`
	StealthAlpha int    `json:"stealthAlpha"` // 背景不透明度，百分比
	StealthColor string `json:"stealthColor"` // gray | green | amber
}

type Bounds struct {
	X, Y, Width, Height int
}

type Config struct {
	Prefs       Prefs   `json:"prefs"`
	AlwaysOnTop bool    `json:"alwaysOnTop"`
	Window      *Bounds `json:"window,omitempty"`
	LastURL     string  `json:"lastURL,omitempty"` // 上次阅读的书，启动时直接打开
}

func defaultConfig() Config {
	return Config{Prefs: Prefs{
		Theme:        "auto",
		Width:        "medium",
		Tint:         "none",
		Immersive:    true,
		RestoreLast:  true,
		ScrollSpeed:  40,
		Spacing:      "standard",
		TrimTop:      true,
		StealthAlpha: 70,
		StealthColor: "gray",
	}}
}

// sanitize 把页面传回的偏好限制在合法取值内。
func (p *Prefs) sanitize() {
	d := defaultConfig().Prefs
	if !oneOf(p.Theme, "auto", "light", "dark") {
		p.Theme = d.Theme
	}
	if !oneOf(p.Width, "narrow", "medium", "wide", "full") {
		p.Width = d.Width
	}
	if !oneOf(p.Tint, "none", "paper", "green", "dim") {
		p.Tint = d.Tint
	}
	if !oneOf(p.StealthColor, "gray", "green", "amber") {
		p.StealthColor = d.StealthColor
	}
	p.StealthAlpha = clamp(p.StealthAlpha, 0, 100)
	p.ScrollSpeed = clamp(p.ScrollSpeed, 10, 400)
	if !oneOf(p.Spacing, "compact", "standard", "loose") {
		p.Spacing = d.Spacing
	}
}

func oneOf(v string, opts ...string) bool {
	for _, o := range opts {
		if v == o {
			return true
		}
	}
	return false
}

func clamp(v, lo, hi int) int {
	return max(lo, min(hi, v))
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "weread-desktop", "config.json")
}

func loadConfig() Config {
	cfg := defaultConfig()
	data, err := os.ReadFile(configPath())
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	cfg.Prefs.sanitize()
	return cfg
}

func saveConfig(cfg Config) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}
