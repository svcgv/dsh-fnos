# 浏览器网络限制研究原型（不得用于生产）

此目录是独立实验，不会自动启动、不安装到 Harness、不修改浏览器插件。

`createRestrictedProxy({ rules, lookup?, connect?, timeoutMs? })` 创建仅接受 HTTPS CONNECT 的原型。`rules` 为 `{ host, port, addresses }` 数组：域名必须为小写 ASCII，端口和每个允许的 IP 均需显式指定；默认没有规则即全部拒绝。调用 `accept(socket)` 将可信 IPC 转交来的 TCP socket 交给代理；接口自身不创建监听端口。调用 `close()` 销毁活跃连接。`lookup` / `connect` 是测试注入点，实际部署必须使用默认实现、不可由用户控制。

每次 CONNECT 重新解析 DNS，若任何结果未列入该规则则拒绝；建立连接后核对远端地址和端口。禁止代理认证、Cookie、请求体、IP 形式的 CONNECT 目标、重复头和非 CONNECT 请求。隧道开始前解析一个完整且未分片的 TLS ClientHello，必须含与 CONNECT 主机完全相同的 SNI，拒绝 ECH。该解析故意保守，某些合法 TLS 客户端可能被拒绝。仅适合通过受隔离网络命名空间里的回环代理入口提供传入连接；本模块不创建命名空间、不提供 IPC 启动器，也不构成完整的出站网络隔离。

## 关键安全限制

**不能据此承诺严格的逐站点授权，不能启用到实际用户环境。** TLS 隧道建立后，代理看不到加密的 HTTP Host、HTTP/2 authority、重定向响应或应用内容。即使 CONNECT、IP 与 SNI 一致，允许的共享 CDN 目标可能服务其他站点；允许的网站也可能成为转发其他网站的中继。原型不保证禁止同隧道的 HTTP 请求跨授权域，也无法验证禁止重定向。浏览器安全配置、禁用 HTTP/2 和 QUIC 只能减少风险，不能替代可信网络边界或让未解密的 HTTP 可见。若要求严格域名和重定向策略，需要另行设计并审查能够验证应用层请求的方案（例如受控 TLS 检查，并明确证书信任、隐私和兼容性成本），或者改用目标站点独占网络目的地的更窄威胁模型。

网络命名空间本身也不隔离文件系统 Unix socket、同系统账号进程和文件。宿主侧控制进程、桥接进程与浏览器的身份边界必须单独解决。未经隔离测试不能声称多飞牛用户安全。

## 本地测试

Node 26：`node --test browser-network/*.test.mjs`。单元测试使用本机临时 TCP 服务器和合成 ClientHello。`namespace-e2e.test.mjs` 另外为本机 x86 飞牛安装的 Chromium 建立独立网络命名空间和无外部路由的回环代理，代理经 Node IPC 传递 socket 到宿主侧研究原型；只使用自建临时 loopback HTTPS 测试服务、临时自签证书和固定 DNS 响应，不连接用户浏览器或外部网站。它需要非 root 用户命名空间、`ip`、`openssl`、固定飞牛 Chromium/Node 26 路径及动态库；仅本机验证，不是安全审计。测试的 Chromium 使用 `--ignore-certificate-errors` 仅为信任自签测试证书，不得用于真实网站。

**联调未达标：**本机 Chromium 152 的 ClientHello 含 `0xfe0d` ECH 扩展，启用 `--disable-features=EncryptedClientHello` 后仍出现；原型按安全规则拒绝包括疑似 GREASE 在内的所有 ECH，因此连配置允许的自建目标也不能访问。回归测试记录了拒绝、宿主 loopback 不直连以及待办项；DNS/IP/SNI 的独立单元拒绝测试不等同于真实 Chromium 端到端通过。未判断该扩展实际是 ECH 还是 GREASE，不得通过移除拒绝放宽策略。

IPC 接收端必须在发送句柄前使用 `net.createServer({pauseOnConnect:true}, ...)`，避免 Node 在传递套接字之前读走首包；宿主代理接收后再 `resume()`。测试桥只为该用例设计，无认证或完整进程/文件隔离，不可接入 Harness。即便未来联通，只能在管理员控制的独占目的地和可信站点模型下讨论连接层限制，仍不能保证密文内的逐 URL、HTTP Host、重定向或子请求策略。

