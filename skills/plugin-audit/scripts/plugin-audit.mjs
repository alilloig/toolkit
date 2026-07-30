#!/usr/bin/env node
/**
 * plugin-audit.mjs — audit the Claude Code plugins on THIS machine and render a
 * self-contained HTML dashboard of the full marketplace catalog.
 *
 * Zero dependencies, plain `node` (>=18), read-only. Nothing here writes to the
 * Claude config directory; the only write is the `--out` HTML file.
 *
 * Usage
 *   node plugin-audit.mjs                      # text summary to stdout
 *   node plugin-audit.mjs --out audit.html     # + write the dashboard
 *   node plugin-audit.mjs --json               # full audit as JSON on stdout
 *   node plugin-audit.mjs --project <dir>      # merge that project's .claude settings
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGRESSION NOTES — five traps this file exists to not fall into again.
 * Full write-up in ../references/data-sources.md. Do not "simplify" these away.
 *
 *  1. KEY ON `name@marketplace`, NEVER ON THE BARE NAME.
 *     Short names collide across marketplaces. A lookup keyed on `name` lets
 *     `hookify@inline` (61 invocations) clobber `hookify@claude-plugins-official`
 *     (46,772) and silently reports the wrong number. Every map in this file is
 *     keyed by the full `name@marketplace` id built by `pluginId()`.
 *
 *  2. RETRY JSON READS.
 *     Claude Code truncates and rewrites settings.json, installed_plugins.json
 *     and ~/.claude.json *while it runs*. A read that lands mid-write throws a
 *     parse error indistinguishable from real corruption. `readJson()` retries
 *     before believing a file is broken, and degrades to a warning instead of
 *     crashing.
 *
 *  3. COMPONENT COUNTS ONLY RESOLVE LOCALLY — NEVER IMPLY ZERO.
 *     A marketplace entry pinned to a git repo has no skills/commands/agents on
 *     disk until it is installed. `countComponents()` returns `null` (rendered
 *     as an em dash) when there is no directory to walk. `{}` means "walked the
 *     directory, found no components" — a different, knowable fact.
 *
 *  4. `.mcp.json` AND `hooks/hooks.json` EACH HAVE TWO SHAPES.
 *     Servers/hooks are usually nested under a wrapper key, but some plugins
 *     declare them at the top level with no wrapper. On this machine
 *     telegram/discord/imessage/slack/notion use `{"mcpServers": {...}}` while
 *     github/pagerduty/linear/serena use `{"github": {...}}`. Reading only the
 *     wrapper key reports a provably wrong 0. Always `raw.mcpServers ?? raw`.
 *
 *  5. MARKETPLACES CARRY A `renames` MAP.
 *     claude-plugins-official maps retired plugin names to current ones
 *     (`adlc` -> `agentforce-adlc`). Ledger keys written before a rename must be
 *     folded onto the current entry or they look like phantom uninstalled
 *     plugins. `resolveAlias()` does that.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(SCRIPT_DIR, "..", "template.html");

/* ── retry-hardened JSON reading (trap 2) ─────────────────────────────────── */

const READ_ATTEMPTS = 5;
const READ_DELAY_MS = 120;

/** Blocking sleep — this script is deliberately synchronous end to end. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin — SharedArrayBuffer unavailable */
    }
  }
}

/**
 * Read + parse JSON, tolerating a read that lands mid-rewrite.
 * Returns { value, missing?, unreadable?, error?, attempts }.
 * A missing file is normal (not every machine has every file) and never warns.
 */
function readJson(file, warnings) {
  let lastError = null;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        return { value: null, missing: true, attempts: attempt };
      }
      lastError = err;
      if (attempt < READ_ATTEMPTS) sleepSync(READ_DELAY_MS);
      continue;
    }
    try {
      return { value: JSON.parse(text), attempts: attempt };
    } catch (err) {
      // Almost always a mid-write truncation. Give the writer time to finish.
      lastError = err;
      if (attempt < READ_ATTEMPTS) sleepSync(READ_DELAY_MS);
    }
  }
  const msg = lastError ? lastError.message : "unknown error";
  warnings.push(
    `Could not read ${file} after ${READ_ATTEMPTS} attempts (${msg}). ` +
      `Audit continues with that source missing.`
  );
  return { value: null, unreadable: true, error: msg, attempts: READ_ATTEMPTS };
}

/** Quiet variant for the many optional per-plugin manifests. */
function readJsonQuiet(file) {
  const sink = [];
  return readJson(file, sink).value;
}

/* ── path resolution (no hardcoded home) ──────────────────────────────────── */

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** `CLAUDE_CONFIG_DIR` wins if set (first entry if it is a path list). */
function resolveConfigDir() {
  const raw = process.env.CLAUDE_CONFIG_DIR;
  if (raw && raw.trim()) {
    const first = raw
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first) return expandHome(first);
  }
  return path.join(os.homedir(), ".claude");
}

/**
 * The usage ledger lives beside the config dir as `.claude.json`. Relocated
 * configs keep it inside CLAUDE_CONFIG_DIR, so check there first.
 */
