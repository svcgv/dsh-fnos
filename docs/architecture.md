# 架构

## 目标与边界

本应用只承担三件事：**飞牛身份接入、用户级隔离、Harness 进程与代理**。聊天、工具、插件协议、会话格式全部交给上游 `dsh`，不自建替代实现，减少升级成本。

不做的事：

- 不实现用户间协作或工作区分享。
- 不把 Harness 暴露成独立端口服务。
- 不允许浏览器或工作区进程直接访问 Docker、宿主系统服务。
- 不复制用户 NAS 文件；接入外部目录时只做挂载/授权映射（后续版本）。

## 组件

| 组件 | 职责 | 关键文件 |
| --- | --- | --- |
| 配置 | 解析 `TRIM_*` 与开发覆盖 | `src/config.ts` |
| 身份 | 只从 `x-trim-userid` 取身份，校验数字格式 | `src/identity.ts` |
| 工作区存储 | 单工作区解析、旧项目迁移、路径约束 | `src/workspaces.ts` |
| 实例管理 | 每个 uid 使用 `nodejs_v26` 启动一个 `dsh`、解析 token、持有 Cookie、空闲回收 | `src/harness.ts` |
| 反向代理 | HTTP/WS 转发、Header 重写、Cookie 隔离、Location 改写 | `src/proxy.ts` |
| HTTP 层 | 路由、静态 UI、JSON API、权限判断 | `src/server.ts` |
| 入口 | 监听 Unix Socket、优雅退出 | `src/index.ts` |

## 发布架构

fnOS 的 `manifest.platform` 只允许 `x86`、`arm`、`all`。本应用的 Harness payload 与 `libatomic` 兼容库包含架构相关二进制，因此不能用 `all` 表示双架构；发布链会生成两个独立 FPK：

| 产物 | manifest | 运行时组成 | 适用设备 |
| --- | --- | --- | --- |
| `dsh-fnos-<version>-linux-amd64.fpk` | `platform=x86` | `nodejs_v26` + amd64 libatomic | x86_64 NAS |
| `dsh-fnos-<version>-linux-arm64.fpk` | `platform=arm` | `nodejs_v26` + arm64 libatomic | ARM64 NAS |

打包脚本先在独立 staging 目录写入对应 manifest，再调用 `fnpack`，避免源码模板与实际产物架构不一致。打包后验证器会解包 FPK，检查 `nodejs_v26` 依赖、libatomic ELF 的 `e_machine` 与 Harness payload 的架构标记。原生日志依赖必须在同架构 Linux runner 上安装，不能由单架构构建机复制生成。

## Node 运行时依赖

FPK 不在应用目录中复制 Node 二进制，而是在 `manifest` 声明：

```text
install_dep_apps = nodejs_v26
```

启动脚本从 `/var/apps/nodejs_v26/target/bin/node` 解析运行时。当前 fnOS 的该插件缺少 `libatomic.so.1`，因此应用在 `runtime/lib/` 携带 Debian 12 的兼容库，并通过仅对应用进程生效的 `LD_LIBRARY_PATH` 注入；不安装或修改宿主系统库。

Harness 的 PTC（`run_code`）工作进程在启动前会清空继承环境，`LD_LIBRARY_PATH` 到不了它。FPK 因此在 `runtime/bin/dsh-ptc-node` 携带一个启动器：它按自身安装位置推导 `runtime/lib`，只把该目录注入即将 `exec` 的 `nodejs_v26`，再原样透传参数。supervisor 仅当自身 Node 与 `nodejs_v26` 是同一真实可执行文件、且启动器存在可执行时才通过工作区 overlay 把它设为 `ptc-runtime.launch.executable`；开发环境或自定义 Node 保持上游默认。该路径是 supervisor 内部事实，`shared.env` 不能覆盖。

Harness 插件安装器依赖 `pnpm`。FPK 在 `runtime/pnpm/` 携带固定版纯 JS pnpm，并在 `runtime/bin/` 提供 `pnpm`/`pnpx` wrapper；启动脚本把该目录加入 `PATH`，因此插件安装不需要宿主预装 pnpm。

