# DSH 0.2.2-rc.1 backend/plugin API findings

Scope: extracted packages under `.dsh-probe\core\dsh\node_modules\@deepseek-ai\` (source of truth: `lib/*.js` + `README.md`; TypeScript declarations are **not shipped**, but `lib/typert.host.js` embeds the public `*.ts` declaration strings verbatim — those are quoted where available). A real third-party plugin installed in this deployment (`C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-budget-handoff`) is used as an in-the-wild cross-check. Everything below is **confirmed** unless marked `INFERRED` / `NOT FOUND`.

---

## 1. Verdict on interception feasibility

`agent/pre-step` is **not** a context-pruning/history-rewrite hook. It is a Cordis *waterfall* run once per proposed model step whose `messages` payload is **only the batch the loop just claimed from the agent inbox** (`messages: claimed`), not `session.deriveMessages()`. Its `enter` decision is appended to the session as new `user/message` surface events and only then is `session.deriveMessages()` taken for the request — so a pre-step listener can **filter/reorder/annotate the incoming pending input** (and inject new user-role context), but it cannot see or remove already-logged history. The supported way to reshape existing history is the **session surface** (`surfaceOp: {op:'replace',startSeq,endSeq}`), either through the official `ctx.compaction` seam (`compactRegion`, or `compactNow` when idle) or by appending replacements yourself, as the shipped `dsh-compaction-tool-result-pruner` does. For persistence of plugin state, the supported external-plugin route is `ctx.storageDomain` (mounted by `dsh-base` in this deployment) — not custom session event types; for commands/tools use `ctx.commands.register(...)` and `defineTool(...)` + `ctx.tools.register(...)`, both effect-owned. All of that is available to a host-side plugin today.

---

## 2. `agent/pre-step` exact contract

### 2.1 Declaration (verbatim)

`dsh-agent/README.md:96-98`:

> ### Step admission
>
> `PreStepDecision` is either `{ kind: 'reject' }` or `{ kind: 'enter', messages, startsRequestSeries? }`. The enter branch contains the complete identified, frozen message batch. Acceptance does not commit it: after assembly and `step/start`, the deprecated `agent/request` hook adjusts controls without changing the step's model selection, and `prepareCall()` binds the adapter before the loop commits the system prompt and user batch. Cancellation during either async phase commits neither. `startsRequestSeries: true` declares a distinct model-message series; a wrapping listener preserves that declaration and the batch unless it intentionally replaces either one. Claiming removes offered messages from the inbox, while messages inserted after the claim remain pending for a later boundary.

`dsh-agent/README.md:80`:

> The `agent/*` events let plugins act on live work without depending on the loop package. `agent/pre-step` can reject a proposed step or replace the messages entering it; `agent/request-error` lets a listener retry a failed model request; `agent/turn-stopping` runs before an otherwise completed turn closes and can steer to keep it open.

### 2.2 Payload (verbatim construction site)

`dsh-agent-loop/lib/index.js:666-697` (the only producer; `agent` is injected by the fused dispatcher, not passed here):

```js
	async preStep(target, position) {
		/* v8 ignore next -- private callers establish the running phase before proposing a step */
		if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
		const signal = this.phase.abort.signal;
		const claimed = this.inbox.claim(target, position.turn);
		const selection = this.model.current();
		if (selection === void 0) throw new Error(`agent "${this.id}" has no provider/model: ...`);
		const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal });
		try {
			const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet });
			signal.throwIfAborted();
			const decision = await this.dispatch.waterfall("agent/pre-step", {
				messages: claimed,
				...position,
				signal,
				modelSelection: selection
			}, () => {
				const sections = renderContextSections(assembly);
				const context = this.runtimeContext.project(joinContextSections(sections), sections);
				return Promise.resolve({
					kind: "enter",
					messages: context === void 0 ? claimed : [...claimed, context]
				});
			});
```

Confirmed payload fields:

| field | type / value |
|---|---|
| `agent` | live `Agent` (injected by `agentEvents` fused dispatcher; `dsh-agent/lib/types/dispatch.js:37-42`) |
| `messages` | `readonly UserMessage[]` — **the claimed inbox batch only** (turn boundary: pending `next-step` + one `next-turn`; between steps: `next-step` only) |
| `turn` | `number` (from `position`) |
| `step` | `number` (from `position`, 1-based) |
| `signal` | the turn's `AbortSignal` (`phase.abort.signal`) |
| `modelSelection` | `{ provider, model, reasoningEffort? }` captured by `agent.model.current()` for the whole step + retries |

Listener signature used by shipped code (`dsh-agent/lib/types/model-selection.js:125`):

```js
	return agentCtx.on('agent/pre-step', async ({ agent, messages, signal, step, modelSelection }, next) => {
		const decision = await next();
		if (decision.kind === 'reject' || signal.aborted) return decision;
		...
		return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, modelSelection)] };
	}, { prepend: true });
