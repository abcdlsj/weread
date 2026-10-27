package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Prefs 是注入脚本使用的阅读偏好，原样序列化给页面。
type Prefs struct {
	Width       string `json:"width"`       // narrow | medium | wide | full
	Tint        string `json:"tint"`        // none | paper | green
	Immersive   bool   `json:"immersive"`   // 阅读页自动隐藏工具栏和光标
	RestoreLast bool   `json:"restoreLast"` // 启动时回到上次阅读的书
	ScrollSpeed int    `json:"scrollSpeed"` // 自动滚动速度，像素/秒
}

type Bounds struct {
	X, Y, Width, Height int
}

type Config struct {
	Prefs       Prefs   `json:"prefs"`
	AlwaysOnTop bool    `json:"alwaysOnTop"`
	Window      *Bounds `json:"window,omitempty"`
}

func defaultConfig() Config {
	return Config{Prefs: Prefs{
		Width:       "medium",
		Tint:        "none",
		Immersive:   true,
		RestoreLast: true,
		ScrollSpeed: 40,
	}}
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
