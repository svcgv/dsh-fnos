# Chromium 隔离研究原型

**仅供研究验证，不是安全沙箱产品；未接入 worker、用户服务或 Harness，不能用于执行不可信网页。** 本机仅测试了 Linux amd64 和 Node.js 26；ARM64 未验证。本原型也没有做浏览器网络代理、站点白名单、用户授权或多租户隔离。

## 运行

在已安装本机飞牛浏览器和 Node.js 26 的机器上，以普通用户在项目根目录运行：

```sh
node browser-isolation/probe.mjs
```

测试路径和可执行文件固定为本机配置：`/vol1/@appcenter/fygo-browser/app/vendor/runtime`、`/vol1/@appcenter/dsh-fnos/runtime/lib/libatomic.so.1`、`/var/apps/nodejs_v26/target/bin/node` 以及脚本中列明的系统文件；不存在、不可读或者系统禁用非特权命名空间时直接失败。不会使用 sudo、`--no-sandbox` 或现有浏览器 profile。

正常输出 JSON 中 `uid` 和 `gid` 为 1000、`hostFile` 和 `hostPathSocket` 为 `ENOENT`，`chromiumStatus` 为 0，并包含预期的 data 页面 DOM；进程退出码为 0 才表示整个探针成功。启动前由父进程创建自有临时文件和 socket，并从宿主侧成功连接 socket 作为正向对照。里面的 UID 1000 是内层命名空间中的映射，不表示宿主用户切换为 UID 1000。

## 做了什么

- 父进程打开自身 user、mount、PID、network 命名空间的句柄，再以固定绝对路径运行 `unshare` 创建四个新命名空间。内嵌启动脚本在任何挂载之前逐一与传入的父进程句柄比较；句柄缺失或任何命名空间未改变即退出。句柄随后关闭；没有供误直接调用的独立挂载脚本。
- 在 private mount namespace 的自建 tmpfs 上建立临时根。只读 bind 浏览器运行时三个库目录，单独只读 bind Node、`unshare`、`umount`、动态链接器及其列明的依赖、`libatomic`；仅 bind 四个基本设备并挂载新 PID namespace 的 `/proc`。这不是经过最小依赖审计的生产文件系统。
- `pivot_root` 后卸载旧根，在第二层 user namespace 中以非 root UID/GID 1000 运行探针，断言自建宿主文件读取和路径型 Unix socket 连接均得到 `ENOENT`。随后使用全新临时 HOME/profile、无 `--no-sandbox` 启动 headless Chromium，验证 data 页面 DOM。
- 普通结束、测试错误、超时，以及子进程运行期间的 SIGINT/SIGTERM，会尽力结束进程组、销毁自建 socket 连接并清理临时目录；服务端关闭等待最多一秒。清理错误会报告并导致非零退出。父进程被 SIGKILL、宿主崩溃等情况下清理无法保证：子进程可能仍运行、私有挂载可能仍存活，临时目录中可能残留自建探针文件和 socket。此原型不提供生产级监督或遗留资源回收。

## 已知限制

- Chromium 的 `chrome://sandbox` 在早期临时根实验中以信号 6 终止，未能取得自报的各层沙箱状态。没有传 `--no-sandbox`、页面能渲染、内层 `CLONE_NEWUSER` 曾成功，**都不证明各层 Chromium 沙箱已启用或有效**。
- 直接 `chroot` 的对照实验无法启动 Chromium：它报告 SUID sandbox helper 配置不正确；本原型使用 `pivot_root`。本机原型缺字体配置，先前出现 Fontconfig/HarfBuzz 错误；也可能出现 D-Bus 不可用日志。data 页 DOM 不代表截图、字体、交互或真实网站功能正常。
- 内层 network namespace 隔离的是此次探针默认网络视图，尚未验证网络规则、抽象 Unix socket、代理或全部侧信道。未来若加网络连接或额外挂载，需要重新设计和验证。不要把一次文件与 socket 否定测试视为完整逃逸测试。
- 不能保证防范恶意同宿主 UID 进程、开放的继承描述符、内核漏洞、浏览器漏洞、资源耗尽或同 UID 并发干扰；不适合作为多租户安全边界。浏览器 runtime 的库目录整体只读暴露在临时根内，未来应审计其内容与子挂载。
- 本原型未验证 ARM、发行版差异、机器重启后的残留处理、完整清理信号矩阵、系统安全策略，以及与实际 Harness 运行环境的集成。