```

`dsh-time-context/lib/index.js:249-282` is the cleanest injection template (`{ agent, turn, step, signal }` destructure, `next()`, returns `{...decision, messages:[...decision.messages, createUserMessage(...)]}`).

### 2.3 Decision union

- `{ kind: 'reject' }` — no step opens. The loop records `turn/end {reason:{kind:'blocked'}}` (`dsh-agent-loop/lib/index.js:746-749`).
- `{ kind: 'enter', messages, startsRequestSeries? }` — accepted; `messages` (default `claimed` + optional runtime-context user message) become this step's new history.
- `startsRequestSeries?: true` — declares a new model-message series (consumed at `dsh-agent-loop/lib/index.js:849`).

Waterfall mechanics (`cordis/src/events.ts:236-261`): listeners run outermost-first; `next()` invokes the rest of the chain and **must be called at most once** (`throw new Error('next() called multiple times')`); a listener that does not call `next()` vetoes the built-in behavior (i.e. replaces the decision entirely). `{ prepend: true }` puts a listener in front of the default handler (used by model-selection, time-context, compaction-basic). **A thrown listener propagates out of `preStep` → the turn ends with `turn/end {kind:'error'}`** (`dsh-agent-loop/lib/index.js:709-712`, 800-826); wrap risky work in try/catch, as `compaction-basic` does (`lib/index.js:839-852`).

### 2.4 Per-step vs per-turn and what happens to `messages`

- Runs **once per proposed step** inside the turn loop (`dsh-agent-loop/lib/index.js:739-745`). Retries of the same step **do not** re-run it: "Retries reuse the same rendered assembly without repeating assembly, `agent/pre-step`, or user admission" (`dsh-agent-loop/README.md:120`).
- Ordering within a step: `preStep` (assembly + `agent/pre-step`) → `step/start` → `agent/request` (deprecated) → `prepareCall` → system/user admission → request.
- `decision.messages` are committed to the session as `user/message` surface events on the first attempt (`dsh-agent-loop/lib/index.js:850-866`):

```js
			let contextAdmitted = false;
			if (firstAttempt) for (const message of decision.messages) if (message.source.kind === "runtime-context") {
				if (context !== void 0 && !contextAdmitted) {
					this.session.append("user/message", context, { surfaceOp: "append" });
					contextAdmitted = true;
				}
			} else this.session.append("user/message", message, { surfaceOp: "append" });
			if (context !== void 0 && !contextAdmitted) this.session.append("user/message", context, { surfaceOp: "append" });
```

- Consequence 1: accepted messages are **durable history**, not "just the next request".
- Consequence 2: dropping a message by returning fewer `decision.messages` means it is **never logged** (it was already claimed out of the inbox) — i.e. pre-step can discard the *arriving* batch, which is also why a `reject` is accounted as consuming the claimed input (`dsh-agent/lib/types/consumed-work.js:14-31`: "the pre-step rejection that produced it discarded the claimed messages, so the work it took will never run").
- Consequence 3: `messages` never contains prior history. History is read later: `dsh-agent-loop/lib/index.js:1078-1088` `const boundaryMessages = session.deriveMessages(); ... messages: boundaryMessages`. There is no other hook around it.

### 2.5 Does it affect only the next model call?

**No.** It affects the next model call *and* everything after it, because the accepted batch is appended to the log (see 2.4) and derived history grows append-only. Conversely, it **cannot** change earlier calls/history.

---

## 3. Message model, tool pairing, turn identification

### 3.1 Message union (verbatim declarations from `dsh-llm/lib/typert.host.js`)

```ts
export interface MessageBase { readonly id: MessageId; readonly content: readonly ContentBlock[]; readonly source: MessageSource; }
export interface MessageRoleMap { system: SystemMessage; developer: DeveloperMessage; user: UserMessage; assistant: AssistantMessage; tool: ToolResultMessage; }
export type Message = MessageRoleMap[keyof MessageRoleMap];
export interface UserMessage extends MessageBase { readonly role: 'user'; }
export interface AssistantMessage extends MessageBase { readonly role: 'assistant'; readonly source: ModelMessageSource; }
export interface ToolResultMessage extends MessageBase { readonly role: 'tool'; readonly source: ToolMessageSource; readonly toolCallId: ToolCallId; readonly isError?: boolean; }
export interface SystemMessage extends MessageBase { readonly role: 'system'; readonly source: MessageSourceMap['system-prompt']; }
export interface DeveloperMessage extends MessageBase { readonly role: 'developer'; }
```
(`dsh-llm/lib/typert.host.js:279-280, 335-336, 475-496, 603-605, 659-672`)

Content blocks (`dsh-llm/lib/typert.host.js:315-321, 347-348, 375-376, 535-536, 627-628, 639-640`):

```ts
export type ContentBlock = ContentBlockMap[ContentBlockType];
export interface ContentBlockMap { text: TextBlock; reasoning: ReasoningBlock; image: ImageBlock; file: FileBlock; 'tool-call': ToolCallBlock; 'tool-addition': ToolAdditionBlock; 'tool-removal': ToolRemovalBlock; }
export interface TextBlock { type: 'text'; text: string; }
export interface ReasoningBlock { type: 'reasoning'; text: string; }
export interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; name: string; arguments: string; }   // arguments is a JSON STRING
export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true; }
export interface FileBlock { type: 'file'; attachment: FileAttachmentRef; }
```

`MessageSource` is a wide discriminated union (`dsh-llm/lib/typert.host.js:491-496`): `'user'`, `'model'`, `'tool'`, `'system-prompt'`, `'model-selection'`, `'tool-registry'`, `'action-cards'`, `'runtime-context'`, `'user-rpc'` (kind `'user'` + `rpcId`/`clientTimeZone`), `'working-directory'`, `'user-approval'`, `'agent-message'`, `'subagent-settled'`, `'skill-invocation'`, `'ptc-mode'`, `'compact-checkpoint'`, `'cordis-host-runner'`, `'user-question-reply'`, `'team-message'`, `'goal'`, `'plan-mode'`, `'schedule'`, `'session-reference'`, `'webhook'`. User-role context carriers also have a `ContextFormed` form tag (`undefined | 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'`; `dsh-llm/lib/typert.host.js:327-328`).

