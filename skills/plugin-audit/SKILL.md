---
name: plugin-audit
description: |
  Audits the Claude Code plugins installed on this machine and emits a
  self-contained HTML dashboard for browsing the full marketplace catalog. Use
  when the user says "audit my plugins", "what plugins do I have", "which
  plugins am I not using", "what plugins are installed but switched off",
  "plugin dashboard", "plugin store", "show me the plugin marketplace", "what
  is my plugin setup costing me", or "/plugin-audit". Reports what is
  installed, what is enabled versus switched off, which marketplace each entry
  came from, what components each ships (skills / commands / agents / hooks /
  MCP servers / LSP servers), how much each has actually been invoked, and the
  always-on context cost of the skills that are loaded every turn. Output is
  one double-click-openable `.html` file — an App-Store-style searchable,
  filterable catalog with a copy-ready `/plugin install` command per plugin.
allowed-tools: Read, Write, Bash, Glob, AskUserQuestion
author: alilloig
version: 1.0.0
date: 2026-07-30
---

# Plugin Audit

You answer two questions in one pass:

1. **What is my plugin setup?** — installed vs. enabled, where each plugin came
   from, what it ships, and how much it actually gets used.
2. **What else is out there?** — a browsable dashboard of every entry in every
   registered marketplace, with the install command ready to copy.

The collection is done by a bundled script. Your job is to pick the output
location, run the script, and turn its summary into a short written audit that
leads with what the user should act on.

**REQUIRED FILES** (next to this SKILL.md):

- `scripts/plugin-audit.mjs` — the collector + renderer. Read-only against the
  Claude config; the only thing it writes is the `--out` HTML file.
- `template.html` — the dashboard engine. The script injects the audit payload
  into its `/*{{AUDIT}}*/` placeholder. Do **not** hand-write the HTML.
- `references/data-sources.md` — the file shapes the collector reads and the
  five traps in them. Read it before changing the script.

**Why a bundled `.mjs` and not TypeScript:** a skill script has to run on a
stranger's machine with no install step. `node file.mjs` works everywhere Node
exists; TypeScript would need a toolchain or a build artifact in the repo. So
this one file is deliberately plain, zero-dependency ESM — the global TypeScript
preference applies to project code, not to bundled skill scripts.

---

## Step 1 — Decide where the artifact goes

Do this **before** running anything, so the script writes once in the right place.

1. **A path the user gave** — use it verbatim.
2. Otherwise, if the working directory has a natural artifacts location
   (`./reports/`, `./artifacts/`, `./docs/`), write there.
