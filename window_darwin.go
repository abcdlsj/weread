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

// 伪装模式下窗口完全透明，背景由页面 CSS 的半透明色决定。
static void setWindowStealth(void *ptr, bool on) {
	NSWindow *w = (__bridge NSWindow *)ptr;
	if (on) {
		[w setOpaque:NO];
		[w setBackgroundColor:[NSColor clearColor]];
	} else {
		[w setOpaque:YES];
		[w setBackgroundColor:[NSColor windowBackgroundColor]];
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
// 部分官方按钮不响应脚本合成的点击，这里向窗口投递一次真实的鼠标点击。
// x、y 是内容区坐标（左上角为原点，单位为点）。
static void windowTap(void *ptr, double x, double y) {
	NSWindow *w = (__bridge NSWindow *)ptr;
	NSPoint p = NSMakePoint(x, w.contentView.bounds.size.height - y);
	NSTimeInterval t = [[NSProcessInfo processInfo] systemUptime];
	for (int i = 0; i < 2; i++) {
		NSEvent *e = [NSEvent mouseEventWithType:(i == 0 ? NSEventTypeLeftMouseDown : NSEventTypeLeftMouseUp)
		                                location:p
		                           modifierFlags:0
		                               timestamp:t
		                            windowNumber:w.windowNumber
		                                 context:nil
		                             eventNumber:0
		                              clickCount:1
		                                pressure:(i == 0 ? 1.0 : 0.0)];
		[w sendEvent:e];
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

func windowTap(w *application.WebviewWindow, x, y float64) {
	application.InvokeAsync(func() {
		if ptr := w.NativeWindow(); ptr != nil {
			C.windowTap(ptr, C.double(x), C.double(y))
		}
	})
}
