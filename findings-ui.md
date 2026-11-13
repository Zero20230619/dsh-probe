# DSH 0.2.2-rc.1 client/UI plugin mechanism — per-message "pin" control feasibility

Scope: local files only. Primary evidence:
- Extracted core: `D:\Windows\Desktop\Code\.dsh-probe\core\dsh\node_modules\@deepseek-ai\...` (referenced below as `core/<pkg>/...`).
- Shell bundle: `core/dsh-web-frontend/dist/assets/index-BgUyXZcc.js` (minified; line references are to that built file).
- Installed community plugins: `C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-github-flow`, `...\dsh-whale-widget`, `...\dsh-message-datetime`.

Legend: **[CONFIRMED]** = read in shipped code/docs; **[INFERRED]** = reasoned from confirmed code but not exercised by a shipped plugin; **[UNVERIFIED]** = could not confirm locally.

---

## 1. Verdict

**Partially — a mouse-clickable checkbox/toggle can be added per *turn* (one control on the turn's closing assistant message), but not "next to every message" out of the box. Full per-user-message/per-assistant-step checkboxes are possible only by *replacing* the official node renderer, which is a supported-but-fragile override, not an extension point.**

The exact mechanism for the supported case: a client plugin declares `dsh.client` in `package.json`, ships `exports["./client"]`, and its bundle registers a component into the **`conversation.chat.assistant-actions` list slot**:

```
core/dsh-client-ui-chat/lib/client.js:9040  const messageId = closing.finalNode.messageId;
core/dsh-client-ui-chat/lib/client.js:9041  const assistantActions = messageId === void 0 ? null : renderSlot("conversation.chat.assistant-actions", { messageId });
...
core/dsh-client-ui-chat/lib/client.js:9046  children: [tail, jsx(MessageIconActions, { ..., extraActions: assistantActions, ... })]
```

`conversation.chat.assistant-actions` is declared as a `list`, `session`-scoped child of the `turn-tail` node ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:9336-9339`), and the existing Like/Dislike buttons use exactly this slot ([CONFIRMED] `core/dsh-client-ui-message-feedback/lib/client.js:963-984`). A new entry's component therefore receives `{ messageId, sessionId, useSession, useProjection, useAccess, t, ...injected }` and can render an arbitrary React `<button role="checkbox">` inside the finalized assistant message's action row. This is rendered only when `messageId !== undefined`, i.e. only for the finalized closing assistant message of a turn (partial/interrupted messages get no action strip at all — also stated in `core/dsh-client-ui-message-feedback/README.md:32`: "Only finalized messages reach the message entry — an interruption-frozen partial carries no `messageId` and therefore no feedback controls.").

Why "not every message":
- **User messages have no extension point in their action row.** The durable user bubble hardcodes its action strip and passes no `extraActions` ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:6280-6287`, compare assistant at `9046-9055`). The only user-message seat is the chain slot `conversation.chat.user.before`, rendered *above* the bubble with owner props `{ source, kind }` only — **no `messageId`, no turn, no seq** ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:6184-6187`, declaration at `9242-9245`). It cannot reliably key persistent state to one message.
- **Assistant steps are not individually extensible.** The action strip is attached to the *turn-tail* (closing) assistant message, not to every `assistant-step` node; `conversation.chat.node` is keyed by node kind, and each kind has exactly one renderer unless shadowed.
- **Replacement path (feasible, not recommended):** register a `conversation.chat.node` entry with `key: "user"` (or `"assistant-step"`) at a **lower priority** than the official `0`, which shadows it ([CONFIRMED] the slot registry renders the lowest-priority entry per key: shell bundle `core/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:123` `entriesOfSlot(...)`; documented replacement idiom at `core/dsh-client-ui-chat/README.md:130` "A replacement uses a lower priority number" and `:79` "a lower priority picks the replacement"). Such a component receives the whole `node` prop, hence `node.data.messageId` ([CONFIRMED] user node data built with `messageId: event.data.id` at `core/dsh-client-ui-chat/lib/client.js:11985-11992`). It could reuse `renderFactorySlot("conversation.chat.user.content", ...)` for the body and add its own checkbox — but it **replaces** the official row (must re-own copy action, clock, pending/echo/steering wiring). For assistant steps the replaced surface is far larger.

So: **yes for a per-turn checkbox on the closing assistant message (recommended); partial for per-user-message (only by replacing the node renderer); no supported per-assistant-step action extension.**

---

## 2. Client plugin packaging & registration

### 2.1 The declaration in `package.json`

[CONFIRMED] `core/dsh-client-ui-message-feedback/package.json:16-38`:

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  ...
},
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-ui-commands"
    ],
    "platform": "web"
  }
}
```

The manifest validator accepts exactly these fields ([CONFIRMED] `core/dsh-client-modules/lib/index.js:86-100`):

```js
const decl = value;
if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
return { platform: decl.platform, ...inject !== void 0 ? { inject } : {}, ...external !== void 0 ? { external } : {}, ...decl.immediately !== void 0 ? { immediately: decl.immediately } : {} };
```

- `platform` — `"web"` for the browser GUI.
- `inject` — **client-plugin load-order dependencies**, i.e. package ids whose bundle/services must be loaded before this one (Cordis service providers such as `slots`, `remote`, `locale`, `uiConversation`). This is *not* the JS module graph (see `external`).
- `external` — non-baseline **module requests** the bundle `require()`s; each must be answered by a dynamic package row or a static-table key ([CONFIRMED] `core/dsh-client-modules/README.md:55`: "`dsh.client.external` adds only exact non-baseline requests, each answered by the dynamic package row it names or an exact static-table key.").
- `immediately` — boot/activation eagerness; used by `@deepseek-ai/dsh-api-remotes` (`core/dsh-api-remotes/package.json`, `"immediately": true`).
- **`dsh.client.entry` is NOT parsed in 0.2.2-rc.1.** `dsh-github-flow/package.json` still includes `"entry": "./lib/client.js"`, but the parser above ignores it; the bundle is located from `exports["./client"]` ([CONFIRMED] `core/dsh-client-modules/lib/index.js:199-209` `clientExportOf()` resolves `exports["./client"]`; used at `:791`).

