# Installed community DSH plugin patterns — verified extract

Scope: four plugins installed under `C:\Users\<user>\.dsh\profiles\desktop\node_modules\`, cross-checked against installed core **0.2.2-rc.1** extracted at `D:\Windows\Desktop\Code\.dsh-probe\core\dsh\node_modules\@deepseek-ai\` (plus `dsh-host-webserver`, extracted for this report).

Evidence legend:
- **[C]** = confirmed by reading shipped code/docs; path:line given.
- **[I]** = inferred (reasoning + partial evidence); explicitly marked.
- **[A]** = author claim in a code comment/README, not independently verified.

Version pins (from each `package.json`):

| plugin | version | declares |
|---|---|---|
| dsh-budget-handoff | 0.4.0 | `engines.dsh >=0.2.0-rc.2`; peers `dsh-{agent,llm,session,tools} >=0.2.0-rc.1 …` |
| dsh-message-datetime | 0.1.3 | runtime dep `dsh-llm 0.2.1-rc.2`, `cordis 4.0.5`, `schemastery 3.18.5` |
| dsh-whale-widget | 0.4.2 | no `engines`, no dsh peers |
| dsh-github-flow | 0.7.1 | peer `@deepseek-ai/cordis ^4.0.4` only |

---

## 0. TL;DR — answers to the Lead's priority questions

1. **budget-handoff persistence is (iii) JSON files under `DSH_HOME`.** Plain `node:fs` + `node:os` + `node:path`; no `ctx.storage`/`storageDomain`, no settings, no `SessionEventMap` augmentation, no `appendPluginRecord`. File: `$DSH_HOME/storages/dsh-budget-handoff/sessions.json`, atomic tmp+rename, 2 s write throttle, prune to 50 sessions/30 days, final flush on unload through `ctx.effect`. See §2.1.
2. **budget-handoff's `/budget` is NOT a registered slash command.** It is literal text prefix interception inside `agent/pre-step`; the receipt is appended with `session.append('user/message', msg, { surfaceOp: 'append' })` and the step returns `{ kind: 'reject' }`. The real command registry (`ctx.commands.register`) is used by **github-flow** and by core's `dsh-command-compact`. See §3.
3. **whale-widget has no `dsh.client` block at all.** Host = `lib/index.js`; client = `assets/whale-widget.js` (1.14 MB plain script) served by the host at `/dsh-whale/widget.js`; it is injected into the page by `webServer.tapIndex(...)` (web) and by a `webserver/index-inject` structured row (desktop). Client↔host channel = **plain HTTP `fetch()` to `/dsh-whale/*.json` routes**, not a remote namespace. See §6.3 and §7.3.
4. **github-flow** = `ctx.tools.register(...)` (raw definition incl. required `output{schema,render}`) + `ctx.inject(['commands'], c => …c.get('commands').register(...))` + `dsh.client {platform:'web', entry:'./lib/client.js'}` + `window.__ModuleLoader__.load({id, factory})` exports `{apply, inject, name}` + `ctx.slots`. See §3.2, §4.1, §6.1–6.2.
5. **No installed plugin** uses `session.deriveMessages()` override, `surfaceOp: {op:'replace', …}`, custom `SessionEventMap` events, `appendPluginRecord`, or `storageDomain`. A repo-wide grep over the four plugin packages returns only budget-handoff's `surfaceOp: 'append'` and a comment mentioning `SessionEventMap`. See §5.4 and §9.

---

## 1. Plugin → pattern table

| plugin | file(s) | patterns demonstrated |
|---|---|---|
| dsh-budget-handoff | `dist/index.js`, `persist.js`, `command.js`, `gate.js`, `snapshot.js`, `ledger.js`, `harvest.js` | JSON-file per-session persistence + atomic write + throttling; `session/event` firehose; `agent/pre-step` waterfall (reject / append / inject); `agent/turn-stopping`, `agent/request-error`; text-prefix "command" without registry; `createUserMessage` with custom `source.kind`; Schemastery `Config`; `ctx.effect` cleanup |
| dsh-message-datetime | `dist/src/index.js` | minimal `agent/pre-step` wrapper with `{prepend:true}`; `decision.messages` append; `boundContextSummary` + `createUserMessage`; `session.snapshotEvents()`; `inject=["agents"]`; `Config` |
| dsh-whale-widget | `lib/index.js`, `assets/whale-widget.js`, `lib/accounting.mjs` | plugin **default-export object** form; `root.on('webserver/index-inject')`; `root.inject([...])`; `webServer.register({kind:'exact',path,handler})`; `webServer.tapIndex`; self-served client bundle; HTTP JSON channel; `$DSH_HOME` JSON persistence (atomic); optional services via `ctx.get()`; `session/event` accounting |
| dsh-github-flow | `lib/main.js`, `lib/commands/gh.js`, `lib/tools/*.js`, `lib/api/routes*.js`, `lib/client.js` | `export const {name, inject, provide, Config, apply}`; Schemastery with `.volatile()`; `ctx.provide('github', …)`; `ctx.inject(['commands'])`; `ctx.tools.register`; `ctx.inject(['webServer'])` route registration inside `ctx.effect`; declared `dsh.client` web bundle; client plugin `apply(ctx)` + `ctx.slots` / `ctx.sidebarRightTabs`; `window.__ModuleLoader__.load` |

---

## 2. Persistence patterns

### 2.1 dsh-budget-handoff — per-session JSON under `$DSH_HOME` **[C]**

Imports and the three path/version constants (`dist/persist.js:26-48`):

```js
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Directory (relative to `$DSH_HOME`) holding this plugin's durable state. */
const STORAGE_SUBDIR = 'storages/dsh-budget-handoff';
/** File name of the per-session state. */
const STATE_FILE_NAME = 'sessions.json';
/** Keep at most this many sessions; the oldest `updatedAt` are dropped first. */
export const MAX_PERSISTED_SESSIONS = 50;
/** Current on-disk shape version. */
const STATE_VERSION = 1;
/** Absolute path of the state file; `$DSH_HOME` falls back to `~/.dsh`. */
export function stateFilePath() {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(dshHome, STORAGE_SUBDIR, STATE_FILE_NAME);
}
```

On-disk shape (built in `dist/index.js:133-149`):

```js
persisted.sessions[sessionId] = {
    sessionId,
    updatedAt: now,
    usage,                                   // full Ledger record (token buckets)
    spentCNY: sessionCosts.get(sessionId) ?? 0,
    unpricedCalls: unpricedCallsBySession.get(sessionId) ?? 0,
    ...(sessionBudgets.has(sessionId) ? { budgetCNY: sessionBudgets.get(sessionId) } : {}),
    ...(sessionTokenBudgets.has(sessionId) ? { tokenBudget: sessionTokenBudgets.get(sessionId) } : {}),
};
```

Top-level file is `{ version: 1, sessions: { [sessionId]: entry } }` (`persist.js:90`).

Load is tolerant and prunes (`persist.js:89-119`, excerpt):

```js
export function loadState(now = Date.now()) {
    const empty = { version: STATE_VERSION, sessions: {} };
    let raw;
    try { raw = readFileSync(stateFilePath(), 'utf8'); }
    catch { return empty; }                       // ENOENT = first run
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { console.error(`[...] state file is not valid JSON, starting empty: ${String(err)}`); return empty; }
    if (parsed === null || typeof parsed !== 'object') return empty;
    if (parsed.version !== STATE_VERSION) return empty;
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') return empty;
    return { version: STATE_VERSION, sessions: pruneSessions(parsed.sessions, now) };
}
```

Atomic write (`persist.js:130-148`, excerpt):

```js
export function saveState(state) {
    const target = stateFilePath();
    const dir = dirname(target);
    const temp = `${target}.tmp`;
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(temp, JSON.stringify(state), 'utf8');
        renameSync(temp, target);                 // same-dir rename = atomic
    } catch (err) { console.error(...); try { unlinkSync(temp); } catch {} }
}
```

Pruning policy (`persist.js:34-42, 61-79`): drop malformed entries, drop `now - updatedAt > 30 days`, keep newest 50, sorted by `updatedAt` desc. Pure function, called on load and before every save.

Restore on plugin start (`dist/index.js:103-118`):

```js
const persisted = loadState();
for (const entry of Object.values(persisted.sessions)) {
    if (entry.usage !== undefined && entry.usage !== null) ledger.restore(entry.usage);
    if (typeof entry.spentCNY === 'number' && entry.spentCNY > 0) sessionCosts.set(entry.sessionId, entry.spentCNY);
    if (typeof entry.unpricedCalls === 'number' && entry.unpricedCalls > 0) unpricedCallsBySession.set(entry.sessionId, entry.unpricedCalls);
    if (typeof entry.budgetCNY === 'number') sessionBudgets.set(entry.sessionId, entry.budgetCNY);
    if (typeof entry.tokenBudget === 'number') sessionTokenBudgets.set(entry.sessionId, entry.tokenBudget);
}
```

Write trigger + throttle (`dist/index.js:119-168`):

```js
let lastPersistAt = 0;
const PERSIST_INTERVAL_MS = 2_000;
function persistSession(sessionId, force = false) {
    const now = Date.now();
    if (!force && now - lastPersistAt < PERSIST_INTERVAL_MS) return;
    lastPersistAt = now;
    if (!mergePersisted(sessionId, now)) return;
    persisted.sessions = pruneSessions(persisted.sessions, now);
    saveState(persisted);
}
```

Called on every `assistant/message` with usage (`index.js:431`) and with `force=true` for `/budget` changes (`:483`) and gate trips (`:530`).

Final flush on unload (`index.js:590-605`) — this is the pattern to copy for "don't lose the last 2 s":

```js
ctx.effect(() => {
    return () => {
        const all = ledger.getAll();
        for (const usage of all) mergePersisted(usage.sessionId);
        if (all.length > 0) {
            const now = Date.now();
            persisted.sessions = pruneSessions(persisted.sessions, now);
            saveState(persisted);
        }
        console.log(`[dsh-budget-handoff] DISPOSED — listeners removed`);
    };
});
```

Why it does **not** use session events for state (`persist.js:11-15`): "Only numbers this plugin derived itself… Nothing here is a credential, a message, or a copy of the session log — the log already exists and replaying it would couple this plugin to the (deprecated) synchronous session readers." **[A]**

### 2.2 dsh-whale-widget — same idea, different shape **[C]**

Multiple candidate paths, `$DSH_HOME` first (`lib/index.js:24, 485-494`):

```js
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const USAGE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
  ...
]
const TURN_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-turn.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-turn.json'),
  ...
]
```

Atomic write + corruption backup (`lib/index.js:1422-1443`, excerpt):

```js
function writeUsageLedger(led) {
  const body = JSON.stringify(led)
  for (const p of USAGE_FILE_CANDIDATES) {
    const temp = p + '.tmp-' + process.pid
    try {
      ...
      ledgerIo(() => fs.writeFileSync(temp, body, 'utf8'))
      ledgerIo(() => fs.renameSync(temp, p))
      return true
    } catch (err) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
      if (err.code !== 'ENOENT') console.error('[whale-ledger] 账本保存失败:', err.code || err.message)
    }
  }
  return false
}
```

Prune/archive policy: events 90 days or max 20 000, history 365 days, overflow archived to `.dshw-usage-archive.json` (`lib/index.js:1444-1474`).

### 2.3 Persistence options actually available in core 0.2.2-rc.1

| option | status | evidence |
|---|---|---|
| plain JSON under `$DSH_HOME` | **used by both shipped plugins** | §2.1, §2.2; `DSH_HOME` used by core CLI too (`dsh/lib/bin.js:151`) |
| `ctx.storage` hub | exists, **but** only a backend registry/form hub; no IO of its own | `dsh-storage/lib/index.js:84-138`: `class Storage extends Service`, `super(ctx,"storage")`, `backend.register/get`, `form.mount/form`, `get domain()` |
| `ctx.storageDomain` | documented public API for host code, **no installed plugin uses it**; the domain form package (`dsh-storage-domain`) is not in the extracted set, so its record API is unverified | `dsh-storage/README.md` ("read and write validated records through `ctx.storageDomain`"); grep over plugins = 0 hits |
| `ctx.settings` | exists for inspecting/editing **plugin Config** (volatile fields); not a state store | `dsh-settings/README.md`; no plugin uses it |
| `appendPluginRecord` (custom log events) | **not usable by external plugins** | `dsh-session/lib/index.js:1271-1299`: "Only production source under `packages/experimental/` may call this function; the `verify-plugin-record-callers` gate rejects any other production caller in this repository." |
| custom `SessionEventMap` augmentation | possible in TS, but no installed plugin does it | grep over plugins: 0 `declare module '@deepseek-ai/dsh-session'`; one comment mentioning the type only |

---

## 3. Slash command registration

### 3.1 dsh-budget-handoff — no registry; prefix interception in `agent/pre-step` **[C]**

The literal prefix (`dist/command.js:14-16`):

```js
/** Literal prefix that addresses this plugin from inside a session. */
export const COMMAND_PREFIX = '/budget';
```

Parsing is pure text → intent (`dist/command.js:38-81`); lookup in the step's pending messages (`:88-95`):

```js
export function findBudgetCommand(messages) {
    for (const message of messages) {
        const command = parseBudgetCommand(messageText(message.content));
        if (command !== null) return command;
    }
    return null;
}
```

Handling inside the `agent/pre-step` waterfall (`dist/index.js:439-485`, condensed to the essential lines):

```js
ctx.on('agent/pre-step', async (payload, next) => {
    ...
    const command = findBudgetCommand(payload.messages);
    if (command !== null) {
        if (command.kind === 'set') sessionBudgets.set(sessionId, command.budgetCNY);
        if (command.kind === 'set-tokens') sessionTokenBudgets.set(sessionId, command.tokenBudget);
        ...
        try {
            payload.agent.session.append('user/message', createUserMessage({
                content: [{ type: 'text', text: receipt }],
                source: { kind: 'user' },        // client only renders this kind [A]
            }), { surfaceOp: 'append' });
        } catch (err) { ... }
        persistSession(sessionId, true);
        return { kind: 'reject' };               // command never reaches the model
    }
    ...
});
```

Design reason (`dist/command.js:2-9`) **[A]**: recognising the request before the step reaches the model means changing a budget costs no model call; free-form parsing would require exactly that call. Order is deliberate — command handling precedes the budget gate (`index.js:458-460`), otherwise a user who is out of budget could not raise it.

> **Implication for the Lead:** if you want `/context …` to work without spending a model call in 0.2.x, this pre-step interception is the proven external-plugin route. Section 3.2 is the "official" registry route.

### 3.2 dsh-github-flow — real `ctx.commands.register` via optional injection **[C]**

Host wiring (`lib/main.js:172-179`):

```js
ctx.inject(['commands'], (c) => {
    registerGhCommand(c.get('commands'), executor, updateChecker, defaultTelemetryCollector);
});
```

Registration (`lib/commands/gh.js:111-130`):

```js
export function registerGhCommand(commandsService, executor, updateChecker, telemetryCollector) {
    if (!commandsService || typeof commandsService.register !== 'function') return;
    commandsService.register({
        name: 'gh',
        description: '查看 GitHub 账号状态、关联仓库与运行时健康度（直接回车即可执行）',
        async handler({ rawInput }) {
            const trimmed = (rawInput || '').trim().toLowerCase();
            if (!trimmed || trimmed === 'status' || …) {
                return { kind: 'success', text: await buildStatusReport(executor, updateChecker, telemetryCollector) };
            }
            ...
            return { kind: 'error', text: `未知命令选项: /gh ${rawInput}。…` };
        },
    });
    commandsService.register({ name: 'gh-upgrade', description: '…', async handler() { return { kind: 'success', text: await buildUpgradeReport(updateChecker) }; } });
    commandsService.register({ name: 'gh-help',    description: '…', async handler() { return { kind: 'success', text: buildHelpReport() }; } });
}
```

Command names are lowercase, `-` allowed (`gh-upgrade`, `gh-help`); the handler returns `{kind:'success'|'error', text}`. The service is typed `any` on purpose (`lib/commands/gh.d.ts:8`).

### 3.3 Canonical in-core `/compact` (0.2.2-rc.1) — the most complete snippet to copy **[C]**

`dsh-command-compact/lib/index.js:8-9, 49-100` (verbatim, comments trimmed):

```js
const name = "command-compact";
const inject = ["commands", "compaction"];