function resolveLedgerPath(configDir) {
  const candidates = [
    path.join(configDir, ".claude.json"),
    path.join(os.homedir(), ".claude.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[candidates.length - 1];
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/* ── ids and aliases (traps 1 and 5) ──────────────────────────────────────── */

const pluginId = (name, marketplace) => `${name}@${marketplace}`;

/** Split `name@marketplace`; plugin names may not contain `@`, marketplaces may. */
function splitId(id) {
  const at = id.indexOf("@");
  if (at < 0) return { name: id, marketplace: "" };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/* ── marketplace catalogs ─────────────────────────────────────────────────── */

const str = (v) => (typeof v === "string" ? v : "");

/** `author` is a string on some entries, `{name,email,url}` on others. */
function authorName(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  return str(a.name) || str(a.email) || str(a.url);
}

/**
 * Normalise the wildly varying `source` field into { kind, ref, localDir }.
 * String sources are relative to the marketplace checkout and therefore local.
 * Object sources are a git pin — nothing on disk until installed (trap 3).
 */
function normalizeSource(entry, marketplaceDir) {
  const s = entry.source;
  if (typeof s === "string" && s) {
    const localDir = path.resolve(marketplaceDir, s);
    return {
      kind: "local",
      ref: s,
      localDir: isDir(localDir) ? localDir : null,
    };
  }
  if (s && typeof s === "object") {
    const kind = str(s.source) || "unknown";
    const ref =
      str(s.repo) ||
      str(s.url) ||
      str(s.path) ||
      str(s.ref) ||
      str(s.commit) ||
      "";
    return { kind, ref, localDir: null };
  }
  return { kind: "unknown", ref: "", localDir: null };
}

function loadMarketplaces(configDir, warnings) {
  const root = path.join(configDir, "plugins", "marketplaces");
  const known =
    readJson(path.join(configDir, "plugins", "known_marketplaces.json"), warnings)
      .value || {};

  let dirNames = [];
  try {
    dirNames = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    warnings.push(
      `No marketplace directory at ${root} — no marketplaces are registered on this machine.`
    );
  }

  const marketplaces = [];
  for (const name of dirNames) {
    const dir = path.join(root, name);
    const manifestPath = path.join(dir, ".claude-plugin", "marketplace.json");
    const res = readJson(manifestPath, warnings);
    const manifest = res.value;
    const meta = known[name] || {};
    const provenance = meta.source
      ? {
          kind: str(meta.source.source) || "unknown",
          ref: str(meta.source.repo) || str(meta.source.url) || "",
        }
      : { kind: "unknown", ref: "" };

    if (!manifest) {
      marketplaces.push({
        name,
        dir,
        provenance,
        lastUpdated: str(meta.lastUpdated) || null,
        autoUpdate: meta.autoUpdate === true,
        description: "",
        owner: "",
        renames: {},
        entries: [],
        broken: true,
      });
      warnings.push(
        res.missing
          ? `Marketplace "${name}" has no .claude-plugin/marketplace.json — treated as empty.`
          : `Marketplace "${name}" has an unusable .claude-plugin/marketplace.json ` +
            `(not a JSON object) — treated as empty.`
      );
      continue;
    }

    const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
    if (!Array.isArray(manifest.plugins) && manifest.plugins !== undefined) {
      warnings.push(
        `Marketplace "${name}" has a non-array "plugins" field — treated as empty.`
      );
    }

    marketplaces.push({
      name: str(manifest.name) || name,
      dir,
      provenance,
      lastUpdated: str(meta.lastUpdated) || null,
      autoUpdate: meta.autoUpdate === true,
      description: str(manifest.description),
      owner: authorName(manifest.owner),
      // trap 5: retired-name -> current-name
      renames:
        manifest.renames && typeof manifest.renames === "object"
          ? manifest.renames
          : {},
      entries: plugins.filter((p) => p && typeof p === "object" && str(p.name)),
      broken: false,
    });
  }
  return marketplaces;
}

/* ── installed / enabled / usage ledgers ──────────────────────────────────── */

function loadInstalled(configDir, warnings) {
  const file = path.join(configDir, "plugins", "installed_plugins.json");
  const raw = readJson(file, warnings).value;
  const byId = new Map();
  const plugins = raw && typeof raw.plugins === "object" ? raw.plugins : {};
  for (const [id, value] of Object.entries(plugins)) {
    // Documented shape is an array of install records (one per scope).
    const records = Array.isArray(value) ? value : value ? [value] : [];
    if (!records.length) continue;
    // Prefer a user-scope record; otherwise the first one.
    const rec = records.find((r) => r && r.scope === "user") || records[0];
    byId.set(id, {
      scope: str(rec.scope) || "unknown",
      installPath: str(rec.installPath),
      version: str(rec.version),
      installedAt: str(rec.installedAt) || null,
      lastUpdated: str(rec.lastUpdated) || null,
      gitCommitSha: str(rec.gitCommitSha) || null,
      scopes: records.map((r) => str(r && r.scope) || "unknown"),
    });
  }
  return { byId, file, present: !!raw };
}

/**
 * enabledPlugins is merged across the settings chain, lowest precedence first:
 *   user (<config>/settings.json) < project (.claude/settings.json)
 *                                < local (.claude/settings.local.json)
 * Installed and enabled are different facts in different files — a plugin can
 * sit on disk and be switched off.
 */
function loadEnabled(configDir, projectDir, warnings) {
  const layers = [
    { scope: "user", file: path.join(configDir, "settings.json") },
    { scope: "project", file: path.join(projectDir, ".claude", "settings.json") },
    {
      scope: "local",
      file: path.join(projectDir, ".claude", "settings.local.json"),
    },
  ];
  const byId = new Map(); // id -> { enabled, scope }
  const used = [];
  for (const layer of layers) {
    const res = readJson(layer.file, warnings);
    if (!res.value) continue;
    used.push(layer);
    const ep = res.value.enabledPlugins;
    if (!ep || typeof ep !== "object") continue;
    for (const [id, on] of Object.entries(ep)) {
      byId.set(id, { enabled: on !== false, scope: layer.scope });
    }
  }
  return { byId, layers: used };
}

/**
 * pluginUsage values are objects ({usageCount, lastUsedAt, lastUsedNumStartups})
 * on current Claude Code and were bare numbers earlier. Accept both.
 */
function loadUsage(configDir, warnings) {
  const file = resolveLedgerPath(configDir);
  const raw = readJson(file, warnings).value;
  const byId = new Map();
  const usage = raw && typeof raw.pluginUsage === "object" ? raw.pluginUsage : {};
  for (const [id, value] of Object.entries(usage || {})) {
    if (typeof value === "number") {
      byId.set(id, { count: value, lastUsedAt: null });
    } else if (value && typeof value === "object") {
      byId.set(id, {
        count: Number.isFinite(value.usageCount) ? value.usageCount : 0,
        lastUsedAt: Number.isFinite(value.lastUsedAt)
          ? new Date(value.lastUsedAt).toISOString()
          : null,
      });
    }
  }
  return { byId, file, present: !!raw };
}

/* ── component counting (traps 3 and 4) ───────────────────────────────────── */

const MAX_WALK_DEPTH = 4;

function walkFiles(dir, predicate, depth = 0, out = []) {
  if (depth > MAX_WALK_DEPTH) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, predicate, depth + 1, out);
    else if (predicate(e.name, p)) out.push(p);
  }
  return out;
}

/** plugin.json component fields may be a string path or an array of paths. */
function declaredPaths(root, field) {
  const list = typeof field === "string" ? [field] : Array.isArray(field) ? field : [];
  const out = [];
  for (const item of list) {
    const rel = typeof item === "string" ? item : str(item && item.path);
    if (rel) out.push(path.resolve(root, rel));
  }
  return out;
}

/**
 * Extract the frontmatter `description` of a SKILL.md. Supports plain,
 * quoted, and `|` / `>` block-scalar forms. Returns "" when absent.
 */
function frontmatterDescription(text) {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  const lines = text.slice(4, end).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^description:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const head = m[1].trim();
    if (/^[|>][-+]?\d*$/.test(head)) {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "") {
          buf.push("");
          continue;
        }
        if (!/^[ \t]/.test(line)) break; // next top-level key ends the block
        buf.push(line.trim());
      }
      return buf.join(" ").replace(/\s+/g, " ").trim();
    }
    return head.replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

function countMd(dirs) {
  const seen = new Set();
  for (const d of dirs) {
    if (!isDir(d)) continue;
    for (const f of walkFiles(d, (n) => n.endsWith(".md"))) seen.add(f);
  }
  return seen.size;
}

/** Count individual hook handlers, and list the events they bind. */
function readHooks(root, manifest) {
  const candidates = [
    path.join(root, "hooks", "hooks.json"),
    path.join(root, "hooks.json"),
    ...declaredPaths(root, manifest.hooks),
  ];
  let handlers = 0;
  const events = new Set();
  const seen = new Set();
  const consume = (config) => {
    // trap 4: hooks are usually under a "hooks" wrapper, sometimes top-level.
    const table = config && typeof config.hooks === "object" ? config.hooks : config;
    if (!table || typeof table !== "object") return;
    for (const [event, groups] of Object.entries(table)) {
      if (!Array.isArray(groups)) continue;
      events.add(event);
      for (const g of groups) {
        handlers += Array.isArray(g && g.hooks) ? g.hooks.length : 1;
      }
    }
  };
  if (manifest.hooks && typeof manifest.hooks === "object" && !Array.isArray(manifest.hooks)) {
    consume(manifest.hooks); // inline in plugin.json
  }
  for (const f of candidates) {
    if (seen.has(f) || !fs.existsSync(f) || isDir(f)) continue;
    seen.add(f);
    consume(readJsonQuiet(f));
  }
  return { handlers, events: [...events].sort() };
}

/** MCP servers declared on disk. Server count != tool count — see below. */
function readMcpServers(root, manifest) {
  const names = new Set();
  const fromManifest =
    manifest.mcpServers && typeof manifest.mcpServers === "object"
      ? Object.keys(manifest.mcpServers)
      : [];
  for (const n of fromManifest) names.add(n);
  for (const file of [path.join(root, ".mcp.json"), ...declaredPaths(root, manifest.mcpServers)]) {
    if (!fs.existsSync(file) || isDir(file)) continue;
    const raw = readJsonQuiet(file);
    if (!raw || typeof raw !== "object") continue;
    // trap 4: `{"mcpServers": {...}}` OR a bare `{"github": {...}}`.
    const table = raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : raw;
    for (const n of Object.keys(table)) {
      if (n === "mcpServers") continue;
      names.add(n);
    }
  }
  return [...names].sort();
}

/**
 * Components a marketplace entry declares in the catalog itself. These are
 * knowable without the plugin on disk — and for LSP plugins they are the ONLY
 * source: every `*-lsp` entry in claude-plugins-official declares `lspServers`
 * in its marketplace entry and ships no plugin.json at all, so a disk-only walk
 * reports "ships nothing" for a plugin that provably ships an LSP server.
 */
function catalogDeclared(entry) {
  const skills = Array.isArray(entry.skills) ? entry.skills : [];
  return {
    skillCount: skills.length,
    // Entries use either ["./name"] or [{name, path, invoke}] — take the path.
    skillPaths: skills
      .map((s) => (typeof s === "string" ? s : str(s && s.path)))
      .filter(Boolean),
    lspServers:
      entry.lspServers && typeof entry.lspServers === "object"
        ? Object.keys(entry.lspServers)
        : [],
  };
}

/**
 * Count what a plugin ships, by walking its directory.
 * Returns null when there is no directory to walk (trap 3) — the caller renders
 * that as an em dash. An empty `counts` object means "walked it, ships nothing".
 * `extraSkillPaths` are catalog-declared skill directories (some marketplaces
 * put skills at the plugin root rather than under `skills/`).
 */
function countComponents(root, extraSkillPaths = []) {
  if (!root || !isDir(root)) return null;
  const manifest = readJsonQuiet(path.join(root, ".claude-plugin", "plugin.json")) || {};

  const skillDirs = [
    path.join(root, "skills"),
    ...declaredPaths(root, manifest.skills),
    ...declaredPaths(root, extraSkillPaths),
  ];
  const skillFiles = new Set();
  for (const d of skillDirs) {
    if (!isDir(d)) continue;
    for (const f of walkFiles(d, (n) => n === "SKILL.md")) skillFiles.add(f);
  }

  // Always-on context cost: every active skill's frontmatter description is
  // injected on every turn, so this is the dominant recurring cost for
  // skill-heavy plugins — and unlike MCP tool counts it is measurable offline.
  let descriptionChars = 0;
  const skills = [];
  for (const f of [...skillFiles].sort()) {
    let desc = "";
    try {
      desc = frontmatterDescription(fs.readFileSync(f, "utf8"));
    } catch {
      /* unreadable skill file — count it as 0 chars */
    }
    descriptionChars += desc.length;
    skills.push({ name: path.basename(path.dirname(f)), descriptionChars: desc.length });
  }

  const hooks = readHooks(root, manifest);
  const mcpServers = readMcpServers(root, manifest);
  const lspServers =
    manifest.lspServers && typeof manifest.lspServers === "object"
      ? Object.keys(manifest.lspServers)
      : [];

  const counts = {};
  const put = (k, n) => {
    if (n > 0) counts[k] = n;
  };
  put("skills", skillFiles.size);
  put("commands", countMd([path.join(root, "commands"), ...declaredPaths(root, manifest.commands)]));
  put("agents", countMd([path.join(root, "agents"), ...declaredPaths(root, manifest.agents)]));
  put("hooks", hooks.handlers);
  put("mcp", mcpServers.length);
  put("lsp", lspServers.length);
  put("outputStyles", countMd([path.join(root, "output-styles"), ...declaredPaths(root, manifest.outputStyles)]));

  return {
    counts,
    hookEvents: hooks.events,
    mcpServers,
    lspServers,
    skills,
    descriptionChars,
    dir: root,
  };
}

/**
 * Combine the disk walk with what the catalog declares. Disk wins where both
 * know a component (it reflects the version actually installed); the catalog
 * fills gaps the disk cannot answer. `source` records which was used, so the
 * dashboard can be honest about provenance instead of implying a disk read.
 * Returns null only when NEITHER source knows anything (trap 3).
 */
function mergeComponents(disk, declared) {
  const hasDeclared = declared.skillCount > 0 || declared.lspServers.length > 0;
  if (!disk && !hasDeclared) return null;

  const counts = disk ? { ...disk.counts } : {};
  const lspServers = disk ? [...disk.lspServers] : [];
  let usedCatalog = false;

  if (declared.lspServers.length) {
    const before = lspServers.length;
    for (const s of declared.lspServers) if (!lspServers.includes(s)) lspServers.push(s);
    if (lspServers.length !== before || !counts.lsp) usedCatalog = true;
    counts.lsp = lspServers.length;
  }
  if (declared.skillCount > 0 && !counts.skills) {
    counts.skills = declared.skillCount;
    usedCatalog = true;
  }

  return {
    counts,
    hookEvents: disk ? disk.hookEvents : [],
    mcpServers: disk ? disk.mcpServers : [],
    lspServers,
    skills: disk ? disk.skills : [],
    // Only a disk read can measure description length, so leave it null when the
    // count came from the catalog — an unknown cost, not a zero cost.
    descriptionChars: disk ? disk.descriptionChars : null,
    dir: disk ? disk.dir : null,
    source: disk ? (usedCatalog ? "disk+catalog" : "disk") : "catalog",
  };
}

/* ── record assembly ──────────────────────────────────────────────────────── */

function buildRecords({ marketplaces, installed, enabled, usage }) {
  // trap 5: retired name -> current name, per marketplace.
  const aliasToId = new Map();
  for (const m of marketplaces) {
    for (const [from, to] of Object.entries(m.renames || {})) {
      if (typeof to === "string" && to) {
        aliasToId.set(pluginId(from, m.name), pluginId(to, m.name));
      }
    }
  }
  const catalogIds = new Set();
  for (const m of marketplaces) {
    for (const e of m.entries) catalogIds.add(pluginId(str(e.name), m.name));
  }
  const resolveAlias = (id) => {
    const target = aliasToId.get(id);
    return target && catalogIds.has(target) ? target : id;
  };

  const records = new Map();

  for (const m of marketplaces) {
    for (const entry of m.entries) {
      const name = str(entry.name);
      const id = pluginId(name, m.name);
      const source = normalizeSource(entry, m.dir);
      const inst = installed.byId.get(id) || null;
      // Prefer the installed copy on disk; fall back to a marketplace-local dir.
      const dir = inst && isDir(inst.installPath) ? inst.installPath : source.localDir;
      const declared = catalogDeclared(entry);
      const comps = mergeComponents(countComponents(dir, declared.skillPaths), declared);
      const en = enabled.byId.get(id) || null;
      const use = usage.byId.get(id) || null;

      const tags = []
        .concat(Array.isArray(entry.tags) ? entry.tags : [])
        .concat(Array.isArray(entry.keywords) ? entry.keywords : [])
        .filter((t) => typeof t === "string");

      records.set(id, {
        id,
        name,
        marketplace: m.name,
        display: str(entry.displayName) || name,
        desc: str(entry.description),
        author: authorName(entry.author) || m.owner || "",
        category: str(entry.category) || "uncategorized",
        version: str(entry.version) || (inst ? inst.version : "") || "",
        url: str(entry.homepage) || str(entry.repository) || "",
        sourceKind: source.kind,
        sourceRef: source.ref,
        tags: [...new Set(tags)],
        listed: true,
        installed: !!inst,
        install: inst,
        // A key set to false is an explicit switch-off; a missing key means the
        // installed plugin was never switched off, i.e. active.
        enabled: en ? en.enabled : null,
        enabledScope: en ? en.scope : null,
        state: !inst ? "none" : en && !en.enabled ? "disabled" : "active",
        uses: use ? use.count : null,
        lastUsedAt: use ? use.lastUsedAt : null,
        components: comps ? comps.counts : null,
        componentDir: comps ? comps.dir : null,
        componentsSource: comps ? comps.source : null,
        alwaysOnTokens: null,
        harnessOnly: false,
        costSource: comps && comps.descriptionChars !== null ? "proxy" : null,
        hookEvents: comps ? comps.hookEvents : [],
        mcpServers: comps ? comps.mcpServers : [],
        lspServers: comps ? comps.lspServers : [],
        descriptionChars: comps ? comps.descriptionChars : null,
        skillList: comps ? comps.skills : [],
      });
    }
  }

  // Ledger keys with no catalog entry: installed from a since-removed
  // marketplace, or the `@inline` pseudo-marketplace Claude Code writes for
  // locally loaded plugins. These are the audit's most interesting rows.
  const ledgerIds = new Set([
    ...installed.byId.keys(),
    ...enabled.byId.keys(),
    ...usage.byId.keys(),
  ]);
  for (const rawId of ledgerIds) {
    const id = resolveAlias(rawId);
    if (records.has(id)) {
      // Fold a renamed ledger key's usage onto the current entry.
      if (id !== rawId) {
        const rec = records.get(id);
        const use = usage.byId.get(rawId);
        if (use) rec.uses = (rec.uses || 0) + use.count;
        rec.aliases = [...(rec.aliases || []), rawId];
      }
      continue;
    }
    const { name, marketplace } = splitId(id);
    const inst = installed.byId.get(id) || null;
    const en = enabled.byId.get(id) || null;
    const use = usage.byId.get(id) || null;
    const dir = inst && isDir(inst.installPath) ? inst.installPath : null;
    // No catalog entry exists for these, so disk is the only possible source.
    const comps = mergeComponents(countComponents(dir), {
      skillCount: 0,
      skillPaths: [],
      lspServers: [],
    });
    records.set(id, {
      id,
      name,
      marketplace: marketplace || "(unknown)",
      display: name,
      desc: "",
      author: "",
      category: "unlisted",
      version: inst ? inst.version : "",
      url: "",
      sourceKind: "unlisted",
      sourceRef: "",
      tags: [],
      listed: false,
      installed: !!inst,
      install: inst,
      enabled: en ? en.enabled : null,
      enabledScope: en ? en.scope : null,
      state: !inst ? "none" : en && !en.enabled ? "disabled" : "active",
      uses: use ? use.count : null,
      lastUsedAt: use ? use.lastUsedAt : null,
      components: comps ? comps.counts : null,
      componentDir: comps ? comps.dir : null,
        componentsSource: comps ? comps.source : null,
        alwaysOnTokens: null,
        harnessOnly: false,
        costSource: comps && comps.descriptionChars !== null ? "proxy" : null,
      hookEvents: comps ? comps.hookEvents : [],
      mcpServers: comps ? comps.mcpServers : [],
      lspServers: comps ? comps.lspServers : [],
      descriptionChars: comps ? comps.descriptionChars : null,
      skillList: comps ? comps.skills : [],
    });
  }

  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/* ── `claude plugin details` enrichment ───────────────────────────────────── */

/**
 * The first-party CLI computes a real tokenizer-based always-on cost, which is
 * strictly better than counting description characters. Use it where we can.
 *
 * Two hard limits mean it CANNOT replace the disk walk:
 *   - it only knows *installed* plugins, and most of a catalog is not installed;
 *   - it under-reports MCP servers declared in `plugin.json` with no `.mcp.json`
 *     (it prints "MCP servers (0)" for sentry, which ships one). Component
 *     counts are therefore NOT merged — see applyCliDetails().
 * There is no --json flag, so this parses human-readable output defensively:
 * anything it fails to recognise degrades to null, never to a wrong number.
 */
function parsePluginDetails(text) {
  const INVENTORY = {
    Skills: "skills",
    Commands: "commands",
    Agents: "agents",
    Hooks: "hooks",
    "MCP servers": "mcp",
    "LSP servers": "lsp",
    "Output styles": "outputStyles",
  };
  const out = { alwaysOnTokens: null, counts: {}, all: {}, names: {}, harnessOnly: false };
  for (const line of text.split("\n")) {
    const inv = /^\s{2}([A-Za-z][A-Za-z ]*?) \((\d+)\)\s*(.*)$/.exec(line);
    if (inv && INVENTORY[inv[1]]) {
      const key = INVENTORY[inv[1]];
      const count = Number(inv[2]);
      out.all[key] = count;
      if (count > 0) out.counts[key] = count;
      const rest = inv[3].replace(/\([^)]*\)/g, "").trim();
      if (rest) out.names[key] = rest.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
      if (/harness-only/i.test(inv[3])) out.harnessOnly = true;
      continue;
    }
    const tok = /^\s*Always-on:\s*~?\s*([\d.,]+)\s*(k?)\s*tok/i.exec(line);
    if (tok) {
      const value = Number(tok[1].replace(/,/g, ""));
      if (Number.isFinite(value)) out.alwaysOnTokens = tok[2] ? value * 1000 : value;
    }
  }
  return out;
}

/** Is the `claude` CLI on PATH and runnable? */
async function claudeCliAvailable() {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 10000 }, (err, stdout) =>
      resolve(!err && /\d+\.\d+/.test(String(stdout)))
    );
  });
}

