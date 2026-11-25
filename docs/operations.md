# 运维手册

## 安装

1. 根据设备架构选择 `dist/dsh-fnos-<version>-linux-amd64.fpk` 或 `dist/dsh-fnos-<version>-linux-arm64.fpk`。
2. 确认飞牛商店已安装 `nodejs_v26` 插件；FPK 会声明该依赖。
3. 通过飞牛应用中心安装；`manifest` 会拒绝与设备架构不匹配的包。
4. 确认 `cmd/main status` 返回运行中（应用中心显示“运行”）。
5. 桌面或 App 打开 **DeepSeek Harness**。

首次安装会创建：

```text
/vol{n}/@appdata/dsh-fnos/        # TRIM_PKGHOME：用户工作区数据
/vol{n}/@appconf/dsh-fnos/        # TRIM_PKGETC：shared.env
/vol{n}/@apphome/dsh-fnos/        # TRIM_PKGVAR：日志、PID、trash
```

## 配置模型密钥（管理员）

```sh
sudo -u dsh-fnos tee /vol{n}/@appconf/dsh-fnos/shared.env >/dev/null <<'EOF'
DEEPSEEK_API_KEY=sk-...
# 可选：DEEPSEEK_BASE_URL=https://api.deepseek.com
EOF
sudo chmod 600 /vol{n}/@appconf/dsh-fnos/shared.env
```

在应用中心重启应用使配置生效。该用户的工作区会读取共享密钥；密钥不会下发到浏览器或工作区配置。

## 配置共享插件（管理员）

```sh
# 在应用目录创建共享 profile（内容与 dsh 的 profile 结构一致）
APP=/var/apps/dsh-fnos/target
sudo mkdir -p "$APP/shared/profile/web"
sudo cp -a "$HOME/.dsh/profiles/web/." "$APP/shared/profile/web/"
```

之后用户 Harness 启动时会把 `$DSH_HOME/profiles/web` 软链到该目录。升级插件即替换目录内容并重启应用。

## 日志与状态

```sh
tail -f /vol{n}/@apphome/dsh-fnos/dsh-fnos.log   # 服务与 Harness 子进程日志（JSON 行）
/var/apps/dsh-fnos/cmd/main status               # 0 运行 / 3 停止
```

日志不记录对话正文、附件、模型密钥或 Harness token。

## 备份与恢复

**要备份：**

```sh
# 停止服务，避免写入中途
sudo /var/apps/dsh-fnos/cmd/main stop
sudo tar -C /vol{n}/@appdata/dsh-fnos -czf dsh-fnos-workspace-$(date +%F).tgz .
```

**恢复：**

```sh
sudo /var/apps/dsh-fnos/cmd/main stop
sudo tar -C /vol{n}/@appdata/dsh-fnos -xzf dsh-fnos-workspace-<date>.tgz
sudo /var/apps/dsh-fnos/cmd/main start
```

0.2.0 的备份重点是 `users/<uid>/harness/`。旧 `projects/` 目录仅用于升级回退或人工恢复。

## 升级与回滚

1. 停止服务，备份 `@appdata/dsh-fnos`。
2. 安装新 FPK；`cmd/upgrade_init` 会停止服务，`upgrade_callback` 记录版本。
3. 首次打开应用时等待旧项目迁移完成，确认会话、附件、插件和模型配置可读。
4. 回滚：卸载/降级到旧 FPK，并恢复对应快照。**不要**让旧版本直接读新版数据。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 打开应用 401 | 是否通过飞牛网关访问；`X-Trim-Userid` 是否被代理丢掉 |
| 打开应用 502 | Harness 实例启动失败；看日志中 `harness-start-failed` 的 `detail` |
| 打开应用 503 | `app/harness/entry.js` 缺失，或 Node 运行时不可用 |
| 安装被拒绝 | FPK 架构与设备不一致；x86 设备装 `amd64`，ARM 设备装 `arm64` |
| 工作区迁移失败 | 检查 `users/<uid>/.workspace-migration.json`、旧项目目录和应用日志；不要删除原数据，修复后重试 |
| 启动即退出 | `cmd/main start` 的 `TRIM_TEMP_LOGFILE` 与日志；确认 `nodejs_v26` 插件存在且 `/var/apps/nodejs_v26/target/bin/node` 可执行 |
| 缺少 `libatomic.so.1` | FPK 应携带 `runtime/lib/libatomic.so.1`；重新生成并安装当前双架构包 |
| 页面空白但 200 | Harness 前端产物不完整；重新打包 payload |
| 同一用户重复启动 | 检查端口占用与 `harness-exit` 记录 |
| 文件权限异常 | `trimacl` 卷不要用 `ls -l` 判断；用实际读写验证 |

## 安全注意

- 当前版本假定使用者是可信的 NAS 用户，不提供互不信任账号之间的强隔离。
- 管理员可读所有用户数据（root/宿主权限），应用层没有“管理员查看他人工作区”的入口。
- 不要在 `shared.env` 之外散落密钥；不要为应用授予整卷访问。