Constructors (`dsh-llm/lib/types/message.js:34-100`): `createMessage`, `createUserMessage`, `createDeveloperMessage`, `createAssistantMessage`, `createSystemMessage`, `createToolResultMessage`, `freezeMessage`. All mint a fresh `id` via `brandString(randomUUID())` and deep-freeze.

### 3.2 Tool call/result pairing

- Assistant tool call: `ToolCallBlock { type:'tool-call', id, name, arguments: string }` inside an assistant message.
- Tool call log event: `tool/call { turn, step, callId: block.id, name, arguments: block.arguments }` (`dsh-tools/lib/pipeline.js:185-195`).
- Result message: `ToolResultMessage { role:'tool', toolCallId, isError?, source:{kind:'tool', callId} }` created by `createToolResultMessage` (`dsh-llm/lib/types/message.js:92-100`).
- Result log event: `tool/result { turn, step, message, error?, meta? }` with `surfaceOp:'append'` and `sourceEventSeqs:[callSeq]` (`dsh-tools/lib/pipeline.js:196-213`).
- Pairing rules to preserve when editing history: every assistant `tool-call.id` must be answered by exactly one `role:'tool'` message with the same `toolCallId`, and a surface cut must not split a step's call/result pair. The compaction seam exports the validators `toolPairingBalancedBefore(session, seq)` / `toolPairingBalancedAfter(session, seq)` (`dsh-compaction/lib/index.js:72-93`); `compactRegion` rejects unbalanced edges (`dsh-compaction-basic/lib/index.js:554-558`).

### 3.3 Turn/step identification (event vocabulary, verbatim)

`dsh-api-session-controller/lib/typert.host.js:3615-3616` (the full `SessionEventMap`, abridged to turn/step/message events):

```ts
export interface SessionEventMap {
    'turn/start': { turn: number; };
    'turn/end': { turn: number; reason: TurnEndReason; };
    'step/start': { turn: number; step: number; };
    'step/end': { turn: number; step: number; };
    'user/message': UserMessage;
    'system/message': { turn: number; step: number; message: SystemMessage; };
    'developer/message': { turn: number; step: number; message: DeveloperMessage; headerSeq?: SessionSeq; };
    'assistant/message': { turn: number; step: number; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true; };
    'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string; };
    'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: {...}; meta?: JsonValue; };
    'model/selection': ModelSelection;
    'agent/inbox/spliced': { target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: 'canceled'; };
    ...
}
```

`TurnEndReason` variants (`dsh-api-session-controller/lib/typert.host.js:4059-4060`):

```ts
export interface TurnEndReasonMap {
    completed: { kind: 'completed'; };
    aborted: { kind: 'aborted'; reason: TurnEndCancelCause; };
    blocked: { kind: 'blocked'; };
    error: { kind: 'error'; error: LlmFailure; };
    'max-tokens': { kind: 'max-tokens'; };
    interrupted: { kind: 'interrupted'; };
    forked: { kind: 'forked'; };
}
```

Loop write sites: `turn/start {turn}` (`dsh-agent-loop/lib/index.js:731`), `step/start {turn,step}` (757-760), `step/end` (781-784), `turn/end {turn, reason}` (819-822).

Helpers:
- `ctx.agents.turnBoundaryOf(session)` → projection state `{ openTurnStartSeq, lastStepStartSeq, lastStepBoundary: {kind:'start'|'end', seq}|null, lastTurn }` (projection definition `dsh-agent/lib/types/projection.js:4-52`; service method `dsh-agent/lib/index.js:84-86`).
- `session.surface.nodes: readonly SessionSeq[]` — current model-visible node seqs in order (`dsh-session/lib/index.js:560-565`; `SessionSurface` declaration at `dsh-api-session-controller/lib/typert.host.js:3823-3824`).

### 3.4 Telling "current user input" apart from history

