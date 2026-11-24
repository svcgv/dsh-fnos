# 架构

## 目标与边界

本应用只承担三件事：**飞牛身份接入、项目级隔离、Harness 进程与代理**。聊天、工具、插件协议、会话格式全部交给上游 `dsh`，不自建替代实现，减少升级成本。

不做的事：

- 不实现用户间协作、项目分享或邀请。
- 不把 Harness 暴露成独立端口服务。
- 不允许浏览器或项目进程直接访问 Docker、宿主系统服务。
- 不复制用户 NAS 文件；接入外部目录时只做挂载/授权映射（后续版本）。

## 组件

| 组件 | 职责 | 关键文件 |
| --- | --- | --- |
| 配置 | 解析 `TRIM_*` 与开发覆盖 | `src/config.ts` |
| 身份 | 只从 `x-trim-userid` 取身份，校验数字格式 | `src/identity.ts` |
| 项目存储 | 创建/列出/删除，归属校验，路径约束 | `src/projects.ts` |
| 实例管理 | 启动 `dsh`、解析 token、持有 Cookie、空闲回收 | `src/harness.ts` |
| 反向代理 | HTTP/WS 转发、Header 重写、Cookie 隔离、Location 改写 | `src/proxy.ts` |
| HTTP 层 | 路由、静态 UI、JSON API、权限判断 | `src/server.ts` |
| 入口 | 监听 Unix Socket、优雅退出 | `src/index.ts` |

## 发布架构

fnOS 的 `manifest.platform` 只允许 `x86`、`arm`、`all`。本应用的 Harness payload 与内置 Node 运行时包含架构相关二进制，因此不能用 `all` 表示双架构；发布链会生成两个独立 FPK：

| 产物 | manifest | 内置运行时 | 适用设备 |
| --- | --- | --- | --- |
| `dsh-fnos-<version>-linux-amd64.fpk` | `platform=x86` | Node 26 `linux-x64` | x86_64 NAS |
| `dsh-fnos-<version>-linux-arm64.fpk` | `platform=arm` | Node 26 `linux-arm64` | ARM64 NAS |

打包脚本先在独立 staging 目录写入对应 manifest，再调用 `fnpack`，避免源码模板与实际产物架构不一致。打包后验证器会解包 FPK，检查 Node ELF 的 `e_machine` 与 Harness payload 的架构标记。原生日志依赖必须在同架构 Linux runner 上安装，不能由单架构构建机复制生成。

## 请求生命周期

```text
GET /app/dsh-fnos/p/<id>/api/echo
  → splitMount 去掉 /app/dsh-fnos
  → readIdentity(x-trim-userid)
  → store.get(uid, id)              # 不属于该用户 → 404
  → harness.ensure(uid, project)    # 已运行则复用，否则启动
  → proxyHttp:
       Host   = 127.0.0.1:<port>
       Origin = http://127.0.0.1:<port>
       Cookie = <服务端持有的 Harness Cookie>
       Set-Cookie 丢弃
       Location 改写回挂载路径
```

### 为什么接管 Harness 登录

上游的浏览器认证是「启动 URL 带 token → 换签名 Cookie」。若把带 token 的 URL 交给用户，用户就拥有绕过飞牛账号的凭据；若让每个项目各自登录，用户需要在同一站点维护多套 Cookie。

本应用在服务端完成一次 token 交换，把 Cookie 保存在内存中并随请求注入。收益：

- 浏览器只持有飞牛会话，退出飞牛即失效。
- 多项目切换不需要用户重复登录。
- Harness 的 Host/Origin 栅栏仍按 loopback authority 校验，代理是可信任的边界。
- 上游 401 时自动用保留的 token URL 重新换 Cookie，并重试幂等请求。

## 隔离模型

| 维度 | 做法 | 不保证 |
| --- | --- | --- |
| 项目数据 | 每个项目独立 `DSH_HOME`、`DSH_AGENTS_HOME`、`HOME`、工作区 | 不阻止同机管理员直接读盘 |
| 会话/上下文 | 存储层分离，不依赖界面过滤 | — |
| 归属 | 服务端按 `uid` 校验，跨用户一律 404 | 不区分“存在但无权”与“不存在” |
| 凭据 | 过滤 `TRIM_*`，密钥只在管理端 `shared.env` | 同机 root 可读进程环境 |
| 执行 | 当前版本未启用项目级进程沙箱 | **不要把它当作互不信任用户之间的安全边界** |

当前版本定位为**可信用户 + 管理员统一治理**。若要让互不信任的账号共用一台设备，需要独立系统执行身份或等效的操作系统级隔离，超出本版本范围。

## 插件模型

`packaging/fpk/app/shared/profile/<profile>/` 是管理员维护的共享插件集。每个项目启动时将 `$DSH_HOME/profiles/<profile>` 软链到该目录：

- 用户无法通过 Web 插件页修改全局插件（共享目录只读）。
- 项目自己的 `$DSH_HOME/cordis.patch.yml` 仍可覆盖行配置，属于项目级数据。
- 升级插件 = 管理员替换共享目录内容 + 重启实例。

## 失败策略

- Harness 启动失败：返回 503 并附带最近日志，不退回“无鉴权直连”。
- 身份缺失：401。未知路由：404。方法不允许：405。
- 上游不可达：502。
- Socket 残留：启动前删除并重新绑定；`status` 只认 PID 与 Socket 同时有效。

## 后续扩展点

1. 接入飞牛个人目录授权（`pickUserFile` + `trim.file.checkUserACL`），把授权目录映射为项目工作区。
2. 项目级进程沙箱（Landlock/bwrap）或独立运行身份。
3. 多实例负载与项目数量配额。
4. 基于签名证书的自动发布与商店上架。
