# 私有 HTTP 测试站：隔离可行性实验记录

**这不是生产功能或部署方案。** worker 不支持访问任意网站；默认仍只支持可信离线 HTML。仅为获准的管理员临时验收提供显式开关的固定私有 HTTP fixture，不能由用户配置地址或内容，也未接入插件。以下均为本机 Linux x86_64、Node 26、Chromium 152 环境中的受控实验，未接入用户 profile、实际网站或生产应用。实验产生的网络服务和目录均为自建资源。

## 前置条件与发现

- 启动入口先对比父 user、mount、PID、net namespace 描述符，均不同后才可修改本次 netns 的 lo 或进行 mount。netns 的 owner 必须验证为预期的外层 userns；不可凭 URL 检查代替网络隔离。
- 在上述 guard 之后，外层 userns 可通过 `/usr/bin/ip link set lo up` 启用独立 lo；不需要、也不能对宿主网络操作。
- 外层对 netns fd 执行 Linux `NS_GET_USERNS` ioctl 后，返回 fd 的 inode 与外层当前 userns inode 相同。本机 `/usr/bin/lsns` 在完成 guard 后将新 PID ns 的 proc 挂到私有 `/proc` 时，`lsns -p $$ -t net -o NS,TYPE,ONS -n -r` 返回 `4026533628 net 4026533625`，外层 userns 为 `user:[4026533625]`，当次 ONS 相同。具体 inode 是运行时实例值。
- `lsns` 不可靠的失败形式必须处理：不挂私有 proc 时，`-p $$` 曾返回**空输出但退出码为 0**；在零能力内层调用时 ONS 输出 **0 但退出码仍为 0**。必须拒绝空、0、多行、非法格式和 owner 不匹配。`lsns`、`ip`、`setpriv` 在本机可用，但未证明它们或其依赖已装入 FPK、存在于其他系统或适配 ARM64；不得将宿主工具假定为生产依赖。Node 标准库不提供上述 ioctl 的直接封装。

## 权限顺序与 Chromium 验证

- 若先执行 `setpriv --bounding-set=-all --no-new-privs` 再创建内层 userns，uid_map 写入失败（`Operation not permitted`）。若先映射成非 root 再普通执行 setpriv，`CapBnd` 仍为 `000001ffffffffff`；工具成功退出不等于能力已剥离。
- 本机可行的实验顺序：先 `unshare --keep-caps --user --map-user=1000 --map-group=1000`，再立即 `setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs`，随后执行 Node；经 `/proc/self/status` 校验五组 Cap 字段全部为 0、NoNewPrivs=1、UID/GID=1000 后才允许后续动作。`--keep-caps` 暂时给予新内层 userns 中的能力，必须立即剥离，不可在其间运行测试站或浏览器。
- 上述严格顺序、私有 mount/PID/net/user namespace、无 `--no-sandbox` 的受控实验中，从启动器的私有 proc 读取真实 Chromium 主进程 `/proc/<pid>/status`：Uid/Gid 的四项均为 1000，CapInh/CapPrm/CapEff/CapBnd/CapAmb 均为 0，NoNewPrivs 为 1。同次 `chrome://sandbox` 显示 Layer 1 Namespace、PID namespaces Yes、Network namespaces Yes、Seccomp-BPF sandbox Yes。**尚未检查 Chromium 全部后代进程，不能将此视为完整安全审计。**
- 同一顺序下，零能力内层和它再创建的 `unshare --map-root-user` 后代尝试 `ip link set lo down` 均得到 `RTNETLINK answers: Operation not permitted`，lo 保持 UP。该结果仅为本机测试，CapBnd 不替代 netns owner 和路由校验。

## 独立网络探测