/** Fan out `claude plugin details` over the installed ids, bounded concurrency. */
async function collectCliDetails(ids, concurrency = 8) {
  const { execFile } = await import("node:child_process");
  const run = (id) =>
    new Promise((resolve) => {
      execFile(
        "claude",
        ["plugin", "details", id],
        { timeout: 25000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // A SIGTERM'd or maxBuffer-killed child still delivers partial stdout;
          // accepting it would store a truncated inventory as a success.
          if (err && (err.killed || err.code === "ETIMEDOUT" || /maxBuffer/i.test(err.message || ""))) {
            return resolve(null);
          }
          const text = String(stdout || "") + String(stderr || "");
          // The CLI exits 0 with a "not found" message for uninstalled plugins.
          if (!text.trim() || /not found/i.test(text)) return resolve(null);
          const parsed = parsePluginDetails(text);
          if (parsed.alwaysOnTokens === null && !Object.keys(parsed.all).length) {
            return resolve(null); // unrecognised output shape — do not guess
          }
          resolve(parsed);
        }
      );
    });

  const out = new Map();
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const parsed = await run(id);
      if (parsed) out.set(id, parsed);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Fold CLI results into the records — TOKEN COST ONLY.
 *
 * Deliberately does NOT merge component counts, because the two sources count
 * different things and a max/union produces numbers that are true of neither:
 *   - the CLI's "Skills" bucket includes slash commands (they are one surface in
 *     Claude Code 2.x), so `commit-commands` reads "Skills (3)" for 0 skills and
 *     3 commands. Merging that into a `skills` bucket double-counts commands.
 *   - the CLI reports 0 for MCP servers and agents declared in `plugin.json`
 *     rather than as files (sentry: 1 MCP server on disk, "MCP servers (0)" from
 *     the CLI; code-forge: 5 agents on disk, "Agents (0)").
 *   - the CLI's "Hooks" counts distinct events; the disk walk counts individual
 *     handlers (security-guidance: 4 events, 9 handlers).
 * So the disk walk stays the component inventory, the CLI supplies the cost, and
 * the CLI's raw inventory is kept alongside for transparency.
 */