async function executeCompact(ctx, invocation) {
	if (invocation.rawInput.trim().length > 0) return { kind: "error", text: "Usage: /compact (no arguments)" };
	try {
		const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
		if (result === null) return { kind: "success", text: "No compactable history yet." };
		return {
			kind: "success",
			text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
			sourceEventSeq: result.summarySeq
		};
	} catch (error) {
		if (invocation.signal.aborted) return { kind: "error", text: "Compaction cancelled." };
		if (error instanceof ManualCompactionError) return expectedFailure(error);
		throw error;
	}
}

function apply(ctx) {
	const active = /* @__PURE__ */ new Set();
	const handler = (invocation) => { … };
	ctx.effect(function* () {
		yield async () => { await Promise.allSettled(active); };
		yield ctx.commands.register({
			definitionId: CommandDefinitionId("@deepseek-ai/dsh-command-compact"),
			name: "compact",
			description: "Compact older conversation history",
			handler
		});
	}, "command-compact lifecycle");
}
```

Canonical contract from `dsh-commands/README.md:30-46`:

```
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => {
    // Runs directly against the agent; no model message is created.
    return { kind: 'success', text: 'plan mode selected' }
  },
})
```
"The handler returns `success` or `error` plus optional UI text… `recordInput` defaults to true; a command whose own authoritative domain event already carries the payload sets it to false… Registering the same name twice in one scope throws." Optional branded `definitionId`, `input.attachments` for images/files, `execute(agent, line, attachments, signal)`/`list(agent)`/`find(agent, name)` for adapters.

### 3.4 Package rows for commands (all four plugins use the same shape) **[C]**

`package.json`:
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
`cordis.patch.yml` (e.g. `dsh-github-flow/cordis.patch.yml:1-3`, `dsh-budget-handoff/cordis.patch.yml:7-9`):
```yaml
- insert:
    - id: github-flow
      name: dsh-github-flow