- 宿主只创建自有的 127.0.0.1 临时 HTTP 监听器并先成功连接一次；隔离侧连相同 host:port 得 `ECONNREFUSED`，宿主计数仍为 1。隔离侧连接保留测试地址 `203.0.113.1`、`2001:db8::1` 得 `ENETUNREACH`，没有访问真实外网；接口仅 lo，IPv4 路由表无项，IPv6 路由条目均为 lo。
- 宿主与隔离内各启动自有 HTTP 监听器、使用相同 127.0.0.1:port。隔离内得到 `PRIVATE_TEST`，宿主得到 `HOST_OWNED`；证实该受控例子中宿主没有访问到隔离站。不能推广为所有继承 fd、网络协议和内核漏洞的证明。
- 最初的独立网络探测未验证所有继承网络 fd、真实浏览器请求、两个完整 worker 的固定站并发、全生命周期和启动取消；后续固定 HTTP fixture 已验证受控真实浏览器请求，但其他项目仍未完整验证。浏览器的 CDP 管道不应变成宿主网络通道；未来必须明确验证可继承 fd、IPv4/IPv6 路由和网络连接，并在任一检查失败时拒绝启动，不能回退至宿主网络。

## 固定私有 HTTP 研究 fixture

默认关闭，仅用测试代码中的固定页面、端口和路径；不存在任何供用户提供 URL、HTML 或端口的接口。实验不安装到 profile，也未与生产 worker/plugin 连接：

```sh
DSH_FNOS_PRIVATE_HTTP_RESEARCH_TEST=1 node --test --test-concurrency=1 browser-worker/private-http-research.test.mjs
```

本机需 Node 26、x86 Chromium、支持无特权 user/mount/PID/net namespace 的 Linux，以及本机固定路径的 `unshare`、`lsns`、`ip`、`setpriv`、`mount`、`stat` 与相应动态库。它们仅是研究测试前提，并未验证已打包或跨架构可用；端口被占用、依赖缺失、权限不可用或 guard 失败均报错，不会选择别的端口或回退宿主网络。测试使用的宿主正控监听器也是自行创建，且连接仅限这些自有监听器；不会打开真实网站或使用用户凭据。

fixture 在内存中派生隔离启动器，先校验四种 namespace 已改变，再于私有 mount namespace 挂载私有 proc，要求 `lsns` 输出非空、非零、单行且 net inode 与实际 netns 一致、owner inode 与外层 userns 一致，之后才启用 netns 中 lo；`lsns` 输出为空的注入测试验证必须拒绝启动。内层严格剥离所有五组 capability 并设置 NoNewPrivs，校验真实 Chromium 主进程状态及 `chrome://sandbox` 后，才对固定 `127.0.0.1:38179` 站点执行页面导航、填写、点击、截图、console、HTTP 500 和服务端主动断连验证。

宿主在固定站同端口启动独立正控，访问时获得宿主自有内容而非隔离站；另一自有宿主监听器先正向验证，隔离内对其端口连接被拒绝且宿主请求计数不增加。启动器与 Chromium 的 stdio 显式允许列表被检查；测试还确认一条自建宿主 TCP socket 的 inode 不在显式 stdio FD 中。**额外 FD 清点存在不可读项时，独立观测子测试标为 skip／inconclusive；本机曾出现 1 项不可读。** 这不是对所有宿主连接、瞬时 FD 或 Chromium 后代的证明。站点正常关闭有时限，测试在父进程退出后确认原进程组不再存在；这不能证明已脱离该进程组的后代全部退出。清理无法确认时保留自建目录并报告；SIGKILL 或崩溃无法保证所有后代和资源回收。

## 跨网络命名空间的继承 socket 研究测试

`browser-worker/socket-fd-research.test.mjs` 是默认跳过、仅限本机实验的 fixture，不修改生产启动器或 profile，也不依赖或连接真实宿主服务。显式运行：

```sh
DSH_FNOS_SOCKET_FD_RESEARCH_TEST=1 node --test --test-concurrency=1 browser-worker/socket-fd-research.test.mjs
```