function applyCliDetails(records, details) {
  for (const r of records) {
    const d = details.get(r.id);
    if (!d) continue;
    r.alwaysOnTokens = d.alwaysOnTokens;
    r.harnessOnly = d.harnessOnly;
    if (d.alwaysOnTokens !== null) r.costSource = "cli";
    r.cliInventory = d.all;
    // Names are additive-only: the CLI never invents a server that is not there.
    if (d.names.mcp && d.names.mcp.length) {
      r.mcpServers = [...new Set([...r.mcpServers, ...d.names.mcp])];
    }
    if (d.names.lsp && d.names.lsp.length) {
      r.lspServers = [...new Set([...r.lspServers, ...d.names.lsp])];
    }
  }
}

/* ── summary ──────────────────────────────────────────────────────────────── */

function summarize(records, marketplaces, warnings, meta) {
  const active = records.filter((r) => r.state === "active");
  const disabled = records.filter((r) => r.state === "disabled");

  // An unlisted ledger row with zero usage is noise (Claude Code writes a
  // zero-count `@inline` key for plugins it merely observed). Keep them out of
  // the catalog but account for them so the numbers still add up.
  const noiseRows = records.filter(
    (r) => !r.listed && !r.installed && (r.uses || 0) === 0
  );
  const catalog = records.filter((r) => !noiseRows.includes(r));

  const findings = {
    // Installed and switched on, but never invoked on this machine.
    neverInvoked: active
      .filter((r) => r.uses === 0)
      .map((r) => r.id)
      .sort(),
    // On disk, switched off — costs nothing at runtime, still costs disk.
    disabled: disabled.map((r) => r.id).sort(),
    // Usage without an install: it was installed once and later removed.
    removedButUsed: catalog
      .filter((r) => !r.installed && (r.uses || 0) > 0)
      .sort((a, b) => (b.uses || 0) - (a.uses || 0))
      .map((r) => ({ id: r.id, uses: r.uses })),
    // Plugin dirs we could not walk — counts are unknown, not zero.
    unknownComponents: catalog.filter((r) => r.components === null).length,
  };

  const perMarketplace = marketplaces.map((m) => {
    const rows = records.filter((r) => r.marketplace === m.name);
    return {
      name: m.name,
      owner: m.owner,
      provenance: m.provenance,
      lastUpdated: m.lastUpdated,
      autoUpdate: m.autoUpdate,
      listed: m.entries.length,
      active: rows.filter((r) => r.state === "active").length,
      disabled: rows.filter((r) => r.state === "disabled").length,
      notInstalled: rows.filter((r) => r.state === "none").length,
      broken: m.broken,
    };
  });

  const unlisted = catalog.filter((r) => !r.listed);
  if (unlisted.length) {
    perMarketplace.push({
      name: "(unlisted ledger keys)",
      owner: "",
      provenance: { kind: "ledger", ref: "" },
      lastUpdated: null,
      autoUpdate: false,
      listed: 0,
      active: unlisted.filter((r) => r.state === "active").length,
      disabled: unlisted.filter((r) => r.state === "disabled").length,
      notInstalled: unlisted.filter((r) => r.state === "none").length,
      broken: false,
    });
  }

  const alwaysOnChars = active.reduce((a, r) => a + (r.descriptionChars || 0), 0);
  const withTokens = active.filter((r) => Number.isFinite(r.alwaysOnTokens));
  const alwaysOnTokens = withTokens.reduce((a, r) => a + r.alwaysOnTokens, 0);
  const alwaysOnSkills = active.reduce(
    (a, r) => a + ((r.components && r.components.skills) || 0),
    0
  );

  return {
    meta: { ...meta, generatedAt: new Date().toISOString(), warnings },
    totals: {
      marketplaces: marketplaces.length,
      catalogEntries: catalog.length,
      listedEntries: catalog.filter((r) => r.listed).length,
      active: active.length,
      disabled: disabled.length,
      notInstalled: catalog.filter((r) => r.state === "none").length,
      unlistedLedgerKeys: unlisted.length,
      omittedZeroUsageLedgerKeys: noiseRows.length,
      alwaysOnSkills,
      alwaysOnDescriptionChars: alwaysOnChars,
      // Authoritative when the CLI answered; null when it did not run at all.
      alwaysOnTokens: withTokens.length ? alwaysOnTokens : null,
      alwaysOnTokensCoverage: withTokens.length,
      // A 0 here means "adds nothing to the prompt", NOT "does nothing":
      // hook-only and LSP plugins are harness-side and cost no context.
      zeroCostActive: active.filter((r) => r.alwaysOnTokens === 0).map((r) => r.id).sort(),
    },
    marketplaces: perMarketplace,
    findings,
    topUsed: catalog
      .filter((r) => (r.uses || 0) > 0)
      .sort((a, b) => (b.uses || 0) - (a.uses || 0))
      .slice(0, 15)
      .map((r) => ({ id: r.id, uses: r.uses, state: r.state })),
    // Ranked on tokens where available: agents cost far more per unit than
    // skills, so any ranking weighted by skill-description length is wrong.
    topContextCost: active
      .filter((r) => (r.alwaysOnTokens || 0) > 0 || (r.descriptionChars || 0) > 0)
      .sort((a, b) =>
        (b.alwaysOnTokens ?? -1) - (a.alwaysOnTokens ?? -1) ||
        (b.descriptionChars || 0) - (a.descriptionChars || 0))
      .slice(0, 15)
      .map((r) => ({
        id: r.id,
        alwaysOnTokens: r.alwaysOnTokens,
        descriptionChars: r.descriptionChars,
        costSource: r.costSource,
        skills: (r.components && r.components.skills) || 0,
        agents: (r.components && r.components.agents) || 0,
      })),
    plugins: catalog,
    omittedLedgerKeys: noiseRows.map((r) => r.id).sort(),
  };
}

