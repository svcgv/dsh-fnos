# 运维手册

## 安装

1. 根据设备架构选择 `dist/dsh-fnos-<version>-linux-amd64.fpk` 或 `dist/dsh-fnos-<version>-linux-arm64.fpk`。
2. 通过飞牛应用中心安装；`manifest` 会拒绝与设备架构不匹配的包。
3. 确认 `cmd/main status` 返回运行中（应用中心显示“运行”）。
4. 桌面或 App 打开 **DeepSeek Harness**。

首次安装会创建：

```text
/vol{n}/@appdata/dsh-fnos/        # TRIM_PKGHOME：项目数据
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

在应用中心重启应用使配置生效。所有项目共用该密钥；密钥不会下发到浏览器或项目配置。

## 配置共享插件（管理员）

```sh
# 在应用目录创建共享 profile（内容与 dsh 的 profile 结构一致）
APP=/var/apps/dsh-fnos/target
sudo mkdir -p "$APP/shared/profile/web"
sudo cp -a "$HOME/.dsh/profiles/web/." "$APP/shared/profile/web/"
```

之后每个项目启动时会把 `$DSH_HOME/profiles/web` 软链到该目录。升级插件即替换目录内容并重启应用。

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
sudo tar -C /vol{n}/@appdata/dsh-fnos -czf dsh-fnos-projects-$(date +%F).tgz .
```

**恢复：**

```sh
sudo /var/apps/dsh-fnos/cmd/main stop
sudo tar -C /vol{n}/@appdata/dsh-fnos -xzf dsh-fnos-projects-<date>.tgz
sudo /var/apps/dsh-fnos/cmd/main start
```

项目归属记录在 `users/<uid>/projects/<id>/project.json`。跨设备恢复时，由管理员确认目标 uid，不要按用户名自动认领。

## 升级与回滚

1. 停止服务，备份 `@appdata/dsh-fnos`。
2. 安装新 FPK；`cmd/upgrade_init` 会停止服务，`upgrade_callback` 记录版本。
3. 打开每个项目确认会话、附件、插件配置可读。
4. 回滚：卸载/降级到旧 FPK，并恢复对应快照。**不要**让旧版本直接读新版数据。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 打开应用 401 | 是否通过飞牛网关访问；`X-Trim-Userid` 是否被代理丢掉 |
| 打开应用 502 | 项目实例启动失败；看日志中 `harness-start-failed` 的 `detail` |
| 打开应用 503 | `app/harness/entry.js` 缺失，或 Node 运行时不可用 |
| 安装被拒绝 | FPK 架构与设备不一致；x86 设备装 `amd64`，ARM 设备装 `arm64` |
| 启动即退出 | `cmd/main start` 的 `TRIM_TEMP_LOGFILE` 与日志；确认 `runtime/node/bin/node` 或系统 Node 为 26.x |
| 页面空白但 200 | Harness 前端产物不完整；重新打包 payload |
| 同一项目重复启动 | 检查端口占用与 `harness-exit` 记录 |
| 文件权限异常 | `trimacl` 卷不要用 `ls -l` 判断；用实际读写验证 |

## 安全注意

- 当前版本假定使用者是可信的 NAS 用户，不提供互不信任账号之间的强隔离。
- 管理员可读所有项目数据（root/宿主权限），应用层没有“管理员查看他人项目”的入口。
- 不要在 `shared.env` 之外散落密钥；不要为项目授予整卷访问。
