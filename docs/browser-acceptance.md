# 浏览器实验能力：管理员网络访问与固定页验收

本功能默认关闭，只对一个精确匹配的飞牛管理员 uid 生效。它**不是多租户安全边界**，也不应在共享或不可信工作区启用。

当前包含两种模式：

- **网络浏览模式**：显示在正常 Harness 工作区右侧栏的多标签「受控浏览器」。用户从右栏「开始」指南点「新建受控浏览器」即可建立互相独立的标签（每个标签一个浏览器进程与独立地址栏；最多同时 6 个标签，同时最多运行 3 个浏览器）；模型通过 `browser_live_control` 的 `tabId` 定向操作某个标签。模型可请求打开本机、局域网或公网 HTTP/HTTPS 地址，但每次模型直接调用 `navigate` 都必须由当前登录用户在该标签内查看完整 URL 后明确批准。
- **固定页验收模式**：`/app/dsh-fnos/acceptance/` 下的离线验收实例，只能打开内置固定测试页，不接受 URL、HTML 或外部网络。

## 网络浏览模式

### 能力

- 工具：`browser_live_control`。
- 动作：`list_tabs`（列出当前会话的标签及各自 URL/标题/加载状态）、`navigate`、`snapshot`、`click`、`fill`、`screenshot`、`diagnostics`；除 `list_tabs` 外都必须带 `tabId`，缺失或歧义时工具报错并提示先列出标签。
- 每个右栏标签使用独立的 WebSocket（`browser-live/ws?sessionId=…&tabId=…`）和独立浏览器进程，画面、地址栏、访问授权与输入互不串扰；关闭标签会释放对应 worker，收起或切换到其他标签只暂停画面订阅。
- `navigate` 支持本机、局域网和公网 HTTP/HTTPS 地址，包括 localhost、IP 和自定义端口。
- 每次模型调用 `navigate`，目标标签都会显示访问申请与完整 URL，必须点击「允许本次访问」才会导航；点击「拒绝」或超时则不会访问该 URL。
- 在同一标签内，模型和用户操作的是同一个页面。用户可以直接在画面里点击、滚动、输入，模型可以读取页面结构和操作元素。
- 键盘和粘贴仅在浏览器画面获得焦点时转发；聊天输入框获得焦点时不会被面板截获。
- 跨域顶层跳转会被浏览器拦截；模型需要针对新的目标 URL 再次调用 `navigate` 并重新取得授权。
- 弹出窗口会被关闭，避免绕过导航授权。

### 明确限制

- 地址栏和模型直接导航只允许 `http:` 和 `https:`；支持 localhost、局域网 IP、自定义端口和内网主机名。模型调用 `navigate` 时须经用户批准；用户手动输入地址则直接导航。
- 当前控制策略允许已批准站点的同源顶层跳转，包括页面链接、重定向和模型点击触发的跳转；这些跳转不会逐个展示完整 URL 审批。对于不可信页面或敏感操作，不应把此机制当作逐 URL 的安全防护。
- 仍拒绝 `file:`、`data:`、JavaScript URL、带用户名或密码的 URL、未指定主机以及 `0.0.0.0`。
- 外部网站仍可发起其正常的子资源、WebSocket、遥测和跨站 iframe 请求；批准一个页面意味着允许该页面运行。
- 登录态和 Cookie 只保存在本次临时浏览器 profile 中；应用或 worker 重启后需要重新登录。
- 不访问飞牛现有 Chrome 的 profile、Cookie 或登录态。
- CAPTCHA、MFA、站点条款和账号权限仍需用户自行处理。

### 安全边界

- 网络浏览模式保留独立的 user、mount、PID 命名空间和只读最小根文件系统。
- 网络出口使用宿主网络，因此浏览器可以访问本机、局域网和公网。该模式不是 SSRF、内网隔离或多租户隔离边界；只能用于可信管理员，并依赖每次访问授权。
- 浏览器没有 `--no-sandbox`，CDP 仍只走私有 pipe，不监听端口，也不向 Web 客户端公开 DevTools。
- 远端画面可能包含登录信息和用户输入。不要录屏、截图上报或写入日志。