The asset subpath rule: `"./assets/*": "./lib/assets/*"` is served under `/plugins` with a content revision ([CONFIRMED] `core/dsh-client-modules/README.md:39`).

### 2.2 What the bundle must look like (hand-written bundle is OK)

[CONFIRMED] All shipped/3rd-party client bundles are plain lazy-CJS factory scripts:

```js
// core/dsh-client-ui-message-feedback/lib/client.js:1-6
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-message-feedback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
```

and the factory's exports are a Cordis plugin object:

```js
// core/dsh-client-ui-message-feedback/lib/client.js:1024-1026
exports.apply = apply;
exports.inject = inject;
return module.exports;
```

```js
// C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-github-flow\lib\client.js:9646, 9716-9719
function apply(ctx) { ... }
exports.apply = apply;
exports.inject = inject;
exports.name = "dsh-github-flow";
return module.exports;
```

Contract details:
- `id` in `load({id, factory})` is the package name; the loader rejects duplicate registration of the same id ([CONFIRMED] `core/dsh-client-modules/lib/client.js:707-714`).
- Executing a bundle only **registers** the factory; module body side effects run at materialization ([CONFIRMED] `core/dsh-client-modules/README.md:43,73`; `core/dsh-client-modules/lib/client.js:16-21`).
- `require()` resolves in this order: frozen platform seed table -> memoized records -> boot-graph rows -> registered factories; anything else throws ([CONFIRMED] `core/dsh-client-modules/README.md:77`).
- **Frozen platform table** ([CONFIRMED] shell bundle `core/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:194`):

```js
function YZ(){return{react:fk,"react/jsx-runtime":gk,"react-dom":xk,"react-dom/client":Ck,"@deepseek-ai/cordis":Rb,zod:JS,"@tanstack/react-virtual":rI,"@deepseek-ai/dsh-client-store":SI,"@deepseek-ai/dsh-client-ui-slots":MI,"@deepseek-ai/dsh-client-ui-primitives":FU,"@deepseek-ai/dsh-client-ui-dockkit":WZ}}
```

So a **hand-written `lib/client.js` is sufficient**: require only `react` / `react/jsx-runtime` (both baseline) and use `React.createElement` (or precompile JSX yourself). No tsdown build is required. Note that `@deepseek-ai/dsh-client-ui-slots` and `@deepseek-ai/dsh-client-ui-primitives` are **not installed as packages in the app asar** — they exist only in this static table (their types are build-time only; `message-feedback` lists them under `devDependencies`, not runtime `dependencies`). A plugin may `require()` them in the browser bundle but cannot `import` them at host runtime.

### 2.3 Discovery, serving, HMR

[CONFIRMED] `core/dsh-client-modules/README.md:34`: "A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`. The host half turns each declaration into a served bundle under `/plugins`, ordered so dynamic providers load before their consumers."

- The host scans **active Cordis Loader entries** and reconciles by **entry name**, reading each package's manifest and `exports["./client"]` ([CONFIRMED] `core/dsh-client-modules/README.md:81`: "The Node half reconciles packages by Loader entry name... Each reconciliation reads the package manifest and the bundle metadata again").
- The browser gets `window.__DSH_BOOT__` entry rows and `window.__ModuleLoader__`; application combo scripts carry only `client.js` entries and register factories during boot ([CONFIRMED] `core/dsh-client-modules/README.md:43,73`; shell boot call `__ModuleLoader__.create({ boot: __DSH_BOOT__, staticModules: YZ(), ... })` at `core/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`).
- HMR: `/plugins/events` SSE carries `graph`/`rebuilt` frames; a rebuilt bundle is swapped into the running page one at a time; `pollIntervalMs` defaults to 500; `pnpm run dev:web` drives rebuilds ([CONFIRMED] `core/dsh-client-hmr/README.md:12,32,42,62,66`).
- Build requirement: a missing `lib/client.js` fails activation loudly ([CONFIRMED] `core/dsh-client-modules/README.md:59`).

### 2.4 Profile installation (what makes the host discover a local plugin)

[CONFIRMED] Profile layout `C:\Users\<user>\.dsh\profiles\desktop\`:
- `package.json` lists the plugin as a dependency and in `dsh.profile.bundles`:
  ```json
  "dependencies": { "dsh-github-flow": "0.7.1", ... },
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket", ..., "dsh-github-flow" ] } }
  ```
- The plugin package supplies `dsh.bundle.patch`; its `cordis.patch.yml` inserts the Loader entry:
  ```yaml
  # C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-github-flow\cordis.patch.yml
  - insert:
      - id: github-flow
        name: dsh-github-flow
  ```
- The profile-level `cordis.patch.yml` ("Your patch layer... applied after every bundle layer") can also hold the `insert:` block ([CONFIRMED] `C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml:1-2`).
- A **host entry is required even for a client-only UI plugin**, because discovery is keyed on the Loader entry name: a plugin whose entry is absent is reconciled out of the graph ([CONFIRMED] `core/dsh-client-modules/README.md:81`: "A pending name absent from the index is reconciled with an empty entry list to remove unloaded sources"). The host entry can be a no-op `apply()`; it also gives the plugin its host half for routes/storage (see §4).
- `cordis.yml` in the profile is an empty entry list; everything is composed from `dsh.profile.bundles` patches + `cordis.patch.yml` ([CONFIRMED] file contents, 3 lines).

---

## 3. Message-level extension APIs (exact names, props, registration)

### 3.1 The message slot tree (Chat target)

Chat declares the node seats and their child slots in `registerChatNodeRenderers()` ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:9228-9347`):