- Inside `agent/pre-step`, `messages` **is** the current input batch: `message.source.kind === 'user'` are real user/steering messages; other kinds are injected context (e.g. `'runtime-context'`, plugin names, `'model-selection'` notices).
- Pre-claim, pending input lives on `agent.inbox.nextTurn` / `agent.inbox.nextStep` (`Inbox` declaration `dsh-api-session-controller/lib/typert.host.js:3183-3188`: `nextTurn/nextStep: readonly UserMessage[]`, `append/prepend/replace/remove/clear/splice`).
- To find the current turn's user input in the *log*, scan back from `session.seq-1` to the latest `turn/start` (`dsh-time-context/lib/index.js:152-161` is the shipped pattern):

```js
function requestMessages(agent, turn, proposed) {
	const entered = [];
	for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
		const event = agent.session.eventAt(SessionSeq(seq));
		if (event?.type === "turn/start" && event.data.turn === turn) return [...entered.reverse(), ...proposed];
		if (event?.type === "user/message") entered.push(event.data);
	}
	return [...proposed];
}
```

(Caveat: `eventAt`/`snapshotEvents` are deprecated for new production callers — see §9.)

Distinguishing `followup` vs `steer` vs `inject`: all are identified user-role messages; `followup` goes to `nextTurn`, `steer` to `nextStep`, `inject` to `nextStep` without waking the driver (`dsh-agent/README.md:56-70`). The inbox target, not a message flag, encodes intent.

---

## 4. Persistence recommendation (external plugin)

### 4.1 Can a third-party plugin declare its own session event type?

**No — not persisted-and-restorable via `SessionEventMap` declaration merging.** Evidence:

- `dsh-session/lib/types/known-event-types.js:7-20` (verbatim):

> Every `SessionEventMap` member declared in this repository — the event vocabulary this build understands. The persistence read path refuses to interpret a log containing a type outside this set unless the event carries the envelope's `ignorable` marker … **Downstream (out-of-repo) plugin events are outside this list by construction.** The persisted `SessionEvent.ignorable` marker is the compatibility mechanism; event-name registration was rejected because it does not classify omission safety and would make reads composition-dependent.

- Read-path enforcement: `dsh-session-persistence/lib/index.js:182-185`:

```js
function validateStoredEvents(meta, events, location) {
	for (const event of events) if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(`session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log ...`, location);
```

- `session.append()` builds the envelope with **no `ignorable` field** (`dsh-session/lib/index.js:1524-1545`), so a custom `declare module` event appended at runtime is accepted live (surface validation only checks marker eligibility, `dsh-session/lib/index.js:298-312`) but **the next resume/read of that persisted log throws `SessionFormatUnsupportedError`** for the whole session. This is a soft data-loss trap.
- The only `ignorable:true` writer is `appendPluginRecord` (`dsh-session/lib/index.js:1548-1571`, `#appendRecord` sets `ignorable: true`), type grammar `^plugin:[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*$` (`:1248`). But `dsh-session/README.md:68-78` says it exists for `@deepseek-ai/dsh-experimental-*` packages and "**Plugins outside this repository must not call it either**, although no repository check can inspect them." Runtime enforces only the name grammar, not the caller. `INFERRED`: technically callable from an external plugin, but explicitly out of contract; do not build on it.

### 4.2 Recommended: `ctx.storageDomain` (schema-validated KV, per-session records)

`dsh-base/cordis.patch.yml:175-190` proves this deployment mounts the stack (root `$DSH_HOME/storages`, backend `json`):

```yaml
    # Durable KV storage: the storage hub, the json backend, and the
    # schema-validated domain form over them. ...
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

API (`dsh-storage-domain/README.md:38-58`; `lib/index.js:46-48, 61-75, 190-194, 254-305, 375-381`):

```js
const spec = defineDomain({
  name: 'context_template',              // /^[a-z][a-z0-9_]*$/
  version: 1,
  tables: { sessions: domainTable(sessionRecordSchema) },   // zod schema
})

const domain = await ctx.storageDomain.open(spec)
ctx.effect(() => () => domain.close(), 'ctx-template.domainClose')
const table = domain.table('sessions')    // key = session id (string)
table.get(sessionId)                      // synchronous read from memory
await table.put(sessionId, record)        // durable before it resolves
await table.update(sessionId, prev => ({ ...prev, n: prev.n + 1 }))  // rejects 'missing-key'
await table.delete(sessionId)
table.entries() / table.keys() / table.size
domain.global.get() / .set(value)         // optional singleton (schema must not accept null)
```

Real shipped usage: `dsh-workspace/lib/index.js:255-268` (domain spec with `workspaces` table + global) and `:379-383`:

```js
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(workspaceDomainSpec);
		this.ctx.effect(() => () => domain.close(), "workspace.domainClose");
		this.table = domain.table("workspaces");
		this.global = domain.global;
