# 离线浏览器 worker 实验原型

**不提供实际网站访问，也不是 MCP 服务或生产级多用户隔离方案。** 不应直接接入或暴露给不可信用户。本原型验证 stdio 私有 CDP、独立临时 profile 和离线浏览器基本操作；所有输入 HTML 必须视为可信测试内容。默认模式没有文件系统隔离，网络命名空间也不阻止访问文件系统上的 Unix socket；相同系统 UID 的进程能够互相干扰。默认模式浏览器进程可以读取其应用账号有权限读取的文件，不得用来运行不可信网页或依赖其保护凭据。另有必须显式启用的实验性文件系统隔离模式，仍不能作为安全边界使用。

## 安全机制与边界

- 默认模式固定 `/usr/bin/unshare --user --map-current-user --net` 在新的 Linux 用户和网络命名空间执行应用插件的 Chromium，不使用 `--no-sandbox`，不向宿主开放 CDP 端口，fd 3/4 是私有管道。新网络命名空间中没有宿主网络接口；`unshare` 不可用或启动失败则报错退出，不降级到共享网络。
- Chromium 子进程仅继承显式 `HOME`、`PATH`、`LANG`、`LD_LIBRARY_PATH`，不继承凭据和代理环境；每次启动创建新的 `0700` 临时目录。worker 登记自己以 `detached:true` 派生的组及 leader，正常关闭、stdin 关闭或 SIGTERM/SIGINT 时仅向登记组尝试发送 SIGTERM、有限等待后必要时 SIGKILL，再要求 `kill(-pgid,0)` 返回 ESRCH 并检查 `/proc` 未见该组成员；检查不可用、超时或 leader 身份不能验证时返回未确认且保留目录。leader PID 和启动时间在发信号前核验，但进程退出及 PID/PGID 复用仍可能与检查竞争，不能当作无竞争的内核生命周期句柄。SIGKILL worker/Harness、机器掉电或后代 `setsid()` 脱组时，不能保证终止后代或清理，需要外部监管和恢复机制；没有委托 cgroup v2，不声称清除整棵进程树。目录不是不同飞牛用户之间的隔离边界。
- `open` 只接受离线 HTML；不开放网络授权或 URL 白名单。Linux 网络命名空间隔离的是网络栈，而非完整文件系统或 Unix socket，也不是对浏览器沙箱、内核或 Chromium 漏洞的额外保证。诊断只返回事件类型、控制台级别和 HTTP 状态，不返回日志正文、URL、Cookie、请求/响应头或正文；页面快照和截图仍可能包含敏感内容。
- 这个安装路径及内置动态库路径固定为当前 x86 测试机器，ARM64 和其它部署未验证。要支持真实站点，必须先设计、实现并独立测试实际连接层策略（包括重定向、DNS、WebSocket、IPv4/IPv6 与内网），不能以 URL 校验或 CDP 拦截代替网络边界；还需要 UID/会话隔离、授权策略、资源限制、故障回收与运维机制。

## 实验性文件系统隔离

`node browser-worker/worker.mjs --experimental-filesystem-isolation` 显式启用；其他或拼错的启动参数会拒绝而非退回默认模式。仅在本机 x86 测试环境验证，不得接入生产。该模式创建 user/mount/PID/net namespace：先验证父 namespace 描述符的类型及其与自身不同，再将 mount 设为私有、创建 tmpfs 根、将固定的 Chromium/Node/运行库和字体只读绑定后 `pivot_root`，最后在内层 user namespace 以非 root UID 1000 启动 Chromium，未使用 `--no-sandbox`；但尚未验证 Chromium 各层沙箱是否实际生效。环境与 profile 仍是独立临时的；启动时在固定 `/tmp` 下创建、校验归属与权限的短路径私有目录，建立真实监听 Unix socket，先在宿主连接并验证响应，再在隔离内检查同一路径返回 `ENOENT`，同时检查宿主临时目录不可见。该探测不接收外部路径，失败、超时或取消均拒绝启动；探测完成后关闭监听和连接并回收目录。独立测试还覆盖真实长 `TMPDIR`、宿主正向对照、隔离负向对照、启动取消与失败清理。`/tmp` 不满足安全检查或不可用时拒绝启动；这仅证明受控测试用例，不代表所有文件和 socket 攻击面均已封闭。

此隔离实现仍未完成安全审计：同 UID 对临时目录可能存在竞争与干扰；宿主 namespace 的差异检查本身不能证明完整隔离；固定只读绑定也会暴露绑定内容；没有资源限制、远程访问策略和可靠的异常进程回收。`SIGKILL` 或崩溃不能保证终止后代。不能用于不可信网页、跨用户保护或者生产发布。

## 仅管理员临时验收的固定 HTTP fixture（默认关闭）

