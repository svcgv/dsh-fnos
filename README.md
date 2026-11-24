# dsh-fnos

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）以**飞牛 fnOS 原生应用**的方式发布：飞牛账号登录、统一网关入口、PC 与飞牛 App 共用界面，**按项目隔离工作区、会话与上下文**。

- 应用包：原生 `.fpk`（Node 进程，无 Docker 依赖）
- 架构：分别发布 `linux-amd64` 与 `linux-arm64`，内置对应架构的 Node.js 26
- 入口：统一网关 `/app/dsh-fnos`
- 身份：只信任网关转发的 `X-Trim-Userid`
- 隔离单位：**项目**。同一用户的多个项目各自拥有 `DSH_HOME`；项目默认仅创建者可见，不支持邀请或分享
- 共享：模型 API 与插件由管理员统一配置，普通用户不可修改

## 架构

```text
飞牛桌面 / 飞牛 App
        │  统一网关（登录校验）
        ▼
  dsh-fnos server（包用户，Unix Socket app.sock）
  ├── 项目列表 / 创建 / 删除（按 uid 归属）
  ├── 项目实例管理（按需启动、空闲回收）
  └── 反向代理（HTTP + WebSocket）
        │  127.0.0.1:<随机端口>，Host 重写
        ▼
  dsh --profile web（每个项目一个进程）
  DSH_HOME=<project>/dsh-home
```

关键设计：

1. **Harness 自己的登录被接管。** 启动时从 `dsh web` 输出解析一次性 token，换取会话 Cookie 后由服务端保存；浏览器只持有飞牛会话，永远看不到 Harness token，也不允许通过分享/配对绕过项目归属。
2. **代理充当可信反向代理。** 转发时把 `Host`/`Origin` 重写为 `127.0.0.1:<port>`，剥离 `Set-Cookie`，改写 `Location`，因此上游的 Host/Origin 栅栏仍然有效，而浏览器始终停留在 `/app/dsh-fnos/p/<id>/` 挂载下。
3. **凭据不下发。** 子进程环境会过滤全部 `TRIM_*`（`TRIM_API_TOKEN` 是飞牛开放 API 凭据），模型密钥只通过管理员维护的 `shared.env` 注入，不进入浏览器和项目配置。
4. **项目数据不删除。** 删除项目只是移出活动列表，目录被移动到 `TRIM_PKGVAR/trash/`，便于恢复和审计。

## 目录与数据

| 内容 | 位置 |
| --- | --- |
| 程序 | `${TRIM_APPDEST}`（`server/`、`harness/`、`runtime/node/`） |
| 管理员配置 | `${TRIM_PKGETC}/shared.env`，`${TRIM_APPDEST}/shared/profile/<profile>/`（共享插件集） |
| 用户项目数据 | `${TRIM_PKGHOME}/users/<uid>/projects/<project-id>/` |
| 项目工作区 | 上表 `.../<project-id>/workspace/` |
| 项目 Harness 状态 | `.../<project-id>/dsh-home/`、`agents-home/`、`home/`、`tmp/` |
| 运行日志 | `${TRIM_PKGVAR}/dsh-fnos.log` |
| 删除隔离区 | `${TRIM_PKGVAR}/trash/` |

## 构建

需要 Node.js 26（版本固定见 `.nvmrc` / `release.json`）、npm 与 `fnpack`。Harness 含原生依赖，amd64/arm64 payload 必须在对应架构的 Linux 环境中构建，不做交叉编译。

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

发布脚本会完成 Harness payload、Node 26 运行时下载与 SHA-256 校验、FPK 打包、manifest 架构检查、内置 Node ELF 架构检查。产物固定为：

```text
dist/dsh-fnos-<version>-linux-amd64.fpk
dist/dsh-fnos-<version>-linux-arm64.fpk
```

GitHub Actions 的 `build-fpk` 工作流会用 `ubuntu-24.04` 与 `ubuntu-24.04-arm` 并行构建，并在汇总任务中再次验证两份产物。未配置 `FNPACK_KEY` / `FNPACK_CERT` 时生成本地验证用 unsigned FPK，不可作为正式商店发布包。

开发时可复用已有 Node 发行版目录：`DSH_FNOS_NODE_DIR=/path/to/node-v26-linux-x64 npm run package:fpk -- --arch amd64`。没有完整 Harness payload 时可用 `--allow-missing-payload` 生成仅用于调试的包，该包会跳过严格发布校验。

## 安装后

1. 应用中心打开 **DeepSeek Harness**（桌面图标 / App）。
2. 创建项目 → 打开，进入官方 Web UI。
3. 管理员把模型密钥写入 `${TRIM_PKGETC}/shared.env`：

   ```
   DEEPSEEK_API_KEY=sk-...
   ```

   重启应用后所有项目共用该密钥，但会话与上下文互不可见。

## 升级与迁移

- 应用版本、Harness payload、Node 运行时随 FPK 一起升级；不在 NAS 上执行 `git pull`。
- 升级前由 `cmd/upgrade_init` 停止服务，用户数据目录不被改写。
- 项目数据迁移：直接复制 `${TRIM_PKGHOME}/users/<uid>/projects/<id>`；`project.json` 记录归属，恢复时由管理员显式放回目标 uid 目录。
- 回滚：恢复旧 FPK + 旧数据快照，不要让旧版本读取新版数据格式。

## 已知限制（当前版本）

- 项目工作区位于应用私有目录；接入「我的文件」授权目录尚未实现。
- 共享插件通过 profile 软链实现，插件安装/升级由管理员在共享目录完成。
- 单实例模型：同一项目在 PC 与手机共用同一个 Harness 进程；空闲 30 分钟后回收。
- 未开放 Harness 的分享、配对与 API 令牌登录。
- Harness payload 取自 npm 发布版，体积约 1 GB；FPK 必须内置 Node 运行时才能在没有 Node 的 NAS 上启动。
- 发布提供 amd64 与 arm64 两个独立 FPK；因包含原生运行时和依赖，不使用 `platform=all` 合并包。

## 开发约定

见 [docs/development.md](docs/development.md) 与 [docs/architecture.md](docs/architecture.md)。