```

There is **no dedicated per-session keyed store API**; the idiom is a domain table keyed by `session.id` (single-unit layout gives `<root>/<domain>.json`, per-record gives `<root>/<domain>/<table>/<key>.json`; `dsh-storage-json/README.md:12, 34-52, 80-90`). This is exactly what `dsh-budget-handoff` 0.4.0 writes: `C:\Users\<user>\.dsh\storages\dsh-budget-handoff\sessions.json` = `{"version":1,"sessions":{"<sessionId>":{...}}}`, i.e. the domain named `dsh-budget-handoff` with a `sessions` table.

### 4.3 The two real routes (and why the shipped plugin chose the second)

- Route A — `ctx.storageDomain` as above: durable, schema-validated, atomic, `domain/changed` events, no model effect. Requires the storage stack to be mounted (it is, via `dsh-base`).
- Route B — hand-rolled JSON under `$DSH_HOME/storages/<plugin>/`, which is what `dsh-budget-handoff/dist/persist.js:1-49, 89-148` does: atomic `writeFileSync(temp)+renameSync`, tolerant load, prune to N sessions. Its header comment explains why they avoided replaying the session log: *"replaying it would couple this plugin to the (deprecated) synchronous session readers."* If your plugin must work under compositions that omit `dsh-storage*`, this is the zero-dependency fallback.

`NOT FOUND`: any `ctx.storage.session(...)`, `ctx.sessions.metadata(...)`, or `ctx.plugins.state(...)`-style per-session store. `dsh-settings` is deployment config editing only (volatile plugin Config through the profile patch), **not** per-session state (`dsh-settings/README.md:12, 33`). `dsh-session-persistence` exposes only the session **log** handle (`create/open/stat/list/flush`; `README.md:36-49`) — do not write plugin state into the log.

### 4.4 Per-session state derived from the log (alternative)

`ctx.sessionProjections.register(definition)` gives replayable per-session state folded from committed events, with optional checkpointing (`dsh-session-projection/README.md:34-64, 98-100`):

```js
const handle = await ctx.sessionProjections.register({
  key: 'contextTemplate', stateVersion: 1, stateSchema, init: () => ({...}),
  apply: (state, event) => event.type === 'turn/start' ? {...state, turn: event.data.turn} : state,
  wire: { viewSchema, view: state => state },
})
handle.stateOf(session)     // synchronous
```

Use this only if your state is a pure fold of events already in the log (`turn/start`, `tool/result`, …). It is *not* a place to persist plugin-authored values that have no session event.

---

## 5. Commands API + minimal example

Registration service: `ctx.commands` (plugin name `'commands'`; `dsh-commands/lib/types/index.js:46, 227-238`). `ctx.commands.register(definition)` is effect-scoped and returns the disposer:

```js
         * @param definition - discovery metadata and direct UI handler.
         * @returns the exact effect disposer that unregisters this definition.
         */
        register(definition) {
            const registered = normalizeDefinition(definition);
            return this.layers.effect(this.ctx, layer => layer.commands.insert(registered.definition.name, registered), { label: 'commands.register()' });
        }
