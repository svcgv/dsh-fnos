# 浏览器 Host 插件：固定验收与受控网络访问

当前部署有两条独立路径：

- 正常 Harness 工作区右侧栏的多标签「受控浏览器」：管理员开启后使用网络浏览模式。用户从右栏指南新建互相独立的标签，模型的 `navigate` 每次都会在目标标签内申请用户批准，支持本机、局域网和公网 HTTP/HTTPS 地址。详见 `docs/browser-acceptance.md`。
- `/acceptance/` 固定页验收：只打开内置 `http://127.0.0.1:38179/` fixture，不接受 URL 或 HTML。


## 右侧栏多标签 UI（网络浏览模式的当前形态）

`live.patch.yml` 同时加载两个插件行，缺一不可：

- `dsh-fnos-browser-live`（`./live.mjs`）：Host 端多标签注册表、`browser-live/ws`，以及 `browser_live_control` 工具（`list_tabs` + 每个标签的 `tabId` 定向操作，标签上限 6、同时运行 worker 上限 3）。
- `dsh-fnos-browser-sidebar`（`./sidebar/index.mjs`）：Client 插件入口，`sidebar/package.json` 的 `dsh.client` 清单指向 `sidebar/client.js`，在右栏 guide 注册「新建受控浏览器」，并在每个标签里渲染画面、工具栏与访问授权层。

每个标签使用独立 WS `browser-live/ws?sessionId=…&tabId=…`；服务端先 `ctx.connection.admit(req)` 且只接受 owner principal（已登录浏览器会话）的连接，sessionId 还必须与实际 agent session 匹配。ID 只用于路由，不是授权凭据。

旧 `panel/` 前端资源仍由 Host 以 `browser-live/panel.js`、`browser-live/panel.css` 提供，用于兼容既有文档与本地自测；Host 不再向页面注入它们，正常 UI 中不存在右下角浮窗。不要把 `panel/` 与新右栏同时当作同一实例的视图启用。
以下内容是低层 worker 和既有离线实验的说明；网络浏览仍不是多租户安全边界，也不构成生产级网络隔离。

**不得安装到用户 profile 或启用。** 这不是浏览真实网站的功能、不是多租户安全边界，也没有经过生产安全审计。patch 默认禁用，入口还有单独的进程级实验开关；本仓库不配置、不启动该插件。浏览器 worker 的输入 HTML 必须是可信测试内容。实验文件系统隔离尚未完成安全审计，固定只读绑定会暴露绑定内容，同 UID 进程可能干扰；不得将不可信网页、秘密或用户数据交给它。

该骨架为每个可信 Agent 单独注册 `browser_offline_prototype`，且仅向相同的 `execution.agent` 受理请求。每个 Agent 启动独立 worker，通过固定路径的 stdin/stdout JSON 行协议通信，不接受 URL、进程路径、浏览器配置路径、隔离开关或调试端点。隔离模式启动失败时调用失败，不回退到默认模式。worker 及其 Chromium 配置均为临时资源，但 SIGKILL、机器断电及 cleanup 超时不能保证资源回收。作用域或临时目录不是 Unix 用户级隔离。

## 两种默认关闭的模式

| 模式 | 进程级开关（精确 `=1`） | worker 启动参数 | 工具动作 |
| --- | --- | --- | --- |
| 离线 HTML 实验（既有） | `DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT=1` | `--experimental-filesystem-isolation` | `open`（可信 HTML）、`snapshot`、`click`、`fill`、`screenshot`、`diagnostics`、`close` |
| 验收固定页（新增） | `DSH_FNOS_ACCEPTANCE_FIXTURE=1` | `--experimental-private-http-fixture` | 仅 `open_test_site`（无参数） |

- 默认（两个变量都不为 `1`）：插件不加载 Harness 包、不注册工具、不启动 worker。
- 两个变量同时为 `1` 时固定页模式优先，**绝不会**回退到可打开任意 HTML 的离线模式。
- 模式只由宿主进程环境决定，不接受任何工具参数、配置文件或模型输出。`open_test_site` 的请求只允许 `{"action":"open_test_site"}`；发送 `open`、`html`、`url` 或其他字段会在启动 worker 之前被拒绝。
- 固定页模式下工具描述明确写“仅内置测试页，不支持任意网站/URL”，schema 只有 `action` 枚举 `open_test_site`。
- 固定页模式复用 `browser-worker/` 的 `--experimental-private-http-fixture`：只导航到内置固定的 `http://127.0.0.1:38179/` 测试页，不使用任意 URL/HTML；仍要求 Chromium 沙箱检查（不添加 `--no-sandbox`）、公开 CDP 或网络命名空间外访问。见 `browser-worker/HTTP-EXPERIMENT.md`。
- 固定页模式要求父进程提供**非空的绝对路径 `TMPDIR`**（验收 supervisor 设置的私有 0700 目录）。worker 只继承这一个父环境变量，其余 env 仍固定；worker 的临时根与失败残留因此落在验收保留目录内，而不是宿主默认 `/tmp`。缺失、空值、相对路径或含 NUL 的 `TMPDIR` 会在启动 worker 前被拒绝；legacy 模式不传 `TMPDIR`，行为不变。