这是对单工作区规则唯一获准的**管理员临时 Harness 验收实例**例外，不是多租户隔离或生产功能；尚未接入插件、Web GUI、用户 profile 或安装包。运行 `node browser-worker/worker.mjs --experimental-private-http-fixture` 显式开启，仅允许本程序固定的 `127.0.0.1:38179` 测试页及固定 `/500`、`/cut` 路径；不能传入 URL、端口或 HTML，也不能访问真实网站。此模式禁用 `open`，新增请求 `{id,op:"open_test_site"}`（不得携带额外字段），后续可使用 snapshot、fill、click、screenshot、diagnostics 和 close。`fill` 只改变固定页面的输入框，并不改变页面代码。

在原实验性文件系统隔离基础上，启动器先检查四个 namespace 不同，在私有 proc 中要求网络 namespace owner 与外层 user namespace inode 一致且结果非空非零，再启用隔离 netns 的 loopback；映射内层用户后立即删除全部 capability、设置 NoNewPrivs。内层检查自己的路由、文件系统和全部可读取 FD：除父进程专门创建的 stderr/CDP socketpair 外拒绝 socket，任何 FD 无法读取均拒绝启动。为正负对照，会短暂创建本程序自己的宿主 `127.0.0.1:38180` TCP 监听器，先在宿主完成握手，再要求隔离内访问同端口返回 `ECONNREFUSED`；该端口占用、正控失败或检查不确定时拒绝启动，不连接已有服务，也不降级。该监听仅绑定本机回环，启动检查完成即关闭。Unix socket 探针同样保留。真正启动后的 Chromium 主进程必须 capability 全零、NoNewPrivs 生效，且 `chrome://sandbox` 报告 Namespace、PID/network namespaces 和 Seccomp-BPF，之后才接收命令；无 `--no-sandbox`。

这些检查只针对启动瞬间及指定程序，不是对全部 Chromium 后代、瞬时 FD、同 UID 对抗者、浏览器漏洞或信号异常退出的形式化证明。正常关闭和 SIGTERM/SIGINT 尽力终止自有进程组，若无法确认该组消失则报告失败并保留临时目录；不能确认已脱组的后代，SIGKILL/崩溃不保证回收。固定依赖包含 x86 Chromium、Node 26、`unshare`、`mount`、`lsns`、`ip`、`setpriv` 和 `libcap-ng`；ARM、FPK 打包及其他宿主均未验证。仅本机的受控测试可执行 `DSH_FNOS_FIXTURE_WORKER_TEST=1 node --test --test-concurrency=1 browser-worker/fixture-http.test.mjs`。研究过程和局限见 `HTTP-EXPERIMENT.md`。

## 实验性固定 fixture live panel（默认关闭）

仅管理员临时验收可用，必须同时传入 `--experimental-private-http-fixture --experimental-live-panel`；单独传 live、重复参数、未知参数或其他组合均拒绝，不回退。先调用 `open_test_site`，再调用 `live_start`；不开放其他站点、HTML、URL 或脚本入口。live 模式不会改变上述文件系统、网络、用户与进程隔离边界，也不是多租户安全功能。

`{id,op:"live_start",quality?,maxWidth?,maxHeight?}`：可选 quality 为整数 1–80（默认 60）、maxWidth 为 64–1280（默认 1280）、maxHeight 为 64–800（默认 800）；返回 `{started:true,viewportWidth:1280,viewportHeight:800,maxWidth,maxHeight,quality}`。worker 使用固定 1280×800 CSS viewport 和 CDP JPEG screencast。异步帧为独立 stdout JSON 行 `{event:"frame",seq,data,width,height}`，`data` 是 JPEG base64，`width/height` 是 JPEG 实际像素而非 viewport 大小，seq 从 1 单调递增且重启流不归零。非响应事件没有 id；调用方必须分别处理事件和带 id 的响应。帧中不附带 URL、诊断或浏览器元数据，但**画面像素本身可能包含用户输入的敏感信息**，不可宣称像素已脱敏，也不应记录、持久化或向未授权方发送。输出事件不包含音频。

每个活动流期间收到的正常 CDP 帧由 worker 自动 ACK（协议无需也不支持 `live_ack`）；stdout 同时最多一个帧写入在途，慢消费者丢弃后续帧，正常输出间隔至少 100 ms，JPEG 数据解码前限 1 MiB，CDP ACK 在途上限 4。ACK 积压、失败或流输出失败时停流并发 `{event:"live_error",error:"live stream failed"}`。停止请求 `{id,op:"live_stop"}` 返回 `{stopped:true}`；该响应之后，以及启动之前、停止和关闭之后不再发送帧。关闭仍须检查下文 `close` 中的进程组清理结果。用户自己终止 worker/Harness 的 SIGKILL 会使流断开且不能保证资源回收。