```

Definition / invocation / result (verbatim declarations, `dsh-commands/lib/typert.host.js:304-338`):

```ts
export interface CommandDefinition {
    readonly definitionId?: CommandDefinitionId;
    readonly name: string;
    readonly description: string;
    readonly input?: CommandInputDescriptor;
    readonly recordInput?: boolean;
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
export interface CommandInvocation {
    readonly commandId: CommandId;
    readonly agent: Agent;
    readonly rawInput: string;
    readonly attachments: readonly (ImageBlock | FileBlock)[];
    readonly signal: AbortSignal;
}
export type CommandResult = { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq; } | { readonly kind: 'error'; readonly text: string; };
```

Notes: `handler` (not `execute`); name must match `/^[a-z][a-z0-9_-]*$/u`; `input.hint` (non-empty string) and `input.attachments: boolean` are the only input metadata; `recordInput:false` suppresses `args` in the `command/run` log event; `description` must be non-empty (`dsh-commands/lib/types/index.js:124-170, 312-317`); the handler runs outside any turn and its text is **not** model-visible (`README.md:12, 120-132`). `execute(agent, line, attachments, signal)` is the adapter entry point; it returns `{commandId, result}` or `undefined` for bad syntax/unknown name (`lib/types/index.js:302-326`).

Shipped example (`dsh-command-compact/lib/index.js:78-99`):

```js
function apply(ctx) {
	const active = new Set();
	const handler = (invocation) => { ... return operation };
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

Real third-party pattern — dependency-optional child injection (`desktop-hand/lib/commands.js:33-43`):

```js
export function registerDesktopHandCommand(ctx, runtime) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME            // 'desktop-hand'
      description: '...',
      input: { hint: 'status | authorize input|files ...' },
      handler: ({ agent, rawInput }) => handleCommand(runtime, agent, rawInput ?? ''),
    })
  })
}
```

Minimal plugin:

```js
import { name as pkg } from './package.json' with { type: 'json' }   // or hardcode
export const name = 'ctx-template'
export const inject = ['commands']

export function apply(ctx) {
  ctx.commands.register({
    name: 'ctx-template',
    description: 'Manage the context template',
    input: { hint: 'status | pin <text> | clear' },
    async handler({ agent, rawInput, signal }) {
      if (rawInput.trim() === 'status') return { kind: 'success', text: 'template: default' }
      if (signal.aborted) return { kind: 'error', text: 'cancelled' }
      return { kind: 'success', text: `ok: ${rawInput.trim()}` }
    },
  })
}
```

(Deliberately omit `definitionId` unless you need stable cross-adapter identity; it is branded via `CommandDefinitionId` from `@deepseek-ai/dsh-commands/brand`.)

---

## 6. Tools API + minimal example

API: `defineTool(options)` from `@deepseek-ai/dsh-tools` then `ctx.tools.register(definition, options?)` (`dsh-tools/README.md:32-62, 69`; `dsh-tools/lib/types/index.js:59-83`):

```js
         * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
         * @param options - optional step-time activation condition.
        register(definition, options = {}) {
            ...
            return this.layers.effect(this.ctx, layer => layer.tools.insert(name, { definition, when: options.when }), { label: 'tools.register()' });
        }
```

`defineTool` options (`dsh-tools/lib/types/schema.js:268-355`): `name`, `description`, `parameters` (property-map DSL or JSON Schema), `output: { schema, render(args, value), presentationMeta? }`, `execute(args, exec)`, optional `finalizeContent`, `projectContent`, `timeoutMs` (declarative only), `deferLoading`, `presentCall/presentResult`, `isConcurrencySafe`. Arguments are validated before `execute`; invalid input becomes `ToolArgsError` → normal tool error result.

Execution context (`exec`) fields, from the pipeline construction (`dsh-tools/lib/pipeline.js:33-42`): `{ callId, name, arguments (parsed, frozen), agent?, toolSet?, signal, log?: {turn, step} }`. `exec.agent` is absent for programmatic calls outside a model step (`dsh-tools/README.md:28`).

Shipped example — `dsh-tool-todo/lib/index.js:97-195` (registration + output + execute + presenter):

```js
	ctx.tools.register(defineTool({
		name: "todo_write",
		description: describe(allowParallel),
		parameters: { todos: { type: "array", required: true, description: "The COMPLETE task list, replacing any previous list.",
			items: { type: "object", additionalProperties: false, properties: {
				content: { type: "string", required: true, description: "..." },
				status: { type: "string", required: true, enum: [...STATUSES], description: "..." } } } } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { todos: {...}, counts: {...} } },
			render: (_args, value) => [{ type: "text", text: `Updated todo list: ...` }]
		},
		execute(args, exec) {
			const todos = toTodoList(args.todos, allowParallel);
			if (!exec.agent) throw new Error("todo_write requires an owning agent session");
			exec.agent.session.append("todo/write", { todos });
			return Promise.resolve({ todos, counts });
		},
		presentCall: (args) => ({ card: "generic", title: "Update todo list", kind: "other", rawInput: args.todos })
	}));
```

Minimal plugin:

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ctx-template'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'context_template_pin',
    description: 'Pin or unpin an instruction block in the context template.',
    parameters: {
      text: { type: 'string', required: true, description: 'Instruction text' },
      mode: { type: 'string', enum: ['pin', 'unpin'], description: 'Operation' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pinned: { type: 'boolean', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.pinned ? 'Pinned.' : 'Unpinned.' }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (exec.agent === undefined) throw new Error('requires an owning agent')
      // persist via ctx.storageDomain (see §4) or set module state here
      return { pinned: args.mode !== 'unpin' }
    },
  }))
}
```

Conditional visibility: `ctx.tools.register(def, { when: async ({ agent, modelSelection, signal }) => boolean })` — evaluated once per model step; a throwing condition fails step preparation as `TOOL_ACTIVATION_FAILED` (`dsh-tools/README.md:66-73`). Per-agent masking: `ctx.tools.restrict({ allow?, deny? })` only works from a scoped context (`agent.ctx`), not global (`lib/types/index.js:89-114`).

---

## 7. `ctx.effect`

`cordis/src/fiber.ts:408-424` (verbatim JSDoc + overloads):

```ts
  /**
   * Register a cleanup-aware effect on this fiber.
   *
   * `execute` runs immediately; the disposers it produces are collected and
   * run (in reverse order) either when the returned disposer is called or
   * when the fiber unloads, whichever comes first. Calling the disposer twice
   * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
   * already disposed, and `TypeError` if `execute` returns an invalid shape.
   */
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

Accepted effect bodies (`cordis/src/fiber.ts:83-93`): a disposer function, `Promise<disposer>`, an iterable of disposers, or an async iterable; generator effects register each yielded disposer **as it is produced** (order preserved, torn down in reverse). Label is for `fiber.getEffects()` diagnostics.

Idioms in shipped code:

```js
ctx.effect(() => () => domain.close(), 'workspace.domainClose')          // dsh-workspace/lib/index.js:381
ctx.effect(function* () { yield async () => {...}; yield ctx.commands.register({...}) }, 'command-compact lifecycle')  // dsh-command-compact/lib/index.js:89-99
ctx.effect(async function* () { yield this.enter(agent, undefined); await this.announce(agent, 'startup') }.bind(this), 'agents.register()')  // dsh-agent/lib/index.js:235-239
```

