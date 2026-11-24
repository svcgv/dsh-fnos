# 开发规范

## 语言与构建

- TypeScript strict，`module: NodeNext`，ESM，`type: "module"`。
- 相对导入写 `.ts`，由 `rewriteRelativeImportExtensions` 在编译时改为 `.js`。
- 服务端**零运行时依赖**，只用 Node 内置模块（`node:http`、`node:fs`、`node:net`）。新增依赖需要说明为什么不能用内置能力。
- 编译产物是唯一发布形式：`.fpk` 中不包含 `src/`、不执行 `tsc`、不执行 `pnpm install`。

## 命名与格式

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| 文件 | kebab-case | `build-harness-payload.mjs` |
| 变量/函数 | camelCase | `readIdentity` |
| 类型/接口 | PascalCase | `ProjectStore` |
| 常量 | UPPER_SNAKE | `MAX_NAME_LENGTH` |
| 布尔 | is/has/can 前缀 | `isAdmin` |

- 两空格缩进、单引号、无分号、文件末尾一个换行。
- 每个导出写一句 JSDoc，说明**用途**而不是复述签名。
- 注释只解释“为什么”，不写“做了什么”。

## 边界与校验

以下位置必须校验，不能依赖类型系统：

1. 网关 Header（`x-trim-userid` 必须是 `^[1-9][0-9]{0,9}$`）。
2. 请求 JSON body（大小上限 + 结构检查）。
3. 项目名称（长度、控制字符）。
4. 任何进入文件系统的 id（`safeSegment` + `resolveInside`）。
5. 上游响应（状态码、Cookie 是否存在）。

内部模块之间不做重复校验。

## 错误处理

- 面向用户：中文、可操作、不暴露宿主路径。
- 面向日志：JSON 单行，字段化（`uid`、`projectId`、`event`）。
- 启动失败必须显式失败（503 / 非零退出 / `TRIM_TEMP_LOGFILE`），**不允许降级为无鉴权或共享实例**。
- `catch` 不能吞掉未知错误；只处理明确的 `ENOENT` 等预期分支。

## 安全不变量

修改代码时逐条确认：

1. 身份只来自网关 Header，绝不来自 query、body 或 Cookie。
2. 不属于当前用户的资源一律返回 404。
3. Harness token、Cookie、`TRIM_API_TOKEN`、模型密钥不进入浏览器、不写日志。
4. 子进程环境过滤 `TRIM_*`。
5. 只代理 `/p/<id>/` 下的路径，不提供任意路径转发。
6. 不新增分享、邀请、跨用户读取入口。

## 测试

- `node:test`，文件名 `*.test.ts`，编译后运行。
- 覆盖重点：身份解析、路径穿越、跨用户访问、Cookie 注入、Location 改写、WebSocket 升级。
- `test/fixtures/mock-harness.mjs` 模拟 `dsh web` 的 token 交换与 401 行为；新增代理行为时优先扩展它，而不是依赖真实上游。
- 提交前：`node scripts/test.mjs`。

## fnOS `trimacl` 注意事项

`/vol1` 的 `trimacl` 卷会把模式位显示为 `0`，真实权限由 ACL 决定；复制或新建目录时如果沿用 `stat().mode`，会产出真正不可读的 000 目录。

规则：

- 构建脚本复制目录后显式 `chmod 0o755`（见 `copyTree`）。
- 删除产物前先 `unlockTree`。
- **不要**用 `chmod`/`chown` 修 NAS 用户数据；授权走飞牛权限体系。
- 不要用 `ls -l` 或 `getfacl` 判断访问权限，用实际读写验证。

## 发布检查清单

1. `node scripts/test.mjs` 通过。
2. `node scripts/build-harness-payload.mjs` 产出 `app/harness/entry.js`。
3. `DSH_FNOS_BUNDLE_NODE=1 node scripts/package.mjs` 产出 `.fpk`。
4. 在真机验证：安装、桌面入口、App 入口、创建两个项目、跨项目不串数据、重启后会话仍在。
5. 升级验证：旧版本数据保留、`shared.env` 仍生效、失败可回滚到旧 FPK + 旧快照。
