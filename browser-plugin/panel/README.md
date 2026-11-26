# 可见浏览器面板（Web GUI 前端资源）

默认关闭的“可见浏览器面板”前端资源：宿主在 Web GUI 页面注入

```html
<script type="module" src="browser-live/panel.js"></script>
```

后，页面右下角出现“浏览器”按钮；点击打开右侧覆盖式停靠面板，通过同源 WebSocket
`browser-live/ws` 订阅远端页面画面并回传鼠标/键盘输入。

本目录只有前端资源，**不包含**服务端（画面采集、CDP 转发、WS 端点由宿主插件实现）。
没有 npm / React / 构建步骤，浏览器直接加载源码。

## 文件

| 文件 | 作用 |
| --- | --- |
| `panel.js` | 面板 UI、WebSocket 协议、输入转发、重连、画面渲染 |
| `panel.css` | 面板样式（自动跟随 `prefers-color-scheme`） |
| `mock-ws.mjs` | 可选自测：零依赖假 WS 服务端，带 `--selftest` |
| `README.md` | 本文件 |

## 资源与地址解析（必须保持 document-relative）

页面地址形如 `http://nas:port/app/dsh-fnos/workspace/`，前面可能还有网关前缀，
因此 `panel.js` 不使用任何绝对路径：

1. 取 `document.baseURI`；若 pathname 不以 `/` 结尾（baseURI 指向文件），
   去掉最后一段作为目录；丢弃 query/hash，保留网关前缀。
2. WebSocket：`new URL('browser-live/ws', document.baseURI)`，协议改成 `wss:`
   （https 页面）或 `ws:`。
3. 样式：`new URL('browser-live/panel.css', 页面目录)`，作为 `<link>` 放进 Shadow DOM。
4. 面板 DOM 全部在 Shadow DOM 中创建（`display: contents` 宿主），不读取宿主 DOM，
   不访问 cookie / localStorage，不注入 iframe，不 fetch 其他 HTTP 端点。

宿主插件需要把 `panel.js` / `panel.css` 以 `browser-live/panel.js`、
`browser-live/panel.css` 路径提供（在网关前缀下同样相对于页面目录），并在
`browser-live/ws` 升级 WebSocket。握手被 401 拒绝（面板未启用）时，前端显示
“浏览器面板未启用”并停止重连，不会刷屏重试。

## 画布与坐标

远端画面固定按 **1280×800 CSS viewport** 采集；canvas 按可用空间缩放显示，
但输入坐标始终换算回该 viewport 的像素：

1. 用 canvas 的 `getBoundingClientRect()` 与最近一帧/`state` 的尺寸做逆缩放；
2. 四舍五入后 clamp 到 `0..1279` / `0..799`；
3. 原点在左上角。

## WebSocket 协议

连接地址：`ws(s)://<页面目录>/browser-live/ws`；消息均为 UTF-8 JSON 文本帧。
服务端不发送 ack；协议错误通过 `{"type":"error","message":"..."}` 返回，前端只展示，
不做重试风暴。所有字符串不得包含 NUL。

### 客户端 → 服务端

| type | 字段 | 说明 |
| --- | --- | --- |
| `subscribe` | — | 面板打开且未暂停时发送，请求开始推流 |
| `unsubscribe` | — | 面板关闭或点击“暂停”时发送，请求停止推流 |
| `input` | `input`（对象） | 用户输入，见下表 |

输入统一放在 `{"type":"input","input":{...}}` 里，`input.kind` 只有三类：

#### `kind: "mouse"`

| type | 字段 | 说明 |
| --- | --- | --- |
| `mouseMoved` | `x`,`y` | **只允许** `kind,type,x,y`；不带 button/delta/modifiers；约 60Hz 节流，只发最新位置 |
| `mousePressed` | `x`,`y`,`button`,`clickCount?`,`modifiers?` | `button` 为 `left`/`middle`/`right`/`back`/`forward`；`clickCount` 1..3；`modifiers` 0..15 |
| `mouseReleased` | 同 `mousePressed` | 松开（含窗口外松开、失焦补发） |
| `mouseWheel` | `x`,`y`,`deltaX`,`deltaY` | 只允许这四个字段 + `kind,type`；不带 modifiers；各分量 clamp 到 `-1200..1200`，正方向=右/下 |

#### `kind: "key"`

| type | 字段 | 说明 |
| --- | --- | --- |
| `keyDown` | `key`,`code?`,`windowsVirtualKeyCode?`,`nativeVirtualKeyCode?`,`text?`,`unmodifiedText?`,`modifiers?` | 可打印字符的 `keyDown` 带 `text`（`event.key` 单字符）；`text` 已去 NUL |
| `keyUp` | 同上但**不带** `text`/`unmodifiedText` | 松开；修饰键变化也走 keyUp/keyDown |