/* ── HTML rendering ───────────────────────────────────────────────────────── */

/**
 * Serialize for embedding inside a <script> block. `</` must be broken up: the
 * HTML parser scans for `</script>` before any JS runs, so a description
 * containing one would close the tag early. `<\/` is a legal JSON escape for
 * `/`, so the payload stays valid JSON.
 */
function embeddable(value) {
  // Written with split/join rather than regex literals on purpose: a `/<\//g`
  // literal is valid JS but mis-tokenizes in several editor parsers, which
  // reported phantom "unterminated regular expression" errors on this function.
  return JSON.stringify(value)
    .split("<")
    .join("\\u003c")
    .split("\u2028")
    .join("\\u2028")
    .split("\u2029")
    .join("\\u2029");
}

function renderHtml(audit, outPath) {
  let template;
  try {
    template = fs.readFileSync(TEMPLATE, "utf8");
  } catch (err) {
    throw new Error(`Cannot read dashboard template at ${TEMPLATE}: ${err.message}`);
  }
  if (!template.includes("/*{{AUDIT}}*/")) {
    throw new Error(`Template ${TEMPLATE} is missing the /*{{AUDIT}}*/ placeholder.`);
  }
  const html = template.replace("/*{{AUDIT}}*/", () => embeddable(audit));
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), html, "utf8");
  return path.resolve(outPath);
}

