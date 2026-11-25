# 开发规范

## 语言与构建

- Node.js 基线固定为 26.x；`.nvmrc`、`.node-version` 和 `release.json` 当前固定 `26.13.1`，`engines.node` 为 `>=26 <27`。
- TypeScript strict，`module: NodeNext`，ESM，`type: "module"`。
- 相对导入写 `.ts`，由 `rewriteRelativeImportExtensions` 在编译时改为 `.js`。
- 服务端**零运行时依赖**，只用 Node 内置模块（`node:http`、`node:fs`、`node:net`）。新增依赖需要说明为什么不能用内置能力。
- 编译产物是唯一发布形式：`.fpk` 中不包含 `src/`、不执行 `tsc`、不执行 `pnpm install`。

## Node 26 与双架构发布

### 不变量

1. 开发与 CI 使用 Node.js 26；生产运行时依赖飞牛商店 `nodejs_v26` 插件，不在 FPK 中复制 Node 二进制。
2. 每次正式发布必须分别产出 `linux-amd64` 与 `linux-arm64` 两个 FPK，缺一不可。
3. 含 `libatomic`、`node-pty`、Koffi、Sherpa 等架构相关二进制的包，`manifest` 只能写 `platform=x86` 或 `platform=arm`。**禁止使用 `platform=all`** 掩盖单架构内容。
4. Harness payload 必须在目标架构的 Linux 构建机上安装；不要把 macOS 或另一 CPU 架构的 payload 直接塞进 FPK。
5. `manifest` 必须声明 `install_dep_apps=nodejs_v26`；启动脚本优先使用 `/var/apps/nodejs_v26/target/bin/node`。
6. 固定版本事实集中在 `release.json`：开发 Node、Node 插件名、Harness、pnpm、libatomic 与需要发布的架构列表。升级时同步更新 `package.json`、锁文件和本文档。
7. FPK 必须携带纯 JS pnpm，并把 `runtime/bin` 放入 Harness 的 `PATH`；不得要求用户在 NAS 上预装 pnpm。

### 架构映射

| 发布标识 | fnOS `platform` | Node 运行时 | libatomic ELF | 推荐 runner |
| --- | --- | --- | --- | --- |
| `amd64` | `x86` | `nodejs_v26` | `62` | `ubuntu-24.04` |
| `arm64` | `arm` | `nodejs_v26` | `183` | `ubuntu-24.04-arm` |

映射由 `scripts/release-config.mjs` 统一实现。新增架构时必须同时补映射、验证逻辑和 CI，不得只改产物文件名。

### 发布命令

在对应架构的 Linux 构建机上执行：

```sh
npm ci
npm test
npm run release -- --arch amd64  # x86_64 构建机
npm run release -- --arch arm64  # ARM64 构建机
```

发布链依次执行：

1. 安装固定版本的 `@deepseek-ai/dsh`，校验 Linux/目标架构原生包存在。
2. 下载 Debian 12 `libatomic` 与固定版 pnpm，校验固定 SHA-256；pnpm 使用纯 JS 包。
3. 在隔离 staging 目录生成对应 `manifest`，不修改源码目录中的模板。
4. 调用 `fnpack` 生成 `<version>-linux-<arch>.fpk`。
5. 解包 FPK 复核 `nodejs_v26` 依赖、server、Harness entry、libatomic 版本/ELF、pnpm wrapper/版本和 payload 架构。

产物名固定为 `dist/dsh-fnos-<version>-linux-<amd64|arm64>.fpk`。无 `FNPACK_KEY` / `FNPACK_CERT` 时只能生成 unsigned 调试包，不能作为正式发布物。

GitHub Actions 的 `.github/workflows/build-fpk.yml` 使用原生 amd64/arm64 runner 并行构建，并由 `verify-both-architectures` 汇总任务再次检查两份产物。应用启动时将自身 `runtime/lib` 注入 `LD_LIBRARY_PATH`，这是为了兼容当前 `nodejs_v26` 插件缺失 `libatomic.so.1` 的 fnOS 环境。

## 单工作区与迁移约束

- 产品模型是“每个飞牛 uid 一个 Harness”，固定路径为 `${TRIM_PKGHOME}/users/<uid>/harness/`；不得再次增加项目选择页或项目 CRUD API。
- 入口 `/app/dsh-fnos/` 自动解析工作区并重定向到 `/workspace/`；旧 `/p/<id>/` 仅做兼容重定向。
- 0.1.x 迁移选择 `createdAt` 最新的项目，原子移动到 `harness/`；其他旧项目目录不删除。
- 迁移必须先写 `.workspace-migration.json`，移动后重写 DSH_HOME 内旧绝对路径，最后写 `instance.json` 并删除 journal；迁移失败不得创建空工作区。
- 测试必须覆盖无旧项目、多个旧项目、移动后续跑、并发去重、绝对路径更新和跨 uid 隔离。

