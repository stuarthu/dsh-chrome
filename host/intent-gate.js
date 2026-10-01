// 浏览器意图解锁门（宿主侧唯一权威实现）。
//
// 本模块拥有门禁的全部组成部分：
//   - INTENT_PATTERN / CAPTURE_PATTERN   两套关键词正则
//   - textOf / currentTurnUserText       本轮用户真实消息的文本提取
//   - sessionEvents                      宿主会话对象 → 事件数组（跨 dsh 版本）
//   - GATES / requireGate / isUnlocked   种类登记表与最终判定
//   - INTENT_KEYWORDS_DOC / CAPTURE_KEYWORDS_DOC / gateDoc(kind)
//       面向用户的关键词说明——系统提示词直接引用前两者，工具被拦截时的
//       拒绝语用 gateDoc(kind) 取对应那一套，免得给抓包工具举导航的例子。
//
// 之所以独立成模块：正则、提取逻辑、判定这三样都曾在 host/browser-tools.js
// 与 tools/*.cjs 里各留一份副本并发生漂移，诊断脚本因此放行了生产实际拦截
// 的输入。这里一份，别处只 import。
// 本模块不依赖任何 @deepseek-ai/* 包，因此 tools/session-log.cjs 里的
// loadIntentGate() 能从 CJS 脚本里直接 import 它——别给它加依赖。

// 浏览器动作意图（中英）。英文关键词用 \b 锚定，避免子串误解锁
// （"table"/"database" 不得匹配 "tab"，"reopen" 不得匹配 "open"），
// 同时允许常见词形变化（opens/opening、clicked/clicking、tabs…）。
// 「go to」必须带上导航对象（URL / 域名 / page / site / tab）才算：
// 光凭 "go to line 200"、"go to the next step" 这种日常说法解锁浏览器动作
// 太宽了。「前往」在中文里指向性足够，不另加限制。
// （也不收「going to」——“I'm going to…”多数时候与浏览器无关；
//  不收裸「goto」——那是编程关键字。）
// 「tab」后面紧跟连字符时不算（"tab-separated" 不是浏览器意图）——这条对
// 「go to …」同样成立，所以 GO_TO 的对象里不单列 tab，交给末尾统一的
// tabs? 分支去匹配（`www.` 也不单列：域名分支已经覆盖）。
const GO_TO = String.raw`\bgo\s+to\s+(?:the\s+)?(?:https?://\S+|\S+\.[a-z]{2,}\b|page\b|site\b|website\b|url\b)`;
export const INTENT_PATTERN = new RegExp(
  String.raw`打开|跳转|前往|点击|导航|浏览一下|新标签|访问|${GO_TO}|\b(?:open(?:s|ed|ing)?|navigat(?:e|es|ed|ing)|click(?:s|ed|ing)?|visit(?:s|ed|ing)?)\b|\btabs?(?![-\w])`,
  "i"
);

/** 面向用户的关键词说明。与上面的正则同处一文件，改正则时一眼就能看到
 *  这段是否还准确；系统提示词直接引用它，不再另抄一份。 */
export const INTENT_KEYWORDS_DOC =
  "open / navigate / click / visit / tab (打开 / 跳转 / 前往 / 点击 / 导航 / 访问 / 浏览一下 / 新标签), " +
  'and "go to" when followed by a page or URL ("go to github.com" — bare "go to the next step" does not count)';
export const CAPTURE_KEYWORDS_DOC =
  "capture / debug (抓包 / 抓一下 / 抓取请求 / 监听网络 / 网络请求 / 流量). Note 抓取 on its own does NOT unlock capture";

// 抓包意图。单独的「抓」与「抓取」故意不匹配——「抓取」是普通中文的
// “scrape/fetch”（读取意图），不应解锁基于调试器的流量抓取；只认
// 抓包/抓取请求/抓一下等明确的抓包说法。
export const CAPTURE_PATTERN =
  /抓包|抓取请求|抓一下|监听网络|网络请求|流量|\b(?:captur(?:e|es|ed|ing)|debug(?:s|ged|ging)?)\b/i;

/** 取一条事件里的纯文本。user/message 是扁平的 data.content，
 *  assistant/message 是 data.message.content，两种形状都接受。
 *  导出是为了让 tools/ 里的诊断脚本共用，别再手抄一份。 */