## 使用步骤

1. 安装 `dist/dsh-fnos-<version>-linux-amd64.fpk` 测试包，并确保应用商店已安装 `nodejs_v26` 与 `fygo-browser`。
2. 在应用数据目录创建两个普通文件：

   ```sh
   sudo sh -c 'printf 1 > /vol1/@appdata/dsh-fnos/browser-acceptance.enabled'
   sudo sh -c 'printf 1000 > /vol1/@appdata/dsh-fnos/browser-acceptance.uid'
   sudo chown dsh-fnos:dsh-fnos /vol1/@appdata/dsh-fnos/browser-acceptance.*
   sudo chmod 600 /vol1/@appdata/dsh-fnos/browser-acceptance.*
   ```

   `uid` 必须是实际使用 Harness 的管理员账号。两个文件必须都是普通文件，符号链接不会启用功能。

3. 重启应用，确认 `dsh-fnos.log` 包含 `browser-acceptance-enabled` 且 `livePanel: true`。
4. 打开该 uid 的 Harness 工作区，展开右侧栏；在「开始」指南中点击「新建受控浏览器」。需要并行对照多个页面时再次点击新建，标签之间彼此独立；关闭标签即释放对应浏览器。
5. 让模型打开设计稿或本地应用，例如：

   > 使用浏览器打开 https://www.figma.com/ ，然后截图并描述当前页面。

   > 使用浏览器打开 http://127.0.0.1:8080/ 并检查页面。

   > 使用浏览器打开 http://192.168.2.64:8080/ 并检查页面。

6. 对应标签会显示访问申请。确认域名和完整 URL 后点击「允许本次访问」。
7. 如果页面跳转到另一个网站，模型需要重新请求导航，用户再次批准。

## 固定页验收模式

`/app/dsh-fnos/acceptance/` 仍使用独立的离线实例和内置验收模型：

- 固定页：`http://127.0.0.1:38179/`
- 工具：`browser_offline_prototype`
- 唯一动作：`open_test_site`
- 不接受 URL、HTML 或外部网络。
- 使用同一个 uid 标记文件；仅管理员可打开。

## 关闭方式

```sh
sudo rm -f /vol1/@appdata/dsh-fnos/browser-acceptance.enabled /vol1/@appdata/dsh-fnos/browser-acceptance.uid
```

重启应用后恢复默认关闭。

## 未证明项与风险

- 网络浏览使用宿主网络，必须假设获准页面能够访问本机、局域网和公网并发出其正常子请求。
- 无法通过 TLS 隧道可靠证明所有子资源或重定向的最终来源；当前控制点是顶层导航授权和同源跳转限制。
- 多飞牛账号共享宿主系统用户；随机 token、单管理员限制和隔离命名空间只降低暴露面，不构成严格租户隔离。
- 认识的启动进程组之外的后代（`setsid` 脱组、worker 被 SIGKILL）无法证明已清理。
- arm64 尚未做真实外部网站验收；当前只在 `linux-amd64`、Chromium 152（飞牛 `fygo-browser` 1.0.4）上实测。
- 2026-11-26 在隔离 Harness 实例（linux-amd64、Chromium 152）完成右侧栏多标签端到端验证：指南新建标签、首帧画面、地址栏导航到 `https://example.com/`、第二标签独立导航到 `https://example.org/`、切回第一标签仍保留自身 URL、关闭第二标签后对应 worker 与 Chromium 退出、旧右下角浮窗不再注入。已安装应用内 GUI 的同等验证需在重启应用后补做；模型真实调用 `browser_live_control`（含 `tabId` 定向与访问授权）目前只由单元/集成测试覆盖。
