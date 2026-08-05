# Changelog

All notable changes to the `toolkit` plugin are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`html-artifact` callout style** — replaced the `border-left: 3px solid`
  side tab with a faint background tint and the state color on the callout's
  lead-in `<strong>`, inside a neutral hairline border on all four sides. Adds
  `--success-bg` / `--warning-bg` / `--error-bg` to both theme branches. Applied
  to `references/example-dark-light.html` and to `plugin-audit/template.html`.
- **Type-scale rule** — each heading size step must be at least 1.25× the next;
  `h3`/`h4` separate by register, not by a third or fourth size.

## [0.7.0] - 2026-07-30

### Added

- **`plugin-audit` skill** — audits the Claude Code plugins installed on the
  current machine and emits a self-contained HTML dashboard for browsing every
  registered marketplace. The bundled zero-dependency collector
  (`scripts/plugin-audit.mjs`, plain ESM so it runs under bare `node` on a
  stranger's machine with no build step) cross-references four local sources —
  every `plugins/marketplaces/*/.claude-plugin/marketplace.json` catalog,
  `installed_plugins.json`, the `enabledPlugins` map merged across the
  user < project < local settings chain, and the `pluginUsage` counters in
  `.claude.json` — then injects the result into `template.html`. Resolves
  `CLAUDE_CONFIG_DIR` (falling back to `~/.claude`) at runtime and never writes
  to the Claude config directory.
  Distinguishes the **three** install states that the two source files imply
  (active / installed-but-disabled / not installed), counts what each plugin
  ships (skills, commands, agents, hook handlers, MCP servers, LSP servers), and
  surfaces two signals the raw ledgers do not: plugins that are switched on but
  have never been invoked, and the **always-on token cost** of everything that is
  enabled.
  For that cost the collector shells out to the first-party
  `claude plugin details <name>@<marketplace>` (bounded concurrency, ~10 s for 80
  installed plugins) and uses its tokenizer-based estimate, falling back to an
  offline skill-description-length proxy when the CLI is unavailable or
  `--no-cli` is passed — the dashboard states which source answered. The CLI is
  deliberately **not** used for component counts: it folds slash commands into its
  "Skills" bucket, counts hook *events* where the disk walk counts *handlers*, and
  reports `0` for MCP servers and agents declared in `plugin.json` rather than as
  files, so blending the two would produce numbers true of neither. The disk walk
  owns the inventory, the CLI owns the cost, and both are shown side by side.
  Two cost findings are surfaced explicitly because they invert the naive
  conclusion: **agents cost far more than skills** (`pr-review-toolkit`, 6 agents
  and 1 skill, is a bigger always-on line item than `plugin-dev` at 8 skills and 3
  agents), and **a `0` token cost means "adds nothing to the prompt", not "does
  nothing"** — hook-only and LSP plugins are harness-side, so `security-guidance`
  fires thousands of times for ~0 always-on tokens.
  Output is one double-click-openable `.html` file: an App-Store-style card grid
  with hash-derived icon tiles, sticky search, category / marketplace / status
  chip filters, six sort modes, data-driven finding cards that filter the catalog
  on click, a marketplace-provenance table, and a `<dialog>` detail sheet
  carrying the copy-ready `/plugin install <name>@<marketplace>` command. A
  documented deviation from `html-conventions.md`'s conservative document
  aesthetic (browse affordances beat prose typography for a few-hundred-item
  catalog) that keeps the token palette, dark/light via `prefers-color-scheme`,
  semantic structure, the single mobile breakpoint, and strict self-containment.
- **`skills/plugin-audit/references/data-sources.md`** — the four data sources,
  every varying field shape (`source` as relative string vs. `url`/`github`/
  `git-subdir` object, `author` object, `skills` as string array vs. object
  array, optional `category`/`version`/`tags`/`keywords`/`lspServers`), the
  interpretation caveats, and the graceful-degradation matrix.

### Fixed

Five data-shape traps found while building the prototype this skill generalises,
each now handled in the collector and recorded as a regression note in both
`SKILL.md` and the script header so a future edit cannot quietly reintroduce them:

- **Short-name collisions across marketplaces.** Ledger keys are
  `name@marketplace`; keying a lookup on the bare `name` let `hookify@inline`
  (61 invocations) silently clobber `hookify@claude-plugins-official` (46k+).
  Every map is keyed on the full pair.
- **Mid-write JSON reads.** Claude Code truncates and rewrites `settings.json`,
  `installed_plugins.json` and `.claude.json` while it runs; a read landing
  mid-write throws `Unexpected end of JSON input`, indistinguishable from real
  corruption. Reads now retry before declaring a file broken, and a definitive
  failure degrades to a warning instead of aborting the audit.
- **Component counts that only resolve locally.** A git-pinned marketplace entry
  has no `skills/`, `commands/` or `agents/` on disk until installed. Counts come
  from walking the plugin directory (installed `installPath`, else a
  marketplace-local relative `source`) and render as an em dash when there is
  nothing to walk — never as zero. `null` (unknown) and `{}` (walked, ships
  nothing) are kept distinct.
- **MCP servers are declared in three places.** `.mcp.json` in a wrapped form
  (`{"mcpServers": {…}}`), `.mcp.json` in a bare form (`{"github": {…}}`), and
  `plugin.json` → `mcpServers` **with no `.mcp.json` at all** (`sentry` does this —
  and it is the case the first-party CLI misses, reporting "MCP servers (0)" for a
  plugin that ships one). On one machine `telegram`/`discord`/`imessage`/`slack`/
  `notion` wrap while `github`/`pagerduty`/`linear`/`serena` do not. Reading only
  the wrapper key reported a provably wrong 0; all three sources are now unioned,
  and `hooks/hooks.json` gets the same `raw.<wrapper> ?? raw` treatment.
- **LSP plugins declare their components in the marketplace entry, not
  `plugin.json`.** All 12 `*-lsp` entries in `claude-plugins-official` ship no
  `plugin.json` at all, so a disk-only walk reported "ships nothing" for plugins
  that provably ship an LSP server. Catalog-declared components are merged with
  the disk walk (disk wins where both know a component) and the dashboard records
  which source answered. The same merge recovers skills for marketplaces whose
  `source` is `"./"` with skills at the plugin root.

Related: marketplace-level `renames` maps (`adlc` → `agentforce-adlc`) are applied
so ledger keys written before a rename fold onto the current entry instead of
appearing as phantom uninstalled plugins.

## [0.6.0] - 2026-07-18

### Added

- **`teleprompter` skill** — turns any text (Markdown file, speech draft, deck
  speaker notes, or pasted prose) into a self-contained HTML teleprompter for
  timing and delivering a live talk. Segments the source into sentence-sized
  spoken beats (headings → dimmed section labels, `[pause]`/`…` cues → silent
  hold beats), then injects them into the bundled `template.html` engine. The
  engine estimates each beat's duration from `words / wpm * 60` at an adjustable
  speaking rate and drives a time-synced autoscroll — each beat's block crosses
  the eye-line arrow in exactly its estimated slot, so reading the line at the
  arrow *is* speaking at the chosen rate (the timing-aware scroll model proven in
  the memwal video teleprompter, generalized from fixed measured targets to a
  live WPM estimate). Adds a beat-by-beat countdown mode, a "fit to a target
  time" box that back-solves WPM from a `m:ss` goal, a running clock + per-beat
  countdown HUD, and mirror/fullscreen for beam-splitter prompter rigs. Output is
  one double-click-openable `.html` file (inline CSS/JS, no network).

## [0.5.0] - 2026-07-03

### Added

- **`inkscape-headless` skill** — navigating the `inkscape` MCP server for headless
  file work, validated against a 220MB Illustrator print PDF: the workspace-root
  sandbox and size limits (`INKSCAPE_MCP_MAX_INPUT_BYTES` 50MB / output 100MB), the
  linked-raster workaround for oversized SVGs (extract embedded base64 to a file,
  absolute `file:///` href), PDF/AI ingestion via background CLI conversion, print
  gotchas (crop-box canvas but `<page>` preserves media-box bleed; RGB-internal so
  CMYK jobs stamp with pypdf; the `/PieceInfo → /Illustrator` stale-artwork trap),
  id-less placed content (snapshot + re-place), and pre-ship verification recipes
  (`pdfimages` resolution parity, dilate-then-decode for dot-style QR codes).

## [0.4.0] - 2026-07-03

### Added

- **`inkscape-live` skill** — operational protocol for live-editing the document open
  in the macOS Inkscape GUI via the `inkscape` MCP server (jjjsood/inkscape-mcp-server,
  extension-socket transport): user-click arming with the 120 s rendezvous race, modal
  session semantics (snapshot at arm, one undo step per session, approval tokens),
  effective-usage patterns (`live_get_scene` dims first, scaled proof renders), and the
  root-caused desync failure mode (`INKSCAPE_MCP_PROCESS_TIMEOUT_S=300` requirement,
  never call the broken `live_arm_socket`).

## [0.3.0] - 2026-05-21

### Changed

- **`move-call-chains` Step 1 now extracts the function inventory from the move-analyzer LSP** (`mcp__plugin_sui-pilot_move-lsp__move_document_symbols`) instead of the regex script. The regex matched function declarations line-by-line and silently dropped `public entry fun`, `macro fun`, `public(package) macro fun`, and signatures whose modifiers/params wrap across lines — verified against the framework `coin` module (every `public entry fun` was missed) and `deepbookv3`. The LSP parses with the real Move grammar, so it catches all of them and returns exact name positions.
- **Visibility classification reads the declaration line the LSP points at.** The document-symbols outline carries no visibility, but `range.startCharacter` is the column where the name begins, so columns `0..startCharacter` are exactly the modifier prefix (`fun `, `public fun `, `public(package) fun `, `public entry fun `). Step 1 matches on the keywords present rather than column arithmetic.
- **Documented the warm-up gotcha**: the first `move_document_symbols` call against a freshly-opened package returns `"symbols": []` while move-analyzer indexes the workspace — retry once (or call `move_diagnostics` first) before recording a module as empty.
- **The regex `scripts/extract-move-functions.py` is demoted to a documented fallback** for when move-analyzer is unavailable, with an explicit "best-effort, may under-count" warning. LSP line numbers are now carried into the inventory to make Step 2 call-chain tracing cheaper.
- **`move-call-chains` diagrams redesigned as a native SVG visual language.** The diagrams were already inline SVG (not Mermaid), but Step 4 authored them by transcribing ASCII primitives 1:1 — hard-cornered `<rect>` boxes, straight `<line>` edges, `<polygon>` "ASCII diamonds" — which read stiff. `references/ascii-style-guide.md` is renamed to `references/svg-style-guide.md` and rewritten to design natively: rounded nodes (`rx≈8`), cubic-Bézier edge `<path>`s with a shared arrowhead marker, per-tier color tokens (dark/light) from the shared html-conventions palette, stadium-shaped event nodes, dashed external nodes/edges, and phase **bands** instead of enclosing mega-boxes. Step 4 now references the guide, forbids ASCII transcription and DSLs (Mermaid/Graphviz), and keeps the textual tags so color is never the only channel (accessibility + grayscale print).

## [0.2.0] - 2026-05-19

### Added

- **Required dark / light mode support in the shared HTML conventions.** `skills/html-artifact/references/html-conventions.md` now mandates a CSS-custom-property token palette (`--bg`, `--fg`, `--fg-muted`, `--heading-fg`, `--accent`, `--border`, `--code-bg`, `--code-fg`, `--pre-bg`, `--aside-bg`, `--success`, `--warning`, `--error`) defined at `:root` with a `@media (prefers-color-scheme: dark)` override. Token values mirror Vlervcode's palette so artifacts opened inside the Vlervcode workspace browser feel visually coherent with the surrounding app chrome.
- **No-toggle, no-JS pattern.** OS preference is the single source of truth — `prefers-color-scheme` re-evaluates automatically when the user flips system appearance, so artifacts stay self-contained with zero JavaScript and zero theme-switcher UI.
- **`color-scheme: light dark` declaration** on `:root` so native browser UI (scrollbars, form controls, focus outline) renders in the matching scheme instead of flashing a light scrollbar on a dark page.
- **Inline-SVG convention update.** Strokes and text use `currentColor` (cascades to `var(--fg)`); colored fills reference tokens directly (`fill="var(--accent)"`). Hardcoded `#000` / `#fff` in SVG is now an explicit anti-pattern.
- **`skills/html-artifact/references/example-dark-light.html`** — a self-contained verification artifact exercising the full pattern (swatches, box-and-arrow diagram with `<line stroke="currentColor">` + arrowhead marker, callouts including the neutral `note` class, typography, code blocks, table). Acts as the minimum compliant example for new artifact authors and a smoke test when the convention evolves.
- **New verify-step checklist items in `skills/html-artifact/SKILL.md`** — one for token presence + `var(--…)` references, one for SVG `currentColor` discipline. Equivalent items added to `skills/for-dummies/SKILL.md` Step 5 verify checklist and `skills/move-call-chains/SKILL.md` HTML Output Conventions, so the requirement is enforced at every consumer's verify step (not only the shared reference).
- **"Print mode (opt-in)" subsection** in `html-conventions.md` with the full 13-token override block — eliminates the previous `...` ellipsis copy-paste hazard and gives print-friendly artifacts a single canonical override to drop in.
- **"Extending the palette" subsection** documenting how to add categorical/tier scales (move-call-chains visibility tiers, log levels), state-plus-emphasis pairs (`--warning-fg` when a state needs body-text contrast vs. a border accent), and diagram-only role tokens — without breaking the dark/light contract.

### Changed

- `skills/html-artifact/references/html-conventions.md` — the "pick 2–4 semantic colors max" CSS-style bullet now reads "use the token palette, never hardcode hex (one exception: `currentColor` inside inline SVG)." A new "Dark / light mode (required)" section follows the existing CSS-style rules, with the canonical CSS demo block now wiring **every** token (the original block only wired 8 of 13).
- **"Collapsibles and callouts" section** updated to name the four canonical classes — `note | success | warning | error` — matching the state tokens. Previously it named `note | warning | tip`, which contradicted the new palette.
- **Token value adjustments for WCAG AA when used as body text.** Light `--warning` deepened from `#b8862e` (3.06:1 on `--bg`) to `#9a5b00` (5.20:1). Dark `--fg-muted` lightened from `#858585` (4.32:1 on dark `--bg`, fails AA for body text) to `#9e9e9e` (6.13:1). Vlervcode keeps its original `#858585` for chrome labels where AA-for-body doesn't apply; the artifact palette now diverges where the use case differs.
- **README** — "all four skills share the conventions" corrected to "every artifact-producing skill," since `publish-html` only publishes existing HTML rather than rendering it.
- **Propagation model**: because the shared `html-conventions.md` is loaded by every artifact-producing skill (`html-artifact`, `for-dummies`, `move-call-chains`), the dark/light requirement propagates to all of them at the convention layer. The per-skill verify-step additions close the gap at the enforcement layer.
- **Distribution**: the `contract-hero` marketplace lists `toolkit` without a commit pin, so users who already have the marketplace registered receive this version on their next `/plugin update toolkit@contract-hero`. No marketplace edits required.

## [0.1.0] - 2026-05-02

### Added

- Initial plugin scaffold bundling the four self-contained HTML deliverable skills: `html-artifact`, `publish-html`, `for-dummies`, `move-call-chains`.
- Shared `skills/html-artifact/references/html-conventions.md` reference loaded by all three artifact-producing skills.
- README and LICENSE.

[Unreleased]: https://github.com/contract-hero/toolkit/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/contract-hero/toolkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/contract-hero/toolkit/releases/tag/v0.1.0
