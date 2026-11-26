# 浏览器实验能力：管理员验收窗口

本功能默认关闭，且**不是**面向普通用户或不可信网站的能力。它只用于在一台可信整机上，由管理员手动验证「Harness 通过 MCP 工具驱动一个隔离的 Chromium 打开内置固定测试页」这条链路。

## 能力边界

- 固定页：`http://127.0.0.1:38179/`（内置 fixture，含 `/500`、`/cut` 两个调试端点）。
- 工具：`browser_offline_prototype`，唯一动作 `open_test_site`，不接受 URL、HTML 或其他参数。
- 每个 Agent 独立注册工具与 worker；跨 Agent 调用被拒绝。
- Chromium 启动参数不包含 `--no-sandbox`；浏览器运行在独立 user/mount/PID/net 命名空间，五组 capability 全零（`NoNewPrivs=1`）。
- 只允许绑定 `127.0.0.1` 随机高位端口；CDP 只走私有 pipe，不监听端口，不公开 DevTools。
- 一次只允许一个验收实例；仅 `admin` 且 uid 精确匹配标记文件的用户可打开 `/acceptance/`。

## 可见浏览器面板（Web GUI）

启用上述标记文件后，管理员自己的 Harness 工作区实例会在启动时额外加载一个**可见浏览器面板**：Web GUI 右下角出现「浏览器」按钮，点开后右侧停靠面板实时显示那个隔离 Chromium 的画面；用户在面板里的点击/滚动/键盘输入与 Agent 的 `browser_live_control` 工具操作的是**同一个页面**（内置固定测试页），不是两个浏览器。

- 面板只是查看与输入通道：页面仍由后台 worker 通过私有 CDP pipe 驱动，浏览器不监听 CDP 端口，DevTools 不对客户端开放；面板与宿主之间只走同源 WebSocket，先经过 Harness 的连接准入检查。
- 面板能打开的唯一页面仍是内置固定测试页；工具不接受 URL/HTML，面板也没有地址栏。
- 画面是 worker 推来的 JPEG 帧（最长边 1280×800、≤10 fps、慢消费者丢帧），只用于观看；画面可能包含用户在页面里键入的内容，不要录屏、截图上报或写入日志。
- 该面板默认关闭；`--patch` 叠加文件缺失时会自动降级为普通实例（不会阻止 GUI 启动）。启用后需要重启应用才生效。
- 已验证：真实 DSH 实例能注入面板脚本、提供面板资源、拒绝未认证的 WebSocket、推送真实 JPEG 帧、接受鼠标输入并拒绝字段非法的输入；**尚未**在真实浏览器里人工点击验收，也未做多客户端、慢网络与触屏/输入法测试。

## 明确不支持

- 任意网站、DNS、外部网络、代理或 CONNECT。
- 复用已有的浏览器配置、登录态、Cookie、mydata 或用户 Harness profile。
- 多租户隔离。同一台 fnOS 上所有账号共享宿主系统用户，同 UID 的进程可以互相读写文件、干扰进程；随机 token、短生命周期、仅管理员单实例只降低暴露面，不构成安全边界。
- 对 SIGKILL、断电、`setsid` 脱组后代或清理超时的整树回收保证。失败时保留的临时目录只记录未证明项，由管理员人工清理。
- arm64 未验证：当前只在 `linux-amd64`、Chromium 152（飞牛 `fygo-browser` 1.0.4 提供的程序）上手工测试。ARM 设备不启用。

## 启用步骤（仅手动验收）

1. 安装 `dist/dsh-fnos-<version>-linux-amd64.fpk`（unsigned 手测包），并确保应用商店的 `nodejs_v26` 插件已安装。
2. 确认飞牛已安装 `fygo-browser`：本功能复用它的 Chromium 程序，但**不读取它的任何配置或会话**。
3. 在应用数据目录创建两个标记文件（需要管理员权限）：

   ```sh
   sudo sh -c 'echo 1 > /vol1/@appdata/dsh-fnos/browser-acceptance.enabled'
   sudo sh -c 'echo 1000 > /vol1/@appdata/dsh-fnos/browser-acceptance.uid'
   ```

   `browser-acceptance.uid` 必须是准备验收的飞牛账号 uid（数字）；内容非法时开关保持关闭。两个文件必须都是普通文件（符号链接一律忽略）。
4. 重启应用（应用中心先停后启），确认 `dsh-fnos.log` 出现 `browser-acceptance-enabled`。
5. 用该 uid 的管理员账号打开 `/app/dsh-fnos/acceptance/`，在界面中发送任意消息：内置离线模型只发出 `open_test_site`，工具结果应为 `{"fixture":true}`。
6. 验收结束后删除标记文件并重启应用；随后按日志或 manifest 路径人工清理 `experimental-browser-tmp/instance-*` 残留目录。

## 关闭方式

```sh
sudo rm -f /vol1/@appdata/dsh-fnos/browser-acceptance.enabled /vol1/@appdata/dsh-fnos/browser-acceptance.uid
```

重启应用后开关恢复默认关闭。即使标记文件存在，缺少 `DSH_FNOS_BROWSER_ACCEPTANCE=1` 或 overlay 缺少 `# fixed-private-fixture-reviewed-v1` 标记时，supervisor 也会拒绝启动。

## 未证明项与风险

- 真实 Web GUI 中「飞牛登录 → 验收页 → 离线模型 → 工具调用 → 固定页打开」的完整链路由本次手测确认；在此之前只分别验证了 Web 就绪与真实 Agent 工具调用。
- 认识的启动进程组之外的后代（`setsid` 脱组、worker 被 SIGKILL）无法证明已清理，属于已知残留风险。
- 临时实例拥有与普通 Harness 相同的宿主权限，标准 Web 工具（含 shell/终端）在实例内可用；因此只能用于整机可信的管理员验收窗口，不得对普通用户开放。
- 浏览器内核沙箱只观测到主进程 capability 清零与 `chrome://sandbox` 报告，未证明所有子进程与全部内核沙箱层；租户隔离需要独立系统账号、管理员监督进程与专属 cgroup，属于后续工作。