/* ── text summary ─────────────────────────────────────────────────────────── */

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n || 0).toLocaleString("en-US");

function printSummary(audit) {
  const t = audit.totals;
  const L = [];
  L.push(`Claude Code plugin audit — ${audit.meta.generatedAt}`);
  L.push(`config dir: ${audit.meta.configDir}`);
  L.push(`project settings from: ${audit.meta.settingsLayers.join(", ") || "(none)"}`);
  L.push("");
  L.push(
    `${num(t.marketplaces)} marketplaces · ${num(t.catalogEntries)} catalog entries · ` +
      `${num(t.active)} active · ${num(t.disabled)} installed-but-disabled · ` +
      `${num(t.notInstalled)} not installed`
  );
  if (t.alwaysOnTokens !== null) {
    L.push(
      `always-on context: ~${num(t.alwaysOnTokens)} tokens added to every session ` +
        `(claude plugin details, ${t.alwaysOnTokensCoverage}/${t.active} active plugins measured)`
    );
    L.push(
      `  ${t.zeroCostActive.length} active plugins cost 0 always-on tokens — hook-only and LSP ` +
        `plugins are harness-side. 0 means "adds nothing to the prompt", not "does nothing".`
    );
  } else {
    L.push(
      `always-on context [${audit.meta.costSource}]: ${num(t.alwaysOnSkills)} skills from ` +
        `active plugins, ${num(t.alwaysOnDescriptionChars)} chars of skill descriptions per turn ` +
        `— a proxy that undercounts agents relative to skills`
    );
  }
  L.push("");
  L.push(`${pad("MARKETPLACE", 30)}${pad("LISTED", 8)}${pad("ACTIVE", 8)}${pad("OFF", 6)}${pad("NOT INST", 10)}SOURCE`);
  for (const m of audit.marketplaces) {
    L.push(
      pad(m.name, 30) +
        pad(m.listed ?? "-", 8) +
        pad(m.active, 8) +
        pad(m.disabled, 6) +
        pad(m.notInstalled, 10) +
        (m.provenance.ref || m.provenance.kind)
    );
  }
  L.push("");
  L.push("MOST-INVOKED (not comparable across plugin types — see below)");
  for (const r of audit.topUsed) L.push(`  ${pad(num(r.uses), 10)}${r.id}  [${r.state}]`);
  L.push("");
  L.push("HEAVIEST ALWAYS-ON CONTEXT COST (active only; agents cost more per unit than skills)");
  for (const r of audit.topContextCost) {
    const cost = Number.isFinite(r.alwaysOnTokens) ? `~${num(r.alwaysOnTokens)} tok` : `${num(r.descriptionChars)} ch`;
    L.push(`  ${pad(cost, 12)}${pad(`${r.skills} skills, ${r.agents} agents`, 22)}${r.id}`);
  }
  L.push("");
  L.push(`ACTIVE BUT NEVER INVOKED (${audit.findings.neverInvoked.length})`);
  L.push(`  ${audit.findings.neverInvoked.join(", ") || "(none)"}`);
  L.push("");
  L.push(`INSTALLED BUT DISABLED (${audit.findings.disabled.length})`);
  L.push(`  ${audit.findings.disabled.join(", ") || "(none)"}`);
  L.push("");
  L.push(`USED BUT NO LONGER INSTALLED (${audit.findings.removedButUsed.length})`);
  for (const r of audit.findings.removedButUsed) L.push(`  ${pad(num(r.uses), 10)}${r.id}`);
  L.push("");
  L.push(
    `component counts unknown (not on disk) for ${audit.findings.unknownComponents} entries — ` +
      `rendered as "—", never as zero`
  );
  if (t.omittedZeroUsageLedgerKeys) {
    L.push(
      `${t.omittedZeroUsageLedgerKeys} zero-usage ledger keys from unregistered sources omitted from the catalog`
    );
  }
  if (audit.meta.warnings.length) {
    L.push("");
    L.push("WARNINGS");
    for (const w of audit.meta.warnings) L.push(`  - ${w}`);
  }
  L.push("");
  L.push(
    "Caveat: invocation counts are NOT comparable across plugin types. A hook or LSP plugin " +
      "fires on every tool call; a slash command only when typed. A count on a plugin that is " +
      "not installed means it was installed once and later removed."
  );
  process.stdout.write(L.join("\n") + "\n");
}

