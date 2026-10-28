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

// 官方网页在系统深色下只改了文字颜色、背景仍是白色，所以窗口外观固定为浅色，
// 夜间模式由注入的 CSS 实现。mode: 0 跟随系统，1 浅色，2 深色。
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
// 窗口拉伸时，新露出的区域先画窗口和 WebView 的底色，再等页面重绘。
// 底色与页面不一致就会闪一下，所以跟页面底色保持同步。
static void setWindowBase(void *ptr, int r, int g, int b) {
	NSWindow *w = (__bridge NSWindow *)ptr;
	if (!w.opaque) return; // 伪装模式保持透明
	NSColor *c = [NSColor colorWithSRGBRed:r / 255.0 green:g / 255.0 blue:b / 255.0 alpha:1];
	[w setBackgroundColor:c];
	WKWebView *web = findWebView(w.contentView);
	if (web) {
		if (@available(macOS 12.0, *)) web.underPageBackgroundColor = c;
	}
}
static bool systemIsDark(void) {
	NSAppearanceName n = [NSApp.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
	return [n isEqualToString:NSAppearanceNameDarkAqua];
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// applyWindowLook 同步原生窗口的透明度与外观；伪装模式用深色，其余固定浅色。
func applyWindowLook(w *application.WebviewWindow, p Prefs) {
	mode := 1
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

func setWindowBase(w *application.WebviewWindow, r, g, b uint8) {
	application.InvokeAsync(func() {
		if ptr := w.NativeWindow(); ptr != nil {
			C.setWindowBase(ptr, C.int(r), C.int(g), C.int(b))
		}
	})
}

// systemDark 返回系统是否处于深色外观，供“跟随系统”的夜间模式使用。
func systemDark() bool {
	var dark bool
	application.InvokeSync(func() { dark = bool(C.systemIsDark()) })
	return dark
}