```
`name` is a **package name**, resolved through the profile's `node_modules`, not a relative path (`dsh-budget-handoff/cordis.patch.yml:1-6` comment) **[A/C]**.

---

## 4. Tool registration

### 4.1 dsh-github-flow — raw definition via `ctx.tools.register` **[C]**

Tool factory returns the definition (`lib/tools/pr.js:19-23` and `:147-156`):

```js
export function createPrTool(executor) {
    return wrapWithGate({
        name: 'github_pr',
        description: '管理与审查 GitHub Pull Request (PR)。…（long, model-facing）',
        parameters: {
            type: 'object',
            properties: { action: { type: 'string', enum: [...] }, pr_number: { type: 'string' }, … },
            required: ['action'],
        },
        output: {
            schema: { type: 'object' },
            render(args, value) {
                return [{ type: 'text', text: renderPrMarkdown(args, value) }, ...buildImageBlocks(value)];
            },
        },
        async execute(args, execContext) {
            const { cwd, sessionId } = executor.resolveExecScope(execContext);
            ...
            return { message: '…', output: res.rawOutput };
        },
    });
}
```

`wrapWithGate` keeps the identity fields and only swaps `execute` (`lib/destructive.js:267-284`): "保持 `name` / `description` / `parameters` / `output` 原样，只替换 `execute`". Gate disposer/policy is internal; the tool definition shape is unchanged.

Registration loop (`lib/main.js:183-215`):

```js
const tools = ctx.tools;
const allTools = [ createPrTool(executor), createIssueTool(executor), … ];
const tier = applyTier(allTools, { toolsets: plain.toolsets, read_only: plain.read_only });
for (const tool of tier.kept) tools.register(tool);
```

Exec context fallback list (`lib/executor.js:247-265`) shows the fields available on a tool invocation: `execContext.sessionId`, `execContext.session.id`, `execContext.agent.id`, `execContext.cwd`, `execContext.signal` (used by core docs).

Core 0.2.2-rc.1 enforces the same shape (`dsh-tools/lib/index.js:433-445`):

```js
register(definition, options = {}) {
    const name = definition.name;
    const output = definition.output;
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || …)
        throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
    ...
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, { definition, when: options.when }), { label: "tools.register()" });
}
```

Core also ships `defineTool` as the typed wrapper (`dsh-tools/README.md:32-68`), and `register(definition, { when })` for step-time activation (`README.md:69`).

### 4.2 dsh-budget-handoff / dsh-message-datetime — no tools **[C]**

Neither registers tools; budget-handoff's `/budget` is pre-step interception, message-datetime only injects a notice. If your context plugin needs a model-facing tool, copy §4.1.

---

## 5. `agent/pre-step` and message injection

### 5.1 dsh-message-datetime — minimal, defensive pre-step wrapper **[C]**

Imports and plugin metadata (`dist/src/index.js:1-12`):

```js
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
...
export const name = "dsh-message-datetime";
export const inject = ["agents"];
export const Config = z.object({
    timeZone: z.string().description("…"),
});
```

Message construction (`:14-23`):

```js
function readingNotice(formatReading, formatSummary, now) {
    return createUserMessage({
        content: [{ type: "text", text: formatReading(now) }],
        source: {
            kind: name,                              // custom kind
            form: "notice",
            summary: boundContextSummary(formatSummary(now))
        }
    });
}
```

Handler (`:63-81`):

```js
export function preStepHandler(clock, onError) {
    return async (payload, next) => {
        const decision = await next();
        if (decision.kind !== "enter") return decision;
        let reading;
        try {
            const lastTurnEnd = findLastTurnEnd(payload.agent);
            reading = composeReading(payload.step, payload.signal.aborted, decision.messages, clock, lastTurnEnd);
            if (reading === undefined) return decision;
        } catch (error) { onError(error); return decision; }
        return { ...decision, messages: [...decision.messages, reading] };
    };
}
```

Registration with prepend (`:110`):

```js
ctx.on("agent/pre-step", preStepHandler(clock, onError), { prepend: true });
```

`prepend` is real cordis API: `ctx.on(name, listener, options)` where `options.prepend` unshifts into the listener list (`core @deepseek-ai/cordis/lib/index.js:810, 948-965`; `events.ts:113  prepend?: boolean`).

Reading history without touching it (`:27-44`):

```js
export function findLastTurnEnd(agent) {
    try {
        const session = agent.session;
        if (typeof session?.snapshotEvents !== "function") return undefined;
        const events = session.snapshotEvents();
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event?.type === "turn/end") return typeof event.time === "number" ? event.time : undefined;
        }
        return undefined;
    } catch { return undefined; }
}
```

Core confirms `snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq)` (`dsh-session/lib/index.js:1454`) and each event carries `time` (`:1536-1542`).

### 5.2 dsh-budget-handoff — waterfall with reject, append, inject **[C]**

Signature and decision handling (`dist/index.js:439-538`, condensed):

```js
ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = String(payload.agent.session?.id ?? '');
    ...
    // queue from session/event is drained HERE, because append only works in pre-step
    payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
    ...
    if (command !== null) { ...; return { kind: 'reject' }; }
    const verdict = judge(gateStateFor(sessionId), { budgetCNY, tokenBudget: tokenBudgetFor(sessionId) });
    if (verdict.tripped.length > 0) {
        await writeHandoffOut({ ..., appendNotice: (text) => {
            payload.agent.session.append('user/message', noticeMessage(text), { surfaceOp: 'append' });
        }, injectContext: (text) => {
            payload.agent.inject(recallMessage(text));    // model-only context, next admitted step
        }});
        persistSession(sessionId, true);
        return { kind: 'reject' };
    }
    warnAt80IfNeeded(...);
    return next();
});
```

Two message constructors (`dist/index.js:59-73`) — user-visible vs model-only:

```js
function noticeMessage(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
function recallMessage(text) {
    return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'budget-handoff', form: 'recall' },
    });
}
```

Core confirms the decision contract (`dsh-agent/README.md:98`): "`PreStepDecision` is either `{ kind: 'reject' }` or `{ kind: 'enter', messages, startsRequestSeries? }`. The enter branch contains the complete identified, frozen message batch." Payload built at `dsh-agent-loop/lib/index.js:685-690`:

```js
const decision = await this.dispatch.waterfall("agent/pre-step", {
    messages: claimed,
    ...position,          // turn, step
    signal,
    modelSelection: selection
}, () => { … });
```
and `agent` is injected into every agent event payload (`dsh-agent/lib/index.js:358-362`).

`agent.inject()` semantics (`dsh-agent-loop/lib/index.js:576-578` + `dsh-agent/README.md:58`): `inject(input)` → `send(input, "next-step", false)`; adds model-facing context without waking the driver, lands in the next admitted step. `followup`/`steer` differ only in target/wakeup.

### 5.3 Critical nuance: append works in `pre-step`, silently fails in `session/event` **[A]**

`dist/index.js:169-183` (author's measured note, 2026-10-08):

> - 同一个 `session.append('user/message', …)` 在 `agent/pre-step` 里能插进会话（拦截通知、`/budget` 回执都正常落地）；
> - 在 `session/event` 里则**静默失败** —— 会话日志里找不到那条事件，而外层 `catch` 只把错误写进 stderr（GUI 用户看不到）。
>
> 所以规矩是：**`session/event` 只记录，插消息一律放到 `agent/pre-step`。**

Hence budget-handoff queues notices produced during `session/event` in `pendingNoticesBySession` and drains the queue at the top of `pre-step` (`index.js:444-457`). Treat this as the shipped workaround; I did not independently reproduce it.

### 5.4 What no plugin does (relevant to history filtering) **[C]**

Grep over all four plugin packages for `deriveMessages`, `appendPluginRecord`, `storageDomain`, `declare module '@deepseek-ai/dsh-session'`, `SessionEventMap`, `surfaceOp`:

```
dsh-budget-handoff|index.js:368: comment mentioning SessionEventMap[K]
dsh-budget-handoff|index.js:451: session.append('user/message', …, { surfaceOp: 'append' })
dsh-budget-handoff|index.js:474: session.append('user/message', …, { surfaceOp: 'append' })
```
No `deriveMessages` override, no `surfaceOp: {op:'replace'}`, no custom event types. This is consistent with the Lead's finding: there is no public per-request history-filter hook used by any community plugin here.

---

## 6. Client UI registration

There are **two distinct, both-working strategies** in the installed set.

### 6.1 Strategy A — declared `dsh.client` web bundle (dsh-github-flow) **[C]**

`package.json:7, 16-25, 37-44`:

```json
"main": "./lib/main.js",
"exports": {
  ".": "./lib/main.js",
  "./entry": "./lib/main.js",
  "./client": "./lib/client.js",
  "./host": "./lib/github-service.js",
  "./package.json": "./package.json"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "entry": "./lib/client.js"
  }
}
```

Core contract (`dsh-client-modules/README.md:12-34`): the host scans enabled Loader entries, composes a boot graph, serves each bundle under `/plugins`; "A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`." The loader also supports `dsh.client.inject` (`dsh-client-modules/lib/index.js:91,96`).