/* ── entry point ──────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = {
    out: null,
    json: false,
    quiet: false,
    project: process.cwd(),
    help: false,
    cli: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") opts.out = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet" || a === "-q") opts.quiet = true;
    else if (a === "--project") opts.project = expandHome(argv[++i]);
    else if (a === "--no-cli") opts.cli = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a.startsWith("--project=")) opts.project = expandHome(a.slice(10));
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.out !== null && !opts.out) {
    throw new Error("--out requires a path");
  }
  if ("project" in opts && !opts.project) {
    throw new Error("--project requires a directory");
  }
  return opts;
}

const USAGE = `plugin-audit.mjs — audit local Claude Code plugins, emit an HTML dashboard

  --out <file>     write the self-contained HTML dashboard to <file>
  --json           print the full audit as JSON on stdout (implies --quiet)
  --project <dir>  project whose .claude/settings{,.local}.json to merge (default: cwd)
  --no-cli         skip \`claude plugin details\`; use the offline char-count proxy
  --quiet          suppress the text summary
  --help           this message

Reads only. Honours CLAUDE_CONFIG_DIR, defaulting to ~/.claude.
Token costs come from \`claude plugin details\` when the CLI is on PATH
(installed plugins only); otherwise a skill-description-length proxy is used.
`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const warnings = [];
  const configDir = resolveConfigDir();
  if (!isDir(configDir)) {
    warnings.push(
      `Claude config directory ${configDir} does not exist — nothing to audit. ` +
        `Set CLAUDE_CONFIG_DIR if it lives elsewhere.`
    );
  }

  const marketplaces = loadMarketplaces(configDir, warnings);
  const installed = loadInstalled(configDir, warnings);
  const enabled = loadEnabled(configDir, opts.project, warnings);
  const usage = loadUsage(configDir, warnings);

  const records = buildRecords({ marketplaces, installed, enabled, usage });

  // Enrich installed plugins with the first-party CLI's tokenizer-based cost.
  // Only installed plugins resolve, so this never covers the whole catalog.
  let costSource = "proxy";
  if (opts.cli && installed.byId.size) {
    if (await claudeCliAvailable()) {
      const details = await collectCliDetails([...installed.byId.keys()]);
      applyCliDetails(records, details);
      const measured = [...details.values()].filter((d) => d.alwaysOnTokens !== null).length;
      costSource = `claude plugin details (${measured}/${installed.byId.size} installed plugins)`;
      if (details.size && !measured) {
        warnings.push(
          "`claude plugin details` answered but reported no always-on figure; " +
            "using the skill-description-length proxy instead."
        );
      }
      if (measured < installed.byId.size) {
        warnings.push(
          `\`claude plugin details\` answered for ${measured} of ${installed.byId.size} ` +
            `installed plugins; the rest fall back to the skill-description-length proxy.`
        );
      }
    } else {
      warnings.push(
        "`claude` CLI not on PATH — token costs fall back to a skill-description-length proxy, " +
          "which undercounts agents relative to skills."
      );
    }
  } else if (!opts.cli) {
    costSource = "proxy (--no-cli)";
  }

  const audit = summarize(records, marketplaces, warnings, {
    configDir,
    projectDir: opts.project,
    marketplacesDir: path.join(configDir, "plugins", "marketplaces"),
    installedPluginsFile: installed.file,
    usageLedgerFile: usage.file,
    settingsLayers: enabled.layers.map((l) => `${l.scope}:${l.file}`),
    costSource,
    node: process.version,
    platform: process.platform,
  });

  if (opts.out) {
    const written = renderHtml(audit, opts.out);
    audit.meta.output = written;
    if (!opts.json && !opts.quiet) process.stdout.write(`dashboard: ${written}\n\n`);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(audit, null, 2) + "\n");
    return;
  }
  if (!opts.quiet) printSummary(audit);
}

main().catch((err) => {
  process.stderr.write(`plugin-audit failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
