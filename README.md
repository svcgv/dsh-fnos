# dsh-fnos

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）以**飞牛 fnOS 原生应用**的方式发布：飞牛账号登录、统一网关入口、PC 与飞牛 App 共用界面。每个飞牛用户拥有一个独立、持久的 Harness 工作区。

- 应用包：原生 `.fpk`（Node 进程，无 Docker 依赖）
- 架构：分别发布 `linux-amd64` 与 `linux-arm64`，运行时依赖飞牛商店 `nodejs_v26` 插件
- 入口：统一网关 `/app/dsh-fnos`
- 身份：只信任网关转发的 `X-Trim-Userid`
- 隔离单位：**飞牛用户**。每个用户的 `DSH_HOME`、会话、凭据和工作区互不可见
- 共享：管理员可通过 `shared.env` 和共享 profile 提供默认模型密钥与插件；用户也可在自己的工作区设置模型提供商并安装插件

## 架构

```text
飞牛桌面 / 飞牛 App
        │  统一网关（登录校验）
        ▼
  dsh-fnos server（包用户，Unix Socket app.sock）
  ├── 单工作区解析 / 旧项目迁移
  ├── Harness 实例管理（按 uid 启动、空闲回收）
  └── 反向代理（HTTP + WebSocket，/workspace/）
        │  127.0.0.1:<随机端口>，Host 重写
        ▼
  nodejs_v26 dsh --profile web（每个飞牛用户一个进程）
  DSH_HOME=<uid>/harness/dsh-home
```

关键设计：

1. **Harness 自己的登录被接管。** 启动时从 `dsh web` 输出解析一次性 token，换取会话 Cookie 后由服务端保存；浏览器只持有飞牛会话，永远看不到 Harness token，也不允许通过分享/配对绕过飞牛用户身份。
2. **代理充当可信反向代理。** 转发时把 `Host`/`Origin` 重写为 `127.0.0.1:<port>`，剥离 `Set-Cookie`，改写 `Location`，因此上游的 Host/Origin 栅栏仍然有效，而浏览器始终停留在 `/app/dsh-fnos/workspace/` 挂载下。
3. **凭据不下发。** 子进程环境会过滤全部 `TRIM_*`（`TRIM_API_TOKEN` 是飞牛开放 API 凭据），模型密钥只通过管理员维护的 `shared.env` 或 Harness 自身凭据存储使用，不进入浏览器。
4. **升级自动复用原数据。** 从 0.1.x 升级时，自动选择最新旧项目并迁移到固定工作区目录，模型、插件、凭据和会话继续可用。

## 目录与数据

| 内容 | 位置 |
| --- | --- |
| 程序 | `${TRIM_APPDEST}`（`server/`、`harness/`、`runtime/lib/`、`runtime/bin/`、`runtime/pnpm/`） |
| 管理员配置 | `${TRIM_PKGETC}/shared.env`，`${TRIM_APPDEST}/shared/profile/<profile>/`（共享插件集） |
| 用户工作区 | `${TRIM_PKGHOME}/users/<uid>/harness/workspace/` |
| 用户 Harness 状态 | `${TRIM_PKGHOME}/users/<uid>/harness/dsh-home/`、`agents-home/`、`home/`、`tmp/` |
| 工作区标记 | `${TRIM_PKGHOME}/users/<uid>/harness/instance.json` |
| 0.1.x 旧项目 | `${TRIM_PKGHOME}/users/<uid>/projects/`（保留，不再从 UI 访问） |
| 运行日志 | `${TRIM_PKGVAR}/dsh-fnos.log` |
| 删除隔离区 | `${TRIM_PKGVAR}/trash/` |

## 构建

需要 Node.js 26（开发版本固定见 `.nvmrc` / `release.json`）、npm 与 `fnpack`。飞牛设备需要商店中的 `nodejs_v26` 插件；FPK 的 `manifest` 会自动声明该依赖。Harness 含原生依赖，amd64/arm64 payload 必须在对应架构的 Linux 环境中构建，不做交叉编译。

```sh
npm ci                      # 安装 Node 26 开发依赖
node scripts/make-icons.mjs # 生成图标（已提交，可跳过）
node scripts/test.mjs       # 类型编译 + 单元/集成测试
```

### 1. 准备上游 Harness 产物

默认从 npm 安装已发布的 `@deepseek-ai/dsh`（生产依赖），并裁掉 source map、类型声明和文档：

```sh
npm run harness:payload -- --arch amd64   # 在 Linux x86_64 上执行
npm run harness:payload -- --arch arm64   # 在 Linux ARM64 上执行
```