| Slot | kind / scope | Declared/rendered at | Owner props passed | Notes |
|---|---|---|---|---|
| `conversation.chat.node` | keyed / session | declared as child of `conversation.chat.flow` `:15437-15457`; registrations `:9238-9346` | node view receives whole `node` | key = `user`, `steering`, `assistant-step`, `turn-tail`, `command`, `compaction`, ... |
| `conversation.chat.user.before` | **chain** / session | declared in the `user` node registration `:9242-9245`; rendered `:6184-6187` | `{ source, kind }` (+ `matched` for chain) | **no messageId / turn / seq** |
| `conversation.chat.assistant-actions` | **list** / session | declared as child of `turn-tail` `:9336-9339`; rendered `:9040-9041` | `{ messageId }` | closest existing precedent = Like/Dislike |
| `conversation.chat.turnTail` | list / session | declared `:9331-9335`; rendered `:9030-9034` | `{ turn, seq, openFile }` | arbitrary content appended to the turn tail |
| `conversation.chat.user.content` | Factory / session | registered `:15383-15391` | its own input | user content stack (text/images/files) |
| `conversation.chat.reasoning.body`, `conversation.chat.message.images`, `conversation.chat.commandview`, `conversation.chat.text-interaction` | single/keyed | `:9234-9296`, `:15471-15474` | — | narrower surfaces |
| `conversation.view` | list (session) | registered by Chat `:15458-15475`; declared by ui-conversation | `{ ... }` | view tabs |
| `conversation.chat.flow` | single / session | `:15437-15457` | — | full transcript renderer seat |

Verbatim declarations:

```js
// core/dsh-client-ui-chat/lib/client.js:9242-9245 (user node child)
children: { "conversation.chat.user.before": {
    kind: "chain",
    scope: "session"
} }

// core/dsh-client-ui-chat/lib/client.js:9331-9340 (turn-tail children)
children: {
    "conversation.chat.turnTail": {
        kind: "list",
        scope: "session"
    },
    "conversation.chat.assistant-actions": {
        kind: "list",
        scope: "session"
    }
}
```

### 3.2 Exact props a `conversation.chat.assistant-actions` entry receives

Owner props: **`messageId: string`** (the finalized closing assistant message id). Standard session props plus the registration's `inject` result. There is **no `turn`, `seq`, or `time` prop** ([CONFIRMED] call site `:9040-9041`; only `{ messageId }` is passed as owner props). The turn can be derived host-side from the message id (recommended) or client-side by scanning the session event stream via `useSession` (possible but undocumented; inferred).

Standard props come from the renderer's kit ([CONFIRMED] `core/dsh-client-ui-renderer/lib/client.js`):
- `materializeStandardBinding`: spreads `binding.props` and turns every declared `hooks` source into a `use<Name>` selector hook (`:667-677`).
- `standardKit`: always adds `renderFactorySlot`; adds `t` when the entry declares `locale`; adds `useStore`/`actions` when the entry declares `store`; adds `renderSlot`/`renderSlotChain` when the entry declares children; adds `SessionProvider` when a child is session-scoped (`:736-761`).
- The session scope's built-in source is ([CONFIRMED] `core/dsh-client-ui-session/lib/client.js:755-764`):

```js
const BUILTIN_SOURCE = {
    hooks: ["session"],
    keyedHooks: ["projection"],
    props: ["sessionId"],
    resolve: (binding) => ({
        hooks: { session: binding.session },
        keyedHooks: { projection: (key) => binding.session.projections.faceOf(key) },
        props: { sessionId: binding.sessionId }
    })
};
```

and the root source adds `sessions`, `sessionStatus`, keyed `sessionRetainInfo`, keyed `sessionAccess` ([CONFIRMED] `core/dsh-client-ui-session/lib/client.js:1120-1134`).

So a session-scoped entry component receives, at minimum:
`messageId` (owner), `sessionId`, `useSession(selector, equal?)`, `useProjection(key, selector?, equal?)`, `useAccess(action)`, `renderFactorySlot`, and `t` if `locale` declared; plus whatever `inject: (sessionId) => ({...})` returned (custom props/hooks). Hooks are selector hooks: `useSession(s => ...)` over the session observable ([CONFIRMED] `core/dsh-client-ui-renderer/lib/client.js:219-224`, `667-677`; example selector use `core/dsh-client-ui-message-feedback/lib/client.js:173` `useFeedback((view) => view.items.get(messageId))`).

### 3.3 Exact props a `conversation.chat.user.before` chain entry receives

