//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static WKWebView *findWebView(NSView *v) {
	if ([v isKindOfClass:[WKWebView class]]) return (WKWebView *)v;
	for (NSView *sub in v.subviews) {
		WKWebView *w = findWebView(sub);
		if (w) return w;
	}
	return nil;
}

// 伪装模式下窗口完全透明，背景由页面 CSS 的半透明色决定；标题文字一并隐藏。
static void setWindowStealth(void *ptr, bool on) {
	NSWindow *w = (__bridge NSWindow *)ptr;
	if (on) {
		[w setOpaque:NO];
		[w setBackgroundColor:[NSColor clearColor]];
		[w setTitleVisibility:NSWindowTitleHidden];
	} else {
		[w setOpaque:YES];
		[w setBackgroundColor:[NSColor windowBackgroundColor]];
		[w setTitleVisibility:NSWindowTitleVisible];
	}
	// WKWebView 自身也会画一层不透明底色，需一并关掉，页面 CSS 的半透明才能透出去。
	WKWebView *web = findWebView(w.contentView);
	if (web) {
		[web setValue:@(!on) forKey:@"drawsBackground"];
		if (@available(macOS 12.0, *)) {
			web.underPageBackgroundColor = on ? [NSColor clearColor] : nil;
		}
	}
	[w invalidateShadow];
}

// 微信读书按 prefers-color-scheme 切换深浅色，改窗口外观即可驱动官方主题。
// mode: 0 跟随系统，1 浅色，2 深色。
static void setWindowAppearance(void *ptr, int mode) {
	NSWindow *w = (__bridge NSWindow *)ptr;
	if (mode == 1) {
		[w setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameAqua]];
	} else if (mode == 2) {
		[w setAppearance:[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]];
	} else {
		[w setAppearance:nil];
	}
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// applyWindowLook 同步原生窗口的透明度与外观；伪装模式强制深色。
func applyWindowLook(w *application.WebviewWindow, p Prefs) {
	mode := map[string]int{"auto": 0, "light": 1, "dark": 2}[p.Theme]
	if p.Stealth {
		mode = 2
	}
	application.InvokeSync(func() {
		if ptr := w.NativeWindow(); ptr != nil {
			C.setWindowStealth(ptr, C.bool(p.Stealth))
			C.setWindowAppearance(ptr, C.int(mode))
		}
	})
}
