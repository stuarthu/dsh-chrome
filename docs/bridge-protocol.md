# dsh-agent 桥接协议

Chrome 扩展的 service worker 与 dsh 侧的桥接插件（`host/bridge.js`）之间
用 **WebSocket** 通信，路径为 `/dsh-agent/bridge`（挂在 dsh web 服务器上）。
所有消息都是 JSON 文本帧。

## 扩展 → dsh

### `result`
对一个 `action` 的应答。`ok:true` 时 `error` 为 `null`，`ok:false` 时
`result` 为 `null`。`result` 的类型随动作而定：可能是对象（`get_page`、
`click`、`capture_requests`）、数组（`list_tabs`）或人类可读的字符串
（`navigate`、`open_tab`、`start_capture`、`stop_capture`）。

```jsonc
{ "type": "result", "id": "…", "ok": true, "result": { … } }
{ "type": "result", "id": "…", "ok": false, "error": "没有元素匹配 .foo" }
```

### `page`
页面变化推送。三个触发点：标签切换、主框架导航、SPA 路由变化
（`history.pushState` 等），前述三者防抖约 2 秒；此外桥接（重）连接成功时
会立即补推一次，不防抖。导航与 SPA 事件只有来自**当前活动标签页**时才排队
（推的永远是活动标签页），且 URL 与正文长度都与上次相同的推送会被跳过——
桥接重连时例外，一定重发。不可注入的标签页（非 `http(s)`，以及 Chrome 应用
商店）整个跳过，不发帧。

正文在扩展侧已按 1,000,000 字符的保护阀截断，截断时 `truncated` 为 true；
桥接侧在正文长度达到上限时也会置 true（无论是否需要再截断，用于兼容不发
该字段的旧版扩展）。正文长度恰好等于上限时无法靠长度分辨是否截断，故
`truncated` 是唯一权威，下游不要按长度重新推断。dsh 侧由页面注入器写进
最近活跃会话。

```jsonc
{ "type": "page", "tab": { "url": "https://…", "title": "…", "content": "页面正文…", "truncated": false } }
```

### `ping`
保活（约 15 秒一次）；dsh 侧回 `pong`。

## dsh → 扩展

### `action`
浏览器工具发起的动作请求，扩展用 `result` 应答（同 `id`）。

```jsonc
{ "type": "action", "id": "…", "action": "navigate", "params": { "url": "https://…" } }
```

动作：`get_page`、`list_tabs`、`navigate {url}`、`click {selector}`、
`open_tab {url}`、`start_capture`、`stop_capture`、`capture_requests`。

几个动作的 `result` 形状：

- `get_page` → `{url, title, text, truncated, links:[{text,href}]}`。
  注意正文字段叫 **`text`**（不是 `page` 帧里的 `content`），上限 40,000
  字符、400 条链接，与 `page` 帧的 1,000,000 字符是两套限额。
- `list_tabs` → `[{id, url, title, active}]`。
- `click` → 成功时 `clicked` 只有两种取值：`true`（点到了，随 `text` 给出
  元素文本片段），或 `"unknown"`——扩展无法确定点击是否已经发生（多半是
  点击自身触发了导航、结果在回传前丢失），此时随 `reason`（机器可读，
  目前只有 `"result_lost"`）与 `detail`（原始错误文本）。点击不是幂等操作，
  这种情况下扩展绝不重试，宿主侧的 `browser_click` 负责把它翻译成给智能体
  看的提示。「没有元素匹配」与其它确定性失败都不走 `result`，而是以
  `ok:false` + `error` 返回（即上面 `result` 帧的第二个例子）。
- `capture_requests` → `{tabId, capturing, count, entries}`，每条 entry 形如
  `{id, seq, method, url, type, postData?, status, mimeType, body?, time,
  redirect?}`。`postData` 与 `body` 为空时整个字段不出现；`status` 与
  `mimeType` 在 `Network.responseReceived` 到达前是 `null`。抓包缓冲区按
  **标签页**保存，停止抓包只是不再记录，已记录的条目会留到标签页关闭为止。宿主侧对 `entries` 逐条脱敏；信封与每条 entry 都按白名单投影，
  认不出的字段会被丢弃并记入同级的 `droppedFields`（所以扩展新增字段时，
  必须同步 `host/redact.js` 里的白名单，否则它会静默消失）。脱敏可用插件配置
  `redactCredentials: false` 关掉，关掉后不做投影也不会有 `droppedFields`。

### `graph-changed`
dsh 模块图变化（装/删插件行）时向所有已连接的扩展广播，无 `id`、无应答；
扩展收到后刷新侧栏里内嵌的 dsh 页面。为避免刚启动就刷一次，启动后 5 秒内
的初始建图不广播。

```jsonc
{ "type": "graph-changed" }
```

### `pong`
对 `ping` 的应答。

## 智能体侧（dsh 内部，非线上协议）

- `host/browser-tools.js`：注册 `browser_*` 工具。需要“本轮用户真实消息含
  关键词”才放行的只有四个：`navigate`/`click`/`open_tab` 看
  `INTENT_PATTERN`，`start_capture` 看另一套 `CAPTURE_PATTERN`；
  `stop_capture` 与 `capture_requests` 不设门槛。两套关键词都定义在
  `host/intent-gate.js`；门禁的输入由同模块的 `sessionEvents()` 取——dsh 0.2
  起事件在 `session.snapshotEvents()`，不再有 `session.events` 属性。
- `host/page-injector.js`：把 `page` 推送写成一条 `source.kind ===
  "plugin:dsh-chrome"` 的"当前页面"消息（生产者自有形状；会话格式 v4 不再
  接受 V3 的 `{ kind: "plugin", plugin }` 包裹），注入最近活跃会话；这类消息
  不能解锁浏览器动作。