`acceptance.patch.yml` 是验收组合覆盖层（不是默认 patch）：同时需要 `DSH_FNOS_BROWSER_ACCEPTANCE=1` 与 `DSH_FNOS_ACCEPTANCE_FIXTURE=1`。验收组合**只**启用固定页模式：内置验收模型发送 `open_test_site`，并按 worker 返回的 `{"fixture":true}` 判定成功；它不再接受 `DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT=1` 的任意 HTML 旧组合。既有的离线 HTML 实验仍可通过 `cordis.patch.yml` 的实验性手动启用 + `DSH_FNOS_OFFLINE_BROWSER_EXPERIMENT=1` 使用，行为不变。

`close` 只在 worker 明确返回 `{"closed":true,...}` 且停止确认成功时才算成功；未确认的结果、输出中断或停止失败都会作为工具错误抛出，文本以“浏览器未确认关闭”开头，并带上 worker 报告的保留临时目录路径（若返回）。不会重试成“成功”。

**尚未验证真实 Harness Web profile 部署，不能通过启用开关绕过安全审计。** 已在本机以隔离内存上下文对两个真实 Agent 和真实 worker 做离线组合实验（见下文），仅覆盖受控测试用例。包当前固定依赖 Harness 0.2.2-rc.5，其 worker 依赖相邻仓库目录，尚未构建为可部署包。生产级发布之前需要重新设计打包、配置与系统隔离、出站策略、凭据/文件隔离、进程监管、图像隐私和双架构实测。无图标和翻译资源，因为这只是禁止安装的实验测试骨架。

## 测试

本地单元测试（Node 26；使用假 worker/假宿主依赖，不访问真实浏览器、不加载安装的 Harness 包，也不需要真实 profile）：

```sh
node --unhandled-rejections=strict --test --test-concurrency=1 browser-plugin/*.test.mjs
```

真实 worker 联动是可选测试，固定执行实验性文件系统隔离模式，需要本机已安装的 `fygo-browser` Chromium、`/var/apps/dsh-fnos/target/runtime/lib` 中的 Node 动态库，以及支持非特权用户命名空间、挂载、PID 和网络隔离的 Linux 环境：

```sh
DSH_FNOS_REAL_WORKER_TEST=1 node --test browser-plugin/integration.test.mjs
```

固定页真实 worker 联动同样可选，额外需要固定私有测试页能力可用（`--experimental-private-http-fixture`）：

```sh
DSH_FNOS_FIXTURE_WORKER_TEST=1 node --test browser-plugin/integration.test.mjs
```

以上只验证特定机器的离线实验，不代表其他架构或环境可用。

真实 Cordis、Harness Agent 与工具注册表的隔离加载测试（仅内存会话，不加载模型服务提供方或持久化，不启动浏览器、Web 服务或网络请求）依赖本机 `/vol1/@appcenter/dsh-fnos/harness/node_modules` 已安装的匹配版本；测试只在专属临时目录复制插件、链接依赖，并使用隔离的 HOME 和环境变量，不读取或修改现有 profile：

```sh
DSH_FNOS_REAL_CORDIS_TEST=1 node --test browser-plugin/cordis.test.mjs
```

它分别验证默认不开启、既有离线模式、固定页模式：注册按两个真实 Agent 隔离、跨 Agent 拒绝、Agent 销毁后注销；固定页模式还校验 schema 只含 `open_test_site`、伪造 `open`/HTML 在启动 worker 前被拒绝，以及内置验收模型发出固定工具调用。它不启动 worker，也不验证生产部署。

真实 Agent + 真实实验 worker 的离线组合测试：

```sh
DSH_FNOS_REAL_AGENT_WORKER_TEST=1 node --test browser-plugin/agent-worker.test.mjs
```

测试复制代码到自建短临时目录，链接本机 Harness 依赖，只创建无持久化、无模型提供方的内存 Agent，不读取或修改用户 profile；两个 Agent 各打开可信离线 HTML、验证快照和跨 Agent 拒绝，销毁 A 后验证 B 仍工作，然后检查各 worker 退出和临时目录回收。它不涉及 Web 部署、模型请求、真实站点、同 UID 对抗或生产多用户隔离。失败或超时时尽力终止仅由本测试创建的进程组；清理无法确认时保留自建目录并报告，不能保证 SIGKILL 后浏览器后代已退出。

实验隔离启动时使用固定 `/tmp` 下的短路径私有目录建立真实监听 Unix socket，先完成宿主正向连接，再检查隔离后不可达；探测失败会拒绝启动。worker 的独立测试覆盖了长 `TMPDIR`，但这只是受控环境中的隔离探测，并不能证明其余文件、socket 或同 UID 进程安全。`SIGKILL`、崩溃或断电后仍不能保证浏览器后代和临时数据回收；生产部署未验证。
