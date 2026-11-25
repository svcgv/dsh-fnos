# dsh-fnos 项目规范

## 运行时基线

- 开发和发布统一使用 Node.js 26；`.nvmrc` 与 `.node-version` 的开发版本固定为 `26.13.1`。
- 运行时不随 FPK 打包；`manifest` 必须声明 `install_dep_apps=nodejs_v26`，使用飞牛商店的 Node.js 26 插件。
- `package.json` 的 `engines.node` 不得低于 `>=26 <27`，TypeScript 类型包跟随 Node 26。
- Harness 上游声明的 Node 最低版本低于本项目基线时，仍以 Node 26 为准。

## 发布产物

- 每次正式构建必须分别产出两个独立 FPK：`linux-amd64` 与 `linux-arm64`。
- 含 `libatomic` 或任一原生依赖的 FPK，`manifest` 只能声明 `platform=x86` 或 `platform=arm`；不得用 `platform=all` 掩盖单架构二进制。
- `libatomic` 与 Harness 原生依赖必须和目标架构一致。构建原生 payload 时使用对应架构的 Linux runner，不做未经验证的交叉编译。
- 产物命名固定为 `dist/dsh-fnos-<version>-linux-<amd64|arm64>.fpk`。
- 双架构产物缺一不可。每个产物都必须通过 `scripts/verify-fpk.mjs`：
  - manifest 平台为 `x86` 或 `arm`；
  - manifest 声明 `nodejs_v26` 依赖；
  - 内置 `libatomic.so.1` ELF 架构与目标一致；
  - Harness payload 标记的架构与目标一致；
  - server、Harness entry 与运行时文件齐全。

## 构建与发布

- 固定版本的事实集中放在 `release.json`，升级 Node 或 Harness 时同步修改文档和锁文件。
- 正式构建使用 `node scripts/release.mjs --arch <amd64|arm64>`，不得手工拼装 FPK。
- 开发机只能原生构建与自身 CPU 架构一致的 Harness payload；跨架构构建交由 CI 的 Linux x86_64/ARM64 runner。
- 未配置签名证书时只能生成用于验证的 unsigned FPK，不得将 unsigned 包作为正式发布物。

## 提交前检查

1. 使用 Node 26 执行 `npm ci` 与 `npm test`。
2. 修改构建脚本时运行对应架构的 `release` 或至少执行脚本级测试。
3. 涉及发布逻辑的变更必须保持 `amd64`、`arm64` 两条路径都能被配置解析和验证。