从本地源码构建（实验性，体积大得多，且需要先 `pnpm run build`）：

```sh
npm run harness:payload -- --arch arm64 --from-source /vol1/1000/code/deepseek-harness
```

两种方式都会生成带架构标记的 Harness payload。发布版本固定为 `release.json` 中的 `harnessVersion`。

### 2. 构建双架构 FPK

```sh
# 分别在原生 Linux x86_64 / ARM64 构建机上运行：
npm run release -- --arch amd64
npm run release -- --arch arm64
```

发布脚本会完成 Harness payload、Debian 12 `libatomic`、纯 JS pnpm 下载与 SHA-256 校验、FPK 打包、`nodejs_v26` 依赖检查、运行时/payload 架构检查。产物固定为：

```text
dist/dsh-fnos-<version>-linux-amd64.fpk
dist/dsh-fnos-<version>-linux-arm64.fpk
```

GitHub Actions 的 `build-fpk` 工作流会用 `ubuntu-24.04` 与 `ubuntu-24.04-arm` 并行构建，并在汇总任务中再次验证两份产物。未配置 `FNPACK_KEY` / `FNPACK_CERT` 时生成本地验证用 unsigned FPK，不可作为正式商店发布包。

运行时使用 `/var/apps/nodejs_v26/target/bin/node`。FPK 携带 `runtime/lib/libatomic.so.1` 兼容库和固定版 pnpm；启动时将 `runtime/bin` 加入 `PATH`，供 Harness 插件安装器调用，不修改 NAS 系统。Harness 的 PTC（`run_code`）子进程会清空继承环境，因此 `runtime/bin/dsh-ptc-node` 额外在 `exec` 时只把该兼容库目录交给 `nodejs_v26`。没有完整 Harness payload 时可用 `--allow-missing-payload` 生成仅用于调试的包，该包会跳过严格发布校验。

## 安装后

1. 应用中心打开 **DeepSeek Harness**（桌面图标 / App）。
2. 应用直接进入该飞牛用户的 Harness 工作区，不再显示项目选择页。
3. 管理员可把共享模型密钥写入 `${TRIM_PKGETC}/shared.env`，也可以在 Harness 模型设置页配置提供商：

   ```
   DEEPSEEK_API_KEY=sk-...
   ```

   重启应用后该用户的工作区会读取共享密钥。

会话侧栏终端默认使用 `/bin/bash`，不使用飞牛应用账号的登录 Shell。管理员可在 `shared.env` 中设置 `SHELL` 为另一个可执行的交互式 Shell 的绝对路径，重启应用后生效。

## 升级与迁移

- 应用版本、Harness payload 与 libatomic 兼容库随 FPK 一起升级；Node.js 26 由飞牛 `nodejs_v26` 插件维护。
- 升级前由 `cmd/upgrade_init` 停止服务，用户数据目录不被改写。
- 0.2.0 首次访问会把最新旧项目目录迁移到 `${TRIM_PKGHOME}/users/<uid>/harness/`，其他旧项目保持不动。
- 备份：复制 `${TRIM_PKGHOME}/users/<uid>/harness`。
- 回滚：恢复升级前 FPK + 升级前数据快照；0.2.0 的目录迁移是单向的。

## 已知限制（当前版本）

- 工作区默认位于应用私有目录；需要编辑其他目录时，在飞牛应用设置中授予该应用目录读写权限，再从 Harness 添加工作区。
- 共享插件通过 profile 软链提供默认集合；用户工作区仍可在 Harness 插件页安装自己的插件。
- FPK 内置 pnpm `10.34.9`，插件安装不依赖宿主自行安装 pnpm。
- 卸载时可选择保留数据（默认）或永久清空全部工作区、配置和日志残留。
- 单实例模型：同一飞牛用户在 PC 与手机共用同一个 Harness 进程；空闲 30 分钟后回收。
- 未开放 Harness 的分享、配对与 API 令牌登录。
- Harness payload 取自 npm 发布版，体积约 1 GB；应用依赖飞牛商店 `nodejs_v26` 插件，不内置完整 Node 运行时。
- 发布提供 amd64 与 arm64 两个独立 FPK；因包含 libatomic 和 Harness 原生依赖，不使用 `platform=all` 合并包。
- 浏览器实验能力默认关闭，仅供管理员在可信整机手动验收：只会驱动 Chromium 打开内置固定测试页，不支持任意网站，也不构成多租户隔离。详见 [docs/browser-acceptance.md](docs/browser-acceptance.md)。

## 开发约定

见 [docs/development.md](docs/development.md) 与 [docs/architecture.md](docs/architecture.md)。