Client bundle bootstrap (`lib/client.js:22-28`):

```js
window.__ModuleLoader__.load({
    id: "dsh-github-flow",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        var React = require("react");
        …
```

Client plugin export (`lib/client.js:9646, 9716-9719`):

```js
function apply(ctx) { … }
exports.apply = apply;
exports.inject = inject;     // ["slots", "sidebarRightTabs", "sessions", "layout", "theme", "sidebarRight"]
exports.name = "dsh-github-flow";
return module.exports;
```

### 6.2 Slot / tab registration (dsh-github-flow) **[C]**

`lib/client.js:9646-9714` (condensed, verbatim for the slot calls):

```js
function apply(ctx) {
    currentPluginCtx = ctx;
    if (ctx.effect) ctx.effect(() => injectStyles(), "github: styles");
    else injectStyles();
    if (ctx.on) ctx.on("theme/change", () => { injectStyles(); });

    if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
        ctx.effect(() => ctx.sidebarRightTabs.register({
            id: "dsh-github-flow",
            kind: "github",
            priority: "plugin",
            title: () => "GitHub 仓库",
            guide: [{ id: "workspace.github", commandId: "workspace.github", order: 40,
                      title: () => "GitHub 仓库", description: () => "…", icon: GithubArtwork }],
        }), "github: sidebar right tab definition");
    }

    if (ctx.slots) {
        ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-github-flow" }, GithubRightbarBody));
        ctx.slots.inject("sidebar.right.pane.tab.title", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "dsh-github-flow" }, GithubRightbarTitle));
        ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register({ name: "sidebar.panellist", id: "github", order: 20, label: "GitHub" }, GithubSidebarIcon));
        ctx.slots.inject("main", () =>
            ctx.slots.register({ name: "main", key: "github" }, GithubWorkspacePanel));
    }
}
```