## 命名与格式

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| 文件 | kebab-case | `build-harness-payload.mjs` |
| 变量/函数 | camelCase | `readIdentity` |
| 类型/接口 | PascalCase | `WorkspaceStore` |
| 常量 | UPPER_SNAKE | `MAX_NAME_LENGTH` |
| 布尔 | is/has/can 前缀 | `isAdmin` |

- 两空格缩进、单引号、无分号、文件末尾一个换行。
- 每个导出写一句 JSDoc，说明**用途**而不是复述签名。
- 注释只解释“为什么”，不写“做了什么”。

## 边界与校验

以下位置必须校验，不能依赖类型系统：

1. 网关 Header（`x-trim-userid` 必须是 `^[1-9][0-9]{0,9}$`）。
2. 任何进入文件系统的 id（`safeSegment` + `resolveInside`）。
3. 旧迁移 journal 和 `instance.json` 的版本、uid 与结构。
4. 上游响应（状态码、Cookie 是否存在）。

内部模块之间不做重复校验。

## 错误处理

- 面向用户：中文、可操作、不暴露宿主路径。
- 面向日志：JSON 单行，字段化（`uid`、`workspace`、`event`）。
- 启动失败必须显式失败（503 / 非零退出 / `TRIM_TEMP_LOGFILE`），**不允许降级为无鉴权或共享实例**。
- `catch` 不能吞掉未知错误；只处理明确的 `ENOENT` 等预期分支。

## 安全不变量

修改代码时逐条确认：

1. 身份只来自网关 Header，绝不来自 query、body 或 Cookie。
2. 不属于当前用户的资源一律返回 404。
3. Harness token、Cookie、`TRIM_API_TOKEN`、模型密钥不进入浏览器、不写日志。
4. 子进程环境过滤 `TRIM_*`。
5. 只代理 `/workspace/` 下的路径；旧 `/p/<id>/` 只允许站内重定向。
6. 不新增分享、邀请、跨用户读取入口。

## 测试

- `node:test`；业务测试使用 `*.test.ts`，构建/发布脚本测试使用 `*.test.mjs`，统一由 `scripts/test.mjs` 运行。
- 覆盖重点：身份解析、路径穿越、跨用户访问、Cookie 注入、Location 改写、WebSocket 升级。
- `test/fixtures/mock-harness.mjs` 模拟 `dsh web` 的 token 交换与 401 行为；新增代理行为时优先扩展它，而不是依赖真实上游。
- `test/workspaces.test.ts` 覆盖单工作区创建、旧项目迁移、路径重写、并发去重和跨 uid 隔离。
- `test/release-config.test.mjs` 校验 Node 26 基线、`nodejs_v26` 依赖、libatomic 校验和、双架构声明、ELF 映射和同架构构建约束。
- 提交前：`node scripts/test.mjs`。

## fnOS `trimacl` 注意事项

`/vol1` 的 `trimacl` 卷会把模式位显示为 `0`，真实权限由 ACL 决定；复制或新建目录时如果沿用 `stat().mode`，会产出真正不可读的 000 目录。

规则：

- 构建脚本复制目录后显式 `chmod 0o755`（见 `copyTree`）。
- 删除产物前先 `unlockTree`。
- **不要**用 `chmod`/`chown` 修 NAS 用户数据；授权走飞牛权限体系。
- 不要用 `ls -l` 或 `getfacl` 判断访问权限，用实际读写验证。

## 发布检查清单

1. 使用 Node 26 执行 `npm ci` 与 `node scripts/test.mjs` 并通过。
2. `amd64` 构建机运行 `npm run release -- --arch amd64`，严格验证通过。
3. `arm64` 构建机运行 `npm run release -- --arch arm64`，严格验证通过。
4. 确认 `dist/` 同时存在两个架构的 FPK，文件名、版本和 SHA-256 正确。
5. 正式发布包使用管理员证书签名；unsigned 包只允许内部验证。
6. 在两类真机验证：安装 `nodejs_v26` 依赖、安装应用、桌面入口、App 入口、两个用户工作区互不串数据、重启后会话仍在。
7. 升级验证：最新旧项目自动迁移、旧项目目录保留、模型/插件/会话可用、`shared.env` 仍生效、失败可回滚到旧 FPK + 旧快照。
