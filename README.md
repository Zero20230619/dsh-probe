# dsh-probe

Research notes and tooling for **DSH (DeepSeek Harness) 0.2.2-rc.1**: how the host plugin API works, where a plugin can intercept model requests, and which UI slots are available to a web-side plugin.

The goal is to answer one practical question: *can a third-party plugin reshape what the model sees on each request without corrupting the session log?* The notes below document what is verified, what is inferred, and what does not exist.

## Findings

| File | Scope |
|---|---|
| [`findings-backend.md`](findings-backend.md) | `agent/pre-step` contract, request assembly (`deriveMessages`), storage seams, commands/tools registration |
| [`findings-examples.md`](findings-examples.md) | Four real community plugins read as in-the-wild examples |
| [`findings-ui.md`](findings-ui.md) | Client module loader, slot map, where a per-turn checkbox can live |

Status markers used throughout: **CONFIRMED** (read from shipped code), **INFERRED** (reasoned but not executed), **NOT FOUND** (searched for and absent).

## Tooling

`asar-tool.mjs` reads an Electron `app.asar` without unpacking it:

```powershell
node asar-tool.mjs <app.asar> list [path]        # list entries
node asar-tool.mjs <app.asar> find <regex>       # find entries by path
node asar-tool.mjs <app.asar> read <path>        # print one file
node asar-tool.mjs <app.asar> extract <path> <out>  # extract a subtree
```

`debug.mjs` dumps the asar header layout and the first bytes of `dsh/package.json`; useful when the archive format shifts between releases.

## Extracted material

`core/`, `desktop-lib/` and `notes-ui/` hold files extracted from the DSH desktop bundle `app.asar` (packages under `core/dsh/node_modules/@deepseek-ai/`, the desktop main/preload scripts, and plain-text dumps). They are kept here so every claim in the findings can be checked against its source.

**These extracted files are the property of their copyright holders.** They are included for interoperability research only and are not covered by any license grant from this repository. If you are a rights holder and want them removed, open an issue.

## Related

- [`dsh-context-template`](https://github.com/Zero20230619/dsh-context-template) — the plugin this research produced: pin selected turns as a durable context template.