3. Otherwise write to the working directory.
4. If the working directory is a repo where a stray HTML file would be noise
   (a clean library, someone else's project), use `AskUserQuestion` to offer:
   the working directory, a `reports/` subdirectory, or `$TMPDIR`.

Filename: `plugin-audit-<YYYY-MM-DD>.html` (kebab-case, dated — the audit is a
snapshot of a machine at a moment, and users re-run it).

## Step 2 — Run the collector

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/plugin-audit/scripts/plugin-audit.mjs \
  --out <output path from Step 1>
```

That writes the dashboard **and** prints a text summary you read to write the
audit. Useful variants:

| Flag | Effect |
|---|---|
| *(none)* | Text summary only. Nothing is written. Good for "which plugins am I not using?" with no artifact. |
| `--out <file>` | Also write the HTML dashboard. |
| `--json` | Full audit as JSON on stdout — use when you need per-plugin detail the summary omits. |
| `--project <dir>` | Which project's `.claude/settings{,.local}.json` to merge (default: cwd). |
| `--no-cli` | Skip `claude plugin details`; use the offline proxy. Makes the run instant. |
| `--quiet` | Suppress the text summary. |

**Two sources, two jobs.** Where the `claude` CLI is on PATH, the collector shells
out to `claude plugin details <name>@<marketplace>` for each *installed* plugin
and uses its tokenizer-based **always-on token cost** — the number that actually
answers "what is this costing me". That is authoritative and survives schema
changes, so prefer it; the offline skill-description-character proxy is only the
fallback, and it undercounts agents relative to skills.

The CLI is **not** used for component counts, because the two sources count
different things and blending them yields a number true of neither: the CLI folds
slash commands into its "Skills" bucket, counts hook *events* where the disk walk
counts *handlers*, and reports `0` for MCP servers and agents declared in
`plugin.json` rather than as files (`sentry` ships one MCP server; the CLI says
zero). So the disk walk remains the component inventory and both are shown.

Cost: ~10 s on a machine with ~80 installed plugins (one subprocess each, run 8
at a time). Pass `--no-cli` when the user only wants the inventory. The CLI
cannot answer for *not-installed* catalog entries at all, which is why the disk
walk is not optional.

The script honours `CLAUDE_CONFIG_DIR` and falls back to `~/.claude`. It never
writes to the Claude config directory. It degrades instead of crashing: no
marketplaces registered, no plugins installed, a missing ledger, a marketplace
with zero entries, or an unreadable manifest all produce a valid audit with a
`WARNINGS` section. **If you see warnings, surface them** — an unreadable
settings file means the enabled/disabled column is guesswork.

## Step 3 — Write the audit

Lead with the actionable findings, not the inventory. The summary hands you:

- **Three install states.** Active, installed-but-disabled, not installed.
  Installed and enabled are separate facts in separate files — say so if the
  user seems to conflate them.
- **Active but never invoked.** The first candidates to switch off.
- **Installed but disabled.** Costs nothing at runtime; still occupies disk and
  still appears in updates.
- **Used but no longer installed.** A usage counter on a plugin that is not
  installed means it was installed at some point and later removed. Worth
  flagging as "you tried this and dropped it".
- **Always-on token cost**, and which source produced it. Say "from
  `claude plugin details`" or "offline proxy" explicitly — the two are not
  equivalent.
- **Unknown component counts.** Entries that are only a git pin have nothing on
  disk to count.

Two facts about cost that change the conclusion, so state them:

- **Agents cost far more than skills.** The heaviest always-on line item is
  typically an agent-bearing plugin, not a skill-heavy one — on a real machine
  `pr-review-toolkit` (6 agents, 1 skill) outweighed `plugin-dev` (8 skills, 3
  agents) and `sui-pilot` (11 skills). Never rank cost by skill count.
- **A `0` token cost means "adds nothing to the prompt", not "does nothing".**
  Hook-only and LSP plugins are harness-side: `security-guidance` fired 7,000+
  times for 0 always-on tokens. Those are the cheapest plugins to leave enabled,
  and presenting them as dead weight is the single easiest way to give bad advice
  here.

Three things you must **not** do when reporting:

1. **Do not present invocation counts as a ranking.** They are not comparable
   across plugin types: a hook or LSP plugin fires on every tool call, a slash
   command only when typed. Use them as "does this get used at all", and say
   why the number for a hook plugin is orders of magnitude larger.
2. **Do not report an unknown component count as zero.** The dashboard renders
   an em dash for those; your prose should say "not on disk until installed".
3. **Do not recommend uninstalling based on a zero count alone.** A plugin can
   be legitimately dormant (a language LSP for a language not touched this
   month). Offer the list; let the user choose.

## Step 4 — Report and hand off

Tell the user:

- The **headline numbers**: marketplaces, catalog size, and the three states.
- The **two or three findings worth acting on**, with names.
- Where the artifact is, and that it is double-click-openable with no network.

Then surface the file. Per the user's global preference, end with a clickable
Vlervcode deep-link to the `.html` (form `[<filename>](vlerv://open?path=<abs
path>)`, path percent-encoded).

Mention [`publish-html`](../publish-html/SKILL.md) as the follow-on step if they
want to share it — and **never publish automatically**. Note that a plugin audit
names a specific machine's setup and file paths, so it is usually *sensitive*
rather than public-safe; `publish-html` will ask, and the honest answer here is
usually "secret gist".

---

## Notes & edge cases

- **Re-running is cheap** (well under a second on a few hundred entries). To
  refresh, re-run with the same `--out`; the file is overwritten.
- **The counters move while you work.** `pluginUsage` increments during the
  session that reads it, so two runs minutes apart legitimately differ. Don't
  treat a changed number as a bug.
- **`@inline` is not a marketplace.** Claude Code writes ledger keys under a
  pseudo-marketplace (commonly `@inline`) for plugins loaded outside a
  registered catalog. Those show as *not listed in any registered catalog*. The
  collector keeps the ones with real usage and omits zero-usage ones as noise,
  reporting the omitted count so the totals still add up.
- **A registered marketplace with zero installs is normal** — the user may have
  its skills installed as personal skills in `~/.claude/skills/` instead.
- **The dashboard is the deliverable, the summary is the argument.** Don't
  paste the whole 300-row catalog into chat; that is what the artifact is for.

## Regression notes — five traps in the data

These are handled in `scripts/plugin-audit.mjs` and documented at length in
`references/data-sources.md`. They are recorded here so a future edit does not
reintroduce them:

1. **Short names collide across marketplaces.** Keys are `name@marketplace`. A
   lookup keyed on the bare name lets `hookify@inline` (61 invocations) clobber
   `hookify@claude-plugins-official` (46k+). Always key on the full pair.
2. **Mid-write JSON reads.** Claude Code rewrites `settings.json`,
   `installed_plugins.json` and `~/.claude.json` while it runs; a read landing
   mid-write throws a parse error that looks exactly like corruption. Retry
   before believing a file is broken.
3. **Component counts only resolve locally.** A git-pinned entry has nothing on
   disk. Count by walking the plugin directory when available; render an em dash
   otherwise. Never imply zero where the answer is unknown.
4. **`.mcp.json` and `hooks/hooks.json` each have two shapes** — usually wrapped
   (`{"mcpServers": {…}}`), sometimes bare (`{"github": {…}}`). Reading only the
   wrapper key reports a provably wrong zero. Always `raw.mcpServers ?? raw`.
5. **LSP plugins declare their components in the marketplace entry, not
   `plugin.json`.** Every `*-lsp` entry in `claude-plugins-official` ships no
   `plugin.json` at all, so a disk-only walk reports "ships nothing" for a
   plugin that provably ships an LSP server. Merge catalog-declared components
   with the disk walk and record which source answered.

Related: marketplaces carry a `renames` map (retired name → current name), so
ledger keys written before a rename must be folded onto the current entry or
they look like phantom uninstalled plugins.

---

## HTML Output Conventions

**REQUIRED REFERENCE:** [html-artifact:html-conventions](../html-artifact/references/html-conventions.md)
— self-containment, semantic HTML5, the `:root` token palette, dark/light via
`prefers-color-scheme`, and the single mobile breakpoint. The bundled
`template.html` already complies; keep it that way if you edit it.

This skill's output **deliberately deviates** from the conventions' conservative
document aesthetic toward a denser "app store" layout: a card grid with
hash-derived icon tiles, a sticky search bar, chip filters, and a `<dialog>`
detail sheet. The catalog is a few hundred items that users search and filter
rather than read top to bottom, so browse affordances beat prose typography
here. What does **not** change:

- **Self-contained.** No external CSS, JS, fonts, or images. Everything inline;
  the only outbound URLs are `<a href>` links to plugin homepages, which are
  navigation, not assets.
- **Token palette in both branches.** `:root` plus a
  `@media (prefers-color-scheme: dark)` override, every rule reading `var(--…)`,
  no raw hex outside the token block. The extra tokens this layout needs
  (`--surface`, `--chip-bg`, `--shadow`, `--state-active`, `--state-disabled`)
  are named by meaning, not by hue.
- **Semantic structure.** `<header>` / `<main>` / `<section id>` / `<footer>`,
  a real `<table>` for the marketplace provenance rows, `<dl>` for the detail
  key/value pairs, `aria-pressed` on filter chips, and `<button>` (not `<div>`)
  for anything clickable.
- **Mobile-responsive** through one `@media (max-width: 720px)` block.
- **JavaScript is the exception the conventions allow.** Search, filtering,
  sorting, and the detail sheet cannot be `<details>`-faked over a few hundred
  rows. It stays inline and vanilla, with no framework and no build step.

### Verify before shipping an edit to the template

- [ ] `node --check` passes on `scripts/plugin-audit.mjs`
- [ ] The generated HTML contains exactly one `<script>` open and one close tag
      — a plugin description containing `</script>` must not end the block
      early (the collector escapes `</` to `<\/` in the payload for this reason)
- [ ] `node --check` passes on the `<script>` block extracted from the
      *generated* file, not just the template
- [ ] No `src="http`, no `href="https://…​.css"`, no `@import`, no font CDN
- [ ] All three install states appear, and unknown component counts render as
      an em dash rather than `0`
- [ ] `:root` tokens + dark override present; no raw hex in component rules