Event listeners are already effects: `ctx.on(name, fn, { prepend? })` registers through `ctx.fiber.effect(...)` and auto-unregisters on unload (`cordis/src/events.ts:263-270`), so no manual cleanup is needed for `ctx.on`. `ctx.inject(['service'], child => {...})` creates a dependency-gated child plugin context; registrations made in the child are owned by that child's fiber.

---

## 8. Compaction hooks (the real pruning interception point)

### 8.1 Service contract

`dsh-compaction/lib/index.js:160-173`:

```js
/**
* Abstract compaction service. Implementations own trigger policy, retention,
* and summarization, and may consume a separate measurement service. A
* successful run replaces the selected surface span with one summary node and
* prevents concurrent compaction of the same session. ...
*/
var CompactionEngine = class extends Service {
	constructor(ctx) {
		super(ctx, "compaction");
	}
};
```

Exactly one implementation per context (`ctx.compaction`). Shipped backend `dsh-compaction-basic` implements the three contract operations (`dsh-compaction/README.md:76-78`; method JSDoc in `dsh-compaction-basic/lib/index.js`):

```js
	async compactIfNeeded(agent, trigger, signal)            // trigger: 'pressure' | 'context-overflow' → CompactionResult | null   (:932-947)
	async compactRegion(start, end, agent, signal)           // inclusive surface-node seqs → CompactionResult                      (:988-993)
	compactNow(agent, signal, sourceCommandId)               // idle-only, forced useful reduction → Promise<CompactionResult|null>  (:1002-1028)
```

`CompactionResult` shape from the commit site (`dsh-compaction-basic/lib/index.js:662-674, 677-681`):

```js
	return {
		compactionId, sourceCommandId?, startSeq, summarySeq,
		summary,                      // ContentBlock[]
		shadowedRange: { start, end },
		shadowedSeqs: [...shadowedSeqs],
		shadowedTokenCount,
		endSeq
	};
```

Contract constraints:
- `compactRegion` requires an **open turn**: `if (entryState.openTurn === null) throw new Error("compactRegion: no open turn — automatic compaction events must be enclosed in a turn")` (`dsh-compaction-basic/lib/index.js:460-461`). So call it from an `agent/pre-step` / `agent/turn-stopping` listener (this is what `compaction-basic` itself does at `lib/index.js:839-852`), or use `compactNow` for an idle agent (it wraps `agent.runMaintenance(...)`; `:1002-1028`).
- Locking is a log bracket: `compaction/start` before summarization, `compaction/end` after; concurrent entry reports `busy` (`dsh-compaction/README.md:71-73, 109-111`).
- Edge validation: `toolPairingBalancedBefore/After(session, seq)` must be true (`dsh-compaction-basic/lib/index.js:554-558`), so you cannot split a tool call/result pair.
- The surface mutation is **exactly one** `user/message` with `surfaceOp: {op:'replace', startSeq, endSeq}` and `sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]` (`dsh-compaction-basic/lib/index.js:650-661`). Raw events stay in the log; derived history only drops the shadowed nodes (`dsh-session/README.md:52, 127-129, 163`).

### 8.2 Is there a better official pruning hook than pre-step? Yes — two:

1. **`ctx.compaction.compactRegion(start, end, agent, signal)`** — the official range-replacement primitive, model-summarized via the mounted backend. This is the correct way to shrink existing history from a context-management feature.
2. **The tool-result pruner pattern**, the only shipped model-free pruning example (`dsh-compaction-tool-result-pruner/lib/index.js:137-191`). It iterates current surface nodes, derives each message, builds a pruned copy with `freezeMessage({...original, content})`, then appends a shadow-price event and a same-type replacement:

```js
			session.append("compaction/prune", {
				shadowedRange: { start: seq, end: seq },
				shadowedSeqs: [seq],
				shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original)
			});
			const replacement = session.append("tool/result", {
				...event.data,
				message
			}, {
				surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
				sourceEventSeqs: [seq]
			});
```

The same recipe works for `user/message` / `assistant/message` / `system/message` nodes (subject to the node-0 `system/message` protection in `dsh-session/README.md:60`), and it works during any open turn. `compaction/prune` is documented as a shadow-price protocol for the token meter (`dsh-compaction/README.md:115`), so emitting it keeps `ctx.tokenMeter.measure()` correct.

Caveat: `session.append(..., {surfaceOp:{op:'replace',...}})` is **irreversible** in model-visible terms (later replacements can shadow the replacement, but the original nodes stay shadowed unless a new node covers them; the log is append-only). Do not use it for transient per-request filtering — that is what a request-scoped hook would be for, and **none is exposed** (`buildRequest()` is package-private; `session.deriveMessages()` is not intercepted).

### 8.3 Not hooks

- `compaction/summary-error` (waterfall) only lets a backend request durable input recovery for a failed summary (`dsh-compaction/README.md:82-86`).
- `compaction/prune` is an event, not a service method.
- No `compaction/pre-*` / `session/pre-derive` interception point exists in 0.2.2-rc.1. `NOT FOUND` after grepping all extracted packages for `pre-step`-style waterfalls on derival.