Owner props: **`{ source, kind }`**, plus `matched` (the non-null return of the entry's `select`). No messageId/turn/seq ([CONFIRMED] render call `:6184-6187`; documented at `core/dsh-client-ui-chat/README.md:48`: "Owner props carry the durable message `source` and row `kind`; each entry's `select` matches its own sources, and the first non-null result reaches the elected component as `matched`."). Standard session props are also supplied (same renderer kit).

Chain registration requires `select` ([CONFIRMED] shell register impl, below); the chain renders the first non-null selector result. Example of chain/keyed use from the shipped message-quotes plugin: `core/dsh-message-quotes/lib/client.js:169-190` registers a `conversation.chat.text-interaction` entry and a UserText rule.

### 3.4 Registration API: exact shapes and validation rules

All slots are declared by a parent registration's `children` table; a plugin may only register into a declared slot, otherwise it throws. The registry's `register` validation was recovered verbatim from the shell bundle (`core/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:123`, minified single line; excerpt edited only for whitespace):

```js
register(e, t) {
  const r = this.records.get(e.name);
  if (!r?.spec) throw new Error(`slot "${e.name}" is not declared (a parent entry's children table must declare it)`);
  const i = r.spec, n = e.priority ?? 0;
  switch (i.kind) {
    case "single": { /* unique at priority; lowest priority renders */ }
    case "keyed":  { if (e.key === void 0) throw new Error(`keyed slot "${e.name}" requires options.key`);
                     /* unique key+priority; entries sorted by priority asc; first per key renders */ }
    case "list":   { if (e.id === void 0) throw new Error(`list slot "${e.name}" requires options.id`);
                     /* unique id+priority; sorted by (priority asc, order asc) */ }
    case "chain":  { if (e.select === void 0) throw new Error(`chain slot "${e.name}" requires options.select`); }
  }
  // children are declared here too, and must not already be declared
  // options captured: key, id, order, label, priority, select, inject, children, store, locale, registrant
}
...
entriesOfSlot(e) { /* keyed: first entry per key in priority order; list: first per id; returns [] when undeclared */ }
```

Registration form ([CONFIRMED] `core/dsh-client-ui-message-feedback/lib/client.js:963-984`):

```js
ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
    name: "conversation.chat.assistant-actions",
    id: "feedback",
    order: 10,
    locale: NS,
    inject: (sessionId) => {
        const { feedback, dialog } = surfaceFor(sessionId);
        return {
            hooks: { feedback },
            ensure: () => feedback.ensure(),
            current: (messageId) => feedback.getSnapshot().items.get(messageId),
            retract: (messageId, rating) => feedback.retract(messageId, rating),
            openDialog: (messageId, rating) => { dialog.open({ kind: "message", messageId, rating }); }
        };
    }
}, MessageFeedbackActions));
```

- `ctx.slots.inject(slotName, cb)` defers registration until the slot's parent declaration exists (used by every shipped plugin; e.g. `core/dsh-client-ui-message-feedback/lib/client.js:963,985,1010`; `dsh-github-flow/lib/client.js:9688-9713`). The callback must return the `ctx.slots.register(...)` disposer.
- Component props are merged as: standard kit -> entry `inject` result -> slot-injected factory props -> contextual hooks -> **owner props last (owner wins)** ([CONFIRMED] `core/dsh-client-ui-renderer/lib/client.js:773-790`).
- `priority` selects shadowing: lower number wins; this is how one plugin replaces another's list/keyed/single entry ([CONFIRMED] `core/dsh-client-ui-chat/README.md:79` "a lower priority picks the replacement"; `:130` "Its official entry registers at priority 100 ... A replacement uses a lower priority number").
- `ctx.slots.registerFactory(...)` declares a reusable Component Factory (`{name, scope, locale, children, store, inject, slots}`; [CONFIRMED] shell bundle registerFactory body; usage `core/dsh-client-ui-chat/lib/client.js:9229-9233,15383-15391`).

### 3.5 Other message-adjacent APIs

- `conversation.chat.turnTail` (list, session) receives `{ turn, seq, openFile }` — a legitimate place for per-turn content BELOW the turn ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:9030-9034`).
- Context menu: `ctx.contextMenus.register({ id, target, order, resolve })`; targets come from `ContextMenuTargetMap` (Session, Workspace, file, directory, URL, image, pane families) and new target families require declaration merging **plus a dispatch site**; there is no message target family and no message-row context-menu dispatch in Chat ([CONFIRMED] `core/dsh-client-ui-context-menu/README.md:30-45`; grep of ui-chat shows only Session-header/file gestures). **Not a viable per-message seat without replacing a renderer.**
- Sidebar/right panel: `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })` + body `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`; extension seats `sidebar.right.tab.guide` (chain) and `sidebar.right.tab.menu.item` (list) ([CONFIRMED] `core/dsh-client-ui-sidebar-right/README.md:83-90`).
- Layout/main panel: root-scoped `main` keyed slot; `conversation` is reserved; `ctx.layout.selectPanel(id)` selects a global panel; `null` returns to Conversation ([CONFIRMED] `core/dsh-client-ui-layout/README.md:36,63-65`).
- Conversation view: `conversation.view` list; Chat registers `id: "chat", order: 0` ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:15458-15475`). View pin/More machinery exists (`conversation.session.header.views.actions`) but is about views, not messages.
- Composer seats: `conversation.composer.bar`, `conversation.composer.dock`, `conversation.input.dock`, `conversation.input.overlay`, `conversation.input.activity` ([CONFIRMED] `core/dsh-client-ui-chat/lib/client.js:22028,22219,22356`; `core/dsh-client-ui-conversation/README.md:101,185`).

---

## 4. Client <-> server channel, and how to persist/read pin state

### 4.1 What exists today (no new Remote namespace can be added by a plugin)

- **Typed Remotes are build-time fixed.** `@deepseek-ai/dsh-api-remotes` is the BFF that mounts generated Typert contributions; adding a namespace requires an explicit `/remote` value import and a rebuild of the assembly, not runtime plugin code ([CONFIRMED] `core/dsh-api-remotes/README.md:14,77-79`):
  > "The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime. Additional capabilities require an explicit `/remote` value import and mount in this assembly."
  The client mount loop is visible at `core/dsh-api-remotes/lib/client.js` (tail: `for (const contribution of [TYPERT_REMOTE...]) disposers.push(await ctx.remote.$mount(contribution))`; file has 28329 lines).
- **`remote.commands.execute` is available and is a real generic client->server action channel.** The namespace is mounted by api-remotes (`package: "@deepseek-ai/dsh-commands"`, endpoints `commands/execute`, `commands/list` — [CONFIRMED] `core/dsh-api-remotes/lib/client.js:1256-1426`). The client caller is a shipped plugin itself:
  ```js
  // core/dsh-client-ui-commands/lib/client.js:1341, 1367, 1669-1680
  "remote.commands"                          // exports.inject entry
  const result = await ctx.remote.commands.list(sessionId);
  async execute(session, line, attachments = []) {
      const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments);
      if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`);
      if (result.value === void 0) return { kind: "error", text: `unknown or malformed command: ${line}` };
      ...
  }
  ```
  Signatures (generated descriptor): `commands.execute(agentId: SessionId, line: string, submittedAttachments: Array<{type:'image',mediaType,data,name?}|{type:'file',receiptId}>) -> RemoteResult<undefined | { commandId: string, result: {kind:'success', text?, sourceEventSeq?} | {kind:'error', text} }>`; `commands.list(agentId) -> RemoteResult<Array<CommandDescriptor>>` ([CONFIRMED] `core/dsh-api-remotes/lib/client.js:1211-1221,1258-1426,1427-1459`).
  Cordis service path: a third-party client plugin declares `"remote.commands"` (and `"remote"`) in its **exports-level** `inject` array; this is exactly what `ui-commands` does ([CONFIRMED] `core/dsh-client-ui-commands/lib/client.js:1337-1342,2265-2271`; message-feedback declares `"remote.messageFeedback"`, `"remote.sessionFeedback"` similarly at `core/dsh-client-ui-message-feedback/lib/client.js:919-925`).
  The host side registers commands with `ctx.commands.register({ name, description, input?, handler })` ([CONFIRMED] `core/dsh-commands/README.md:38-56`).
  **Caveat:** every admitted command append-logs lifecycle events `command/run` + `command/done` and renders a persistent `command` row in the transcript outside model history ([CONFIRMED] descriptor description `core/dsh-api-remotes/lib/client.js:1260`; `core/dsh-client-ui-commands/lib/client.js:1657-1675`; row renderer registration `core/dsh-client-ui-chat/lib/client.js:9289-9296`). So using commands for every pin toggle would litter the transcript; suitable for `/pin`-style explicit commands, not for a checkbox.