`modifiers` 位掩码：Alt=1、Ctrl=2、Meta=4、Shift=8。
`windowsVirtualKeyCode`/`nativeVirtualKeyCode` 仅在能确定时携带（0..255 / 0..65535）。

#### `kind: "text"`

| 字段 | 说明 |
| --- | --- |
| `text` | 粘贴/输入法整段文本，去 NUL 后按 UTF-8 截断到 ≤4096 字节；空文本不发送。服务端映射为 `insertText` |

多余字段、越界坐标、错误类型都会被服务端拒绝；前端只构造上表允许的字段。

### 服务端 → 客户端

| type | 字段 | 说明 |
| --- | --- | --- |
| `state` | `open`,`url`,`title`,`width`,`height`,`loading` | 标题栏/状态点/尺寸来源 |
| `frame` | `seq`,`data`（base64 **JPEG**）,`width`,`height` | 画面帧；只接受 JPEG（`/9j/` 前缀），非 JPEG 丢弃并在状态行提示；`seq` 递增，旧帧/重复帧丢弃 |
| `show` | — | 请求自动展开面板（面板已关闭时自动打开） |
| `error` | `message` | 显示在底部状态行，状态点变红 |

帧解码优先 `createImageBitmap`，不支持时回退 `Image` + object URL；只保留最新一帧，
解码慢时直接覆盖旧帧，避免积压。

## 交互行为

- 右下角“浏览器”按钮开关面板；`Esc` 关闭。
- 面板左边缘可拖动改宽：320px ~ 70% 视口；聚焦拖拽条后用 ←/→ 调 24px，Home/End 到极限。
- 标题栏：状态点、页面 title、URL、暂停/恢复、关闭。暂停 = 发送 `unsubscribe` 并压暗画面。
- 底部状态行：连接状态、帧尺寸、帧率、最近错误；未启用时优先显示“浏览器面板未启用”。
- 键盘在面板打开时监听 `document` 的 `keydown`/`keyup`；忽略 Ctrl/Cmd/Alt 组合与
  F1–F12、Tab（保留给宿主和浏览器）；`Esc` 关闭面板；可打印字符通过 `keyDown.text` 传递。
- 关闭面板 / 窗口失焦 / 页面隐藏时，会为仍按下的键和鼠标按键补发 `keyUp` /
  `mouseReleased`，避免远端卡键。
- 断线按指数退避重连（0.5s 起，封顶 15s，带抖动），状态行显示重连次数；只有
  WS 从未收到任何消息、且同源 HTTP 探测到 401 时才判定“未启用”并停止重连。
  页面 `pagehide` 时停止重连并关闭连接。

## 自检

```bash
# 1) 语法检查（文件不使用顶层 import/export，可直接 node --check）
node --check browser-plugin/panel/panel.js
node --check browser-plugin/panel/mock-ws.mjs

# 2) 可选：零依赖假 WS 服务端自测（不需要真实 Chromium/网络）
node browser-plugin/panel/mock-ws.mjs --selftest
```

`mock-ws.mjs --selftest` 会用 Node 内置 `WebSocket` 客户端连接自己启动的服务端，
验证 HTTP 资源、WS 握手、`state`/`show`/`frame` 推送、JPEG 帧可解码、`subscribe` +
最终协议各类 `input` 能被服务端按字段白名单正确接受，以及伪造的 `mouseMoved`
多余字段会被拒绝。

## 手动验证（可选）

```bash
node browser-plugin/panel/mock-ws.mjs
# 输出示例：http://127.0.0.1:PORT/app/dsh-fnos/workspace/
```

浏览器打开该 URL：应看到右下角“浏览器”按钮，服务端连接后自动 `show` 展开面板，
显示 640×400 的静态 JPEG 演示画面；在画布上移动/点击/滚轮/键入，服务端终端会打印
收到的输入消息；改动浏览器窗口宽度可验证面板拖拽（320 ~ 70% 视口）。

真实部署时由宿主插件负责：注入脚本、提供 `browser-live/{panel.js,panel.css}`、
实现 `browser-live/ws` 服务端与远端页面采集。本仓库当前**未**把该面板接入真实
Harness Web profile，也**未**在标准 Web profile 中实际加载验证。

## 安全约束

- 只建立同源 WebSocket，不请求其他端点，不访问 cookie / localStorage / sessionStorage。
- 不读取宿主页面 DOM，面板 DOM 全部位于自己的 Shadow DOM。
- 不注入 iframe、不执行远端 HTML、不加载第三方脚本。
- 面板只是展示与输入转发；是否允许输入、是否只读、远端页面来源限制由服务端决定。
- **画面可能包含用户输入或敏感内容：不得记录、截图留存、上报或写入日志。**
