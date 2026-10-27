# weread

微信读书桌面壳（非官方）。Wails v3 直接加载 weread.qq.com，再注入阅读增强脚本，登录、同步、笔记都走官方页面。

## 运行

```bash
wails3 build            # 产物 bin/weread
wails3 package          # 打包 bin/WeRead.app
WEREAD_DEBUG=1 ./bin/weread   # 打印页面消息
```

## 功能

- 沉浸模式：阅读页工具栏和光标自动隐藏，鼠标移到顶部或右侧时浮现（`F` / `⌘E`）
- 版心宽度：窄 / 适中 / 宽 / 铺满（`⌘1`–`⌘4`）
- 纸张底色：米黄纸、护眼绿、夜间暗化
- 翻页：`空格` `J` `K` `PgUp` `PgDn`，章末自动进入下一章
- 自动滚动：`A` / `⌘⇧A`，`+` `-` 调速，`Esc` 停止
- 章节进度条、窗口标题显示书名、启动时回到上次阅读
- 窗口置顶（`⌥⌘T`），记住窗口位置与大小
- 站外链接用系统浏览器打开；`?` 查看快捷键

## 结构

- `main.go`：窗口、菜单、页面消息处理
- `config.go`：偏好与窗口状态，存于 `~/Library/Application Support/weread-desktop/config.json`
- `inject/reader.js`：增强脚本；官方 DOM 选择器集中在顶部 `SEL`
- `inject/reader.css`：增强样式