- **`ctx.connection.rpc.call(channel, endpoint, payload, signal)`** is a generic unary RPC caller on the browser side ([CONFIRMED] `core/dsh-client-connection/lib/client.browser.js:1209-1238`): it POSTs `POST /<channel>/<endpoint>` with a `{type:"client-request", rpcId, method, payload}` envelope and validates the `{type:"server-response", rpcId, result}` envelope. Registered on the context as `ctx.connection.rpc` ([CONFIRMED] `.../client.browser.js:1382-1387,1497`).
- **`dsh.client.external` is not a general RPC channel** and cannot add server methods.

### 4.2 Supported non-codegen write/read channels (answers C/E of the Lead brief)

**(E.1) Exact Fetch routes on Connection — recommended, authenticated.**
The Host `ctx.connection` service exposes a Context-scoped exact fetch-route registry ([CONFIRMED] `core/dsh-client-connection/lib/index.js`):

```js
/** Generic channel registry scoped to the Context reading this service. */
get rpc() { const owner = this.ctx; return {
    handle: (channel, handler) => this.register(owner, channel, handler),
    intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler)
}; }
/** Exact Fetch-route registry scoped to the Context reading this service. */
get fetch() { const owner = this.ctx; return { register: (route) => this.registerFetchRoute(owner, route) }; }   // :723-735
```

```js
registerFetchRoute(owner, route) {                     // :840-851
    assertFetchRoute(route);
    const registered = { methods: new Set(route.methods), requestBody: route.requestBody, fetch: route.fetch };
    return owner.effect(() => {
        if (this.fetchRoutes.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
        this.fetchRoutes.set(route.path, registered);
        ...
```

```js
function assertFetchRoute(route) {                     // :973-976
    if (endpointFromPath("/api", route.path) === void 0) throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`);
    if (route.methods.length === 0) throw new Error(...);
    if (new Set(route.methods).size !== route.methods.length) throw new Error(...);
}
```

The `/api` HTTP route is a **prefix** route with browser authentication and the shared handler; exact fetch routes are matched **before** Gateway dispatch, and a non-owner Peer gets 403 ([CONFIRMED] `core/dsh-client-connection/lib/index.js:820-838,1044-1058`). So a host plugin can do:

```js
ctx.inject(["connection", "webServer"], (c) => {
  c.effect(() => c.connection.fetch.register({
    path: "/api/dsh-pin/state",            // must be under /api/<endpoint>
    methods: ["GET", "POST"],
    requestBody: "buffered",               // "buffered" | "streaming"
    fetch: async (request) => new Response(JSON.stringify(...), { headers: { "content-type": "application/json" } })
  }), "pin: routes");
});
```
and the browser plugin can simply `fetch("/api/dsh-pin/state")` (same-origin cookie auth, exact route is served directly, no envelope needed) — the page GUI origin is `http://127.0.0.1:10382`, so relative fetch works in the Web/desktop shell. Mark: the route **API surface is confirmed in code**; it is described only as "exact GET/HEAD/POST route registries" in the package README (`core/dsh-client-connection/README.md:34`), so treat it as a semi-public internal seam.

**(E.2) Plain webserver route — the 3rd-party precedent (unauthenticated).**
`ctx.webServer.register({ kind: 'exact'|'prefix', path, handler | resource })` ([CONFIRMED] `core/dsh-host-webserver/README.md:61`; host service `ctx.webServer`).
- `dsh-github-flow` registers exact routes under `/api/github/...` and the client calls them with plain `fetch`:
  ```js
  // dsh-github-flow/lib/api/routes-actions.js:141-142
  kind: 'exact',
  path: '/api/github/refresh',
  // dsh-github-flow/lib/client.js:3381
  var res = await fetch("/api/github/branch-switch", { ... });
  ```
  Registered via `registerOneRoute` -> `webServer.register(route)` inside `ctx.effect` (`dsh-github-flow/lib/api/routes.js`, `bindRoute`).