export function textOf(event) {
  const content = event.data?.message?.content ?? event.data?.content ?? [];
  const parts = [];
  for (const block of content) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * 宿主会话对象 → 事件数组。dsh 0.2 起 `session.events` 属性被移除，事件改为
 * 通过 `session.snapshotEvents()` 读取（dsh 自带的工具，如 dsh-tool-goal，就是
 * 这么用的）；更早的版本反过来只有属性。两种形状都认，都取不到就返回
 * undefined，由 isUnlocked 失败关闭——绝不在这里「兜底放行」。
 *
 * 放在本模块而不是调用方：门禁的输入形状与判定一样，只该有一处定义，否则
 * browser-tools 与诊断脚本又会各写一份并漂移。本函数不依赖任何
 * @deepseek-ai/* 包，因此 tools/ 里的脚本能直接跑。
 *
 * @param session - exec.agent.session，或任何同形状对象
 * @returns 事件数组；两种宿主形状都不认识时返回 undefined
 */
export function sessionEvents(session) {
  if (!session) return undefined;
  if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
  return session.events;
}

/**
 * 本轮中所有「用户真实消息」（source.kind === "user"）的文本。
 * 注入的“当前页面”消息 source.kind 是生产者自有的 "plugin:dsh-chrome"，
 * 不等于 "user"，不计入，因此页面内容无法解锁浏览器动作。
 */
export function currentTurnUserText(events) {
  if (!Array.isArray(events)) return "";
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn/start") {
      start = i;
      break;
    }
  }
  // 找不到 turn/start 就无法界定“本轮”，此时必须失败关闭：返回空串让门禁
  // 拒绝。否则下面的向后扫描会从下标 0 开始，把整个会话的用户消息全收进来
  // ——门禁就从“按轮”退化成“按会话”，第 1 轮说过的“打开…”会让第 20 轮
  // 一直处于解锁状态，页面里藏的指令便可借此驱动浏览器。
  if (start === -1) return "";
  const parts = [];
  // 触发本轮的消息可能落在 turn/start 之前（inbox 拼接）：向前找最近的一条
  // 用户真实消息（遇到上一轮的 turn/end 就停），再收集本轮内的用户消息。
  for (let i = start - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "turn/end") break;
    if (e.type === "user/message" && e.data?.source?.kind === "user") {
      const t = textOf(e);
      if (t) parts.unshift(t);
      break;
    }
  }
  for (let i = start + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "user/message" && e.data?.source?.kind === "user") {
      const t = textOf(e);
      if (t) parts.push(t);
    }
  }
  return parts.join("\n");
}

/** 门禁种类 → 关键词正则 + 面向用户的说明。加一类门禁只需在这里加一行。 */
const GATES = new Map([
  ["browser", { pattern: INTENT_PATTERN, doc: INTENT_KEYWORDS_DOC }],
  ["capture", { pattern: CAPTURE_PATTERN, doc: CAPTURE_KEYWORDS_DOC }],
]);

/** 某类门禁的关键词说明；kind 认不出就抛错。 */
export function gateDoc(kind) {
  return requireGate(kind).doc;
}

function requireGate(kind) {
  const gate = GATES.get(kind);
  // 认不出的 kind 一律抛错，绝不当成“没门槛”放行：不设门槛的工具由调用方
  // 自己不调用本函数来表达（intent: null），而不是把拼错的 kind 静默变成
  // 通行证——那会让一个 typo 就悄悄解除某个工具的门禁。
  if (!gate) throw new Error(`unknown intent kind ${JSON.stringify(kind)}; refusing to unlock`);
  return gate;
}

/**
 * 门禁的最终判定：本轮用户消息是否解锁了某类浏览器动作。
 * kind 为 "browser"（navigate/click/open_tab）或 "capture"（start_capture）。
 *
 * 判定本身也放在这里，而不是让调用方各自「取文本 + 挑正则 + test」——
 * 那一步同样是会漂移的逻辑：诊断脚本 tools/verify-intent.cjs 必须走完全
 * 相同的路径，否则它复现不了生产的放行/拦截结果。
 */
export function isUnlocked(events, kind) {
  return requireGate(kind).pattern.test(currentTurnUserText(events));
}