依赖本机 Node 26、已安装的当前 x86 Chromium、隔离 worker 已列出的固定工具及库、`/usr/bin/setpriv`、`/lib/x86_64-linux-gnu/libcap-ng.so.0`，以及允许无特权 user/mount/PID/net namespace 的 Linux。测试通过 Node 26 的内部 `_handle.fd` 获取**自身创建**的宿主回环 TCP 连接，用宿主 `/proc/net/tcp` 验证其 inode 是 ESTABLISHED；再将它作为 fd 9 有意注入仅在内存中改写的隔离启动器。隔离内读取 `/proc/self/fd/9` 的 inode 对照，并通过该 fd 将固定控制消息发回自建宿主监听器。相同扫描函数必须能在内层进程自身 fd 列表中找到该 inode：这是单独、必须通过的正控子测试；同时验证该 inode **不在隔离内 `/proc/net/tcp` 中**。因此仅检查隔离 netns 的 TCP 表无法排除已继承的宿主网络连接。

随后用独立子测试立即和定时采样 Chromium **主进程** `/proc/<pid>/fd`，查找正控 inode；正控若被观察到则失败。任一快照不可读、进程消失等导致采样不完整时，浏览器子测试标为 **skip／inconclusive**，不能算安全通过，也不掩盖已经观察到的正控泄漏。一次本机运行 21/21 个快照完整且未观察到正控；另一次出现 1 个不完整快照，结果按不可判定处理。这仅能描述采样期内该正控的观测，**不能原子观测 exec 瞬间的所有 FD，也不能证明其他 socket、瞬态 fd、全部 Chromium 后代或生产隔离安全**。测试故意注入的 socket 只通向本次自建监听器；固定超时、进程组终止和目录回收仅为尽力清理，SIGKILL、超时和崩溃不能保证所有后代退出。

默认关闭的 `DSH_FNOS_CHROMIUM_RESEARCH_TEST=1 node --test --test-concurrency=1 browser-worker/chromium-research.test.mjs` 是另一项后代采样：曾观察到 Chromium 主进程五组能力为零，但部分后代的 CapPrm/CapEff 或 CapBnd 非零，且部分网络 namespace 不同；这不证明它们能管理外层 netns。userns 和网络 owner 的对应关系、不可读 FD、瞬时消失 PID 和完整后代覆盖仍未解决；测试一旦观察到进程、namespace 或 FD 不可读，会标为 skip／inconclusive，不能将采样当作全量证明。

## 剩余工作与限制

此后已将固定站能力实现为 worker 中默认关闭的 `--experimental-private-http-fixture` 和 `open_test_site`，只供用户明确批准的管理员临时 Harness 验收实例；详见 `README.md`。没有配置地址、内容、外部资源或转发的能力，也未接入插件、安装包或用户 GUI；不得包装为可访问任意网站的功能。真实 Chromium 页面操作、诊断、HTTP 500、断连、受控宿主拒绝、FD 正控、正常清理和 SIGTERM 已单独测试；双 worker 并发及所有启动阶段取消尚未完整验证。

worker 为 `detached:true` 的直属启动器登记独立进程组，先验证 leader 身份、发 SIGTERM，超时后必要时发 SIGKILL，仅在 `kill(-pgid,0)` 返回 ESRCH 且 `/proc` 扫描未发现该组成员时将该组标记为空；无法确认则保留 worker 临时 profile，并在 close 结果返回未确认及路径。此检查存在 PID/PGID 复用竞争且不是完整进程树核验，不能排除子代通过 `setsid()` 脱组；worker/Harness 被 SIGKILL、机器掉电或内核异常时也不能保证后代退出或资源回收。未获得 cgroup v2 委托，不能据此声称整棵进程树已清除；验收主管需独立保留和处理其整个实例目录。`/tmp` 自建探测和 HTTP 连接仅尽力有界清理。同 UID 干扰、只读绑定暴露、架构依赖、Chromium 沙箱兼容性与多租户安全均未解决，禁止生产启用。