- Because exact-table matching precedes the `/api` prefix, these routes bypass Connection's auth; the webserver package explicitly warns it has "No server-wide authentication or origin policy" (`core/dsh-host-webserver/README.md:132`). Safe only on the loopback listener; prefer E.1 for new plugins.

**(E.3) `ctx.connection.rpc.handle(channel, handler)` / `intercept`.**
Generic non-`/api` channels: `assertChannel` rejects channel `"/api"` (`core/dsh-client-connection/lib/index.js:970-971`), and the handler is mounted at `/<channel>/<endpoint>`. A web carrier must still expose the channel (e.g. a webserver route delegating to `createSharedFetchHandler(channel)`); the browser side uses `ctx.connection.rpc.call(channel, endpoint, payload, signal)`. No shipped third-party plugin uses this; **[INFERRED]** viable for unary plugin RPC but more plumbing than E.1.

**(E.4) Client-only persistence: `localStorage`.** Real precedent: `dsh-github-flow` persists panel/cache state there (`dsh-github-flow/lib/client.js:3029,3052,3061`). Cheap for "pinned templates" if cross-reload, same-origin (same host:port, i.e. same desktop app port) is acceptable; not shared across browsers/hosts/tabs and lost if the origin changes. The message-feedback controller in contrast never persists client-side; it uses a Host Remote.

**(E.5) Host-side durable storage: `ctx.storageDomain`.** A host plugin declares its own domain and gets validated KV persistence without session events ([CONFIRMED] `core/dsh-storage-domain/README.md:34-58`):

```text
const workspaceSpec = defineDomain({ name: 'workspace', version: 1, tables: { workspaces: domainTable(workspaceRecordSchema) } })
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id)   // synchronous
```
Caveats: the storage family must be mounted (`storage`, a backend, `storage-domain`); domain names are process-global (`already-open` error); `domain/changed` is in-process only (`core/dsh-storage-domain/README.md:73,146`). A plugin can also just write its own JSON file under its package/profile data dir with `node:fs` (no documented plugin API prevents it; `dsh-whale-widget`/`github-flow` do their own caching/persistence).

**(E.6) Session log plugin records are NOT a supported third-party write path.** `appendPluginRecord` is restricted to repository-internal `packages/experimental/` callers and the docs tell external plugins not to call it ([CONFIRMED] `core/dsh-session/README.md:72`). Arbitrary `session.append('<custom/type>')` is typed via declaration merging but the durable event vocabulary/persistence catalog is generated host-side; not recommended for a pin flag.

### 4.3 How to persist/read **pin state** for the recommended design

[INFERRED, built only from the confirmed channels above]

1. Host half (plugin entry):
   - Register routes with `ctx.connection.fetch.register({ path: "/api/dsh-pin/...", methods: ["GET","POST"], requestBody: "buffered", fetch })` (authenticated) or `ctx.webServer.register` (github-flow-style, loopback-only).
   - Back the routes with `ctx.storageDomain.open(defineDomain({ name: "dsh-pin", version: 1, tables: { pins: domainTable(pinRecordSchema) } }))`, or a JSON file in the plugin/profile dir.
   - Pin record: `{ id, sessionId, messageId, turn?, label, textSnapshot, createdAt, addedBy }`. The host can read the durable turn content from `ctx.sessions.get(sessionId)` / `session.eventAt(seq)` / `snapshotEvents()` ([CONFIRMED] `core/dsh-session/README.md:44,64`) to snapshot the template text, instead of trusting the browser.
   - Optionally also register host commands `/pin` / `/pins` via `ctx.commands.register` for keyboard/menu access.
2. Client half (plugin bundle):
   - `ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "dsh-pin", order: 20, locale }, PinToggle))` — `order` places it beside Like/Dislike (feedback uses order 10) inside the same action row.
   - `PinToggle` receives `messageId` + `sessionId`; reads state with `fetch("/api/dsh-pin/state?sessionId=...&messageId=...")` (or one list fetch per session, then a `Set`), toggles with `POST`, and uses local React state for optimistic UI. No `remote` namespace needed, so no api-remotes rebuild.
   - Optionally a second registration on `sidebar.right.pane.tab` or `main` to browse/apply pinned templates (see §5).

No existing message-level pin state exists to read: the only per-message persistent state in core is `messageFeedback` (positive/negative rating + note, Session-log events), exposed through `ctx.remote.messageFeedback.list/put/retract` and documented as log-only; it has no plugin-extensible fields ([CONFIRMED] `core/dsh-client-ui-message-feedback/README.md:12,28,46,68`; `core/dsh-client-ui-message-feedback/lib/client.js:687-692,973-975`). A pin flag must therefore be plugin-owned state.

---

## 5. Closest feasible UI alternatives (if per-message is not acceptable)

Ranked for a "pin turn as template" feature:

1. **Per-turn checkbox in the closing assistant message's action row** via `conversation.chat.assistant-actions` — supported extension, zero replacement, one control per turn, carries `messageId`. (Recommended; this *is* the per-message answer for turns.)
2. **Per-user-message checkbox by shadowing `conversation.chat.node` key `"user"`** at `priority: -1` — full row control plus `node.data.messageId`; must re-own bubble/clock/copy/echo behaviour; replacement not extension. Same for `"assistant-step"` (much heavier; avoid).
3. **Added turn content below the turn** via `conversation.chat.turnTail` (list; props `{ turn, seq, openFile }`) — e.g. a "Pin this turn" inline chip; no `messageId` but has `turn`/`seq`, which is arguably a better key for a *turn template* than a message id.
4. **Right-sidebar panel tab** listing pinned templates, with an "Add current turn" action: `ctx.sidebarRightTabs.register({ id, kind, title, ... })` + `sidebar.right.pane.tab` body ([CONFIRMED] `core/dsh-client-ui-sidebar-right/README.md:83-90`; working example `dsh-github-flow/lib/client.js:9667-9713`). Per-session docking surface, or a global panel.
5. **Global main panel** (e.g. "Pin library" page replacing the Conversation view): root-scoped `main` keyed slot + `ctx.layout.selectPanel("dsh-pin")` ([CONFIRMED] `core/dsh-client-ui-layout/README.md:36,63`).
6. **Composer dock / toolbar button**: `conversation.composer.dock` (list) or `conversation.input.dock`; e.g. a "pin last turn" button next to the model selector. No message identity, but convenient.
7. **Host slash command** `/pin` / `/pins` with an optional command-menu action decoration (`ctx.commandUi.decorate({ name, ui: { kind: 'action', run } })`, [CONFIRMED] `core/dsh-client-ui-message-feedback/lib/client.js:1010-1021`) — zero per-message UI, keyboard-driven; every run still logs a visible command row.
8. **Context menu** — NOT viable for messages today: no `message` target family and no message-row menu dispatch; adding one requires declaration merging **and** a Chat-side dispatch site (core change) ([CONFIRMED] `core/dsh-client-ui-context-menu/README.md:40` + ui-chat grep).

---

## 6. Minimal file layout for the recommended approach, and risks

Recommended: **host + client plugin package**, per-turn checkbox via `conversation.chat.assistant-actions`, host-owned pin store exposed through authenticated Connection exact routes.

```
dsh-pin-turns/
├─ package.json            # see below
├─ cordis.patch.yml        # - insert: [{ id: dsh-pin-turns, name: dsh-pin-turns }]
├─ lib/
│  ├─ index.js             # HOST Cordis plugin: export const inject = ["connection","webServer","storageDomain","sessions"]
│  │                       #   export function apply(ctx) { register /api/dsh-pin routes; define+open domain; optional command }
│  └─ client.js            # BROWSER bundle (hand-written is fine):
│                          #   window.__ModuleLoader__.load({ id: "dsh-pin-turns", factory: (require) => { ... } })
│                          #   exports.inject = ["slots","sessions","locale"]        (client-plugin load order but these are services)
│                          #   exports.apply  = (ctx) => { ctx.slots.inject("conversation.chat.assistant-actions", ...) }
├─ locale/en.json          # only if the entry declares locale:"dsh-pin"
└─ icon.svg                # optional dsh.icon
```

`package.json` skeleton:

```json
{
  "name": "dsh-pin-turns",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale"] }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.1.0" }
}
```

Client registration (sketch, aligned with the confirmed API shapes):

```js
exports.inject = ["slots", "locale"];              // client-plugin deps/services
function apply(ctx) {
  ctx.effect(() => ctx.locale.register("dsh-pin", { en }), "pin: locale");
  ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
    name: "conversation.chat.assistant-actions",
    id: "dsh-pin",
    order: 20,                                     // feedback uses 10
    locale: "dsh-pin"
  }, function PinToggle({ messageId, sessionId, t }) {
    // useState/useEffect + fetch("/api/dsh-pin/state?...") / fetch("/api/dsh-pin/toggle", { method:"POST", ... })
    // render <button role="checkbox" aria-checked=...> inside the IconActions row
  }));
}
exports.apply = apply;
```

Install: copy into `C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-pin-turns` (or `dsh plugin --profile desktop add link:<path>` per whale-widget/README), add to profile `package.json` `dependencies` + `dsh.profile.bundles`, add the entry via the plugin's own `cordis.patch.yml`. Restart/patch reload; HMR picks up client rebuilds while `dev:web` watchers run.

Risks / constraints:

- **No `messageId` for user messages** in the supported chain slot; the only per-user-message id path is renderer replacement (fragile, version-coupled).
- **One control per turn**, attached to the closing finalized assistant message; interrupted partials have no action strip (`core/dsh-client-ui-message-feedback/README.md:32`).
- **Slot declarations are owned by core plugins**; if a future release renames/removes `conversation.chat.assistant-actions` or changes its owner props, the plugin breaks. The `order`/`id`/priority rules are internal-but-observable.
- **`ctx.connection.fetch.register` is an internal seam**: confirmed in code, not documented as a plugin contract; a host-plugin-only fallback is `ctx.webServer.register` (github-flow precedent) but that is unauthenticated and only saved by the loopback bind (`core/dsh-host-webserver/README.md:132`).
- **No custom typed Remotes**: do not design around `ctx.remote.<yourNamespace>` — api-remotes must be rebuilt ([CONFIRMED] `core/dsh-api-remotes/README.md:77-78`).
- **`/api` route auth**: E.1 gets browser-cookie auth for free; E.2 does not (any loopback process can hit it).
- **Electron/desktop origin**: desktop GUI is served over `http://127.0.0.1:<port>` (this session: `http://127.0.0.1:10382`), so relative `fetch` works; the port can vary, so don't hard-code it. `localStorage` is origin-scoped (host:port) if you choose that route.
- **Module identity**: bundle must `require("react")` from the frozen table, not bundle its own React, or hooks/context break (`core/dsh-client-ui-renderer/README.md:74` "React, React DOM, Cordis, ui-slots, and ui-primitives retain one browser identity through the web shell's static module table").
- **HMR reload loses plugin React state** (expected); pin state must live host-side/localStorage, not component state.
- **Command-based toggles pollute history**: every admitted command logs `command/run`/`command/done` and shows a row, so keep commands for explicit `/pin` UX, not for the checkbox's backend.
- **`dsh.client.entry` is ignored** by 0.2.2-rc.1's manifest parser; rely on `exports["./client"]` (some shipped/3rd-party manifests still carry `entry`, harmless but misleading).
- **Host entry required**: a client-only package with no active Loader entry is removed from the browser graph (`core/dsh-client-modules/README.md:81`).