## 独立的固定端点测试（不改变上述 strict-SNI 策略）

`fixed-endpoint-test-only.mjs` 与 `fixed-endpoint-e2e.test.mjs` 是另一个独立实验，只允许临时本机服务 `127.0.0.1:<明确配置端口>`；空策略和其他地址均报错。CONNECT 的 authority 必须是 `allowed.test:<配置端口>`，但真正的上游 socket 完全使用固定配置值，连接后再次核对目标。它不做 DNS 解析，也不以 SNI 或 ECH 为授权依据。仅此实验允许 ECH；原 strict-SNI 代理仍然默认拒绝所有 ECH。

本机测试使用独立网络命名空间，无 IPv4/IPv6 外部路由；受控 Chromium 只能经该命名空间 loopback 和 IPC 传递的 socket 到测试代理。测试用 openssl 创建临时自签证书，Chromium 仅通过该证书的 SPKI pin 接受证书；没有使用全局 `--ignore-certificate-errors`。Chrome 的 SPKI 例外可能同时放宽名称/证书错误，**这里的 pin 仅用于本地实验的证书公钥匹配，不证明正常 PKI 或域名身份**。证书、私钥和 profile 在正常测试结束时删除；意外 SIGKILL 或系统掉电不保证清理。

受控本机 Chromium 测试验证目标能成功访问（观察到 ECH 扩展）、伪造 CONNECT authority 和另一自建服务的端口不能访问、网络命名空间不能直接连接宿主 loopback、错误 SPKI pin 无法取得页面，以及关闭代理后新连接失败。测试结果**不是对任意网站、DNS、同 UID 进程、Unix socket、代理认证、宿主路由或浏览器沙箱的完整安全证明**，也不保证每个 URL、重定向、子请求或 TLS 内 Host 的授权。目标服务必须始终由管理员独占且不提供转发；共享服务、网络地址漂移、透明代理/NAT 和服务自身转发均不在实验保证范围内。严禁接入生产、用户站点或 Harness 插件。

## 外部单端点代理：离线研究，禁止接入

`public-endpoint-experiment.mjs` 是与 strict-SNI 和固定 localhost 实验分离的原型。要求精确小写域名、端口和一个 IPv4 地址；缺少策略、地址非 IPv4、IPv4 特殊用途静态拒绝范围或接口地址则拒绝。CONNECT authority 和 Host 必须与配置完全一致；目标固定由配置指定，不解析 DNS，连接后重新比较实际远端 IP/端口并复查本机接口。它透明转发 TLS，包含 ECH，不读取密文 Host；每方向上限 8 MiB，最多 8 个客户端，启动/空闲超时 5 秒。测试注入入口 `createOfflineMockEndpointExperiment` 只供 mock，绝不能安装或暴露。

地址过滤是**静态保守排除表，不证明全球可路由、不证明当前 IANA 登记状态，也不证明目标不是宿主服务**。公网地址可以通过路由、DNAT 或透明代理落到本机服务；`remoteAddress` 只能反映 socket 的目标地址。本机接口清单也不能证明所有 NAT/路由或动态变化。当前代码没有验证管理员对 IP/端口的独占、外部服务 authority 策略、浏览器命名空间/宿主 Unix socket 隔离、服务端 TLS 身份和用户隔离，因此**不能为真实外网站点启用，也不能宣称已解决宿主服务禁令**。对无法核实的目的地或环境，实际部署必须拒绝；已有代码并未实现全部核验，不能用作部署入口。

`node --test browser-network/public-endpoint-experiment.test.mjs` 仅建立本机回环监听并把上游连接替换成内存 mock，不连接公网；覆盖特殊地址、接口变化、authority、远端地址/端口、DNS 不调用、数量/超时/字节限制及关闭。ECH 测试只是传递不透明字节，不是浏览器 TLS 联调。管理员独占的站点仍须自行拒绝不匹配的 HTTP Host/authority、不得转发；代理本身不能识别 TLS 内 URL、重定向或子请求，更不能将此模型推广到共享 CDN 或任意网站。