## 请求生命周期

```text
GET /app/dsh-fnos/workspace/api/echo
  → splitMount 去掉 /app/dsh-fnos
  → readIdentity(x-trim-userid)
  → store.ensure(uid)               # 迁移或创建唯一工作区
  → harness.ensure(uid, workspace)  # 已运行则复用，否则启动
  → proxyHttp:
       Host   = 127.0.0.1:<port>
       Origin = http://127.0.0.1:<port>
       Cookie = <服务端持有的 Harness Cookie>
       Set-Cookie 丢弃
       Location 改写回挂载路径
```

### 为什么接管 Harness 登录

上游的浏览器认证是「启动 URL 带 token → 换签名 Cookie」。若把带 token 的 URL 交给用户，用户就拥有绕过飞牛账号的凭据；若让每个用户各自登录，用户需要在同一站点维护多套 Cookie。

本应用在服务端完成一次 token 交换，把 Cookie 保存在内存中并随请求注入。收益：

- 浏览器只持有飞牛会话，退出飞牛即失效。
- 多个用户切换不需要重复登录。
- Harness 的 Host/Origin 栅栏仍按 loopback authority 校验，代理是可信任的边界。
- 上游 401 时自动用保留的 token URL 重新换 Cookie，并重试幂等请求。

## 隔离模型

| 维度 | 做法 | 不保证 |
| --- | --- | --- |
| 用户数据 | 每个 uid 独立 `harness/`、`DSH_HOME`、`DSH_AGENTS_HOME`、`HOME`、工作区 | 不阻止同机管理员直接读盘 |
| 会话/上下文 | 存储层分离，不依赖界面过滤 | — |
| 归属 | 服务端始终按 `uid` 解析工作区，不提供跨用户路径 | 不区分“存在但无权”与“不存在” |
| 凭据 | 过滤 `TRIM_*`，密钥只在管理端 `shared.env` | 同机 root 可读进程环境 |
| 执行 | 当前版本未启用用户级进程沙箱 | **不要把它当作互不信任用户之间的安全边界** |

当前版本定位为**可信用户 + 管理员统一治理**。若要让互不信任的账号共用一台设备，需要独立系统执行身份或等效的操作系统级隔离，超出本版本范围。

## 插件模型

`packaging/fpk/app/shared/profile/<profile>/` 是管理员维护的默认插件集。每个用户工作区启动时将 `$DSH_HOME/profiles/<profile>` 软链到该目录：

- 共享目录用于提供默认插件，应用不会写回该目录。
- 用户可以通过 Harness 插件页在自己的 `DSH_HOME` 中安装和配置插件。
- `$DSH_HOME/cordis.patch.yml` 属于用户级数据。
- 升级默认插件 = 管理员替换共享目录内容 + 重启实例。

## 单工作区迁移

应用入口不再展示项目选择页。每个 uid 使用固定目录：

```text
${TRIM_PKGHOME}/users/<uid>/harness/
  workspace/
  dsh-home/
  agents-home/
  home/
  tmp/
  instance.json
```

首次访问 0.2.0 时，服务端选择 `createdAt` 最新的 0.1.x 项目，将整个项目目录原地移动到 `harness/`，并把 `dsh-home`、`agents-home`、`home` 内 JSON/YAML 等存储中的旧绝对路径替换为新路径。其他旧项目目录保留不删。迁移由 journal 和 `instance.json` 保证幂等，迁移失败不会启动一个空工作区。

## 失败策略

- Harness 启动失败：返回 503 并附带最近日志，不退回“无鉴权直连”。
- 身份缺失：401。未知路由：404。方法不允许：405。
- 上游不可达：502。
- Socket 残留：启动前删除并重新绑定；`status` 只认 PID 与 Socket 同时有效。

## 后续扩展点

1. 接入飞牛个人目录授权（`pickUserFile` + `trim.file.checkUserACL`），把授权目录映射为用户工作区。
2. 用户级进程沙箱（Landlock/bwrap）或独立运行身份。
3. 多实例负载与用户配额。
4. 基于签名证书的自动发布与商店上架。