---

## 7. Open questions

1. **Is `ctx.connection.fetch.register` intended as a third-party extension point?** It is a public getter on the served service and validates `/api/...` paths, but the README mentions only "exact GET/HEAD/POST route registries". No shipped community plugin uses it; github-flow and whale-widget use `ctx.webServer` instead. Needs upstream confirmation before relying on it.
2. **Exact owner-prop type for `conversation.chat.user.before`** (`source` shape) is not shipped as `.d.ts`; the README says only "durable message `source` and row `kind`". If `source` ever carries a stable message id, a non-replacing user-message checkbox becomes possible. **[UNVERIFIED]** whether it contains any stable id; runtime code passes `event.data.source`, which for an ordinary user prompt is `{ kind: 'user' }` (README example), so no id was observed.
3. **Whether the message id supplied to `assistant-actions` is stable across forks/compaction** (it is the closing final node's `messageId`; feedback keys its store on it, so presumably stable within a session). A "template" library that survives fork/replay needs a host-side validation rule.
4. **Cross-client sync of pin state** — domain `changed` events are in-process only; no forwarded event exists for a plugin namespace (`API_REMOTE_FORWARDED_EVENTS` is a fixed allowlist, [CONFIRMED] `core/dsh-api-remotes/README.md:43`). Multi-tab live update would need polling or a second-tab storage event/localStorage.
5. **Can a third-party host plugin safely depend on `@deepseek-ai/dsh-storage-domain`?** It must match the host release exactly; the profile hoists only a small subset of `@deepseek-ai/*` packages (`cordis`, `dsh-llm`, `dsh-timeout`, `dsh-typert-protocol`, `dsh-util-*`, ...), so a plugin bundling its own copy risks duplicate domain-facility state. A file-based store may be safer; **[UNVERIFIED]** which route the plugin manager supports.
6. **Message id availability for assistant steps in Trajectory/other views**: the feedback controller documents "trajectory and waterfall views render no feedback controls even though their assistant nodes carry the same `messageId`" (`core/dsh-client-ui-message-feedback/README.md:83`). A pin plugin using the same slot would likewise be Chat-only; whether that is acceptable is a product decision.
7. **Whether the desktop build's index path/deprecation of `webserver/index-inject` script rows** matches whale-widget's workaround long-term (see its comments at `dsh-whale-widget/lib/index.js:706-742,4893-4924`); irrelevant for the slot-based approach, relevant only if a plugin falls back to DOM/script injection.

---

## Appendix — Lead's A-E brief, mapped to evidence

- **A.** `assistant-actions`: owner props `{ messageId }` only — `core/dsh-client-ui-chat/lib/client.js:9040-9041`; standard session props from `core/dsh-client-ui-renderer/lib/client.js:667-677,736-761` + `core/dsh-client-ui-session/lib/client.js:755-764`. `user.before`: owner props `{ source, kind }` + `matched`, **no ids** — `core/dsh-client-ui-chat/lib/client.js:6184-6187` and README `:48`. Neither passes `turn`/`seq`; derive host-side from `messageId` (recommended) or scan session events.
- **B.** `ctx.remote.commands.execute(sessionId, line, attachments)` -> `RemoteResult<undefined | { commandId, result: {kind:'success'|'error', text?} }>` — caller `core/dsh-client-ui-commands/lib/client.js:1668-1680`, descriptor `core/dsh-api-remotes/lib/client.js:1258-1421`. Third-party client plugins can inject `"remote.commands"` (exact precedent: ui-commands' inject arrays at `:1337-1342,2265-2271`). Executing logs `command/run`/`command/done` and renders a transcript command row, outside model history — confirmed by the descriptor description `:1260` and `core/dsh-client-ui-chat/lib/client.js:9289-9296`.
- **C.** Hand-written bundle is valid: `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`; stripClientSuffix/id contract `core/dsh-client-modules/lib/client.js:85-126`; duplicate-id rejection `:707-714`; only `react`, `react/jsx-runtime` (and other frozen-table keys) need `require` — frozen table at `core/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:194`. Exports must be a Cordis plugin object (`apply`, `inject`, optional `name`) — evidence `core/dsh-client-ui-message-feedback/lib/client.js:1024-1026` and `dsh-github-flow/lib/client.js:9716-9719`.
- **D.** Discovery = active Loader entry name + manifest `dsh.client` + `exports["./client"]` (`core/dsh-client-modules/README.md:34,81`; resolver `core/dsh-client-modules/lib/index.js:199-209,791`). Fields: `platform`, `inject`, `external`, `immediately` only (parser `:86-100`). Local install = profile `dependencies` + `dsh.profile.bundles` + a bundle `cordis.patch.yml` `insert:` entry (desktop profile files, github-flow patch).
- **E.** Supported non-codegen write channels: Connection exact Fetch routes `ctx.connection.fetch.register` (`core/dsh-client-connection/lib/index.js:723-735,840-851,973-976,1044-1058`); plain webserver exact routes + client `fetch` (github-flow, `lib/api/routes-actions.js:141-142`, `lib/client.js:3381`); generic `ctx.connection.rpc.handle`/`call` (`core/dsh-client-connection/lib/client.browser.js:1209-1238,1382-1387`); `remote.commands.execute`; client `localStorage`; host `ctx.storageDomain`. Custom typed Remotes require rebuilding api-remotes and are **not** a plugin channel.