---

## 9. Open questions / risks (mark unverified)

1. **Deprecated event readers vs. pruning.** `eventAt`, `snapshotEvents`, `ownEvents` are deprecated: "existing logic may remain unmigrated for now, but new production calls are prohibited" (`dsh-session/README.md:64`). Yet the shipped pruner itself uses `session.eventAt(seq)` (`dsh-compaction-tool-result-pruner/lib/index.js:140`). The supported alternative for reading history is `ctx.sessionQuery` (`readSession`, `readSurface`, `listEvents`, `readEvent`, `observeSession`; `dsh-session-query/README.md:28-45`) — but that service is backend-provided (shipped composition uses `dsh-session-query-sqlite`) and its reads are async. **Unverified:** whether a minimal desktop composition always mounts `sessionQuery`; if not, surface replacement via `ctx.compaction` avoids the problem entirely (you only need `session.surface.nodes` + the seqs you already have).
2. **Overriding `session.deriveMessages()` per instance** (Lead's noted option) is technically possible (plain class, no freeze) but not a documented extension point; a second consumer calling it would see the filtered view, and `buildRequest()` freezes the returned messages, so the override must return stable frozen objects. Treat as unsupported and fragile; no shipped plugin does it.
3. **Custom session events** — see §4.1: in-memory append works, persisted resume fails closed. `KNOWN_SESSION_EVENT_TYPES` is exported as a mutable `Set`, so a plugin could `.add()` its type at load; `INFERRED` hack, version-fragile, not attempted/verified, and the comment explicitly rejects event-name registration.
4. **`appendPluginRecord` callable but forbidden** for out-of-repo plugins (policy lint only, no runtime caller check). Not verified whether the desktop host's own lint/CI would reject; do not rely on it.
5. **`storageDomain` availability** — confirmed for `dsh-base`-based desktop profiles (`dsh-base/cordis.patch.yml:179-190`); unverified for `dsh-sdk-minimal` / headless spines. A plugin should either `inject: ['storageDomain']` (hard dependency) or use the `$DSH_HOME/storages` fallback (`dsh-budget-handoff` pattern).
6. **`agent/pre-step` listener ordering** — `{prepend:true}` runs before the default and before other non-prepended listeners; `compaction-basic`'s pressure listener is registered without `prepend` (`lib/index.js:839`), `time-context`/`model-selection` use `prepend: true`. Relative order among same-priority listeners is registration order (Cordis array push). Unverified whether any shipped listener can mutate `decision.messages` after yours; assume it can and always spread `...decision`.
7. **Turn identification via `turnBoundaryOf`** returns boundary *state*, not `{turn, step}`; the only direct sources of the current numbers are the `agent/pre-step` payload, `session.seq` scanning, or `exec.log` in a tool. Confirmed fields, no helper that returns `{turn, step}` directly.
8. **Message `id` requirement for injected messages**: `createUserMessage` mints one; the session append validator does not require `id` on `user/message` data, but `MessageBase` declares it and Client APIs use `message.id` (`dsh-api-session-controller/lib/index.js:2398-2402`). Always use the constructors, never hand-built objects.

---

### One-line index of exact names

`ctx.agents.{create,resume,get,list,roots,turnBoundaryOf,withInitiator,requireInitiator}` · `agent.{id,session,model,inbox,status,ctx,cancel,whenIdle,runMaintenance,send,followup,steer,inject}` · `agent.inbox.{nextTurn,nextStep,append,prepend,replace,remove,clear,splice}` · `ctx.sessions.{create,get,list,fork,flush}` · `session.{append,deriveMessages,deriveEventMessage,surface,requestHeader,toolHistory,seq,eventAt,snapshotEvents}` · `session.surface.{nodes,replaceGeneration,contentGeneration}` · surface events `system/message,developer/message,user/message,assistant/message,tool/result` + `surfaceOp:'append' | {op:'replace',startSeq,endSeq}` · `ctx.commands.register({definitionId?,name,description,input?:{hint,attachments?},recordInput?,handler})` · `ctx.tools.register(defineTool({name,description,parameters,output:{schema,render},execute,timeoutMs?,...}), {when?})` · `ctx.compaction.{compactIfNeeded,compactRegion,compactNow}` · `toolPairingBalancedBefore/After(session,seq)` · `compactCheckpointSource/isCompactCheckpointSource` · `ctx.storageDomain.open(defineDomain({name,version,tables,global?}))` → `domain.table(name).{get,put,update,delete,deleteMany,entries,keys,size}` · `domain.global.{get,set}` · `defineDomain/domainTable` · `ctx.sessionProjections.register(definition)` → `handle.stateOf(session)` · `ctx.sessionQuery.{readSession,readSurface,listEvents,readEvent,observeSession}` · `ctx.effect(execute,label?)` · `ctx.on(name,fn,{prepend?})` · `ctx.inject(deps,cb)`.
