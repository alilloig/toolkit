# Plugin Audit Data Sources

Everything `scripts/plugin-audit.mjs` reads, the shapes it has to tolerate, and
the traps that produce wrong-but-plausible numbers. All sources are local; the
collector makes no network calls.

Paths below are relative to the Claude config directory, which is
`CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`. Never hardcode a home
directory — resolve it at runtime.

## The four sources

| Source | Answers | Shape notes |
|---|---|---|
| `plugins/marketplaces/*/.claude-plugin/marketplace.json` | What exists to install | One catalog per registered marketplace. Support **all** of them. |
| `plugins/installed_plugins.json` | What is on disk | `{version, plugins: {"name@marketplace": [ {scope, installPath, version, installedAt, lastUpdated, gitCommitSha?} ]}}` |
| `settings.json` → `enabledPlugins` | What is switched on | `{"name@marketplace": true \| false}`. Merged across user < project < local. |
| `.claude.json` → `pluginUsage` | How much each was invoked | `{"name@marketplace": {usageCount, lastUsedAt, lastUsedNumStartups}}`. Older versions stored a bare number. |

Supporting file: `plugins/known_marketplaces.json` gives each marketplace's
provenance (`{source: {source: "github", repo: "owner/name"}, lastUpdated,
autoUpdate}`) — this is how the dashboard answers "where did this come from".

### Installed ≠ enabled

These are different facts in different files. A plugin can be present on disk and
switched off. The audit therefore has **three** states, not two:

- **active** — an install record exists and `enabledPlugins` does not say `false`
- **disabled** — an install record exists and `enabledPlugins` says `false`
- **not installed** — no install record

A missing `enabledPlugins` key for an installed plugin is treated as active (it
was never switched off), and the dashboard says so explicitly rather than
guessing silently.

## Field shapes that vary

Observed across six marketplaces (326 entries) on one machine:

- **`source`** is either a **relative string** (`"./plugins/x"`,
  `"./external_plugins/x"`, or just `"./"` when the marketplace root *is* the
  plugin) **or an object** whose own `source` field is `url` | `github` |
  `git-subdir`, with the reference under `repo` / `url` / `path` / `ref` /
  `sha` / `commit`. A string source is on disk; an object source is a git pin
  and is not.
- **`author`** is an object with some subset of `{name, email, url}`, and may be
  absent. Fall back to the marketplace `owner`.
- **`skills`** is either an array of path strings (`["./local-ai-use"]`) or an
  array of objects (`[{name, path, invoke}]`).
- **`lspServers`** is an object keyed by server name.
- **`category`**, **`version`**, **`tags`**, **`keywords`**, **`homepage`**,
  **`displayName`**, **`license`**, **`repository`** are all optional.
- **`renames`** appears at the marketplace level: a map of retired plugin name to
  current name.

Plugin manifests (`.claude-plugin/plugin.json`) rarely declare components at
all — components are found by directory convention (`skills/`, `commands/`,
`agents/`, `hooks/`, `.mcp.json`). When a manifest *does* declare them, the value
is a string path or an array of paths. Some installed plugins ship **no**
`plugin.json` whatsoever.

## The traps

### 1. Short-name collisions across marketplaces

Ledger keys are `name@marketplace`. Keying any lookup on the bare `name` merges
distinct plugins. Real example from one machine:

```
hookify@claude-plugins-official   46,772 invocations
hookify@inline                        61 invocations
```

A bare-name map silently reports 61 for both, or 46,772 for both, depending on
iteration order. **Every map is keyed on the full pair.**

### 2. Mid-write JSON reads look exactly like corruption

Claude Code truncates and rewrites `settings.json`, `installed_plugins.json` and
`.claude.json` while it runs. A read that lands mid-write throws
`Unexpected end of JSON input` — indistinguishable from a genuinely broken file.

Retry a handful of times with a short delay before reporting a file as broken,
and when all retries fail, **warn and continue with that source missing** rather
than crashing the whole audit.

### 3. Component counts only resolve locally

A third-party marketplace entry is just a git pin. Its `skills/`, `commands/`
and `agents/` directories do not exist on disk until the plugin is installed.

Resolve the directory to walk in this order:

1. the installed plugin's `installPath`
2. a marketplace-local relative `source`, resolved against the marketplace dir
3. nothing — the count is **unknown**

Unknown must render as an em dash, never as `0`. The collector distinguishes:

- `components === null` → nothing to walk; unknown
- `components === {}` → walked it, genuinely ships nothing detectable

### 4. `.mcp.json` and `hooks/hooks.json` each have two shapes

Most plugins wrap their declarations:

```json
{ "mcpServers": { "telegram": { } } }
```

Some declare the server at the top level with no wrapper:

```json
{ "github": { } }
```

On one machine `telegram` / `discord` / `imessage` / `slack` / `notion` use the
wrapped form while `github` / `pagerduty` / `linear` / `serena` use the flat one.
Reading only `raw.mcpServers` reports **0 MCP servers** for the flat ones — worse
than "unknown", because zero is provably wrong. The robust read:

```js
const servers = Object.keys(raw.mcpServers ?? raw);
```

`hooks/hooks.json` has the same duality (`{"description", "hooks": {…}}` vs. a
bare event map), so it gets the same `raw.hooks ?? raw` treatment.

### 5. LSP plugins declare components only in the marketplace entry

Every `*-lsp` entry in `claude-plugins-official` (12 of them: `typescript-lsp`,
`pyright-lsp`, `clangd-lsp`, …) declares `lspServers` in its **marketplace
entry** and ships no `plugin.json` at all. Its plugin directory contains only a
README and a LICENSE.