Core confirms the service and API (`dsh-client-ui-renderer/lib/client.js`):
- `super(ctx, "slots")` — service name `slots` (`:1348`).
- `inject(key, callback)` — waits for a slot declaration, runs callback inside an effect, returns disposer (`:1353-1427`).
- `register(rawOptions, component)` — effect-wrapped `_register(options, component)`; returns disposer (`:1813-1816`).
- Slot keys used above exist in the installed 0.2.2 client packages (`sidebar.right.pane.tab` / `.title` at `dsh-client-ui-sidebar-right/lib/client.js:5683,5688`; `sidebar.panellist` in `dsh-client-ui-plugin-manager/lib/client.js:7820`).

> Slot options are per-slot (`name`, plus `key`/`id`/`order`/`label` as the slot's spec requires); copy the exact trio above rather than inventing fields.

### 6.3 Strategy B — self-served bundle + index injection (dsh-whale-widget) **[C]**

`package.json` has **no** `dsh.client`; only `dsh.bundle.patch` (`package.json:31-35`) and `"icon": "./icon.png"` (`:14`). Split:
- host: `lib/index.js` (265 KB, cordis plugin, default-export object at `:723-731`);
- client: `assets/whale-widget.js` (1.14 MB, plain script), located by `WIDGET_FILE_CANDIDATES` and served from an exact route (`lib/index.js:684-703`, `4891-4901`):

```js
const WIDGET_FILE_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'assets', 'whale-widget.js'),
]
…
disposers.push(registerRoute({
  kind: 'exact',
  path: '/dsh-whale/widget.js',
  handler: (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(loadWidgetJs())
  },
}))
```

Injection into the page, two channels (`lib/index.js:718-746`, `4903-4908`):

```js
const DESKTOP_WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-whale/widget.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'whale-balance-widget',
  apply(root) {
    const rowDisposers = []
    root.effect(() => () => { for (const d of rowDisposers) { try { d() } catch (err) {} } })
    // desktop: structured injection row, collected once at host boot
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      …
      table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })
    }))
    …
    // web: raw HTML transform
    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))
```

Both core APIs exist in installed 0.2.2: `tapIndex(transform)` (`dsh-host-webserver/lib/index.js:450-456`) and `collectIndexInjections` emitting `webserver/index-inject` with `(table, peer)` (`:646-650`).

**Which to choose:** `dsh.client` (Strategy A) if you ship a building-block client plugin consumed by the shell's module loader; Strategy B only if you must inject into the page/desktop shell yourself, and it is notably heavier (host route + self-injection + manual dedupe). For a context-management GUI panel, Strategy A is the supported path.

---

## 7. Client ↔ server communication

### 7.1 dsh-github-flow — custom HTTP JSON routes **[C]**

Host side (`lib/api/routes.js:11-67`, condensed verbatim):

```js
export function registerApiRoutes(ctxOrWebServer, executor, cacheTtlMs = 15_000, …) {
    const ctx = ctxOrWebServer;
    const isCordisContext = typeof ctx?.get === 'function';
    const webServer = webServerOverride ?? (isCordisContext ? ctx.get('webServer') : (ctx?.webServer ?? ctx));
    if (!webServer || typeof webServer.register !== 'function') return;
    …
    const bindRoute = (route) => {
        if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(() => registerOneRoute(route), `github-flow: ${route.kind} ${route.path}`);
        } else {
            registerOneRoute(route);
        }
    };
    …
}
```

Route object shape is `{ kind: 'exact' | 'prefix', path, handler(req,res) }`, and `webServer.register(route)` returns a disposer (`dsh-host-webserver/lib/index.js:369-382`; `kind==='exact'` → `exact` map, otherwise `prefixes`). The comment at `routes.js:33-39` warns that a stale route registration causes `duplicate route` on hot reload, so they probe/delete first — wrap registration in `ctx.effect`.

Whale's helper shows the wrapper pattern and route body style (`lib/index.js:876-885`, `3548-3565`):

```js
function registerRoute(route) {
  const inner = route && route.handler
  const wrapped = Object.assign({}, route, {
    handler: async (req, res) => { if (rejected(req, res)) return; return inner(req, res) },
  })
  return ctx.webServer.register(wrapped)
}
…
disposers.push(registerRoute({
  kind: 'exact',
  path: '/dsh-whale/image.png',
  handler: (req, res) => {
    const bytes = loadImage()
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  },
}))
```

Client side (`lib/client.js`, e.g. `:9002`, `:9017`):

```js
fetch("/api/github/proxy").then(r => r.json()).then(j => { if (j && j.ok && j.state) { … } })
fetch("/api/github/check-update").then(res => res.json()).then(json => { if (json && json.ok && json.data) setUpdateInfo(json.data) })
```

Convention: JSON envelope `{ ok: boolean, data | state | error }`, absolute `/api/<plugin>/…` paths, server validates/creates dirs, all routes removed on unload.

### 7.2 State flowing into the client without HTTP **[C]**

Slot props carry host-provided state hooks; github-flow reads the session cwd from a prop rather than an endpoint (`lib/client.js:8141-8143`):

```js
if (props && typeof props.useSessions === "function" && sessionId) {
    cwd = props.useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd) || null;
}
```

Besides that, the client persists UI state in `localStorage` with namespaced keys (`dsh_github_rightbar_snapshot_*`, `RIGHTBAR_STATE_FILTER_KEY = "dsh_github_rightbar_state_filter_v1"`, `lib/client.js:3095-3176`). No remote namespace / RPC service is used by any installed plugin.

### 7.3 Security boundary for custom routes **[C]**

`webServer` itself does not authenticate routes. Whale-widget implements its own fence: loopback Host/Origin check, `Sec-Fetch-Site` rejection, delegation to `connection.requestRejection` when present, and a separate rule that **write methods (`POST/PUT/PATCH/DELETE`) must come from loopback or `DSHW_ADMIN_HOSTS`** (`lib/index.js:750-874`). If your context plugin exposes any mutating route (e.g. save/clear session context), copy that discipline or don't expose one.

---

## 8. Version compatibility: plugins target 0.2.0-rc.2 / 0.2.1-rc.2, installed core 0.2.2-rc.1

Verified installed core versions: `dsh`, `dsh-llm`, `dsh-commands`, `dsh-agent`, `dsh-tools`, `dsh-session`, `dsh-web-app`, `dsh-client-modules`, `dsh-storage`, `dsh-settings` are all **0.2.2-rc.1** (each `package.json`).

Observed / potential drift:

1. **Tool definition shape — no break.** 0.2.2-rc.1 `ctx.tools.register` requires `output { schema, render, presentationMeta? }` and throws otherwise (`dsh-tools/lib/index.js:433-445`). github-flow 0.7.1 already declares `output` in every tool (e.g. `lib/tools/pr.js:147-152`), so it is compatible. A new plugin that omits `output` will fail loudly on 0.2.2.
2. **Command registration — additive.** 0.2.2 adds optional branded `definitionId` and richer invocation fields (`agent`, `signal`, `commandId`, `attachments`) (`dsh-commands/README.md:30-68`; `dsh-command-compact/lib/index.js:55`). github-flow's older `{name, description, handler({rawInput})}` still works. Command syntax is `/name` at byte zero, lowercase letters/digits/`_`/`-`, rest = `rawInput` (`README.md:50`).
3. **Custom message `source.kind` — runtime OK, TS-union drift.** The 0.2.2 generated declaration for `MessageSourceMap` is a closed map of known kinds (`dsh-llm/lib/typert.host.js:496`), and `ContextFormed` forms (`notice | instructions | catalog | snapshot | relay | recall`) are intersected only onto a subset (`'model-selection'`, `'runtime-context'`, `'user-approval'`, `'plan-mode'`, `'schedule'`, `'webhook'`, `'subagent-settled'` — e.g. `:3916`, `:496`). Yet both shipped plugins construct sources with **custom kinds**:
   - message-datetime: `{ kind: "dsh-message-datetime", form: "notice", summary }` (`dist/src/index.js:15-22`);
   - budget-handoff: `{ kind: "budget-handoff", form: "recall" }` (`dist/index.js:68-73`).
   `createUserMessage` performs no source validation (`dsh-llm/lib/types/message.js:53-58` → `createMessage` = freeze/clone only), and no runtime source-kind validator was found in `dsh-session`/`dsh-llm` JS. **[I]** So this works at runtime, but those source types are outside the shipped TS union; if you compile against 0.2.2 types you must augment `MessageSourceMap` or reuse an existing kind. Whether 0.2.0-rc.2 had the same closed union cannot be verified from local artifacts (no old package present).
4. **`form` values are the semantic contract.** Core uses `form: 'notice'` + `summary` for its own model-selection notice (`dsh-agent/lib/types/model-selection.js:111`) and for `webhook`/`subagent-settled` sources; compaction produces a `user/message` replacement. Use the shipped `form` vocabulary (`notice`/`snapshot`/`recall`, …) rather than inventing new `form` values. **[I]**
5. **Stop/error hooks — no break.** `agent/turn-stopping` payload is `{ turn, signal }` + injected `agent` (`dsh-agent-loop/lib/index.js:791-794`), which is all budget-handoff uses. `agent/request-error` payload is `{ turn, step, provider, failure, retryPolicy, signal }` and a listener may return `{ kind: 'retry' }` (`:929-939`); budget-handoff reads only `payload.failure.code` and calls `next()` (`dist/index.js:557-586`).
6. **`session.append` surface rules unchanged.** `append(type, data, ...opts)` takes `{ surfaceOp, sourceEventSeqs }`; surface events (`user/message`, `assistant/message`, `tool/result`) **require** `surfaceOp`, other events reject it (`dsh-session/lib/index.js:1493-1546`; `surfaceOpOf` at `:298-310`). budget-handoff's `{ surfaceOp: 'append' }` is valid in 0.2.2.
7. **Client contracts unchanged.** `dsh.client {platform:'web', entry}` still supported (`dsh-client-modules/README.md:12-34`, parser at `lib/index.js:91-96`); `window.__ModuleLoader__.load({id, factory})` still the bundle bootstrap (`README.md:30-44`); slot names used by github-flow exist in the 0.2.2 client packages (§6.2).
8. **whale-widget's injection channels unchanged.** `webserver/index-inject` + `tapIndex` both present in `dsh-host-webserver` 0.2.2-rc.1 (§6.3).
9. **Engines mismatch to watch.** budget-handoff requires `node >=22.19.0` and `dsh >=0.2.0-rc.2`; message-datetime requires node `>=22.5`; whale/github-flow declare no engines. Installed core 0.2.2-rc.1 satisfies budget-handoff's range.
10. **Core APIs not exercised by these plugins but present in 0.2.2** — potentially useful for a context plugin, but *do not assume they exist in 0.2.0-rc.2 without checking*: `ctx.compaction` (`dsh-compaction/lib/index.js:171`), `ctx.tokenMeter` (`inject` at `dsh-compaction-tool-result-pruner/lib/index.js:62`; `measure(session[, header])` returns `{nodes, totalTokens}` — `dsh-compaction-basic/lib/index.js:939-960`; each node has `{seq, tokens, heuristicTokens}` at `:568-579`), `ctx.llm.resolveModelInfo(provider, model, signal)` → `{context:{contextWindow}, defaultMaxTokens}` (`dsh-compaction-basic/lib/index.js:955-959`).

---

## 9. Open questions / not verifiable locally

1. **History filtering**: the only per-step hook any plugin uses is `agent/pre-step`, whose payload carries the *pending inbox batch* (`messages: claimed`, `dsh-agent-loop/lib/index.js:685-690`), not `session.deriveMessages()`. `deriveMessages()` is a plain Session method (`dsh-session/lib/index.js:1681-1696`), not an injectable service/waterfall. No evidence in extracted core of a public "filter derived history" hook; consistent with the Lead's finding. **[C for payload/method; I for absence]**
2. **Surface replace from a third-party plugin**: technically `session.append('user/message', msg, { surfaceOp: { op: 'replace', startSeq, endSeq } })` is the shape compaction uses (compaction README "the surface is mutated exactly once… replacement inside the lock bracket"), but no installed plugin attempts it, and `validateSurfaceMetadata`/`surfaceOpOf` enforce strict marker validity (`dsh-session/lib/index.js:298-310, 1493-1523`). Risk/legality for external plugins: **unverified**. Compaction additionally brackets with `compaction/start`/`compaction/end` and uses the service seam.
3. **`ContextFormed` rendering**: how each client renders/skips messages with `form: 'notice'` vs `'recall'` vs unknown custom kinds was not traced through `dsh-client-ui-conversation`. message-datetime's custom `kind` + `form:'notice'` suggests non-user sources are hidden; budget-handoff's comment says the desktop client renders only `kind:'user'` (`dist/index.js:55-57`, measured 2026-10-08) **[A]**. Verify per-client before relying on it.
4. **`dsh-storage-domain` / `ctx.storageDomain` record API**: domain form package not present in the extracted core and not used by any installed plugin; its exact `read/write` signatures are unverified here.
5. **`subagent/start` / `subagent/end`** events used by whale (`lib/index.js:1124-1125`) live in a package not included in the extracted set; payload shape unverified. whale registers them defensively with try/catch and `ctx.on`.
6. **message-datetime type augmentation**: the package ships only `dist/src/*.js` (no `.d.ts`), so whether it augments `MessageSourceMap` via `declare module` in source cannot be confirmed. Its runtime behavior is confirmed.
7. **Provider `usage.totalTokens` optionality**: budget-handoff derives totals from the four disjoint buckets and treats `usage.totalTokens` as optional (`ledger.js:51-57`; comments cite `dsh-llm` types). Use bucket sums, not `totalTokens`, if you need a guaranteed number.
8. **Node/DSH engine enforcement**: whether the loader refuses a plugin whose `engines` don't match was not tested.

---

## Appendix A — copy-paste skeletons

### A.1 Minimal plugin (server half)

`package.json`:
```json
{
  "name": "dsh-context-manager",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js", "./client": "./dist/client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "entry": "./dist/client.js" }
  }
}
```
`cordis.patch.yml`:
```yaml
- insert:
    - id: context-manager
      name: dsh-context-manager
```
`dist/index.js`:
```js
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-context-manager';
export const inject = ['agents'];              // hard dependency → plugin stays PENDING if absent
export const Config = z.object({
  maxTokens: z.number().min(1000).default(100_000),
  verbose: z.boolean().default(false),
});

export function apply(ctx, config) {
  ctx.on('agent/pre-step', async (payload, next) => {           // waterfall
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    // …decide based on payload.agent.session.snapshotEvents()…
    return decision;                                            // or { kind:'reject' }
  });
  ctx.effect(() => () => { /* flush persisted state here */ }); // disposer on unload
}
```

### A.2 Real slash command via registry (0.2.2-rc.1)

```js
export const inject = ['commands'];
export const name = 'dsh-context-manager';

export function apply(ctx) {
  ctx.inject(['commands'], (c) => {
    c.get('commands').register({
      name: 'context',
      description: 'Show or set context-management limits',
      async handler({ agent, rawInput, signal }) {
        if (!rawInput.trim()) return { kind: 'success', text: 'no limits set' };
        return { kind: 'success', text: `rawInput=${rawInput}` };
      },
    });
  });
}
```
For hard dependency use `export const inject = ['commands']` and `ctx.commands.register(...)` directly (as `dsh-command-compact` does). For optional dependency use the `ctx.inject([...], cb)` form (as github-flow does) so the plugin still activates in CLI/TUI profiles.

### A.3 Tool via raw definition / defineTool

```js
ctx.tools.register({
  name: 'context_status',
  description: 'Report current context usage for this session.',
  parameters: { type: 'object', properties: {}, required: [] },
  output: {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    return { totalTokens: 0, sessionId: exec?.sessionId };
  },
});
```

### A.4 `$DSH_HOME` state file (budget-handoff pattern, minimal)

```js
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const file = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-context-manager', 'state.json');

function load() {
  try { const p = JSON.parse(readFileSync(file(), 'utf8')); return p && typeof p === 'object' ? p : {}; }
  catch { return {}; }
}
function save(state) {
  const target = file(), temp = `${target}.tmp`;
  try { mkdirSync(dirname(target), { recursive: true });
        writeFileSync(temp, JSON.stringify(state), 'utf8'); renameSync(temp, target); }
  catch (e) { console.error('[context-manager] save failed', e); }
}
```

---

## Appendix B — adjacent core APIs relevant to a context-management plugin (0.2.2-rc.1 only)

- **`ctx.compaction`** service (`dsh-compaction/lib/index.js:171`): abstract `CompactionEngine` with `compactIfNeeded`, `compactNow`, `compactRegion`; `/compact` uses `compactNow(agent, signal, commandId)` and reports `result.shadowedSeqs.length`, `result.shadowedTokenCount`, `result.summarySeq` (`dsh-command-compact/lib/index.js:55-64`).
- **`ctx.tokenMeter`** service (`inject` in `dsh-compaction-tool-result-pruner/lib/index.js:62`): `measure(session[, header])` → `{ nodes, totalTokens }`, `estimateMessage(message)` → number (`dsh-compaction-basic/lib/index.js:939-960`, `dsh-compaction-tool-result-pruner/lib/index.js:165`). Provider package not extracted → signature inferred from consumers.
- **`ctx.llm.resolveModelInfo(provider, model, signal)`** → `{ context: { contextWindow }, defaultMaxTokens }` (`dsh-compaction-basic/lib/index.js:955-959`).
- **Compaction-safe boundaries**: `toolPairingBalancedBefore/After(session, seq)` exported by the compaction contract (`dsh-compaction/README.md` "Tool-pairing boundaries").
- **Session surface facts**: `session.surface` (`dsh-session/lib/index.js:1331-1333`), `session.deriveMessages()` (`:1681-1696`, cached by `surface.contentGeneration`), `session.snapshotEvents()` (`:1454`), `session.requestHeader()?.config` (`used at dsh-agent-loop:933`, `dsh-compaction-basic:933`).

If the target is strictly 0.2.0-rc.2 compatibility, do **not** build on `ctx.compaction` / `ctx.tokenMeter` / `ctx.llm.resolveModelInfo` without verifying those versions first; the four community plugins themselves only rely on `session`, `agent`, `tools`, `commands`, `webServer`, `slots`.
