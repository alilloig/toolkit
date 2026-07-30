# Toolkit

A Claude Code plugin that bundles the **self-contained HTML deliverable** skill family. Install it once and every skill that produces or shares a `.html` artifact is available.

## Bundled skills

| Skill | Purpose |
|---|---|
| `html-artifact` | One-off self-contained HTML deliverable (visual reports, side-by-side comparisons, box-and-arrow diagrams, ad-hoc explainers). Reference: `references/html-conventions.md` (system fonts, dark/light token palette via `prefers-color-scheme`, inline SVG, no external assets). |
| `publish-html` | Turn a local `.html` file into a shareable URL — public via GitHub Pages on `alilloig/artifacts`, sensitive via secret gist. Enforces a mandatory sensitivity question; never publishes automatically. |
| `for-dummies` | Reads an actual codebase and generates an `*_FOR_DUMMIES.html` intro guide (architecture, prerequisites, boot sequence, common tasks). Monorepo-aware. |
| `move-call-chains` | Generates HTML call-chain diagrams for Sui Move packages, organized as user stories. Inline SVG box-and-arrow per user story. |
| `teleprompter` | Turns any text — a Markdown file, a speech draft, deck speaker notes, pasted prose — into a self-contained HTML teleprompter. Segments the text into spoken beats, estimates each beat's duration from word count at an adjustable speaking rate (WPM), and emits a time-synced autoscroll (each line crosses the eye-line in exactly its spoken slot) plus beat-by-beat countdown, a "fit to a target time" control that back-solves the rate, and mirror/fullscreen for prompter rigs. Bundles the tested engine as `template.html`. |
| `plugin-audit` | Audits the Claude Code plugins installed on the current machine — installed vs. enabled vs. not installed, marketplace provenance, components shipped, invocation counts, and the always-on context cost of active skills — then emits a searchable/filterable HTML dashboard of every registered marketplace with a copy-ready `/plugin install` command per plugin. Bundles a zero-dependency `scripts/plugin-audit.mjs` collector; reads only, honours `CLAUDE_CONFIG_DIR`. |
| `inkscape-live` | Live-edit the document open in the macOS Inkscape GUI via the `inkscape` MCP server: arming protocol (user click + 120s rendezvous race), modal session semantics (one undo step per session), desync troubleshooting. macOS-specific; headless SVG work doesn't need it. |
| `inkscape-headless` | Headless file work through the `inkscape` MCP server: sandbox root + size-limit navigation, linked-raster workaround for oversized SVGs, PDF/AI ingestion via CLI conversion, print gotchas (bleed, CMYK→RGB, Illustrator `/PieceInfo`), verification recipes. Companion to `inkscape-live` (live-GUI protocol). |

Every artifact-producing skill (`html-artifact`, `for-dummies`, `move-call-chains`) loads `skills/html-artifact/references/html-conventions.md` as its REQUIRED REFERENCE — the family aesthetic. `publish-html` doesn't render HTML, only publishes existing files, so it doesn't share rendering conventions.

## Why one plugin?

The four skills cooperate around a shared convention file (`html-conventions.md`) and a shared mental model ("self-contained, double-click-openable, no network"). Bundling them lets:

- The convention file ship once, in one canonical location.
- Other plugins (notably [`agentic-community-college`](https://github.com/contract-hero/agentic-community-college)) declare a single `claude-plugin-enabled` probe against `toolkit@contract-hero` instead of four separate `filesystem-exists` probes.
- Consumers install the entire HTML-deliverable surface in one click.

## Install

Via Claude Code's plugin manager, once the `contract-hero` marketplace is registered:

```
/plugin install toolkit@contract-hero
```

## Source repos

This plugin tracks the same skill source as the maintainer's personal Claude Code config. Bug reports and PRs against the skills are welcome here — changes are mirrored back to the personal config periodically.