A disk-only walk therefore reports "ships nothing" for a plugin that provably
ships an LSP server. Merge what the catalog declares with what the disk walk
found — disk wins where both know a component (it reflects the installed
version), catalog fills the gaps — and record which source answered so the
dashboard can say "declared in the marketplace catalog, not yet on disk".

The same merge recovers skills for entries whose skills live at the plugin root
rather than under `skills/` (a marketplace whose `source` is `"./"` with
`skills: [{path: "…"}]`).

### Bonus: `renames` produces phantom plugins

`claude-plugins-official` carries e.g. `{"adlc": "agentforce-adlc"}`. A ledger
key written before the rename has no catalog entry, so it looks like a plugin
installed from a vanished marketplace. Fold renamed keys onto the current entry
(and keep the old key in an `aliases` list so the provenance is not lost).

## The `claude plugin details` CLI

`claude plugin details <name>@<marketplace>` is first-party and prints a
component inventory plus a **tokenizer-based always-on token cost**. Related
commands: `claude plugin list`, `enable`, `disable`, `uninstall`,
`claude plugin marketplace`.

**Use it for cost.** The token number is what users actually want and it survives
schema changes, so it beats any locally computed proxy. There is no `--json`
flag, so parse the human-readable output defensively and degrade to null on
anything unrecognised.

**Do not use it for component counts, and do not blend them.** Two hard limits
and three semantic mismatches:

| Limit / mismatch | Consequence |
|---|---|
| Only resolves *installed* plugins (exits 0 with a "not found" message otherwise) | Cannot answer for most of a catalog |
| One subprocess per plugin, ~0.7 s each | ~10 s for 80 plugins even at concurrency 8 |
| "Skills (n)" includes slash commands | `commit-commands`: 0 skills + 3 commands reads as "Skills (3)" |
| "Hooks (n)" counts events, not handlers | `security-guidance`: 4 events, 9 handlers |
| Reports `0` for `plugin.json`-declared MCP servers and agents | `sentry` ships 1 MCP server → "MCP servers (0)"; `code-forge` ships 5 agents → "Agents (0)" |

A max/union merge across the two sources produces numbers true of neither — it
double-counts commands into the skills bucket while still missing the MCP servers.
So: disk walk owns the inventory, CLI owns the cost, and both inventories are
displayed side by side rather than blended.

### MCP servers are declared in three places

Union all three or the count is wrong:

1. `.mcp.json`, wrapped: `{"mcpServers": {"telegram": {…}}}`
2. `.mcp.json`, flat: `{"github": {…}}`
3. `plugin.json` → `mcpServers`, with **no `.mcp.json` at all** — `sentry` does
   this, and it is the case the first-party CLI misses.

## Interpreting the numbers

- **Invocation counts are not comparable across plugin types.** A hook or LSP
  plugin fires on every tool call; a slash command fires only when typed. Real
  spread on one machine: `hookify` 46k, `security-guidance` 7k,
  `typescript-lsp` 1.4k, `commit-commands` 19. Present them as "used at all vs.
  never", not as a leaderboard.
- **Usage on a plugin that is not installed** means it was installed at some
  point and later removed.
- **MCP server count is not MCP tool count.** `.mcp.json` gives you servers; the
  number of tool schemas a server registers is only knowable with the server
  running (and varies with version and auth state). Report servers from disk and
  treat tool counts as unavailable.
- **Always-on cost: prefer the CLI, fall back to the proxy.** `claude plugin
  details` gives a real token estimate. The offline fallback — summed character
  length of each active skill's frontmatter `description` — is a crude stand-in:
  it is measurable with no subprocess, but it **undercounts agents relative to
  skills**, which inverts the ranking. Either way, count only *active* plugins; a
  disabled plugin's skills are on disk but not in context. The proxy is
  approximate to ±1 char per skill depending on how a YAML block scalar's
  trailing newline is counted.
- **Agents dominate always-on cost.** Measured on one machine: `pr-review-toolkit`
  ~3,561 tok from 6 agents + 1 skill — more than `plugin-dev` (~2,349; 8 skills +
  3 agents) or `sui-pilot` (~1,486; 11 skills). Whole-set total ~16k tok across
  ~40 enabled plugins. Any ranking weighted by skill count is wrong.
- **Zero always-on cost is not zero value.** Hook-only and LSP plugins are
  harness-side and add nothing to the prompt: `security-guidance` fired 7,000+
  times for ~0 always-on tokens, and every `*-lsp` plugin is also ~0. Label the
  column so a `0` is not misread as dead weight.
- **A marketplace registered with zero installs is normal.** Its skills may be
  installed as personal skills under `<config>/skills/` instead.

## Graceful degradation

Each of these must produce a valid audit, not an exception — all are covered by
the collector and were tested against synthetic fixtures:

| Condition | Behaviour |
|---|---|
| `CLAUDE_CONFIG_DIR` points nowhere | warn, empty audit |
| no `plugins/marketplaces/` directory | warn, catalog is ledger keys only |
| marketplace directory with no `marketplace.json` | warn, treated as empty |
| `marketplace.json` truncated / unparseable | warn after retries, marketplace marked unreadable |
| `plugins` field present but not an array | warn, treated as empty |
| marketplace with `"plugins": []` | listed as a registered marketplace with 0 entries |
| missing `.claude.json` | usage shows as "no ledger entry", not `0` |
| no settings file at all | every installed plugin treated as active, stated in the footer |
