# 受控浏览器右侧栏 Client

本目录是独立 DSH Client 插件，需由 Host patch 加载 `index.mjs`，并由同一应用提供 `browser-live/ws`。不会部署或修改用户 profile。它与原有 `panel/` 是不同的 UI；不应同时启用两者作为同一实例的视图。

右侧栏 guide 的“新建受控浏览器”创建 `multiple: true` 标签。Client 从右栏 slot 的 session 注入取得会话 ID，从 `useTabInfo().tab.id` 取得该会话内的标签 ID；以二者组合作为身份。每个标签一条同源 WebSocket，页面目录相对地址 `browser-live/ws?sessionId=…&tabId=…`，适配反向代理前缀。ID 仅用于路由，不是授权凭据：服务端必须独立验证用户、session 和来源。

插件根 effect 订阅 `sidebarRight.mounted`，为当前屏幕上的 session 保持独立的 `browser-live/control?sessionId=…` WebSocket，即使没有浏览器标签、右栏收起也保持连接。切换会话或插件卸载时关闭，断线指数退避重连；未显示的会话无控制通道。Host 选定单个同 session 连接发送 `{type:'create_tab',sessionId,requestId,expiresAt}`（Unix 毫秒），Client 只接受匹配当前 session 且未过期的请求；同步调用公开的 `openTab`，从同步更新的 inventory 新增集与 `active()` 双重校验得到真实 tabId，再以 `create_tab_result` 返回 tabId 或 error。同一连接重复 requestId 返回缓存，切会话清空。多个窗口或网络断线下，Host 不应自动重试不确定结果；创建已提交但响应丢失、同步重入导致无法唯一识别时，可能留下用户可见的标签。控制连接必须与现有 WS 使用相同鉴权及来源检查，sessionId 不是授权凭据。

连接后依据可见状态发送 `subscribe`/`unsubscribe`；切换、收起、页面组件卸载、暂时断线及插件卸载不应释放服务端实例。每个标签显式关闭时发送 `close`；未连接时会先重连再发送。WebSocket 无 close 确认机制，因此发送成功不保证服务端已处理；整页关闭或进程退出时待发送的关闭消息也可能丢失，服务端应有资源清理策略。地址栏只允许无凭据的 HTTP(S)，手动导航发送 `navigate`；按钮发送 `back`、`forward`、`reload`。图像、输入和权限消息使用原有 live 协议。标签不可见时停止订阅；远端画面聚焦时才转发键盘和粘贴。

## 自测

```sh
node --check browser-plugin/sidebar/client.js
node --test browser-plugin/sidebar/client.test.mjs
```

单元测试使用 mock Client 注册和 WebSocket，不代表真实运行时验收。集成时应验证：同一 session 两标签和不同 session 同 tab ID 的帧及输入互不串扰；guide、新增、关闭未显示标签、断线重连、切换 session/收起/浮动和页面刷新；权限请求的允许/拒绝、HTTP(S) 导航、前进后退刷新、粘贴与失焦释放；代理前缀和 HTTPS；显式 close 的后端资源释放，以及用户鉴权与未启用状态。需要真实后端和目标 Harness 页面才能验证 UI 和端到端行为。

## 真实实例验收（2026-11-26，隔离 Harness 实例）

在 `/tmp/dsh-e2e` 的隔离实例（linux-amd64、Chromium 152、headless CDP 驱动）中完成并通过：

- 右栏 guide 出现并点击「新建受控浏览器」后建标签：WS 建立 264ms，首帧 924ms（1280×800 JPEG，初始 `about:blank`）。
- 地址栏导航 `https://example.com/` 后画面真实变化；第二标签独立导航 `https://example.org/`，切回第一标签地址栏仍为 `https://example.com/`。
- 关闭第二标签后仅剩 1 个 worker 进程与 1 个 Chromium（`close` → `dispose` 生效），旧右下角浮窗 DOM 不存在。
- 失败教训：探测 canvas 时需排除浏览器默认 300×150 画布，否则会把“未绘制”误判为失败。

已安装应用内 GUI 的部署验证仍需重启应用后补做。