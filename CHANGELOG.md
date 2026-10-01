# Changelog

All notable changes to `dsh-chrome` are documented here. This project follows
[semantic versioning](https://semver.org/).

## Unreleased

dsh 0.2 host-API compatibility. Both items were found on dsh 0.2.0-rc.2; one
disabled a whole feature silently, the other failed the running turn outright.

### Fixed

- **Every intent-gated tool was denied, whatever the user said.** The gate read
  the turn's events from `exec.agent.session.events`, but dsh 0.2 removed that
  property — the event log is read through `session.snapshotEvents()` (what
  in-tree tools such as `dsh-tool-goal` use). The resulting `undefined` made
  `currentTurnUserText` return `""`, so the fail-closed gate refused `navigate`
  / `click` / `open_tab` / `start_capture` in every turn, quoting keywords the
  user had in fact typed. Reading now goes through `sessionEvents()` in
  `host/intent-gate.js`, which accepts either host generation and still fails
  closed when neither exists.
- **The injected "current page" message failed session-format admission and
  killed the turn.** `page-injector` still built the retired V3 wrapper
  `source: { kind: "plugin", plugin: "dsh-chrome" }`. Session format v4 rewrites
  that shape only while migrating an existing log; on a new message it rejects
  it with `format v4 message requires a producer-owned source kind`, and the
  throw surfaced as a failed turn (reported as "本轮运行失败 …"), so every tab
  switch or navigation that pushed a page broke the turn it happened in.
  Injection now uses the producer-owned kind `plugin:dsh-chrome` — the shape
  `producerKind()` itself assigns to a third-party plugin — and drops the
  redundant `plugin` field. `kind` stays distinct from `"user"`, so injected
  page text still cannot unlock the browser gates.

## 0.1.3

Seven review rounds over the 0.1.2 follow-up work. Bullets describe the end
state, not the path taken.

**Upgrading:** re-run `npx dsh-chrome install` and reload the extension at
`chrome://extensions` — the host plugins and the extension must move together,
and the installer copies rather than links.

### Security

- **Captured traffic was never redacted.** The transform only handled a bare
  array, but `capture_requests` replies with
  `{tabId, capturing, count, entries}`, so secrets reached the model unmasked
  even though `redactCredentials` defaults on. Redaction now fails closed:
  an unrecognisable envelope throws, and both the envelope and each entry are
  projected onto allowlists so an unknown field is dropped rather than
  forwarded, and named in `droppedFields`. The fast-path pre-filter is derived
  from the same key-name list as the matcher, so it cannot narrow what gets
  masked — including keys spelled with escapes (`%74oken`, `\u0074oken`).
- **A redaction pattern could hang the host.** The form-body shape check
  nested quantifiers that also matched the separators, so a ~90-byte
  form-shaped body with trailing whitespace backtracked for tens of seconds
  (measured 18.7 s at 85 bytes) and stalled the single-threaded dsh host.
  Replaced with linear scans. Captured bodies are page-controlled, so patterns
  applied to them must stay linear.
- **The intent gate failed open.** With no `turn/start` event found it scanned
  the entire session, so a browser keyword typed in turn 1 kept the gate
  unlocked indefinitely and an injected page could act on it. It now denies
  when the turn cannot be identified, and `isUnlocked` throws on an
  unrecognised gate kind instead of treating it as ungated.

### Browser control

- **Clicks are never retried.** `runInPage` reports `ok` / `failed` /
  `indeterminate`; a click that may already have fired returns
  `clicked: "unknown"` (rendered host-side into agent-facing prose) instead of
  being retried on the destination page. Scrapes, which are safe to repeat,
  still treat `indeterminate` as failure.
- **CDP target selection** joins `chrome.debugger.getTargets()` by target id
  rather than guessing from URLs, falling back to URL matching when the id is
  absent (targets with a debugger already attached omit it). Transport is
  chosen structurally from the tab URL, never from Chrome's error prose.
- **`browser_get_page`** surfaces CDP errors instead of returning `ok: true`
  with a null page, and no longer routes ordinary pages through CDP.
- **SPA routes** (`history.pushState`) fire `onHistoryStateUpdated`, not
  `onCommitted`, so single-page navigation never triggered a page push. Added
  the listener, scoped page pushes to the active tab, and skipped pushes whose
  URL and body length are unchanged — except on bridge reconnect, where the
  host has dropped its cached page and needs it again.
- **Intent keywords**: common inflections unlock ("opening", "clicking",
  "capturing"); `go to` unlocks only before a page or URL, so "go to line 200"
  does not; `tab` does not match inside "tab-separated"; standalone 抓取
  ("scrape/fetch") still does not unlock capture.
- **CDP endpoint hardening**: `/json/list` responses that are not JSON, or are
  JSON but not an array, now produce a clear error naming
  `--remote-debugging-port` instead of failing downstream on
  `targets.find is not a function`; a read timeout is distinguished from a
  connect timeout. Target selection prefers `type === "page"` again and always
  excludes iframe targets — 0.1.2 had removed the `page` requirement to reach
  extension pages, which let the side panel's own embedded dsh UI match.
- **`minimum_chrome_version` is now 118** — `InjectionResult.error`, which the
  click and scrape paths depend on, does not exist before it. `manifest.json`
  had also been left at 0.1.1 while the package shipped as 0.1.2; the two are
  now bumped together.

### Structure

- One intent gate owning patterns, turn-text extraction, the `isUnlocked`
  decision and the user-facing keyword strings (`host/intent-gate.js`); one
  page-script dispatcher shared by scrape and click; one session-log reader for
  both `tools/` scripts; one pair-masking helper in `redact.js`. Each replaced
  a duplicate that had already drifted.
- Page-body capping happens once per runtime — the extension at extraction, the
  host at bridge ingress (it cannot trust a local client's cap). `host/bridge.js`
  is the host-side authority for both the cap and the `truncated` flag, and
  everything downstream, the page injector included, only consumes the flag.
  Oversized slices are flattened so a 50 MB push cannot stay pinned behind a
  1 MB view; captured request/response bodies get the same treatment, and
  base64 bodies are truncated before decoding rather than after.
- Removed a `composer-history` content-script registration for a file that has
  never existed in this package.
- `browser_stop_capture` is listed among the always-available tools in the
  system prompt, and automatic page pushes skip the Chrome Web Store along with
  the other pages Chrome won't let extensions script.
- Added `CLAUDE.md` (repo guide for AI coding agents).
- Docs, protocol spec and file headers brought back in line with the code —
  including correcting the long-standing claim that capture is scoped "per
  session": the buffer is per **tab**, reading it back is not intent-gated, and
  it outlives stopping the capture.

## 0.1.2

Code-review fixes:

- **redaction**: guard `redactUrl`'s `decodeURIComponent` so a malformed `%` in a
  captured URL no longer throws and fails the whole `browser_capture_requests`
  tool. (Redaction stays key-name based and best-effort by design — see README.)
- **intent-unlock**: anchor the English keywords to word boundaries so substrings
  ("table"/"reopen"/"database") no longer unlock state-changing browser actions;
  drop the over-broad lone `抓`.
- **page-injector**: explicitly drop the `session/event` listener on dispose, and
  enforce the documented ~1 MB page-body cap host-side.
- **bridge**: on dispose close the WebSocket server, clear sockets, and reset the
  cached page; also reset it when the last browser socket disconnects, so a stale
  page can't be injected after the browser is gone.
- **CDP fallback**: add a fetch timeout (no more indefinite hangs), surface
  protocol-level errors instead of resolving null, match the CDP target by exact
  URL and fail safe on zero/ambiguous matches (never drive the wrong tab, and no
  longer exclude chrome-extension targets by requiring type `page`), and stop
  falling through to CDP on a normal page when injection returns no result.
- **cli**: ignore a non-absolute `XDG_DATA_HOME`/`LOCALAPPDATA` (per XDG spec).
- Docs: note that the extension's own side-panel UI (top-bar labels) is currently
  Chinese only, and that redaction is best-effort (treat captured traffic as
  sensitive).

## 0.1.1

- Extension: read `chrome-extension://` pages via a remote CDP (DevTools
  protocol) fallback when ordinary `chrome.scripting`/`chrome.debugger`
  injection is blocked cross-extension.

## 0.1.0

- Initial public release. Chrome side panel embedding the full dsh web UI, plus
  three dsh host plugins (WebSocket bridge, browser tools, page injector) that
  let the agent read the current page, capture HTTP traffic, and drive the
  browser.
- Install: host side via `dsh plugin --profile web add dsh-chrome`; extension via
  `npx dsh-chrome install` (cross-platform, unpacked).
- Captured traffic redacts secret-shaped query params / body fields by default
  (`redactCredentials`).
- MIT licensed.