`{id,op:"live_input",kind,...}` 只接受已启动流，其余未知字段拒绝；成功返回 `{accepted:true}`：

- `kind:"mouse"`：必填 `type`（`mouseMoved`、`mousePressed`、`mouseReleased`、`mouseWheel`）、有限数字 `x,y`（各须在 -100000..100000；再夹到 viewport 的 x=0..1279、y=0..799）。坐标单位是 CSS 像素、原点左上；UI 应根据实际帧的显示比例转换。可选 `button` 为 `none|left|middle|right|back|forward`，按下/抬起必须给出非 `none` 的 button；可选 `clickCount` 为整数 0..3，`modifiers` 为整数 0..15。wheel 必须给有限数字 `deltaX,deltaY`、各在 -1200..1200；分别为水平和垂直增量，正数向右/向下，其他类型不得带 delta。
- `kind:"key"`：必填 `type:"keyDown"|"keyUp"` 和非空 `key`（UTF-8 不超过 64 字节）；可选 `code`（不超过 64 字节）、`windowsVirtualKeyCode` 和 `nativeVirtualKeyCode`（各整数 0..65535）、`text` 和 `unmodifiedText`（各不超过 256 字节）、`modifiers`（整数 0..15）。字符串不得含 NUL；字段原样传给 CDP。`keyDown` 带 text 可能输入字符，`keyUp` 文本行为由 Chromium 决定；避免同时用 keyDown 文本和 insertText 导致重复。
- `kind:"text"`：必填非空 `text`，UTF-8 不超过 4096 字节且不得含 NUL，映射 `Input.insertText`。modifiers 位掩码为 Alt=1、Ctrl=2、Meta=4、Shift=8，可按位组合。

单测默认不启动实时 Chromium；可在已具备本机隔离依赖且安装 `/usr/bin/ffmpeg` 的自有测试机上显式运行 `DSH_FNOS_LIVE_PANEL_TEST=1 node --unhandled-rejections=strict --test --test-concurrency=1 browser-worker/live-panel.test.mjs`。测试检查 JPEG 实际解码、固定页输入、停止后不发帧及关闭组确认；慢消费者由 mock 覆盖，尚未验证真实慢消费者压力、多客户端及 WebSocket 端到端。首版画面只用于固定 fixture。

## 接口

Node.js 26 运行 `node browser-worker/worker.mjs`；输入输出均为一行一个 JSON。启动错误输出到 stderr 并非零退出。每个请求含 `id`（由调用者提供）与 `op`；响应为 `{ "id": ..., "result": ... }` 或 `{ "id": ..., "error": "..." }`。操作按输入顺序执行。请求行上限为 128 KiB，超限（即使尚无换行符）会报错并终止 worker。截图以 base64 内联返回，禁止记录或传播其内容。

- `open`：`{id,op:"open",html:"..."}`，最大 64 KiB，返回 `{offline:true}`。
- `snapshot`：返回 `{generation,elements:[{index,tag,text}]}`，最多 100 个可见控件。密码框显示为 `[REDACTED]`；其他内容仍可能含页面敏感信息。引用只用于紧随其后的操作；顶层页面导航后自动过期。
- `click`：`{id,op:"click",generation,index}`。
- `fill`：`{id,op:"fill",generation,index,value}`，仅 input/textarea，拒绝文件及密码框。
- `screenshot`：返回 `{mime:"image/png",base64:"..."}`。
- `diagnostics`：返回 `{events:[...]}`，最多 100 条脱敏事件。
- `close`：尝试关闭并退出。成功响应的 `result` 为 `{closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false}`；组或辅助资源无法确认时返回 `{closed:false,groupConfirmedEmpty:false,temporaryDirectoryRetained:true,temporaryDirectory:"绝对路径",error:"原因"}` 并非零退出。若组已确认但其他资源清理失败，`groupConfirmedEmpty` 可为 `true`；若删除目录操作本身失败，`temporaryDirectoryRetained` 为 `null`（状态不确定）并仍返回路径。调用方必须检查 `closed` 和 `groupConfirmedEmpty` 均为 `true` 才能认定**登记的进程组**已确认空；缺失响应、异常退出或 SIGKILL 均为未确认，不得自行推断。组确认不代表脱组后代已经退出；保留路径用于外部主管调查和处理，不能据此假设目录已安全清理。

测试：`node --test --test-concurrency=1 browser-worker/*.test.mjs`；实验隔离模式完整回归：`DSH_TEST_ISOLATED=1 node --test --test-concurrency=1 browser-worker/*.test.mjs`。测试要求当前宿主允许无特权用户命名空间，且上述浏览器路径可执行；测试在本机创建自有回环 HTTP 监听器验证浏览器无法访问宿主网络，并验证 UI 操作、截图、事件和正常清理。测试不能替代安全审计。
