#!/usr/bin/env node
// agtop - htop-style dashboard for AI coding agents
// Copyright (C) 2025  Loris Degioanni
//
// This program is free software; you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation; version 2 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, see <https://www.gnu.org/licenses/>.
/**
 * Estimate the token-based cost of local Codex and Claude Code sessions.
 *
 * The script reads recent session metadata from:
 * - ~/.codex/sessions
 * - ~/.claude/projects
 *
 * It presents a single combined session picker and computes an estimated cost
 * using built-in pricing tables for the detected models.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
  createReadStream,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  rmSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, basename, dirname, sep } from "node:path";
import { homedir, cpus } from "node:os";
import { spawn, execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = homedir();
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CODEX_SESSIONS_ROOT = join(HOME, ".codex", "sessions");
const CLAUDE_PROJECTS_ROOT = join(CLAUDE_CONFIG_DIR, "projects");
const UUID_RE = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const FULL_UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SESSION_DATA_CACHE = new Map();
const COST_CACHE_DIR = join(HOME, ".cache", "agtop");
const COST_CACHE_FILE = join(COST_CACHE_DIR, "cost-cache.json");
const PRICING_CACHE_FILE = join(COST_CACHE_DIR, "litellm-pricing.json");
const UI_PREFS_FILE = join(COST_CACHE_DIR, "ui-prefs.json");
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Pricing tables
// ---------------------------------------------------------------------------

const CODEX_PRICING = {
  "gpt-5.3-codex": {
    input_per_million: 1.75,
    cached_input_per_million: 0.175,
    output_per_million: 14.0,
  },
  "codex-mini-latest": {
    input_per_million: 1.5,
    cached_input_per_million: 0.375,
    output_per_million: 6.0,
  },
};

const CLAUDE_PRICING = {
  "claude-opus-4-7": {
    input_per_million: 5.0,
    cache_write_5m_per_million: 6.25,
    cache_write_1h_per_million: 10.0,
    cache_read_per_million: 0.5,
    output_per_million: 25.0,
  },
  "claude-opus-4-6": {
    input_per_million: 5.0,
    cache_write_5m_per_million: 6.25,
    cache_write_1h_per_million: 10.0,
    cache_read_per_million: 0.5,
    output_per_million: 25.0,
  },
  "claude-opus-4-5-20251101": {
    input_per_million: 5.0,
    cache_write_5m_per_million: 6.25,
    cache_write_1h_per_million: 10.0,
    cache_read_per_million: 0.5,
    output_per_million: 25.0,
  },
  "claude-sonnet-4-6": {
    input_per_million: 3.0,
    cache_write_5m_per_million: 3.75,
    cache_write_1h_per_million: 6.0,
    cache_read_per_million: 0.3,
    output_per_million: 15.0,
  },
  "claude-sonnet-4-5-20250929": {
    input_per_million: 3.0,
    cache_write_5m_per_million: 3.75,
    cache_write_1h_per_million: 6.0,
    cache_read_per_million: 0.3,
    output_per_million: 15.0,
  },
  "claude-haiku-4-5-20251001": {
    input_per_million: 1.0,
    cache_write_5m_per_million: 1.25,
    cache_write_1h_per_million: 2.0,
    cache_read_per_million: 0.1,
    output_per_million: 5.0,
  },
};

// ---------------------------------------------------------------------------
// Plan tables
// ---------------------------------------------------------------------------

const PLAN_ALIASES = {
  retail: "retail",
  default: "retail",
  max: "max",
  "claude-max": "max",
  included: "included",
  enterprise: "included",
  "not-billed": "included",
};

const PLAN_CHOICES = {
  codex: [
    ["retail", "API"],
    ["plus", "ChatGPT Plus"],
    ["pro", "ChatGPT Pro"],
    ["business", "ChatGPT Business (flex pricing)"],
    ["enterprise_edu", "ChatGPT Enterprise / Edu (flex pricing)"],
    ["included", "Not Billed"],
  ],
  claude: [
    ["retail", "API / Usage-based"],
    ["claude_pro", "Claude Pro"],
    ["max5", "Claude Max 5x"],
    ["max20", "Claude Max 20x"],
    ["team", "Claude Team"],
    ["enterprise_contract", "Claude Enterprise"],
    ["included", "Not Billed"],
  ],
};

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class SessionCostError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseCliArgs() {
  const args = process.argv.slice(2);
  let listSessions = false;
  let json = false;
  let plan = "retail";
  let delay = 2;
  let help = false;

  const takeValue = (i, flag) => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      process.stderr.write(`error: ${flag} requires a value\n`);
      process.exit(1);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-l" || arg === "--list") {
      listSessions = true;
    } else if (arg === "-j" || arg === "--json") {
      json = true;
    } else if (arg === "-p" || arg === "--plan") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        plan = "select";
      } else {
        plan = next;
        i++;
      }
    } else if (arg.startsWith("--plan=")) {
      plan = arg.slice("--plan=".length) || "select";
    } else if (arg === "-d" || arg === "--delay") {
      const value = takeValue(i, arg);
      delay = parseFloat(value);
      if (Number.isNaN(delay) || delay < 1) {
        process.stderr.write("error: --delay must be a number >= 1 (seconds)\n");
        process.exit(1);
      }
      i++;
    } else if (arg.startsWith("--delay=")) {
      delay = parseFloat(arg.slice("--delay=".length));
      if (Number.isNaN(delay) || delay < 1) {
        process.stderr.write("error: --delay must be a number >= 1 (seconds)\n");
        process.exit(1);
      }
    } else {
      process.stderr.write(`error: unknown option '${arg}'\n`);
      process.exit(1);
    }
  }

  if (help) {
    process.stdout.write(
      `agtop — an htop-like monitor for AI coding agent sessions

Tracks Claude Code and Codex sessions running on your machine, showing
real-time cost estimation, token usage, tool invocations, and OS-level metrics.

OPTIONS
  -l, --list             List sessions in a table and exit
  -j, --json             Dump full session data as JSON and exit
  -p, --plan <plan>      Billing plan for cost display (default: retail)
                           retail    Standard API pricing
                           max       Claude Max (Claude usage = included)
                           included  All usage marked as included
  -d, --delay <secs>     Refresh interval in seconds (default: 2)
  -h, --help             Show this help

KEYBOARD SHORTCUTS (interactive mode)
  j/k, arrows            Navigate sessions
  Enter                  Open detail view
  Tab                    Cycle bottom panel tabs (Info/Performance/Processes/Tool/Cost/Config)
  \`                      Toggle Sessions/Live Sessions list view
  1-6                    Jump to Info/Performance/Processes/Tool Activity/Cost/Config panel
  F3 or /                Filter sessions by text
  F6 or >                Sort-by panel
  F7                     Filter sessions by age (1d / 1w / 1mo)
  F5 or r                Force refresh
  d                      Delete selected session (non-running only, with confirmation)
  q or F10               Quit

MOUSE
  Click session rows, column headers, tabs, and menu bar items.
  Hover over column headers for descriptions.

COST ESTIMATION
  Cost figures are estimates based on per-token API pricing from the LiteLLM
  database (cached locally for 24 hours). Many subscription plans — such as
  Claude Max, Pro, or Team — charge a flat rate or bundle tokens differently,
  so reported costs may not reflect your actual bill. Use the $ column as a
  rough indicator of resource consumption, not as an authoritative invoice.

NOTES
  Session data is read from ~/.claude/projects/ and ~/.codex/sessions/.
  UI preferences (active tab, sort order, filters) persist across runs.
`
    );
    process.exit(0);
  }

  if (plan !== "select") {
    const normalized = PLAN_ALIASES[plan.toLowerCase()];
    if (normalized === undefined) {
      process.stderr.write(
        `error: unsupported plan '${plan}'; use one of: ${Object.keys(PLAN_ALIASES).sort().join(", ")}\n`
      );
      process.exit(1);
    }
    plan = normalized;
  }

  return {
    listSessions,
    json,
    plan,
    delay,
  };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function forEachJsonl(filePath, callback) {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  try {
    for await (const raw of rl) {
      lineNum++;
      // Yield to the event loop every 1000 lines so UI input isn't blocked
      // by large transcript files during background refresh.
      if (lineNum % 1000 === 0) await new Promise(r => setImmediate(r));
      // Skip lines >512KB — these are almost always base64 image payloads
      // and contain no token/cost/tool data worth extracting.
      if (raw.length > 524_288) continue;
      const line = raw.trim();
      if (!line) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue; // skip corrupted/truncated lines (e.g. null-byte padding)
      }
      callback(item);
    }
  } catch (err) {
    if (err instanceof SessionCostError) throw err;
    throw new SessionCostError(`Unable to read ${filePath}: ${err.message}`);
  }
}

function dirExists(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Recursively find all .jsonl files under a directory. */
function rglob(dir, pattern = /\.jsonl$/) {
  const results = [];
  const walk = (d) => {
    for (const entry of listDir(d)) {
      const full = join(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && pattern.test(entry)) results.push(full);
      } catch {
        /* skip inaccessible */
      }
    }
  };
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function money(value) {
  return value.toFixed(6);
}

function usd(value) {
  return `$${value}`;
}

function compactUsd(value) {
  if (value === null || value === undefined) return "n/a";
  if (value === "included") return "incl";
  return `$${parseFloat(value).toFixed(2)}`;
}

/** Local-time date key "YYYY-MM-DD" for a Date object */
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
/** Local-time hour key "YYYY-MM-DDTHH" for a Date object */
function localHourKey(d) {
  return `${localDateKey(d)}T${String(d.getHours()).padStart(2,'0')}`;
}

function compactTokens(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function compactBytes(value) {
  if (value === null || value === undefined || value === 0) return "";
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}G`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}M`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)}K`;
  return `${value}B`;
}

function fitText(value, width) {
  const text = value || "unknown";
  if (text.length <= width) return text.padEnd(width);
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

function clipLine(text, width) {
  if (width <= 0 || text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return text.slice(0, width - 3) + "...";
}

function displayWidth() {
  return Math.max(60, process.stdout.columns || 100);
}

function tokenCost(tokens, ratePerMillion) {
  return (tokens * ratePerMillion) / 1_000_000;
}

function numberWithCommas(n) {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

function parseTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function relativeAge(value, now) {
  const parsed = parseTimestamp(value);
  if (!parsed) return "n/a";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo`;
  return `${Math.floor(seconds / 31536000)}y`;
}

// ---------------------------------------------------------------------------
// Path abbreviation
// ---------------------------------------------------------------------------

function pathParts(value) {
  if (!value) return [];
  return value
    .split(sep === "\\" ? /[\\/]/ : "/")
    .filter((p) => p && p !== "/");
}

function abbreviatePaths(values) {
  // Strip HOME prefix before splitting into parts
  const homeParts = pathParts(HOME);
  const partsList = values.map((v) => {
    const parts = pathParts(v);
    // Remove leading HOME components if they match
    if (parts.length >= homeParts.length &&
        homeParts.every((hp, i) => parts[i] === hp)) {
      const rest = parts.slice(homeParts.length);
      return rest.length ? rest : ["~"];
    }
    return parts;
  });

  // Start with just the leaf name (width=1), expand only on collision
  const widths = partsList.map((p) => (p.length ? 1 : 0));

  while (true) {
    let changed = false;
    const groups = {};
    for (let i = 0; i < partsList.length; i++) {
      const parts = partsList[i];
      if (!parts.length) continue;
      const label = parts.slice(-widths[i]).join("/");
      if (!groups[label]) groups[label] = [];
      groups[label].push(i);
    }
    for (const indices of Object.values(groups)) {
      if (indices.length < 2) continue;
      for (const idx of indices) {
        if (widths[idx] < partsList[idx].length) {
          widths[idx]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return partsList.map((parts, i) =>
    parts.length ? parts.slice(-widths[i]).join("/") : "unknown"
  );
}

// ---------------------------------------------------------------------------
// Codex sessions
// ---------------------------------------------------------------------------

// Cache for static Codex session metadata (id, startedAt, model, cwd).
const _codexStaticCache = new Map(); // filePath → { sessionId, startedAt, model, cwd }

function summarizeCodexSession(filePath) {
  // Static fields: read once and cache forever.
  let staticParts = _codexStaticCache.get(filePath);
  if (!staticParts) {
    let sessionId = null;
    let startedAt = null;
    let model = null;
    let cwd = null;

    const m = UUID_RE.exec(basename(filePath, ".jsonl"));
    if (m) sessionId = m[1];

    for (const item of readFirstLines(filePath, 50)) {
      const type = item.type;
      const payload = item.payload || {};
      if (type === "session_meta") {
        sessionId = payload.id || sessionId;
        startedAt = payload.timestamp || item.timestamp || startedAt;
        cwd = payload.cwd || cwd;
      } else if (type === "turn_context") {
        model = payload.model || model;
      }
      if (sessionId && startedAt && model && cwd) break;
    }
    staticParts = { sessionId, startedAt, model, cwd };
    if (sessionId) _codexStaticCache.set(filePath, staticParts);
  }

  // Dynamic field: lastActive from mtime — cheap stat, no file read.
  const mt = fileMtime(filePath);
  const lastActive = mt ? mt.toISOString() : staticParts.startedAt;

  return {
    provider: "codex",
    session_id: staticParts.sessionId,
    started_at: staticParts.startedAt,
    last_active: lastActive,
    model: staticParts.model,
    label_source: staticParts.cwd,
    data_file: filePath,
  };
}

function listCodexSessions() {
  if (!dirExists(CODEX_SESSIONS_ROOT)) return [];
  const sessions = [];
  for (const filePath of rglob(CODEX_SESSIONS_ROOT).sort().reverse()) {
    try {
      sessions.push(summarizeCodexSession(filePath));
    } catch (err) {
      if (err instanceof SessionCostError) continue;
      throw err;
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Claude sessions
// ---------------------------------------------------------------------------

function claudeTranscriptFiles(transcriptPath) {
  const files = [transcriptPath];
  const stem = transcriptPath.replace(/\.jsonl$/, "");
  const subagentsDir = join(stem, "subagents");
  if (dirExists(subagentsDir)) {
    for (const entry of listDir(subagentsDir).sort()) {
      if (entry.endsWith(".jsonl")) {
        files.push(join(subagentsDir, entry));
      }
    }
  }
  return files;
}

function formatTimestampForSession(d) {
  return d
    ? d.toISOString().replace(/\.\d{3}Z$/, ".000000Z").replace(/\.000000Z$/, "Z")
    : null;
}

function readFirstLines(filePath, maxLines) {
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const items = [];
  let start = 0;
  let count = 0;
  while (count < maxLines && start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.substring(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
    count++;
  }
  return items;
}

// Read the last N non-empty JSONL lines from a file, parsing each as JSON.
// Reads incrementally from the end so it's cheap even on huge files.
function readLastLines(filePath, maxLines) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const chunkSize = 64 * 1024;
    let pos = size;
    let buf = "";
    let items = [];
    while (pos > 0 && items.length < maxLines) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      readSync(fd, chunk, 0, readSize, pos);
      buf = chunk.toString("utf-8") + buf;
      const lines = buf.split("\n");
      // Keep the first (potentially partial) line in buf for next iteration
      buf = pos > 0 ? lines.shift() : "";
      // Walk from the end backwards
      for (let i = lines.length - 1; i >= 0 && items.length < maxLines; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          items.push(JSON.parse(line));
        } catch {
          /* skip malformed */
        }
      }
    }
    return items; // newest-first order
  } finally {
    try { closeSync(fd); } catch {}
  }
}

function fileMtime(filePath) {
  try {
    return statSync(filePath).mtime;
  } catch {
    return null;
  }
}

// Cache for the static parts of a session summary (model, cwd, startedAt).
// These are set in the first few lines and never change, so we only read once.
const _sessionStaticCache = new Map(); // transcriptPath → { model, cwd, startedAt }

function collectClaudeSessionSummary(transcriptPath) {
  // Static fields that genuinely never change: model, cwd, startedAt.
  let staticParts = _sessionStaticCache.get(transcriptPath);
  let aiTitleFromHead = null;
  if (!staticParts) {
    let earliest = null;
    let model = null;
    let cwd = null;
    for (const item of readFirstLines(transcriptPath, 50)) {
      const parsed = parseTimestamp(item.timestamp);
      if (parsed && (!earliest || parsed < earliest)) earliest = parsed;
      if (!cwd && item.cwd) cwd = item.cwd;
      if (!model && item.type === "assistant") {
        const candidate = (item.message || {}).model;
        if (candidate && candidate !== "<synthetic>") model = candidate;
      }
      if (item.type === "ai-title" && typeof item.aiTitle === "string") aiTitleFromHead = item.aiTitle;
    }
    staticParts = { model, cwd, startedAt: formatTimestampForSession(earliest), aiTitle: aiTitleFromHead };
    if (model) _sessionStaticCache.set(transcriptPath, staticParts); // only cache once we have a model
  }
  // custom-title (via /rename) is usually set late in a session, so scan the
  // last lines on every call. Cheap: reads chunks backwards from EOF.
  let customTitle = null;
  for (const item of readLastLines(transcriptPath, 200)) {
    if (item.type === "custom-title" && typeof item.customTitle === "string") {
      customTitle = item.customTitle;
      break;
    }
  }

  // Dynamic field: lastActive is just mtime — cheap stat, no file read.
  let latest = fileMtime(transcriptPath);
  for (const filePath of claudeTranscriptFiles(transcriptPath).slice(1)) {
    const mt = fileMtime(filePath);
    if (mt && (!latest || mt > latest)) latest = mt;
  }

  return {
    ...staticParts,
    customTitle,
    lastActive: latest ? formatTimestampForSession(latest) : null,
  };
}

function summarizeClaudeSession(transcriptPath) {
  const sessionId = basename(transcriptPath, ".jsonl");
  const summary = collectClaudeSessionSummary(transcriptPath);
  return {
    provider: "claude",
    session_id: sessionId,
    started_at: summary.startedAt,
    last_active: summary.lastActive || summary.startedAt,
    model: summary.model,
    label_source: summary.cwd,
    data_file: transcriptPath,
    title: summary.customTitle || summary.aiTitle || null,
  };
}

function listClaudeSessions() {
  if (!dirExists(CLAUDE_PROJECTS_ROOT)) return [];
  const sessions = [];
  for (const projectName of listDir(CLAUDE_PROJECTS_ROOT)) {
    const projectDir = join(CLAUDE_PROJECTS_ROOT, projectName);
    if (!dirExists(projectDir)) continue;
    for (const entry of listDir(projectDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const stem = entry.replace(/\.jsonl$/, "");
      if (!FULL_UUID_RE.test(stem)) continue;
      try {
        const s = summarizeClaudeSession(join(projectDir, entry));
        if (!s.model) continue; // skip empty/abandoned sessions
        sessions.push(s);
      } catch (err) {
        if (err instanceof SessionCostError) continue;
        throw err;
      }
    }
  }
  sessions.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
  return sessions;
}

function listAllSessions() {
  return [listCodexSessions(), listClaudeSessions()];
}

// ---------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------

function planMode(plan, provider) {
  if (provider === "codex") {
    if (["plus", "pro", "included"].includes(plan)) return "included";
    return "retail";
  }
  if (provider === "claude") {
    if (["claude_pro", "max", "max5", "max20", "included"].includes(plan))
      return "included";
    return "retail";
  }
  return "retail";
}

function planIncludesProvider(plan, provider) {
  return planMode(plan, provider) === "included";
}

function resolveProviderPlans(plan) {
  if (plan === "retail") return ["retail", "retail"];
  if (plan === "max") return ["retail", "max"];
  if (plan === "included") return ["included", "included"];
  throw new SessionCostError(`Unsupported plan mode: ${plan}`);
}

function applyCurrentDirectoryOverride(sessions) {
  if (!sessions.length) return;
  const cwd = process.cwd();
  for (const s of sessions) {
    if (s.provider === "codex") {
      s.label_source = cwd;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

function emptyMetrics() {
  return {
    tool_count: 0, tools: {},
    tool_details: {}, // {toolName: [detail, ...]} — per-tool invocation details
    mcp_tool_count: 0, mcp_tools: [],
    skill_count: 0, skills: {},
    web_fetch_count: 0, web_fetches: [],
    web_search_count: 0, web_searches: [],
    lines_added: 0, lines_removed: 0,
    api_duration_ms: 0,
  };
}

/** Extract display (truncated) and full clipboard strings from a tool invocation's input.
 *  Returns { short, full } where short is for panel display and full is for clipboard. */
function extractToolDetail(name, input) {
  if (!input) return { short: "", full: "" };
  if (name === "Bash") {
    const cmd = input.command || "";
    return { short: cmd.split("\n")[0].slice(0, 200), full: cmd };
  }
  if (name === "Agent") {
    const p = input.prompt || "";
    return { short: p.split("\n")[0].slice(0, 120), full: p };
  }
  if (name === "TaskCreate") {
    const d = input.description || "";
    return { short: d.split("\n")[0].slice(0, 120), full: d };
  }
  let s = "";
  if (name === "Read") s = input.file_path || "";
  else if (name === "Edit") s = input.file_path || "";
  else if (name === "Write") s = input.file_path || "";
  else if (name === "Grep") s = (input.pattern || "") + (input.path ? ` in ${input.path}` : "");
  else if (name === "Glob") s = input.pattern || "";
  else if (name === "WebFetch") s = input.url || "";
  else if (name === "WebSearch") s = input.query || "";
  else if (name === "ToolSearch") s = input.query || "";
  else if (name === "TaskUpdate") s = input.task_id ? `#${input.task_id} ${input.status || ""}`.trim() : "";
  else if (name === "TaskGet" || name === "TaskStop" || name === "TaskOutput") s = input.task_id ? `#${input.task_id}` : "";
  else if (name === "TaskList") s = "(list)";
  else if (name === "write_stdin") {
    const raw = input.input || input.stdin || "";
    s = raw.split(/[\r\n]/)[0].slice(0, 200);
  } else if (typeof input === "object") {
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.length > 0) { s = v.split(/[\r\n]/)[0].slice(0, 120); break; }
    }
  }
  return { short: s, full: s };
}

const MAX_TOOL_DETAILS = 200; // max invocation details per tool

function safeMetrics(data) {
  return (data && data.metrics) || emptyMetrics();
}

// ---------------------------------------------------------------------------
// Session config extraction
// ---------------------------------------------------------------------------

/** Read a file safely, returning its content or null. */
function safeReadFile(p, maxBytes) {
  try {
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (!st.isFile()) return null;
    const bytes = maxBytes || 32768;
    if (st.size <= bytes) return readFileSync(p, "utf-8");
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, 0);
    closeSync(fd);
    return buf.toString("utf-8");
  } catch { return null; }
}

/** Parse a TOML-like config.toml into a flat key/value map (simple parser). */
function parseSimpleToml(text) {
  const result = {};
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) { section = secMatch[1]; continue; }
    const kvMatch = line.match(/^(\w[\w.-]*)?\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = section ? `${section}.${kvMatch[1]}` : kvMatch[1];
      let val = kvMatch[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      result[key] = val;
    }
  }
  return result;
}

/** Wrap a plain-text line to fit within maxW visible columns. ANSI codes are preserved. */
function wrapLine(text, maxW) {
  if (maxW <= 0) return [text];
  const result = [];
  let vis = 0, start = 0, lastBreak = -1, lastBreakVis = -1;
  let inEsc = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") { inEsc = true; continue; }
    if (inEsc) { if ((text[i] >= "A" && text[i] <= "Z") || (text[i] >= "a" && text[i] <= "z")) inEsc = false; continue; }
    if (text[i] === " " || text[i] === "-") { lastBreak = i; lastBreakVis = vis; }
    vis++;
    if (vis >= maxW) {
      if (lastBreak > start) {
        result.push(text.slice(start, lastBreak + 1) + "\x1b[0m");
        start = lastBreak + 1;
        vis = vis - lastBreakVis - 1;
      } else {
        result.push(text.slice(start, i + 1) + "\x1b[0m");
        start = i + 1;
        vis = 0;
      }
      lastBreak = -1; lastBreakVis = -1;
    }
  }
  if (start < text.length) result.push(text.slice(start));
  else if (result.length === 0) result.push("");
  return result;
}

/** Helper: format a "not found" line for a config file. */
function notFoundLine(text) {
  return `\x1b[38;5;238m${text}\x1b[0m`;
}

/** Sanitize a line for terminal display: replace tabs, strip \r and other control chars. */
function sanitizeLine(line) {
  return line.replace(/\t/g, "    ").replace(/\r/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1a]/g, "");
}

/** Helper: read and format a config file's content into lines, with header. */
function formatConfigFile(filePath, displayPath, maxLines) {
  const content = safeReadFile(filePath);
  if (!content) return null;
  const lines = [];
  lines.push(`\x1b[1;38;5;75m${displayPath}\x1b[0m`);
  const srcLines = content.split("\n");
  const limit = maxLines || 50;
  for (const l of srcLines.slice(0, limit)) lines.push("  " + sanitizeLine(l));
  if (srcLines.length > limit) lines.push("  \x1b[38;5;245m... (truncated)\x1b[0m");
  lines.push("");
  return lines;
}

/** Extract config info for a Claude session. */
function extractClaudeConfig(session) {
  const sections = []; // [{label, lines, copyPath}]

  const projectName = session.data_file
    ? basename(dirname(session.data_file))
    : null;
  const projectMemDir = projectName
    ? join(CLAUDE_CONFIG_DIR, "projects", projectName, "memory")
    : null;
  const cwd = session.label_source || "";

  // 1. CLAUDE.md files
  const claudeMdLines = [];
  const globalCmPath = join(CLAUDE_CONFIG_DIR, "CLAUDE.md");
  const globalCmBlock = formatConfigFile(globalCmPath, CLAUDE_CONFIG_DIR + "/CLAUDE.md");
  if (globalCmBlock) claudeMdLines.push(...globalCmBlock);
  else claudeMdLines.push(notFoundLine(CLAUDE_CONFIG_DIR + "/CLAUDE.md not found"));

  if (cwd) {
    const projCmPath = join(cwd, "CLAUDE.md");
    const projCmBlock = formatConfigFile(projCmPath, cwd + "/CLAUDE.md");
    if (projCmBlock) claudeMdLines.push(...projCmBlock);
    else claudeMdLines.push(notFoundLine("CLAUDE.md not found"));

    const rulesDir = join(cwd, ".claude", "rules");
    if (dirExists(rulesDir)) {
      for (const f of listDir(rulesDir)) {
        if (!f.endsWith(".md")) continue;
        const block = formatConfigFile(join(rulesDir, f), `.claude/rules/${f}`);
        if (block) claudeMdLines.push(...block);
      }
    }
  }
  // Primary copy path: project CLAUDE.md if it exists, else global
  const instrCopyPath = cwd ? join(cwd, "CLAUDE.md") : globalCmPath;
  sections.push({ label: "Instructions", lines: claudeMdLines, copyPath: instrCopyPath });

  // 2. Auto-memories
  const memLines = [];
  const memCopyPath = projectMemDir || "";
  if (projectMemDir && dirExists(projectMemDir)) {
    for (const f of listDir(projectMemDir)) {
      if (!f.endsWith(".md")) continue;
      const block = formatConfigFile(join(projectMemDir, f), f, 40);
      if (block) memLines.push(...block);
    }
  }
  if (memLines.length === 0) memLines.push(notFoundLine("No memory files found"));
  sections.push({ label: "Memory", lines: memLines, copyPath: memCopyPath });

  // 3. Skills
  const skillLines = [];
  const skillsDirPath = join(CLAUDE_CONFIG_DIR, "skills");
  if (dirExists(skillsDirPath)) {
    for (const d of listDir(skillsDirPath)) {
      const skillMd = safeReadFile(join(skillsDirPath, d, "SKILL.md"), 4096);
      if (skillMd) {
        const nameMatch = skillMd.match(/name:\s*(.+)/i);
        const descMatch = skillMd.match(/description:\s*(.+)/i);
        const name = nameMatch ? nameMatch[1].trim() : d;
        const desc = descMatch ? descMatch[1].trim() : "";
        skillLines.push(`\x1b[38;5;114m${name}\x1b[0m` + (desc ? `  \x1b[38;5;245m${desc}\x1b[0m` : ""));
      } else {
        skillLines.push(`\x1b[38;5;114m${d}\x1b[0m`);
      }
    }
  }
  if (skillLines.length === 0) skillLines.push(notFoundLine(`No skills installed (${CLAUDE_CONFIG_DIR}/skills/)`));
  sections.push({ label: "Skills", lines: skillLines, copyPath: skillsDirPath });

  // 4. MCP Servers
  const mcpLines = [];
  const settingsPath = join(CLAUDE_CONFIG_DIR, "settings.json");
  const settingsContent = safeReadFile(settingsPath);
  if (settingsContent) {
    try {
      const settings = JSON.parse(settingsContent);
      if (settings.mcpServers) {
        for (const [name, cfg] of Object.entries(settings.mcpServers)) {
          mcpLines.push(`\x1b[38;5;180m${name}\x1b[0m  \x1b[38;5;245m(global)\x1b[0m`);
          if (cfg.command) mcpLines.push(`  command: ${cfg.command}`);
        }
      }
    } catch {}
  }
  let mcpCopyPath = settingsPath;
  if (cwd) {
    const mcpJsonPath = join(cwd, ".mcp.json");
    const mcpJson = safeReadFile(mcpJsonPath);
    if (mcpJson) {
      mcpCopyPath = mcpJsonPath;
      try {
        const mcp = JSON.parse(mcpJson);
        const servers = mcp.mcpServers || mcp;
        for (const [name, cfg] of Object.entries(servers)) {
          if (typeof cfg !== "object") continue;
          mcpLines.push(`\x1b[38;5;180m${name}\x1b[0m  \x1b[38;5;245m(project)\x1b[0m`);
          if (cfg.command) mcpLines.push(`  command: ${cfg.command}`);
        }
      } catch {}
    }
  }
  if (mcpLines.length === 0) mcpLines.push(notFoundLine("No MCP servers configured"));
  sections.push({ label: "MCP", lines: mcpLines, copyPath: mcpCopyPath });

  // 5. Permissions
  const permLines = [];
  const permFiles = [
    { path: join(CLAUDE_CONFIG_DIR, "settings.json"), label: "global" },
  ];
  if (cwd) {
    permFiles.push({ path: join(cwd, ".claude", "settings.json"), label: "project" });
    permFiles.push({ path: join(cwd, ".claude", "settings.local.json"), label: "local" });
  }
  for (const pf of permFiles) {
    const pc = safeReadFile(pf.path);
    if (!pc) continue;
    try {
      const ps = JSON.parse(pc);
      const perms = ps.permissions;
      if (!perms) continue;
      if (perms.allow && perms.allow.length)
        permLines.push(`\x1b[38;5;114mallow\x1b[0m \x1b[38;5;245m(${pf.label})\x1b[0m: ${perms.allow.join(", ")}`);
      if (perms.deny && perms.deny.length)
        permLines.push(`\x1b[38;5;167mdenied\x1b[0m \x1b[38;5;245m(${pf.label})\x1b[0m: ${perms.deny.join(", ")}`);
      if (perms.ask && perms.ask.length)
        permLines.push(`\x1b[38;5;180mask\x1b[0m \x1b[38;5;245m(${pf.label})\x1b[0m: ${perms.ask.join(", ")}`);
    } catch {}
  }
  if (permLines.length === 0) permLines.push(`\x1b[38;5;238mNo permission rules configured\x1b[0m`);
  sections.push({ label: "Permissions", lines: permLines, copyPath: settingsPath });

  return sections;
}

/** Extract config info for a Codex session. */
function extractCodexConfig(session) {
  const sections = [];
  const cwd = session.label_source || "";

  // 1. AGENTS.md files
  const agentsLines = [];
  const globalAmPath = join(HOME, ".codex", "AGENTS.md");
  const globalAmBlock = formatConfigFile(join(HOME, ".codex", "AGENTS.override.md"), "~/.codex/AGENTS.override.md")
    || formatConfigFile(globalAmPath, "~/.codex/AGENTS.md");
  if (globalAmBlock) agentsLines.push(...globalAmBlock);
  else agentsLines.push(notFoundLine("~/.codex/AGENTS.md not found"));

  if (cwd) {
    const projAmBlock = formatConfigFile(join(cwd, "AGENTS.override.md"), "AGENTS.override.md")
      || formatConfigFile(join(cwd, "AGENTS.md"), "AGENTS.md");
    if (projAmBlock) agentsLines.push(...projAmBlock);
    else agentsLines.push(notFoundLine("AGENTS.md not found"));
  }
  const instrCopyPath = cwd ? join(cwd, "AGENTS.md") : globalAmPath;
  sections.push({ label: "Instructions", lines: agentsLines, copyPath: instrCopyPath });

  // 2. config.toml
  const configLines = [];
  const globalTomlPath = join(HOME, ".codex", "config.toml");
  const globalToml = safeReadFile(globalTomlPath);
  const globalTomlBlock = formatConfigFile(globalTomlPath, "~/.codex/config.toml", 30);
  if (globalTomlBlock) configLines.push(...globalTomlBlock);
  else configLines.push(notFoundLine("~/.codex/config.toml not found"));

  if (cwd) {
    const projTomlPath = join(cwd, ".codex", "config.toml");
    const projTomlBlock = formatConfigFile(projTomlPath, ".codex/config.toml", 30);
    if (projTomlBlock) configLines.push(...projTomlBlock);
  }
  sections.push({ label: "Config", lines: configLines, copyPath: globalTomlPath });

  // 3. Skills
  const skillLines = [];
  const skillsDirPath = join(HOME, ".codex", "skills");
  if (dirExists(skillsDirPath)) {
    for (const d of listDir(skillsDirPath)) {
      const skillMd = safeReadFile(join(skillsDirPath, d, "SKILL.md"), 4096);
      if (skillMd) {
        const nameMatch = skillMd.match(/name:\s*(.+)/i);
        const descMatch = skillMd.match(/description:\s*(.+)/i);
        const name = nameMatch ? nameMatch[1].trim() : d;
        const desc = descMatch ? descMatch[1].trim() : "";
        skillLines.push(`\x1b[38;5;114m${name}\x1b[0m` + (desc ? `  \x1b[38;5;245m${desc}\x1b[0m` : ""));
      } else {
        skillLines.push(`\x1b[38;5;114m${d}\x1b[0m`);
      }
    }
  }
  if (skillLines.length === 0) skillLines.push(notFoundLine("No skills installed (~/.codex/skills/)"));
  sections.push({ label: "Skills", lines: skillLines, copyPath: skillsDirPath });

  // 4. MCP Servers (from config.toml)
  const mcpLines = [];
  if (globalToml) {
    const mcpRe = /^\[mcp_servers\.([^\]]+)\]/gm;
    let m;
    while ((m = mcpRe.exec(globalToml)) !== null) {
      mcpLines.push(`\x1b[38;5;180m${m[1]}\x1b[0m`);
    }
  }
  if (mcpLines.length === 0) mcpLines.push(notFoundLine("No MCP servers in config.toml"));
  sections.push({ label: "MCP", lines: mcpLines, copyPath: globalTomlPath });

  // 5. Exec policy rules
  const ruleLines = [];
  const rulesDirPath = join(HOME, ".codex", "rules");
  if (dirExists(rulesDirPath)) {
    for (const f of listDir(rulesDirPath)) {
      if (!f.endsWith(".rules")) continue;
      const block = formatConfigFile(join(rulesDirPath, f), f, 20);
      if (block) ruleLines.push(...block);
    }
  }
  if (ruleLines.length === 0) ruleLines.push(notFoundLine("No exec policy rules (~/.codex/rules/)"));
  sections.push({ label: "Rules", lines: ruleLines, copyPath: rulesDirPath });

  return sections;
}

/** Get config sections for a session (cached on session object). */
function getSessionConfig(session) {
  if (!session) return [];
  if (session._configSections) return session._configSections;
  session._configSections = session.provider === "claude"
    ? extractClaudeConfig(session)
    : extractCodexConfig(session);
  return session._configSections;
}

// ---------------------------------------------------------------------------
// Cost extraction
// ---------------------------------------------------------------------------

function resolveCodexPricing(model) {
  if (model && CODEX_PRICING[model]) return CODEX_PRICING[model];
  // Try LiteLLM fallback
  const entry = findLitellmEntry(model, _litellmPricing);
  if (entry) return litellmToCodexPricing(entry);
  // Unknown model: return zero pricing instead of crashing
  return {
    input_per_million: 0,
    cached_input_per_million: 0,
    output_per_million: 0,
  };
}

async function extractCodexSessionData(sessionFile) {
  let model = null;
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let sawLastUsage = false;
  const costsByDay  = {}; // "YYYY-MM-DD"    (UTC) → { model: float }
  const costsByHour = {}; // "YYYY-MM-DDTHH" (UTC) → { model: float }
  const metrics = emptyMetrics();
  const seenCallIds = new Set();
  const seenQueries = new Set();

  await forEachJsonl(sessionFile, (item) => {
    if (item.type === "turn_context") {
      model = (item.payload || {}).model || model;
    } else if (item.type === "event_msg") {
      const payload = item.payload || {};
      if (payload.type === "token_count") {
        const lastUsage = (payload.info || {}).last_token_usage || {};
        if (Object.keys(lastUsage).length) {
          sawLastUsage = true;
          for (const key of Object.keys(totals)) {
            totals[key] += parseInt(lastUsage[key] || 0, 10) || 0;
          }
          // Track cost by day/hour — finalized after pricing is resolved
          if (item.timestamp) {
            const d = new Date(item.timestamp);
            const dateKey = localDateKey(d);
            const hourKey = localHourKey(d);
            const addTo = (bucket, key) => {
              if (!bucket[key]) bucket[key] = { inp: 0, cachedInp: 0, out: 0 };
              bucket[key].inp       += parseInt(lastUsage.input_tokens || 0, 10) || 0;
              bucket[key].cachedInp += parseInt(lastUsage.cached_input_tokens || 0, 10) || 0;
              bucket[key].out       += parseInt(lastUsage.output_tokens || 0, 10) || 0;
            };
            addTo(costsByDay, dateKey);
            addTo(costsByHour, hourKey);
          }
        }
      }
    }

    // --- Tool/function call extraction ---
    const payload = item.payload || {};
    const itemType = item.type;
    // Handle both top-level and response_item-wrapped function_call
    const effectiveType = itemType === "response_item" ? (payload.type || "") : itemType;
    const effectivePayload = itemType === "response_item" ? payload : payload;

    if (effectiveType === "function_call" || effectiveType === "custom_tool_call") {
      const callId = effectivePayload.call_id || null;
      if (callId && seenCallIds.has(callId)) return;
      if (callId) seenCallIds.add(callId);
      const name = effectivePayload.name || "unknown";
      if (effectiveType === "custom_tool_call") {
        metrics.mcp_tool_count++;
        if (!metrics.mcp_tools.includes(name)) metrics.mcp_tools.push(name);
      }
      metrics.tools[name] = (metrics.tools[name] || 0) + 1;
      metrics.tool_count++;
      // Per-tool invocation detail with timestamp (try parsing arguments JSON)
      try {
        const args = effectivePayload.arguments;
        const parsed = typeof args === "string" ? JSON.parse(args) : (args || {});
        const detail = extractToolDetail(name, parsed);
        if (!metrics.tool_details[name]) metrics.tool_details[name] = [];
        const entry = { d: detail.short || "(no args)", ts: item.timestamp || "" };
        if (detail.full && detail.full !== detail.short) entry.full = detail.full;
        metrics.tool_details[name].push(entry);
        if (metrics.tool_details[name].length > MAX_TOOL_DETAILS) {
          metrics.tool_details[name] = metrics.tool_details[name].slice(-MAX_TOOL_DETAILS);
        }
      } catch {}
    } else if (effectiveType === "web_search_call") {
      const action = effectivePayload.action || {};
      const query = action.query || "";
      if (query && seenQueries.size < 50 && !seenQueries.has(query)) {
        seenQueries.add(query);
        metrics.web_searches.push(query);
        metrics.web_search_count++;
      }
    }
  });

  if (!sawLastUsage)
    return {
      session_id: basename(sessionFile, ".jsonl"), lastModel: model || "", models: model ? [model] : [],
      tokens: { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
      costs: { total: "0.00" }, modelBreakdown: [], costsByDay: {}, costsByHour: {},
      metrics, started_at: null, last_active: null,
    };

  const pricing = resolveCodexPricing(model);
  const inputTokens = totals.input_tokens;
  const cachedInputTokens = totals.cached_input_tokens;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = totals.output_tokens;
  const reasoningOutputTokens = totals.reasoning_output_tokens;
  const totalTokens = totals.total_tokens;

  // Convert raw token buckets to per-model cost dicts now that we have pricing
  const finalizeRaw = (raw) => {
    const out = {};
    for (const [key, t] of Object.entries(raw)) {
      const uncached = Math.max(0, t.inp - t.cachedInp);
      out[key] = { [model]: tokenCost(uncached, pricing.input_per_million) +
        tokenCost(t.cachedInp, pricing.cached_input_per_million) +
        tokenCost(t.out, pricing.output_per_million) };
    }
    return out;
  };
  const costsByDayFinal  = finalizeRaw(costsByDay);
  const costsByHourFinal = finalizeRaw(costsByHour);

  const inputCost = tokenCost(uncachedInputTokens, pricing.input_per_million);
  const cachedInputCost = tokenCost(
    cachedInputTokens,
    pricing.cached_input_per_million
  );
  const outputCost = tokenCost(outputTokens, pricing.output_per_million);
  const totalCost = inputCost + cachedInputCost + outputCost;

  return {
    provider: "codex",
    session_id: null,
    model,
    tokens: {
      input: uncachedInputTokens,
      input_total: inputTokens,
      cached_input: cachedInputTokens,
      output: outputTokens,
      reasoning_output: reasoningOutputTokens,
      total: totalTokens,
    },
    costs: {
      input: money(inputCost),
      cached_input: money(cachedInputCost),
      output: money(outputCost),
      total: money(totalCost),
    },
    rates: {
      input: String(pricing.input_per_million),
      cached_input: String(pricing.cached_input_per_million),
      output: String(pricing.output_per_million),
    },
    costsByDay: costsByDayFinal,
    costsByHour: costsByHourFinal,
    metrics,
    _localDates: true,
  };
}

function resolveClaudePricing(model) {
  if (CLAUDE_PRICING[model]) return CLAUDE_PRICING[model];
  // Try LiteLLM fallback
  const entry = findLitellmEntry(model, _litellmPricing);
  if (entry) return litellmToClaudePricing(entry);
  // Unknown model: return zero pricing instead of crashing
  return {
    input_per_million: 0,
    cache_write_5m_per_million: 0,
    cache_write_1h_per_million: 0,
    cache_read_per_million: 0,
    output_per_million: 0,
  };
}

function requestKey(item, message) {
  if (item.requestId) return String(item.requestId);
  if (message.id) return String(message.id);
  return null;
}

async function extractClaudeSessionData(transcriptPath) {
  const tokenTotals = { input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 };
  const costTotals  = { input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 };
  const tokensByModel = {}; // model → { input, cache_write_5m, cache_write_1h, cache_read, output }
  const costsByModel  = {}; // model → { input, cache_write_5m, cache_write_1h, cache_read, output }
  const costsByDay  = {}; // "YYYY-MM-DD"    (UTC) → { model: float }
  const costsByHour = {}; // "YYYY-MM-DDTHH" (UTC) → { model: float }
  const models = {};
  let lastModel = null;
  let lastMainModel = null; // model from main session file only (excludes subagent sidechains)
  let customTitle = null;   // /rename — user-set title (preferred)
  let aiTitle = null;       // AI-generated title (fallback)
  const metrics = emptyMetrics();
  const seenToolIds = new Set();
  const seenUrls = new Set();
  const seenQueries = new Set();
  const CMD_RE = /<command-name>\/?([^<]+)<\/command-name>/g;

  const transcriptFiles = claudeTranscriptFiles(transcriptPath);
  // Per-subagent-file accumulators (one entry per non-main file)
  const subagentStats = new Map(); // filePath → { cost, tool_count, first_ts, last_ts, last_model, latest_used, latest_used_ts }
  for (const fp of transcriptFiles.slice(1)) {
    subagentStats.set(fp, { cost: 0, tool_count: 0, first_ts: null, last_ts: null, last_model: null, latest_used: 0, latest_used_ts: "" });
  }
  // Agent tool_use blocks in the main file and their matching tool_results (for status detection)
  const agentToolUses = new Map(); // tool_use_id → { description, subagent_type, model, ts }
  const agentResults = new Set();  // tool_use_ids that have a tool_result in the main file
  for (const [fileIdx, filePath] of transcriptFiles.entries()) {
    const isMainFile = fileIdx === 0;
    const fileStats = isMainFile ? null : subagentStats.get(filePath);
    // Map of requestId → latest token snapshot (streaming writes same requestId multiple times;
    // the last entry has final token counts — keep that one, discard earlier partials).
    const lastByKey = new Map();
    // Keyless entries (no requestId/messageId) accumulate immediately.
    await forEachJsonl(filePath, (item) => {
      // Per-subagent activity tracking (any entry with a timestamp counts as activity)
      if (fileStats && item.timestamp) {
        if (!fileStats.first_ts || item.timestamp < fileStats.first_ts) fileStats.first_ts = item.timestamp;
        if (!fileStats.last_ts  || item.timestamp > fileStats.last_ts)  fileStats.last_ts  = item.timestamp;
      }

      // --- System branch: accumulate API duration ---
      if (item.type === "system" && item.subtype === "turn_duration" && item.durationMs) {
        metrics.api_duration_ms += item.durationMs;
        return;
      }

      // --- Title branches: track user-set and AI-generated session titles ---
      if (isMainFile && item.type === "custom-title" && typeof item.customTitle === "string") {
        customTitle = item.customTitle;
        return;
      }
      if (isMainFile && item.type === "ai-title" && typeof item.aiTitle === "string") {
        aiTitle = item.aiTitle;
        return;
      }

      // --- User branch: scan for skill/slash commands and structuredPatch line counts ---
      if (item.type === "user") {
        // Lines added/removed from structuredPatch in tool results
        const tr = item.toolUseResult;
        if (tr && typeof tr === "object" && Array.isArray(tr.structuredPatch)) {
          for (const hunk of tr.structuredPatch) {
            for (const line of (hunk.lines || [])) {
              if (line.startsWith("+")) metrics.lines_added++;
              else if (line.startsWith("-")) metrics.lines_removed++;
            }
          }
        }

        const content = (item.message || {}).content;
        const texts = [];
        if (typeof content === "string") texts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "string") texts.push(block);
            else if (block && typeof block.text === "string") texts.push(block.text);
            // Track Agent tool_result ids (main file only) for subagent status detection
            if (isMainFile && block && block.type === "tool_result" && block.tool_use_id) {
              agentResults.add(block.tool_use_id);
            }
          }
        }
        for (const text of texts) {
          for (const m of text.matchAll(CMD_RE)) {
            const name = m[1].trim();
            if (name) {
              metrics.skills[name] = (metrics.skills[name] || 0) + 1;
              metrics.skill_count++;
            }
          }
        }
        return;
      }

      if (item.type !== "assistant") return;
      const message = item.message || {};

      // --- Tool scanning (independent of token dedup) ---
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_use" || !block.name) continue;
          if (block.id && seenToolIds.has(block.id)) continue;
          if (block.id) seenToolIds.add(block.id);

          const name = block.name;
          if (name.startsWith("mcp__")) {
            metrics.mcp_tool_count++;
            if (!metrics.mcp_tools.includes(name)) metrics.mcp_tools.push(name);
          }
          metrics.tools[name] = (metrics.tools[name] || 0) + 1;
          metrics.tool_count++;

          // Track Agent tool_use blocks in main file (for subagent status + description fallback)
          if (isMainFile && name === "Agent" && block.id) {
            const inp = block.input || {};
            agentToolUses.set(block.id, {
              description: inp.description || "",
              subagent_type: inp.subagent_type || "",
              model: inp.model || "",
              ts: item.timestamp || "",
            });
          }
          // Per-subagent tool count (tools the subagent itself invoked)
          if (fileStats) fileStats.tool_count++;

          // Per-tool invocation detail with timestamp
          const input = block.input || {};
          const detail = extractToolDetail(name, input);
          if (!metrics.tool_details[name]) metrics.tool_details[name] = [];
          const detailEntry = { d: detail.short || "(no args)", ts: item.timestamp || "" };
          if (detail.full && detail.full !== detail.short) detailEntry.full = detail.full;
          metrics.tool_details[name].push(detailEntry);
          if (metrics.tool_details[name].length > MAX_TOOL_DETAILS) {
            metrics.tool_details[name] = metrics.tool_details[name].slice(-MAX_TOOL_DETAILS);
          }

          // Web fetch/search extraction
          if (name === "WebFetch" && input.url && seenUrls.size < 50) {
            if (!seenUrls.has(input.url)) {
              seenUrls.add(input.url);
              metrics.web_fetches.push(input.url);
              metrics.web_fetch_count++;
            }
          } else if (name === "WebSearch" && input.query && seenQueries.size < 50) {
            if (!seenQueries.has(input.query)) {
              seenQueries.add(input.query);
              metrics.web_searches.push(input.query);
              metrics.web_search_count++;
            }
          }
        }
      }

      // --- Token / cost accounting ---
      const usage = message.usage;
      if (!usage) return;

      const inputTokens = parseInt(usage.input_tokens || 0, 10) || 0;
      const cacheReadTokens =
        parseInt(usage.cache_read_input_tokens || 0, 10) || 0;
      const outputTokens = parseInt(usage.output_tokens || 0, 10) || 0;
      const cacheCreation = usage.cache_creation || {};
      let cacheWrite5mTokens =
        parseInt(cacheCreation.ephemeral_5m_input_tokens || 0, 10) || 0;
      let cacheWrite1hTokens =
        parseInt(cacheCreation.ephemeral_1h_input_tokens || 0, 10) || 0;
      const totalCacheWriteTokens =
        parseInt(usage.cache_creation_input_tokens || 0, 10) || 0;
      const remainder =
        totalCacheWriteTokens - (cacheWrite5mTokens + cacheWrite1hTokens);
      if (remainder > 0) cacheWrite5mTokens += remainder;

      if (
        inputTokens === 0 &&
        cacheReadTokens === 0 &&
        outputTokens === 0 &&
        cacheWrite5mTokens === 0 &&
        cacheWrite1hTokens === 0
      )
        return;

      const model = message.model;
      if (!model || model === "<synthetic>")
        throw new SessionCostError(
          `Encountered billable Claude usage with unknown model in ${filePath}`
        );

      // Track the latest cumulative context usage for this subagent (input + cache).
      // Streaming partials share a requestId; we pick the latest-timestamped entry.
      if (fileStats) {
        const ts = item.timestamp || "";
        if (!fileStats.latest_used_ts || ts >= fileStats.latest_used_ts) {
          fileStats.latest_used = inputTokens + cacheReadTokens + totalCacheWriteTokens;
          fileStats.latest_used_ts = ts;
        }
      }

      const key = requestKey(item, message);
      const snapshot = { inputTokens, cacheReadTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, model, ts: item.timestamp || "" };
      if (key !== null) {
        // Overwrite with latest — streaming partials share the same requestId;
        // the final entry has the highest (correct) token counts.
        lastByKey.set(key, snapshot);
      } else {
        accum(filePath, model, inputTokens, cacheReadTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, item.timestamp || "", isMainFile);
      }
    });
    // Flush the last-occurrence map for this file
    for (const { inputTokens, cacheReadTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, model, ts } of lastByKey.values()) {
      accum(filePath, model, inputTokens, cacheReadTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, ts, isMainFile);
    }
  }

  function accum(filePath, model, inp, cacheR, out, cw5m, cw1h, ts, isMain) {
    lastModel = model;
    if (isMain) lastMainModel = model;
    models[model] = (models[model] || 0) + 1;
    const pricing = resolveClaudePricing(model);
    tokenTotals.input += inp;
    tokenTotals.cache_read += cacheR;
    tokenTotals.output += out;
    tokenTotals.cache_write_5m += cw5m;
    tokenTotals.cache_write_1h += cw1h;
    costTotals.input += tokenCost(inp, pricing.input_per_million);
    costTotals.cache_read += tokenCost(cacheR, pricing.cache_read_per_million);
    costTotals.output += tokenCost(out, pricing.output_per_million);
    costTotals.cache_write_5m += tokenCost(cw5m, pricing.cache_write_5m_per_million);
    costTotals.cache_write_1h += tokenCost(cw1h, pricing.cache_write_1h_per_million);
    if (!tokensByModel[model]) tokensByModel[model] = { input: 0, cache_read: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0 };
    if (!costsByModel[model])  costsByModel[model]  = { input: 0, cache_read: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0 };
    tokensByModel[model].input += inp;
    tokensByModel[model].cache_read += cacheR;
    tokensByModel[model].output += out;
    tokensByModel[model].cache_write_5m += cw5m;
    tokensByModel[model].cache_write_1h += cw1h;
    costsByModel[model].input += tokenCost(inp, pricing.input_per_million);
    costsByModel[model].cache_read += tokenCost(cacheR, pricing.cache_read_per_million);
    costsByModel[model].output += tokenCost(out, pricing.output_per_million);
    costsByModel[model].cache_write_5m += tokenCost(cw5m, pricing.cache_write_5m_per_million);
    costsByModel[model].cache_write_1h += tokenCost(cw1h, pricing.cache_write_1h_per_million);
    // Per-day and per-hour cost tracking (local time), keyed by model
    if (ts) {
      const d = new Date(ts);
      const dateKey = localDateKey(d);
      const hourKey = localHourKey(d);
      const callCost = tokenCost(inp, pricing.input_per_million) +
        tokenCost(cacheR, pricing.cache_read_per_million) +
        tokenCost(out, pricing.output_per_million) +
        tokenCost(cw5m, pricing.cache_write_5m_per_million) +
        tokenCost(cw1h, pricing.cache_write_1h_per_million);
      if (!costsByDay[dateKey])  costsByDay[dateKey]  = {};
      if (!costsByHour[hourKey]) costsByHour[hourKey] = {};
      costsByDay[dateKey][model]  = (costsByDay[dateKey][model]  || 0) + callCost;
      costsByHour[hourKey][model] = (costsByHour[hourKey][model] || 0) + callCost;
    }
    // Per-subagent cost + last-model tracking
    if (!isMain) {
      const stats = subagentStats.get(filePath);
      if (stats) {
        const callCost2 = tokenCost(inp, pricing.input_per_million) +
          tokenCost(cacheR, pricing.cache_read_per_million) +
          tokenCost(out, pricing.output_per_million) +
          tokenCost(cw5m, pricing.cache_write_5m_per_million) +
          tokenCost(cw1h, pricing.cache_write_1h_per_million);
        stats.cost += callCost2;
        stats.last_model = model;
      }
    }
  }

  if (!Object.keys(models).length)
    throw new SessionCostError(
      `No assistant usage records found in ${transcriptPath}`
    );

  const totalCost = Object.values(costTotals).reduce((a, b) => a + b, 0);
  const totalTokens = Object.values(tokenTotals).reduce((a, b) => a + b, 0);

  // Build per-model summary for display
  const modelBreakdown = Object.keys(tokensByModel).sort().map(model => {
    const t = tokensByModel[model];
    const c = costsByModel[model];
    const modelTotal = Object.values(c).reduce((a, b) => a + b, 0);
    return { model, tokens: t, costs: c, total: money(modelTotal) };
  });

  // Build per-subagent summary (one entry per file in <stem>/subagents/)
  const subagents = [];
  const nowMs = Date.now();
  for (const fp of transcriptFiles.slice(1)) {
    const stats = subagentStats.get(fp) || {};
    const agentFile = basename(fp);                          // "agent-XXXX.jsonl"
    const agentId = agentFile.replace(/\.jsonl$/, "");        // "agent-XXXX"
    const metaPath = fp.replace(/\.jsonl$/, ".meta.json");
    let meta = {};
    try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { /* missing sidecar */ }
    const toolUseId = meta.toolUseId || null;
    const parentUse = toolUseId ? agentToolUses.get(toolUseId) : null;
    const type = meta.agentType || (parentUse && parentUse.subagent_type) || "?";
    const description = meta.description || (parentUse && parentUse.description) || "";
    const model = stats.last_model || (parentUse && parentUse.model) || "?";
    let fileMtimeMs = 0;
    try { fileMtimeMs = statSync(fp).mtime.getTime(); } catch {}
    const lastTsMs = stats.last_ts ? new Date(stats.last_ts).getTime() : 0;
    const firstTsMs = stats.first_ts ? new Date(stats.first_ts).getTime() : 0;
    const lastActiveMs = Math.max(fileMtimeMs, lastTsMs);
    const durationMs = (firstTsMs && lastTsMs) ? Math.max(0, lastTsMs - firstTsMs) : 0;
    // Status: prefer parent tool_result presence; fall back to recency when no tool_use_id known.
    let status;
    if (toolUseId) {
      status = agentResults.has(toolUseId) ? "done" : "running";
    } else {
      status = (nowMs - lastActiveMs < 30000) ? "running" : "done";
    }
    // Per-subagent context usage: total of the latest assistant message, against
    // the model's max input window. Subagents have their own isolated contexts
    // independent of the parent, so we compute from the subagent's own usage.
    // Use usage-based inference for the max (same fallback the parent uses when
    // no project settings are pinned) — LiteLLM reports 1M for any model that
    // *can* do 1M with the [1m] beta header, which over-estimates the window
    // for the common 200k-default case and made some subagents show single-digit
    // CTX% next to their parent's normal 25-50% reading on the same usage.
    let context = null;
    if (stats.latest_used > 0) {
      const maxCtx = stats.latest_used > 200000 ? 1_048_576 : 200000;
      context = { used: stats.latest_used, max: maxCtx };
    }

    subagents.push({
      agent_id: agentId,
      type,
      description,
      model,
      started_at: stats.first_ts || null,
      last_active: stats.last_ts || null,
      duration_ms: durationMs,
      status,
      cost: stats.cost || 0,
      tool_count: stats.tool_count || 0,
      tool_use_id: toolUseId,
      context,
      ghost: false,
    });
  }

  // Fallback pairing: on-disk subagents whose meta.json lacked toolUseId (older
  // Explore agents) still match a real Agent tool_use in the parent. Pair them by
  // description (closest started_at wins on ties) so we don't synthesize a ghost
  // for the same subagent. Each parent tool_use can be claimed at most once.
  const seenToolUseIds = new Set(subagents.map(s => s.tool_use_id).filter(Boolean));
  const unclaimedOnDisk = subagents.filter(s => !s.tool_use_id);
  if (unclaimedOnDisk.length > 0 && agentToolUses.size > 0) {
    for (const sa of unclaimedOnDisk) {
      let best = null;
      let bestDelta = Infinity;
      const saTs = sa.started_at ? new Date(sa.started_at).getTime() : null;
      for (const [tuId, use] of agentToolUses) {
        if (seenToolUseIds.has(tuId)) continue;
        if ((use.description || "") !== (sa.description || "")) continue;
        const useTs = use.ts ? new Date(use.ts).getTime() : null;
        const delta = (saTs !== null && useTs !== null) ? Math.abs(saTs - useTs) : 0;
        if (delta < bestDelta) { best = tuId; bestDelta = delta; }
      }
      if (best) {
        sa.tool_use_id = best;
        const use = agentToolUses.get(best);
        // Now that we know the parent tool_use, prefer its data where ours was guessed
        sa.status = agentResults.has(best) ? "done" : sa.status;
        if (!sa.type || sa.type === "?") sa.type = use.subagent_type || sa.type;
        seenToolUseIds.add(best);
      }
    }
  }

  // Ghost subagents: parent Agent tool_use blocks whose on-disk transcript is gone
  // (Claude Code purges old subagent jsonl files but keeps the tool_use/tool_result
  // pair in the parent transcript). Synthesize a row with the metadata we still have.
  for (const [tuId, use] of agentToolUses) {
    if (seenToolUseIds.has(tuId)) continue;
    subagents.push({
      agent_id: tuId,
      type: use.subagent_type || "?",
      description: use.description || "",
      model: use.model || "?",
      started_at: use.ts || null,
      last_active: null,
      duration_ms: 0,
      status: agentResults.has(tuId) ? "done" : "running",
      cost: 0,
      tool_count: 0,
      tool_use_id: tuId,
      ghost: true,
    });
  }

  return {
    provider: "claude",
    title: customTitle || aiTitle || null,
    customTitle, // null if not set via /rename
    aiTitle,     // null if AI hasn't generated one
    lastModel: lastMainModel || lastModel,
    models: Object.keys(models).sort(),
    modelBreakdown,
    tokens: { ...tokenTotals, total: totalTokens },
    costs: {
      input: money(costTotals.input),
      cache_write_5m: money(costTotals.cache_write_5m),
      cache_write_1h: money(costTotals.cache_write_1h),
      cache_read: money(costTotals.cache_read),
      output: money(costTotals.output),
      total: money(totalCost),
    },
    costsByDay,
    costsByHour,
    metrics,
    subagents,
    _localDates: true,
    _noSubagentModel: true, // cache bust: lastModel now excludes subagent sidechain files
    _hasSubagentsField: true, // cache bust: data.subagents added
    _hasGhostSubagents: true, // cache bust: subagents now include ghost entries from purged transcripts
    _subagentCostNumber: true, // cache bust: subagent.cost is now a number (was a money() string)
    _subagentDescPairing: true, // cache bust: on-disk subagents without toolUseId now back-paired by description
    _subagentContext: true,     // cache bust: per-subagent context usage added
  };
}

// ---------------------------------------------------------------------------
// Disk-based cost cache
// ---------------------------------------------------------------------------

let _diskCache = null;
let _diskCacheDirty = false;

function loadDiskCache() {
  if (_diskCache) return _diskCache;
  try {
    _diskCache = JSON.parse(readFileSync(COST_CACHE_FILE, "utf-8"));
  } catch {
    _diskCache = {};
  }
  return _diskCache;
}

function pruneDiskCache() {
  if (!_diskCache) return;
  for (const key of Object.keys(_diskCache)) {
    const filePath = key.split("|")[0];
    // Remove if file no longer exists or has been superseded by a newer entry
    if (diskCacheKey(filePath) !== key) {
      delete _diskCache[key];
      _diskCacheDirty = true;
    }
  }
}

function saveDiskCache() {
  if (!_diskCacheDirty) return;
  try {
    pruneDiskCache();
    mkdirSync(COST_CACHE_DIR, { recursive: true });
    writeFileSync(COST_CACHE_FILE, JSON.stringify(_diskCache));
  } catch {
    /* best effort */
  }
}

function loadUiPrefs() {
  try {
    return JSON.parse(readFileSync(UI_PREFS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveUiPrefs(prefs) {
  try {
    mkdirSync(COST_CACHE_DIR, { recursive: true });
    const existing = loadUiPrefs();
    writeFileSync(UI_PREFS_FILE, JSON.stringify({ ...existing, ...prefs }));
  } catch { /* best effort */ }
}

function diskCacheKey(filePath) {
  try {
    const st = statSync(filePath);
    // For Claude transcripts, also fold in the max mtime across all subagent jsonl
    // files. The parent jsonl's mtime alone doesn't reflect activity in a running
    // subagent (whose file is appended in-process by Claude Code without touching
    // the parent), nor does the subagents/ dir mtime (which only changes when files
    // are added or removed, not when existing ones are modified).
    let subTag = "";
    if (filePath.endsWith(".jsonl")) {
      const subDir = filePath.replace(/\.jsonl$/, "") + "/subagents";
      try {
        const entries = listDir(subDir);
        let maxSubMtime = statSync(subDir).mtimeMs;
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue;
          try {
            const m = statSync(subDir + "/" + entry).mtimeMs;
            if (m > maxSubMtime) maxSubMtime = m;
          } catch { /* file vanished between readdir and stat */ }
        }
        subTag = `|${maxSubMtime}`;
      } catch { /* no subagents dir */ }
    }
    return `${filePath}|${st.size}|${st.mtimeMs}${subTag}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LiteLLM dynamic pricing
// ---------------------------------------------------------------------------

let _litellmPricing = null;

async function fetchLitellmPricing() {
  // Try disk cache first
  try {
    const raw = readFileSync(PRICING_CACHE_FILE, "utf-8");
    const cached = JSON.parse(raw);
    const age = Date.now() - (cached._fetchedAt || 0);
    if (age < PRICING_CACHE_MAX_AGE_MS && cached.data) {
      _litellmPricing = cached.data;
      return _litellmPricing;
    }
    // Stale — try network, fall back to stale data below
  } catch {
    /* no cache */
  }

  // Fetch from network
  try {
    const resp = await fetch(LITELLM_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // Save to disk cache
    try {
      mkdirSync(COST_CACHE_DIR, { recursive: true });
      writeFileSync(
        PRICING_CACHE_FILE,
        JSON.stringify({ _fetchedAt: Date.now(), data })
      );
    } catch { /* best effort */ }
    _litellmPricing = data;
    return _litellmPricing;
  } catch {
    // Network failed — try stale cache
    try {
      const raw = readFileSync(PRICING_CACHE_FILE, "utf-8");
      const cached = JSON.parse(raw);
      if (cached.data) {
        _litellmPricing = cached.data;
        return _litellmPricing;
      }
    } catch { /* no stale cache either */ }
    return null;
  }
}

function findLitellmEntry(modelName, data) {
  if (!data || !modelName) return null;
  // Exact match
  if (data[modelName]) return data[modelName];
  // With anthropic. prefix
  if (data["anthropic." + modelName]) return data["anthropic." + modelName];
  // Partial match: find first key containing the model name
  for (const key of Object.keys(data)) {
    if (key.includes(modelName)) return data[key];
  }
  return null;
}

function litellmToClaudePricing(entry) {
  const inputPerMillion = (entry.input_cost_per_token || 0) * 1_000_000;
  return {
    input_per_million: inputPerMillion,
    cache_write_5m_per_million: inputPerMillion * 1.25,
    cache_write_1h_per_million: inputPerMillion * 2.0,
    cache_read_per_million:
      (entry.cache_read_input_token_cost || 0) * 1_000_000,
    output_per_million: (entry.output_cost_per_token || 0) * 1_000_000,
  };
}

function litellmToCodexPricing(entry) {
  return {
    input_per_million: (entry.input_cost_per_token || 0) * 1_000_000,
    cached_input_per_million:
      (entry.cache_read_input_token_cost || 0) * 1_000_000,
    output_per_million: (entry.output_cost_per_token || 0) * 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

// Track mtime for each in-memory cache entry so we can detect changes.
const SESSION_DATA_MTIME = new Map();

function fileMtimeMs(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return 0; }
}

async function safeExtractSessionData(session) {
  if (!session.data_file) {
    // Virtual session (running process with no transcript yet)
    return {
      session_id: session.session_id,
      started_at: session.started_at,
      last_active: session.last_active,
      model: "",
      tokens: { input: 0, output: 0, total: 0 },
      costs: { total: 0 },
      tools: {},
      metrics: emptyMetrics(),
    };
  }
  const memKey = `${session.provider}:${session.data_file}`;

  // For Claude sessions, check max mtime across ALL transcript files
  // (main + subagent files) so cache invalidates when subagents are active.
  const effectiveMtime = session.provider === "claude"
    ? claudeTranscriptFiles(session.data_file).reduce(
        (mx, f) => Math.max(mx, fileMtimeMs(f)), 0)
    : fileMtimeMs(session.data_file);

  // Check in-memory cache, but verify mtime hasn't changed.
  if (SESSION_DATA_CACHE.has(memKey)) {
    const cachedMtime = SESSION_DATA_MTIME.get(memKey) || 0;
    if (effectiveMtime === cachedMtime) {
      return SESSION_DATA_CACHE.get(memKey);
    }
    // File changed — invalidate
    SESSION_DATA_CACHE.delete(memKey);
    SESSION_DATA_MTIME.delete(memKey);
  }

  // Check disk cache (diskCacheKey includes mtime, so stale entries auto-miss).
  // Also force re-extraction if cached entry lacks metrics (old cache format).
  const cache = loadDiskCache();
  const dKey = diskCacheKey(session.data_file);
  // Cache: require tool_details with {d,ts} format and matching tool counts
  const cachedMetrics = cache[dKey] && cache[dKey].metrics;
  const cachedDetails = cachedMetrics && cachedMetrics.tool_details;
  const cachedTools = cachedMetrics && cachedMetrics.tools;
  const detailsValid = cachedDetails && cachedTools
    && Object.values(cachedDetails).every(arr =>
      !arr.length || (typeof arr[0] === "object" && arr[0].d !== undefined))
    && Object.keys(cachedTools).every(t => cachedDetails[t] && cachedDetails[t].length > 0);
  const hasLinesFields = cachedMetrics && typeof cachedMetrics.lines_added !== "undefined";
  const hasModelBreakdown = cache[dKey] && Array.isArray(cache[dKey].modelBreakdown);
  // Require costsByHour (v2 format — also implies costsByDay is per-model dict, not flat float)
  const hasCostsByDay = cache[dKey] && typeof cache[dKey].costsByHour === "object";
  const hasLocalDates = cache[dKey] && cache[dKey]._localDates === true;
  const hasNoSubagentModel = cache[dKey] && cache[dKey]._noSubagentModel === true;
  const hasSubagentsField = cache[dKey] && cache[dKey]._hasSubagentsField === true;
  const hasGhostSubagents = cache[dKey] && cache[dKey]._hasGhostSubagents === true;
  const subagentCostNumber = cache[dKey] && cache[dKey]._subagentCostNumber === true;
  const subagentDescPairing = cache[dKey] && cache[dKey]._subagentDescPairing === true;
  const subagentContext = cache[dKey] && cache[dKey]._subagentContext === true;
  if (dKey && cache[dKey] && detailsValid && hasLinesFields && hasModelBreakdown && hasCostsByDay && hasLocalDates && hasNoSubagentModel && hasSubagentsField && hasGhostSubagents && subagentCostNumber && subagentDescPairing && subagentContext) {
    SESSION_DATA_CACHE.set(memKey, cache[dKey]);
    SESSION_DATA_MTIME.set(memKey, effectiveMtime);
    return cache[dKey];
  }

  try {
    let data = null;
    if (session.provider === "codex") {
      data = await extractCodexSessionData(session.data_file);
    } else if (session.provider === "claude") {
      data = await extractClaudeSessionData(session.data_file);
    }
    SESSION_DATA_CACHE.set(memKey, data);
    SESSION_DATA_MTIME.set(memKey, effectiveMtime);
    if (dKey && data) {
      cache[dKey] = data;
      _diskCacheDirty = true;
    }
    return data;
  } catch (err) {
    if (err instanceof SessionCostError) {
      return { _error: err.message, session_id: session.session_id, tokens: { input: 0, output: 0, total: 0 }, costs: { total: 0 }, metrics: emptyMetrics() };
    }
    throw err;
  }
}

async function annotateListCosts(sessions, plan) {
  await Promise.all(
    sessions.map(async (session) => {
      const data = await safeExtractSessionData(session);
      if (data) {
        const t = data.tokens || {};
        session.list_input_tokens =
          (t.input || 0) +
          (t.cached_input || 0) +
          (t.cache_read || 0) +
          (t.cache_write_5m || 0) +
          (t.cache_write_1h || 0);
        session.list_output_tokens = t.output || 0;
        const m = safeMetrics(data);
        session.list_tool_count = m.tool_count;
        // Update displayed model from full extraction (lastModel excludes subagent sidechain files)
        if (data.lastModel) session.model = data.lastModel;
        session.costs_by_day  = data.costsByDay  || null;
        session.costs_by_hour = data.costsByHour || null;
        // Pre-compute per-session spend for last-hour and today columns
        if (data.costsByDay || data.costsByHour) {
          const nowMs = Date.now();
          const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
          const todayKey  = localDateKey(today);
          const hourKey   = localHourKey(new Date(nowMs));
          let hourCost = 0, todayCost = 0;
          if (data.costsByHour) {
            const h = data.costsByHour[hourKey];
            if (h) hourCost = typeof h === "object" ? Object.values(h).reduce((a, b) => a + b, 0) : h;
          }
          if (data.costsByDay) {
            for (const [day, models] of Object.entries(data.costsByDay)) {
              if (day >= todayKey) {
                todayCost += typeof models === "object" ? Object.values(models).reduce((a, b) => a + b, 0) : models;
              }
            }
          }
          session.list_cost_hour  = hourCost;
          session.list_cost_today = todayCost;
        }
      }
      if (planIncludesProvider(plan, session.provider || "")) {
        session.list_total_cost = "included";
      } else if (data) {
        session.list_total_cost = data.costs.total;
      }
      // Subagents (for list-row expansion)
      if (data && Array.isArray(data.subagents)) {
        session.list_subagents = data.subagents;
        session.list_subagents_count = data.subagents.length;
        session.list_subagents_cost = data.subagents.reduce(
          (sum, sa) => sum + (typeof sa.cost === "number" ? sa.cost : Number(sa.cost) || 0), 0);
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Last active tool extraction (for live sessions — reads file tail)
// ---------------------------------------------------------------------------

/**
 * Read the last ~16KB of a file and return the lines (most recent last).
 */
function readFileTail(filePath, bytes) {
  try {
    const st = statSync(filePath);
    const size = st.size;
    const readBytes = Math.min(bytes || 16384, size);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
    closeSync(fd);
    return buf.toString("utf-8").split("\n");
  } catch {
    return [];
  }
}

/**
 * Extract the last tool_use name from a Claude or Codex transcript.
 * Only called for sessions with a running process.
 */
function extractLastToolName(session) {
  if (!session || !session.data_file) return "";
  try {
    // For Claude, check all transcript files (main + subagent), use the one with latest mtime
    let targetFile = session.data_file;
    if (session.provider === "claude") {
      const files = claudeTranscriptFiles(session.data_file);
      let maxMt = 0;
      for (const f of files) {
        const mt = fileMtimeMs(f);
        if (mt > maxMt) { maxMt = mt; targetFile = f; }
      }
    }

    const lines = readFileTail(targetFile, 32768);
    let lastTool = "";

    // Scan from end to find the most recent tool_use
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (session.provider === "claude") {
          // Claude: assistant message with content[] containing tool_use blocks
          if (item.type === "assistant" && item.message && item.message.content) {
            const content = item.message.content;
            for (let j = content.length - 1; j >= 0; j--) {
              if (content[j].type === "tool_use") {
                return content[j].name || "";
              }
            }
          }
        } else {
          // Codex: function_call or custom_tool_call at top level
          if (item.type === "function_call" || item.type === "custom_tool_call") {
            return (item.payload && item.payload.name) || "";
          }
          if (item.type === "response_item" && item.payload) {
            if (item.payload.type === "function_call") {
              return item.payload.name || "";
            }
          }
        }
      } catch {
        continue;
      }
    }
    return lastTool;
  } catch {
    return "";
  }
}

/**
 * Extract context window usage from a session transcript.
 * Returns { used, max, percent } or null if unavailable.
 * Reads the tail of the transcript for the most recent usage data.
 */
function extractContextUsage(session) {
  if (!session || !session.data_file) return null;
  try {
    // Context usage is per-conversation; the parent session's CTX% must come
    // from the parent's own jsonl. The previous logic picked whichever
    // transcript file had the latest mtime, which meant CTX% would flip to
    // a running subagent's context while it streamed — subagents run in their
    // own isolated context and shouldn't shadow the parent's reading.
    const targetFile = session.data_file;

    const lines = readFileTail(targetFile, 65536);

    if (session.provider === "claude") {
      // Claude: last assistant message usage block
      // used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
      // Context window: check Claude Code settings for [1m] model variant,
      // then LiteLLM, then infer from usage (>200k → 1M tier)
      const CLAUDE_DEFAULT_CTX = 200000;
      const CLAUDE_1M_CTX = 1_048_576;

      // Check Claude Code settings files for model with [1m] suffix
      // Priority: local project > project > global
      let settingsCtx = 0;
      const cwd = session.label_source;
      const settingsFiles = [
        ...(cwd ? [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json")] : []),
        join(CLAUDE_CONFIG_DIR, "settings.json"),
      ];
      for (const sf of settingsFiles) {
        try {
          const s = JSON.parse(readFileSync(sf, "utf-8"));
          if (s.model && typeof s.model === "string") {
            settingsCtx = s.model.includes("[1m]") ? CLAUDE_1M_CTX : CLAUDE_DEFAULT_CTX;
            break; // most specific setting wins
          }
        } catch { /* file missing or invalid */ }
      }

      let litellmCtx = 0;
      if (_litellmPricing && session.model) {
        const entry = findLitellmEntry(session.model, _litellmPricing);
        if (entry && entry.max_input_tokens) litellmCtx = entry.max_input_tokens;
      }
      let sawCompactBoundary = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (item.type === "system" && item.subtype === "compact_boundary") {
            sawCompactBoundary = true;
          }
          if (item.type === "assistant" && item.message && item.message.usage) {
            const u = item.message.usage;
            const used = (u.input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0);
            if (used > 0) {
              // Resolution order: settings [1m] > usage inference > LiteLLM > default
              const maxCtx = settingsCtx > 0 ? settingsCtx
                : used > CLAUDE_DEFAULT_CTX ? CLAUDE_1M_CTX
                : litellmCtx > 0 ? litellmCtx : CLAUDE_DEFAULT_CTX;
              return { used, max: maxCtx, percent: Math.round((used / maxCtx) * 100),
                compacting: sawCompactBoundary };
            }
          }
        } catch { continue; }
      }
      // If we saw compact_boundary but no assistant usage, still report compacting
      const maxCtx = settingsCtx > 0 ? settingsCtx : litellmCtx > 0 ? litellmCtx : CLAUDE_DEFAULT_CTX;
      if (sawCompactBoundary) {
        return { used: 0, max: maxCtx, percent: 0, compacting: true };
      }
    } else {
      // Codex: last token_count event with info
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (item.type === "event_msg" && item.payload &&
              item.payload.type === "token_count" && item.payload.info) {
            const info = item.payload.info;
            const last = info.last_token_usage || info.total_token_usage;
            const maxCtx = info.model_context_window || 258400;
            if (last && last.input_tokens > 0) {
              const used = last.input_tokens;
              return { used, max: maxCtx, percent: Math.round((used / maxCtx) * 100) };
            }
          }
        } catch { continue; }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-session rate tracking (tokens/min, cost/min, tools/min)
// tok/m and $/m use EMA for smooth, responsive updates.
// TL/m uses instantaneous rate (delta since last tick) for immediate feedback.
// ---------------------------------------------------------------------------

const _rateState = new Map(); // session key → {ts, tokens, cost, tools, emaTok, emaCost}
const EMA_HALF_LIFE_MS = 10_000; // 10s half-life

function updateSessionRates(sessions) {
  const now = Date.now();
  for (const s of sessions) {
    const key = `${s.provider}:${s.session_id}`;
    const tokens = (s.list_input_tokens || 0) + (s.list_output_tokens || 0);
    const cost = s.list_total_cost === "included" ? 0 : parseFloat(s.list_total_cost || 0) || 0;
    const tools = s.list_tool_count || 0;

    if (!_rateState.has(key)) {
      // First sample — no rate yet
      _rateState.set(key, { ts: now, tokens, cost, tools, baselineTools: tools, emaTok: 0, emaCost: 0 });
      s.list_tokens_per_min = 0;
      s.list_cost_per_min = 0;
      s.list_tools_since_start = 0;
      continue;
    }

    const prev = _rateState.get(key);
    const dtMs = now - prev.ts;
    if (dtMs < 100) {
      // Too soon — skip
      s.list_tokens_per_min = prev.emaTok;
      s.list_cost_per_min = prev.emaCost;
      s.list_tools_since_start = tools - prev.baselineTools;
      continue;
    }

    const dtMin = dtMs / 60_000;

    // Instantaneous rates for this tick (per minute)
    const instTok = Math.max(0, tokens - prev.tokens) / dtMin;
    const instCost = Math.max(0, cost - prev.cost) / dtMin;
    // EMA smoothing factor: alpha = 1 - 2^(-dt/halfLife)
    const alpha = 1 - Math.pow(2, -dtMs / EMA_HALF_LIFE_MS);
    const emaTok = alpha * instTok + (1 - alpha) * prev.emaTok;
    const emaCost = alpha * instCost + (1 - alpha) * prev.emaCost;

    s.list_tokens_per_min = emaTok;
    s.list_cost_per_min = emaCost;
    s.list_tools_since_start = tools - prev.baselineTools;

    prev.ts = now;
    prev.tokens = tokens;
    prev.cost = cost;
    prev.tools = tools;
    prev.emaTok = emaTok;
    prev.emaCost = emaCost;
  }
}

// Session duration helper
function sessionDuration(s) {
  const start = parseTimestamp(s.started_at);
  const end = parseTimestamp(s.last_active) || start;
  if (!start || !end) return "";
  const secs = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d`;
  return `${Math.floor(secs / 604800)}w`;
}

// ---------------------------------------------------------------------------
// ANSI / Terminal constants
// ---------------------------------------------------------------------------

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const MOUSE_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h"; // SGR mouse + any-event tracking
const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// btop-style color palette — dark bg, vibrant accents, rounded box borders
const C = {
  // Panel borders and titles
  border: "\x1b[38;5;60m",      // muted blue-gray for box borders
  borderHi: "\x1b[38;5;75m",    // brighter blue for active panel border / tab underlines
  panelTitle: "\x1b[1;38;5;179m", // bold muted gold for panel titles and active tab text
  // Labels and values
  hdrLabel: "\x1b[1;38;5;75m", // bold blue for field labels (distinct from amber titles)
  hdrValue: "\x1b[1;37m",      // bold white for values
  hdrCyan: "\x1b[1;36m",       // bold cyan for Claude counts
  hdrGreen: "\x1b[1;32m",      // bold green for Codex counts
  hdrYellow: "\x1b[1;33m",     // bold yellow for spend
  hdrDim: "\x1b[38;5;245m",    // gray for secondary text
  // Column headers: dark blue bg, bold white text (btop style)
  colHdrBg: "\x1b[1;37;48;5;236m", // bold white on dark gray
  // Selected row: subtle highlight
  selBg: "\x1b[48;5;236m",     // dark gray bg
  selFg: "\x1b[1;37m",         // bold white text
  // Footer: btop-style
  footerKey: "\x1b[1;30;48;5;75m", // bold black on blue
  footerLabel: "\x1b[38;5;245;40m", // gray on black
  footerBg: "\x1b[40m",        // black bg
  // Provider colors
  provClaude: "\x1b[38;5;141m",  // purple-ish
  provCodex: "\x1b[38;5;114m",   // green-ish
  // Cost colors
  costGreen: "\x1b[38;5;114m",
  costYellow: "\x1b[38;5;221m",
  costRed: "\x1b[1;38;5;203m",
  // Chart colors (for strip charts)
  chartBar: "\x1b[38;5;75m",     // blue bars
  chartBarHi: "\x1b[38;5;203m",  // red for high values
  chartBarMed: "\x1b[38;5;221m", // yellow for medium
  chartBarLow: "\x1b[38;5;114m", // green for low
  // Misc
  dimText: "\x1b[38;5;245m",   // gray
  normalFg: "\x1b[37m",        // white
  searchFg: "\x1b[1;36m",      // bold cyan
  accent: "\x1b[38;5;75m",     // accent blue
};

// ---------------------------------------------------------------------------
// Box-drawing helpers (btop-style rounded corners)
// ---------------------------------------------------------------------------

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

/** Draw a box top edge: ╭─ Title ──────────╮ */
function boxTop(width, title, highlight) {
  const bc = highlight ? C.borderHi : C.border;
  const tc = C.panelTitle;
  if (!title) {
    return bc + BOX.tl + BOX.h.repeat(width - 2) + BOX.tr + RESET;
  }
  const label = ` ${title} `;
  const after = Math.max(0, width - 3 - label.length);
  return bc + BOX.tl + BOX.h + RESET + tc + label + RESET + bc + BOX.h.repeat(after) + BOX.tr + RESET;
}

/** Draw a box bottom edge: ╰──────────────╯ */
function boxBottom(width, highlight) {
  const bc = highlight ? C.borderHi : C.border;
  return bc + BOX.bl + BOX.h.repeat(width - 2) + BOX.br + RESET;
}

/** Wrap content in box side borders: │ content │ */
function boxLine(content, width, highlight) {
  const bc = highlight ? C.borderHi : C.border;
  // visible: │ + space + inner + space + │ = width
  const inner = width - 4;
  const clipped = ansiSlice(content, 0, inner);
  const vLen = ansiLen(clipped);
  const pad = Math.max(0, inner - vLen);
  return bc + BOX.v + RESET + " " + clipped + " ".repeat(pad) + " " + bc + BOX.v + RESET;
}

/** Render an empty box-bordered line */
function boxEmpty(width, highlight) {
  return boxLine("", width, highlight);
}

// ---------------------------------------------------------------------------
// Strip chart (sparkline-style bar chart for time series)
// ---------------------------------------------------------------------------

const SPARK_STYLES = {
  blocks:  [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  braille: [" ", "⡀", "⡄", "⡆", "⡇", "⡧", "⡷", "⡿", "⣿"],
  shades:  [" ", "░", "░", "▒", "▒", "▓", "▓", "█", "█"],
  dots:    ["⠀", "⡀", "⡀", "⠄", "⠄", "⠂", "⠂", "⠁", "⠁"],
};

// History buffers for CPU/memory (keyed by session)
const _cpuHistory = new Map();   // sessionKey → number[]
const _memHistory = new Map();   // sessionKey → number[]
const HISTORY_MAX = 300;

function pushHistory(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

// btop-style smooth gradient: green(114) → teal(79) → yellow(221) → red(203)
function sparkColor(ratio) {
  if (ratio <= 0.01) return "\x1b[38;5;22m";  // near-zero: dark forest green
  if (ratio <= 0.30) return "\x1b[38;5;71m";  // low: muted green
  if (ratio <= 0.50) return "\x1b[38;5;114m"; // medium-low: green
  if (ratio <= 0.70) return "\x1b[38;5;186m"; // medium: yellow-green
  if (ratio <= 0.85) return "\x1b[38;5;221m"; // medium-high: yellow
  return "\x1b[38;5;203m";                     // high: red
}

// Accent-only gradient (blue/cyan tones, no red) for non-CPU metrics
function sparkColorAccent(ratio) {
  if (ratio <= 0.01) return "\x1b[38;5;238m"; // near-zero: dark gray
  if (ratio <= 0.25) return "\x1b[38;5;60m";  // low: muted blue
  if (ratio <= 0.50) return "\x1b[38;5;68m";  // medium-low: steel blue
  if (ratio <= 0.75) return "\x1b[38;5;75m";  // medium: bright blue
  return "\x1b[38;5;117m";                     // high: cyan
}

// Green-to-red gradient for spend/token metrics
function sparkColorSpend(ratio) {
  if (ratio <= 0.01) return "\x1b[38;5;22m";  // near-zero: dark forest green
  if (ratio <= 0.25) return "\x1b[38;5;71m";  // low: muted green
  if (ratio <= 0.50) return "\x1b[38;5;114m"; // medium: green
  if (ratio <= 0.75) return "\x1b[38;5;186m"; // medium-high: yellow-green
  if (ratio <= 0.85) return "\x1b[38;5;221m"; // high: yellow
  return "\x1b[38;5;203m";                     // very high: red
}

/**
 * Render a single-row braille sparkline (column chart style).
 * Each character encodes a 1×4 column; bottom dot = bit 0x40, top = bit 0x01.
 * Braille bits for left column: row0=0x01, row1=0x02, row2=0x04, row3=0x40
 * We use only the left column of each braille cell for 1:1 char-to-value mapping.
 */
function renderBrailleSparkline(values, width, maxVal, colorMode) {
  const colorFn = colorMode === "cpu" ? sparkColor
    : colorMode === "spend" ? sparkColorSpend
    : sparkColorAccent;
  // Left-column braille bits, bottom-to-top: bit3(0x40), bit2(0x04), bit1(0x02), bit0(0x01)
  const bits = [0x40, 0x04, 0x02, 0x01]; // row 3, 2, 1, 0
  const baseline = String.fromCharCode(0x2800 | 0x40); // bottom dot only
  const dimBase = (colorMode === "spend" || colorMode === "cpu") ? "\x1b[38;5;22m" : "\x1b[38;5;236m";

  if (!values.length) {
    return (dimBase + baseline + RESET).repeat(width);
  }
  const start = Math.max(0, values.length - width);
  const visible = values.slice(start);

  let hi;
  if (maxVal > 0) {
    hi = maxVal;
  } else {
    hi = Math.max(...visible);
    if (hi <= 0) hi = 1;
    else hi *= 1.1;
  }

  let out = "";
  // Leading empty area
  if (visible.length < width) {
    const fill = width - visible.length;
    out += (dimBase + baseline + RESET).repeat(fill);
  }

  for (const v of visible) {
    if (v <= 0) {
      out += dimBase + baseline + RESET;
      continue;
    }
    const ratio = Math.max(0, Math.min(1, v / hi));
    // Map to 0-4 filled dots (bottom-up)
    const filled = Math.max(1, Math.round(ratio * 4));
    let code = 0x2800;
    for (let d = 0; d < filled; d++) code |= bits[d];
    out += colorFn(ratio) + String.fromCharCode(code) + RESET;
  }
  return out;
}

/**
 * Render a sparkline chart.
 *  maxVal > 0  → fixed scale (e.g. CPU 0-100)
 *  maxVal = 0  → auto-range: scale to [min..max] of visible values
 *                so even small variations produce visible bars
 */
function renderSparkline(values, width, maxVal, colorMode, style) {
  const colorFn = colorMode === "cpu" ? sparkColor
    : colorMode === "spend" ? sparkColorSpend
    : sparkColorAccent;
  const chars = SPARK_STYLES[style || "blocks"];
  const minChar = chars[1]; // smallest visible dot

  if (!values.length) {
    return ("\x1b[38;5;238m" + minChar + RESET).repeat(width);
  }
  const start = Math.max(0, values.length - width);
  const visible = values.slice(start);

  let lo, hi, isFlat = false;
  if (maxVal > 0) {
    lo = 0;
    hi = maxVal;
  } else {
    lo = Math.min(...visible);
    hi = Math.max(...visible);
    const range = hi - lo;
    if (range < hi * 0.01) {
      isFlat = true;
      lo = 0;
      hi = hi > 0 ? hi * 2 : 1;
    } else {
      hi += range * 0.1;
    }
  }

  let out = "";

  // Leading empty area — minimum dots instead of blank spaces
  if (visible.length < width) {
    const fill = width - visible.length;
    out += ("\x1b[38;5;238m" + minChar + RESET).repeat(fill);
  }

  const span = hi - lo || 1;
  for (const v of visible) {
    if (v <= 0) {
      out += "\x1b[38;5;238m" + minChar + RESET;
      continue;
    }
    if (isFlat) {
      out += colorFn(0.15) + chars[1] + RESET;
      continue;
    }
    const ratio = Math.max(0, Math.min(1, (v - lo) / span));
    // Non-linear mapping: sqrt boosts low values for better visibility
    const curved = Math.sqrt(ratio);
    const idx = Math.max(1, Math.min(8, Math.round(curved * 7) + 1));
    out += colorFn(ratio) + chars[idx] + RESET;
  }
  return out;
}

/** Round a value up to a "nice" chart maximum (1, 1.5, 2, 2.5, 3, 5, 7.5, 10 × 10^n). */
function niceMax(val) {
  if (val <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(val)));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];
  for (const s of steps) { if (s * mag >= val) return s * mag; }
  return 10 * mag;
}

/**
 * Render a braille line chart with Y-axis labels.
 * Returns array of (chartRows + 1) strings: data rows + bottom axis.
 * Each braille character = 2×4 dots, giving high-resolution line drawing.
 * totalWidth includes axis labels + chart area.
 */
function renderBrailleChart(values, totalWidth, chartRows, maxVal, colorMode, forceAxisW) {
  const colorFn = colorMode === "cpu" ? sparkColor
    : colorMode === "spend" ? sparkColorSpend
    : sparkColorAccent;

  const hi = maxVal > 0 ? maxVal : niceMax(values.length > 0 ? Math.max(...values) : 1);
  const maxLabelLen = Math.max(1, String(Math.ceil(hi)).length);
  const axisW = forceAxisW || (maxLabelLen + 2); // "NNN ┤"
  const chartCols = Math.max(4, totalWidth - axisW);
  const dotW = chartCols * 2;
  const dotH = chartRows * 4;

  // Braille dot bit positions: [x%2][y%4] → bit
  const BD = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]];
  const grid = Array.from({ length: chartRows }, () => new Uint8Array(chartCols));

  const start = Math.max(0, values.length - dotW);
  const vis = values.slice(start);
  const off = 0; // left-align: data grows left→right; blank is on right while filling

  function dot(x, y) {
    if (x < 0 || x >= dotW || y < 0 || y >= dotH) return;
    grid[y >> 2][x >> 1] |= BD[x & 1][y & 3];
  }

  // Plot data points and connect consecutive points with interpolated lines
  let prevY = -1;
  for (let i = 0; i < vis.length; i++) {
    const x = off + i;
    const ratio = Math.max(0, Math.min(1, vis[i] / hi));
    const y = Math.round((1 - ratio) * (dotH - 1));
    dot(x, y);
    if (prevY >= 0 && prevY !== y) {
      const yLo = Math.min(prevY, y), yHi = Math.max(prevY, y);
      for (let yy = yLo + 1; yy < yHi; yy++) {
        const frac = (yy - prevY) / (y - prevY);
        dot(Math.round(x - 1 + frac), yy);
      }
    }
    prevY = y;
  }

  // Per text-column color based on max data value in that column
  const colRatio = new Float32Array(chartCols);
  for (let i = 0; i < vis.length; i++) {
    const tc = (off + i) >> 1;
    if (tc >= 0 && tc < chartCols) {
      const r = Math.min(1, vis[i] / hi);
      if (r > colRatio[tc]) colRatio[tc] = r;
    }
  }

  const dimLabel = "\x1b[38;5;239m";
  const dimAxis = "\x1b[38;5;238m";
  const lines = [];

  for (let r = 0; r < chartRows; r++) {
    const tickVal = Math.round(hi * (chartRows - r) / chartRows);
    const label = String(tickVal).padStart(maxLabelLen);
    let line = dimLabel + label + dimAxis + " ┤" + RESET;
    for (let c = 0; c < chartCols; c++) {
      const bits = grid[r][c];
      const ch = String.fromCharCode(0x2800 + bits);
      line += (bits ? colorFn(colRatio[c]) : "\x1b[38;5;236m") + ch + RESET;
    }
    lines.push(line);
  }

  // Bottom axis with 0 label
  lines.push(dimLabel + String(0).padStart(maxLabelLen) + dimAxis + " └" + "─".repeat(chartCols) + RESET);
  return lines;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const LIST_TABS = ["Sessions"]; // Single unified list

// Shared column defs
const COL_STATUS = {
  key: "status", label: " ", width: 1, align: "left",
  desc: "Running status: ● running (bright=recent, dark=idle), ○ stopped",
  render: (s) => s.process ? "●" : "○",
  compare: (a, b) => (a.process ? 1 : 0) - (b.process ? 1 : 0),
};
const COL_LAST = {
  key: "active", label: "LAST", width: 5, align: "right",
  desc: "Time since last activity",
  render: (s, now) => relativeAge(s.last_active, now),
  compare: (a, b) => (b.last_active || "").localeCompare(a.last_active || ""),
};
const COL_DURATION = {
  key: "duration", label: "DUR", width: 6, align: "right",
  desc: "Session duration (first to last activity)",
  render: (s) => sessionDuration(s),
  compare: (a, b) => {
    const da = (parseTimestamp(a.last_active) || parseTimestamp(a.started_at) || new Date()).getTime() - (parseTimestamp(a.started_at) || new Date()).getTime();
    const db = (parseTimestamp(b.last_active) || parseTimestamp(b.started_at) || new Date()).getTime() - (parseTimestamp(b.started_at) || new Date()).getTime();
    return da - db;
  },
};
const COL_TOKENS = {
  key: "tokens", label: "TOK", width: 8, align: "right", desc: "Total tokens (input + output)",
  render: (s) => compactTokens((s.list_input_tokens || 0) + (s.list_output_tokens || 0)),
  compare: (a, b) => ((a.list_input_tokens || 0) + (a.list_output_tokens || 0)) - ((b.list_input_tokens || 0) + (b.list_output_tokens || 0)),
};
const COL_COST = {
  key: "cost", label: "$", width: 9, align: "right", desc: "Estimated cost based on per-token API pricing (LiteLLM).\nMany plans (Max, Pro, Team) are flat-rate or bundled,\nso actual billing may differ significantly.",
  render: (s) => compactUsd(s.list_total_cost),
  compare: (a, b) => {
    const ca = a.list_total_cost === "included" ? -1 : parseFloat(a.list_total_cost || 0);
    const cb = b.list_total_cost === "included" ? -1 : parseFloat(b.list_total_cost || 0);
    return ca - cb;
  },
};
const COL_TOOLS = {
  key: "tools", label: "TOOLS", width: 6, align: "right", desc: "Total tool invocations in session",
  render: (s) => s.list_tool_count > 0 ? String(s.list_tool_count) : "",
  compare: (a, b) => (a.list_tool_count || 0) - (b.list_tool_count || 0),
};
const COL_TOK_RATE = {
  key: "tok_rate", label: "TOK/m", width: 7, align: "right", desc: "Token rate (tokens per minute, EMA)",
  render: (s) => s.list_tokens_per_min > 0 ? compactTokens(Math.round(s.list_tokens_per_min)) : "",
  compare: (a, b) => (a.list_tokens_per_min || 0) - (b.list_tokens_per_min || 0),
};
const COL_COST_RATE = {
  key: "cost_rate", label: "$/m", width: 6, align: "right", desc: "Estimated cost rate (USD/min, EMA-smoothed).\nBased on per-token API pricing; flat-rate plans\n(Max, Pro, Team) are billed differently.",
  render: (s) => s.list_cost_per_min > 0.001 ? `$${s.list_cost_per_min.toFixed(2)}` : "",
  compare: (a, b) => (a.list_cost_per_min || 0) - (b.list_cost_per_min || 0),
};
const COL_CPU = {
  key: "cpu", label: "CPU%", width: 5, align: "right", desc: "CPU usage of session processes",
  render: (s) => s.process ? `${s.process.cpu}` : "\x1b[38;5;238m─\x1b[0m",
  compare: (a, b) => ((a.process && a.process.cpu) || 0) - ((b.process && b.process.cpu) || 0),
};
const COL_MEM = {
  key: "mem", label: "MEM", width: 6, align: "right", desc: "Memory usage of session processes",
  render: (s) => s.process ? compactBytes(s.process.memory) : "",
  compare: (a, b) => ((a.process && a.process.memory) || 0) - ((b.process && b.process.memory) || 0),
};
const COL_TOOLS_RATE = {
  key: "tools_rate", label: "+TL", width: 5, align: "right", desc: "Tool invocations since agtop started",
  render: (s) => s.list_tools_since_start > 0 ? String(s.list_tools_since_start) : "",
  compare: (a, b) => (a.list_tools_since_start || 0) - (b.list_tools_since_start || 0),
};
const COL_MODEL = {
  key: "model", label: "MODEL", width: 14, align: "left", desc: "AI model used by the session",
  render: (s) => (s.model || "").replace(/^claude-/, "").replace(/^gpt-/, ""),
  compare: (a, b) => (a.model || "").localeCompare(b.model || ""),
};
const COL_IN_TOKENS = {
  key: "in_tokens", label: "IN", width: 7, align: "right", desc: "Input tokens (prompts sent to model)",
  render: (s) => compactTokens(s.list_input_tokens || 0),
  compare: (a, b) => (a.list_input_tokens || 0) - (b.list_input_tokens || 0),
};
const COL_OUT_TOKENS = {
  key: "out_tokens", label: "OUT", width: 7, align: "right", desc: "Output tokens (model responses)",
  render: (s) => compactTokens(s.list_output_tokens || 0),
  compare: (a, b) => (a.list_output_tokens || 0) - (b.list_output_tokens || 0),
};
const COL_LAST_TOOL = {
  key: "last_tool", label: "LAST_TOOL", width: 14, align: "left", desc: "Most recently invoked tool",
  render: (s) => {
    const t = s.list_last_tool || "";
    return t.replace(/^mcp__[^_]+__/, "mcp:");
  },
  compare: (a, b) => (a.list_last_tool || "").localeCompare(b.list_last_tool || ""),
};
const COMPACT_THRESHOLD = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  ? parseInt(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 10) / 100
  : 0.835; // Claude compacts at ~83.5% of context window
const COL_CTX = {
  key: "ctx", label: "CTX%", width: 6, align: "right", desc: "Context window usage (% until auto-compact)",
  render: (s) => {
    if (!s.list_context) return "\x1b[38;5;238m─\x1b[0m";
    if (s.list_context.compacting) return "COMPCT";
    const compactAt = s.list_context.max * COMPACT_THRESHOLD;
    const pct = Math.round((s.list_context.used / compactAt) * 100);
    if (pct > 100) return "\x1b[1;38;5;203m>100%\x1b[0m";
    return pct + "%";
  },
  compare: (a, b) => {
    // Compacting sessions sort to top
    const ca = a.list_context && a.list_context.compacting ? 999 : 0;
    const cb = b.list_context && b.list_context.compacting ? 999 : 0;
    if (ca !== cb) return cb - ca;
    const pa = a.list_context ? a.list_context.used / (a.list_context.max * COMPACT_THRESHOLD) : -1;
    const pb = b.list_context ? b.list_context.used / (b.list_context.max * COMPACT_THRESHOLD) : -1;
    return pb - pa;
  },
};
const COL_COST_HOUR = {
  key: "cost_hour", label: "$/1H", width: 7, align: "right", desc: "Cost in the last hour",
  render: (s) => s.list_cost_hour > 0 ? compactUsd(s.list_cost_hour) : "\x1b[38;5;238m─\x1b[0m",
  compare: (a, b) => (a.list_cost_hour || 0) - (b.list_cost_hour || 0),
};
const COL_COST_TODAY = {
  key: "cost_today", label: "$/1D", width: 7, align: "right", desc: "Cost since midnight (local time)",
  render: (s) => s.list_cost_today > 0 ? compactUsd(s.list_cost_today) : "\x1b[38;5;238m─\x1b[0m",
  compare: (a, b) => (a.list_cost_today || 0) - (b.list_cost_today || 0),
};
const COL_PROJECT = {
  key: "project", label: "PROJECT", width: 0, align: "left", flex: true, desc: "Session title (if renamed) or working directory",
  render: (s) => s.title || s._abbrevLabel || s.label_source || "unknown",
  compare: (a, b) => (a.title || a.label_source || "").localeCompare(b.title || b.label_source || ""),
};

const SESSION_COLUMNS = [
  COL_STATUS, COL_LAST, COL_DURATION, COL_COST, COL_COST_HOUR, COL_COST_TODAY, COL_CTX, COL_CPU, COL_TOOLS, COL_MODEL, COL_PROJECT,
];

// Legacy aliases kept for non-interactive output and sort restore
const SUMMARY_COLUMNS = SESSION_COLUMNS;
const LIVE_COLUMNS = SESSION_COLUMNS;

/** Get active column set */
function activeColumns(_state) {
  return SESSION_COLUMNS;
}

// Back-compat alias used by non-interactive output
const COLUMNS = SESSION_COLUMNS;

// ---------------------------------------------------------------------------
// Quota: fetch usage limits from provider APIs
// ---------------------------------------------------------------------------

const QUOTA_TTL_MS = 30_000; // refetch every 30s
const QUOTA_INTERVAL_TICKS = 5; // only attempt every 5th loadSessions tick
let _quotaCache = { ts: 0, fetched: false, claude: null, codex: null };

// Both API keys (sk-ant-api...) and OAuth access tokens (sk-ant-oat...) start with "sk-ant-",
// so the API-key check must use the longer prefix to avoid misclassifying subscription tokens.
function isClaudeApiKey(tok) {
  return typeof tok === "string" && tok.startsWith("sk-ant-api");
}

// Claude Code stores credentials as JSON ({"claudeAiOauth":{"accessToken":...}}) in the
// keychain and credentials file; very old builds may have stored a bare token string.
function extractClaudeToken(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    return obj?.claudeAiOauth?.accessToken
      || obj?.claudeAiOauth?.access_token
      || obj?.accessToken
      || obj?.access_token
      || null;
  } catch {
    return s;
  }
}

/**
 * Read Claude credential from macOS keychain or ~/.claude/.credentials.json.
 * Returns { type: "oauth", token } | { type: "api_key" } | { type: "none" }.
 */
function readClaudeCredential() {
  // Try keychain first (macOS). Current Claude Code uses "Claude Code-credentials";
  // older builds used "Claude Code".
  if (process.platform === "darwin") {
    for (const svc of ["Claude Code-credentials", "Claude Code"]) {
      try {
        const raw = execSync(
          `security find-generic-password -s "${svc}" -w 2>/dev/null`,
          { encoding: "utf-8", timeout: 3000 }
        );
        const tok = extractClaudeToken(raw);
        if (tok) {
          if (isClaudeApiKey(tok)) return { type: "api_key" };
          return { type: "oauth", token: tok };
        }
      } catch { /* try next */ }
    }
  }
  // Fallback: credentials file
  try {
    const credPath = join(CLAUDE_CONFIG_DIR, ".credentials.json");
    const tok = extractClaudeToken(readFileSync(credPath, "utf-8"));
    if (tok) {
      if (isClaudeApiKey(tok)) return { type: "api_key" };
      return { type: "oauth", token: tok };
    }
  } catch { /* no file */ }
  // Fallback: ~/.claude.json (used by native Claude Code installs on Windows/Linux)
  try {
    const claudeJson = join(homedir(), ".claude.json");
    const data = JSON.parse(readFileSync(claudeJson, "utf-8"));
    if (isClaudeApiKey(data.primaryApiKey)) return { type: "api_key" };
    const tok = data.oauthAccount?.accessToken || data.oauthAccount?.access_token;
    if (tok) {
      if (isClaudeApiKey(tok)) return { type: "api_key" };
      return { type: "oauth", token: tok };
    }
  } catch { /* no file */ }
  return { type: "none" };
}

/**
 * Read Codex access token from ~/.codex/auth.json
 */
function readCodexToken() {
  try {
    const authPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    if (auth.tokens && auth.tokens.access_token) return auth.tokens.access_token;
    if (auth.access_token) return auth.access_token;
  } catch { /* no file */ }
  return null;
}

/**
 * Read Claude account info from ~/.claude.json.
 * Returns { email, organization, role } | null.
 */
let _claudeAccountCache = undefined;
function readClaudeAccount() {
  if (_claudeAccountCache !== undefined) return _claudeAccountCache;
  try {
    const claudeJson = join(HOME, ".claude.json");
    const data = JSON.parse(readFileSync(claudeJson, "utf-8"));
    const oa = data.oauthAccount;
    if (oa && oa.emailAddress) {
      _claudeAccountCache = {
        email: oa.emailAddress,
        organization: oa.organizationName || null,
        role: oa.organizationRole || null,
      };
      return _claudeAccountCache;
    }
  } catch { /* no file or no oauth account */ }
  _claudeAccountCache = null;
  return null;
}

/**
 * Read Codex account info by decoding the id_token JWT in ~/.codex/auth.json.
 * Returns { email, name } | null.
 */
let _codexAccountCache = undefined;
function readCodexAccount() {
  if (_codexAccountCache !== undefined) return _codexAccountCache;
  try {
    const authPath = join(process.env.CODEX_HOME || join(HOME, ".codex"), "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    const idToken = auth.tokens?.id_token;
    if (!idToken) {
      _codexAccountCache = null;
      return null;
    }
    const parts = idToken.split(".");
    if (parts.length < 2) {
      _codexAccountCache = null;
      return null;
    }
    // Decode the JWT payload (base64url)
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf-8"));
    _codexAccountCache = {
      email: payload.email || null,
      name: payload.name || null,
    };
    return _codexAccountCache;
  } catch { /* no file or invalid token */ }
  _codexAccountCache = null;
  return null;
}

/**
 * Fetch Claude usage quota via OAuth API.
 * Returns { provider, ... quota windows } | { provider, api_billing } | null.
 */
async function fetchClaudeQuota() {
  const cred = readClaudeCredential();
  if (cred.type === "api_key") return { provider: "claude", api_billing: true };
  if (cred.type === "none") return null;
  const token = cred.token;
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // Normalize: each window has { utilization: 0-100 (percent), resets_at: ISO|epoch }
    const result = { provider: "claude" };
    for (const key of ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "extra_usage"]) {
      if (data[key] && typeof data[key].utilization === "number") {
        result[key] = {
          pct: Math.round(data[key].utilization),
          resets_at: data[key].resets_at || null,
        };
      }
    }
    if (data.rate_limit_tier) result.plan = data.rate_limit_tier;
    return Object.keys(result).length > 1 ? result : null;
  } catch { return null; }
}

/**
 * Fetch Codex usage quota via ChatGPT backend API.
 * Returns { plan_type, primary_window, secondary_window } or null.
 */
async function fetchCodexQuota() {
  const token = readCodexToken();
  if (!token) return null;
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.rate_limit) return null;
    const result = { provider: "codex" };
    if (data.plan_type) result.plan = data.plan_type;
    const rl = data.rate_limit;
    if (rl.primary_window) {
      result.primary = {
        pct: rl.primary_window.used_percent || 0,
        resets_at: rl.primary_window.reset_at || null,
        window_secs: rl.primary_window.limit_window_seconds || 18000,
      };
    }
    if (rl.secondary_window) {
      result.secondary = {
        pct: rl.secondary_window.used_percent || 0,
        resets_at: rl.secondary_window.reset_at || null,
        window_secs: rl.secondary_window.limit_window_seconds || 604800,
      };
    }
    result.limit_reached = rl.limit_reached || false;
    const crl = data.code_review_rate_limit;
    if (crl && crl.primary_window) {
      result.code_review = {
        pct: crl.primary_window.used_percent || 0,
        resets_at: crl.primary_window.reset_at || null,
      };
      if (crl.limit_reached) result.limit_reached = true;
    }
    return result;
  } catch { return null; }
}

/**
 * Fetch quota for all providers. Cached with TTL.
 */
async function fetchQuota() {
  const now = Date.now();
  if (now - _quotaCache.ts < QUOTA_TTL_MS) return _quotaCache;
  const [claude, codex] = await Promise.all([
    fetchClaudeQuota().catch(() => null),
    fetchCodexQuota().catch(() => null),
  ]);
  _quotaCache = { ts: now, fetched: true, claude: claude || _quotaCache.claude, codex: codex || _quotaCache.codex };
  return _quotaCache;
}

// ---------------------------------------------------------------------------
// Tier 2: OS process metrics (posix backend)
// ---------------------------------------------------------------------------

const TIER2_INTERVAL_TICKS = 1; // collect every loadSessions tick
const LSOF_CHUNK_SIZE = 50;
const PID_TREE_TTL_MS = 15_000; // cache subtree PIDs for 15s
const PROC_LINGER_TICKS = 3; // keep exited sub-processes visible for N collection cycles
const _procGhostCache = new Map(); // sessionKey → Map<pid, { entry, remaining }>

// Minimal pidusage: runs ps to get CPU% and RSS for a set of PIDs.
function pidusage(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  const isDarwin = process.platform === "darwin";
  const args = isDarwin
    ? ["-p", pids.join(","), "-o", "pid=,pcpu=,rss="]
    : ["-p", pids.join(","), "-o", "pid=,pcpu=,rss="];
  return new Promise((resolve) => {
    const proc = spawn("ps", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("close", () => {
      const result = new Map();
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10);
          const cpu = parseFloat(parts[1]) || 0;
          const rss = (parseInt(parts[2], 10) || 0) * 1024; // KB → bytes
          if (pid > 0) result.set(pid, { cpu, memory: rss });
        }
      }
      resolve(result);
    });
    proc.on("error", () => resolve(new Map()));
  });
}

// Run a single ps to get a full snapshot of all processes.
function psSnapshot() {
  const isDarwin = process.platform === "darwin";
  const args = isDarwin
    ? ["-Aww", "-o", "pid=,ppid=,args="]
    : ["-eo", "pid=,ppid=,args=", "ww"];
  return new Promise((resolve) => {
    const proc = spawn("ps", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("close", () => {
      const procs = new Map(); // pid → { ppid, args }
      for (const line of out.split("\n")) {
        const trimmed = line.trimStart();
        const sp1 = trimmed.indexOf(" ");
        if (sp1 < 0) continue;
        const pid = parseInt(trimmed.slice(0, sp1), 10);
        const rest = trimmed.slice(sp1).trimStart();
        const sp2 = rest.indexOf(" ");
        if (sp2 < 0) continue;
        const ppid = parseInt(rest.slice(0, sp2), 10);
        const args = rest.slice(sp2).trimStart();
        if (pid > 0) procs.set(pid, { ppid, args });
      }
      resolve(procs);
    });
    proc.on("error", () => resolve(new Map()));
  });
}

// BFS to collect all descendant PIDs from a childrenByPpid map.
function bfsDescendants(rootPid, childrenByPpid) {
  const result = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const children = childrenByPpid.get(pid);
    if (children) {
      for (const child of children) {
        if (!result.has(child)) {
          result.add(child);
          queue.push(child);
        }
      }
    }
  }
  return result;
}

// Extract session UUID from Claude/Codex command line args.
const RESUME_UUID_RE = /\bresume\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/;
// Match "claude" / "codex" as a command (binary name), not as part of a path
// like ~/.claude/projects/... — require start-of-string or "/" before, whitespace
// or end-of-string after, so ".claude/" in a path does NOT match.
const DAEMON_RE = /\b(app-server|server|daemon)\b/;

// lsof-based fallback: find session UUID by checking open files.
let _lsofCache = new Map(); // pid → { uuid, cwd, ts }
let _lsofCacheTs = 0;
let _orphanProcessInfo = new Map(); // syntheticKey → { pid, provider, cwd }

function lsofLookup(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  // Chunk pids to avoid ARG_MAX
  const chunks = [];
  for (let i = 0; i < pids.length; i += LSOF_CHUNK_SIZE) {
    chunks.push(pids.slice(i, i + LSOF_CHUNK_SIZE));
  }
  return new Promise((resolve) => {
    const result = new Map(); // pid → { uuid?, cwd? }
    let pending = chunks.length;
    if (pending === 0) { resolve(result); return; }
    for (const chunk of chunks) {
      const args = ["-p", chunk.join(","), "-Fn"];
      const proc = spawn("lsof", args, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.on("close", () => {
        let currentPid = null;
        let isCwd = false;
        for (const line of out.split("\n")) {
          if (line.startsWith("p")) { currentPid = parseInt(line.slice(1), 10) || null; isCwd = false; }
          else if (line.startsWith("f") && currentPid) { isCwd = line === "fcwd"; }
          else if (line.startsWith("n") && currentPid) {
            const path = line.slice(1);
            if (!result.has(currentPid)) result.set(currentPid, {});
            const entry = result.get(currentPid);
            if (isCwd) { entry.cwd = path; isCwd = false; }
            // Look for UUID in path (Claude session files)
            const m = path.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/);
            if (m && !entry.uuid) entry.uuid = m[1];
          }
        }
        if (--pending === 0) resolve(result);
      });
      proc.on("error", () => { if (--pending === 0) resolve(result); });
    }
  });
}

// ---------------------------------------------------------------------------
// Windows backend: PowerShell-based process snapshot
// ---------------------------------------------------------------------------

// Tracks previous CPU time (100ns units) per PID for delta-based CPU%.
const _winPrevCpu = new Map(); // pid → { cpuTime, ts }

function psSnapshotWindows() {
  // Single PowerShell call: get all processes with ppid, cmdline, memory, cpu time.
  const script =
    "Get-CimInstance Win32_Process " +
    "| Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingDirectory,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime " +
    "| ConvertTo-Json -Compress -Depth 1";
  return new Promise((resolve) => {
    const proc = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.on("close", () => {
      try {
        const raw = JSON.parse(out.trim());
        const arr = Array.isArray(raw) ? raw : [raw];
        const procs = new Map(); // pid → { ppid, args, memory, cpu }
        const now = Date.now();
        const numCpus = cpus().length || 1;
        for (const p of arr) {
          const pid = p.ProcessId;
          if (!pid || pid <= 0) continue;
          const cpuTime = (p.KernelModeTime || 0) + (p.UserModeTime || 0);
          const prev = _winPrevCpu.get(pid);
          let cpu = 0;
          if (prev && now > prev.ts) {
            // cpuTime is in 100ns units; convert delta to ms: * 0.0001
            const dtMs = now - prev.ts;
            const dtCpu = Math.max(0, cpuTime - prev.cpuTime);
            cpu = Math.min(100, (dtCpu * 0.0001 / dtMs / numCpus) * 100);
          }
          _winPrevCpu.set(pid, { cpuTime, ts: now });
          // CreationDate is serialized as "/Date(ms)/" by ConvertTo-Json
          const cdMatch = String(p.CreationDate || "").match(/Date\((\d+)\)/);
          const createdAt = cdMatch ? parseInt(cdMatch[1], 10) : 0;
          procs.set(pid, {
            ppid: p.ParentProcessId || 0,
            name: (p.Name || "").toLowerCase(),
            args: p.CommandLine || "",
            cwd: (p.WorkingDirectory || "").replace(/\\/g, "/"),
            createdAt,
            memory: p.WorkingSetSize || 0,
            cpu,
          });
        }
        resolve(procs);
      } catch {
        resolve(new Map());
      }
    });
    proc.on("error", () => resolve(new Map()));
  });
}

async function collectProcessMetricsWindows(sessions) {
  const snapshot = await psSnapshotWindows();
  if (snapshot.size === 0) return new Map();

  // Build childrenByPpid
  const childrenByPpid = new Map();
  for (const [pid, info] of snapshot) {
    const list = childrenByPpid.get(info.ppid);
    if (list) list.push(pid);
    else childrenByPpid.set(info.ppid, [pid]);
  }

  // Identify Claude/Codex root processes and map to session UUID via --resume arg.
  // Fall back to cwd-based matching, then creation-time matching if no UUID in args.
  const rootPids = new Map(); // sessionKey → rootPid

  // Build cwd→session lookup for fallback (normalize to lowercase forward-slashes)
  const cwdToSession = new Map();
  for (const s of sessions) {
    if (!s.label_source) continue;
    const normalizedCwd = s.label_source.replace(/\\/g, "/").toLowerCase();
    const existing = cwdToSession.get(normalizedCwd);
    if (!existing || (s.last_active && (!existing.last_active || s.last_active > existing.last_active))) {
      cwdToSession.set(normalizedCwd, s);
    }
  }

  // Collect no-resume processes for creation-time fallback
  const noResume = []; // { pid, info, provider }

  for (const [pid, info] of snapshot) {
    const args = info.args || "";
    const name = info.name || ""; // e.g. "claude.exe", "node.exe", "codex.exe"
    // Detect by process name (reliable) or by script path for Node-hosted codex.
    // Exclude .app bundles (Desktop apps and their helpers)
    const isAppBundle = /\.app[/\\]/.test(args);
    const isClaudeProc = (name === "claude.exe" || name === "claude") && !isAppBundle;
    let isCodexNode = false;
    if (name === "node.exe" && !isAppBundle) {
      const tokens = args.split(/\s+/);
      for (let t = 1; t < tokens.length && t < 4; t++) {
        if (tokens[t].startsWith("-")) continue;
        const scriptBase = tokens[t].replace(/.*[/\\]/, "").replace(/\.js$/, "").toLowerCase();
        if (scriptBase === "codex") { isCodexNode = true; break; }
        break;
      }
    }
    const isCodexProc = ((name === "codex.exe" || name === "codex") && !isAppBundle) || isCodexNode;
    if (!isClaudeProc && !isCodexProc) continue;
    if (DAEMON_RE.test(args)) continue;

    const provider = isCodexProc ? "codex" : "claude";
    const resumeMatch = args.match(RESUME_UUID_RE);
    if (resumeMatch) {
      rootPids.set(`${provider}:${resumeMatch[1]}`, pid);
    } else {
      // Try CWD-based match first (WorkingDirectory from Win32_Process, when available).
      const procCwd = info.cwd ? info.cwd.toLowerCase() : "";
      if (procCwd) {
        const session = cwdToSession.get(procCwd);
        if (session) {
          const key = `${session.provider}:${session.session_id}`;
          if (!rootPids.has(key)) rootPids.set(key, pid);
          continue;
        }
      }
      // Queue for creation-time fallback (Win32_Process.WorkingDirectory is often null).
      if (info.createdAt) noResume.push({ pid, info, provider });
    }
  }

  // Creation-time fallback: match process start time against session started_at.
  // The process starts a few seconds before the first JSONL entry is written,
  // so we look for the session whose started_at is closest and within 60s.
  if (noResume.length > 0) {
    const unmatched = sessions.filter((s) => {
      const key = `${s.provider}:${s.session_id}`;
      return !rootPids.has(key) && s.started_at;
    });
    for (const { pid, info, provider } of noResume) {
      const procMs = info.createdAt;
      let bestSession = null;
      let bestDiff = Infinity;
      for (const s of unmatched) {
        if (s.provider !== provider) continue;
        const sessionMs = new Date(s.started_at).getTime();
        // Session is written after process starts; allow up to 60s gap.
        const diff = sessionMs - procMs;
        if (diff >= 0 && diff < 60_000 && diff < bestDiff) {
          bestDiff = diff;
          bestSession = s;
        }
      }
      if (bestSession) {
        const key = `${bestSession.provider}:${bestSession.session_id}`;
        if (!rootPids.has(key)) rootPids.set(key, pid);
      }
    }
  }

  // BFS descendants + aggregate cpu/memory per session
  const result = new Map();
  for (const [key, rootPid] of rootPids) {
    const pids = bfsDescendants(rootPid, childrenByPpid);
    let totalCpu = 0, totalMemory = 0;
    const processList = [];
    for (const pid of pids) {
      const u = snapshot.get(pid);
      const info = snapshot.get(pid);
      if (u) {
        totalCpu += u.cpu;
        totalMemory += u.memory;
        processList.push({ pid, cpu: u.cpu, memory: u.memory, args: (info && info.args) || "", isRoot: pid === rootPid });
      }
    }
    const rootInfo = snapshot.get(rootPid);
    result.set(key, {
      pids: pids.size,
      cpu: Math.round(totalCpu * 10) / 10,
      memory: totalMemory,
      command: rootInfo ? rootInfo.args : "",
      processList,
    });
  }
  return result;
}

async function collectProcessMetrics(sessions) {
  if (process.platform === "win32") return collectProcessMetricsWindows(sessions);
  _orphanProcessInfo.clear();

  const snapshot = await psSnapshot();
  if (snapshot.size === 0) return new Map();

  // Build childrenByPpid
  const childrenByPpid = new Map();
  for (const [pid, info] of snapshot) {
    const list = childrenByPpid.get(info.ppid);
    if (list) list.push(pid);
    else childrenByPpid.set(info.ppid, [pid]);
  }

  // Identify root processes (Claude/Codex) and extract session UUID from argv
  const rootPids = new Map(); // sessionKey → rootPid
  const unmappedClaude = []; // PIDs where Claude process found but no --resume UUID
  const unmappedCodex = [];

  for (const [pid, info] of snapshot) {
    const args = info.args || "";
    // Extract basename of argv[0] — reliable regardless of install path.
    const argv0 = args.split(" ")[0];
    const base = argv0.replace(/.*[/\\]/, "").replace(/\.js$/, "").toLowerCase();
    // Exclude macOS .app bundles (Claude Desktop / Codex Desktop and their helpers)
    const isAppBundle = /\.app[/\\]/.test(args);
    const isClaudeProc = base === "claude" && !isAppBundle;
    // Node-hosted codex: check that the script argument (not just any path) is "codex"
    let isCodexNode = false;
    if (base === "node" && !isAppBundle) {
      const tokens = args.split(/\s+/);
      for (let t = 1; t < tokens.length && t < 4; t++) {
        if (tokens[t].startsWith("-")) continue; // skip flags
        const scriptBase = tokens[t].replace(/.*[/\\]/, "").replace(/\.js$/, "").toLowerCase();
        if (scriptBase === "codex") { isCodexNode = true; break; }
        break; // only check first non-flag argument (the script)
      }
    }
    const isCodexProc = (base === "codex" && !isAppBundle) || isCodexNode;
    if (!isClaudeProc && !isCodexProc) continue;
    if (DAEMON_RE.test(args)) continue; // skip background daemons (e.g. codex app-server)

    const resumeMatch = args.match(RESUME_UUID_RE);
    if (resumeMatch) {
      const uuid = resumeMatch[1];
      const provider = isCodexProc ? "codex" : "claude";
      const key = `${provider}:${uuid}`;
      rootPids.set(key, pid);
    } else {
      if (isClaudeProc) unmappedClaude.push(pid);
      else unmappedCodex.push(pid);
    }
  }

  // lsof fallback for unmapped Claude/Codex PIDs (check open files for UUID + cwd)
  const unmapped = [
    ...unmappedClaude.map(p => ({ pid: p, provider: "claude" })),
    ...unmappedCodex.map(p => ({ pid: p, provider: "codex" })),
  ];
  if (unmapped.length > 0) {
    const now = Date.now();
    const allUnmappedPids = unmapped.map(u => u.pid);
    // Only re-run lsof if cache is stale
    const needsLsof = allUnmappedPids.filter((pid) => {
      const cached = _lsofCache.get(pid);
      return !cached || (now - cached.ts > PID_TREE_TTL_MS);
    });
    if (needsLsof.length > 0) {
      const lsofResult = await lsofLookup(needsLsof);
      for (const [pid, info] of lsofResult) {
        _lsofCache.set(pid, { uuid: info.uuid || null, cwd: info.cwd || null, ts: now });
      }
    }

    // Build cwd→session lookup for cwd-based matching (prefer most recent)
    const cwdToSession = new Map();
    for (const s of sessions) {
      if (!s.label_source) continue;
      const existing = cwdToSession.get(s.label_source);
      if (!existing || (s.last_active && (!existing.last_active || s.last_active > existing.last_active))) {
        cwdToSession.set(s.label_source, s);
      }
    }

    for (const { pid, provider } of unmapped) {
      const cached = _lsofCache.get(pid);
      if (!cached) continue;
      if (cached.uuid) {
        const key = `${provider}:${cached.uuid}`;
        if (!rootPids.has(key)) rootPids.set(key, pid);
      } else if (cached.cwd) {
        // cwd-based fallback: find most recent session matching this working directory
        const session = cwdToSession.get(cached.cwd);
        if (session) {
          const key = `${session.provider}:${session.session_id}`;
          if (!rootPids.has(key)) rootPids.set(key, pid);
        } else {
          // Truly orphan: running process with no session file yet
          const syntheticKey = `${provider}:_pid_${pid}`;
          rootPids.set(syntheticKey, pid);
          _orphanProcessInfo.set(syntheticKey, { pid, provider, cwd: cached.cwd });
        }
      }
    }
  }

  // Build descendant sets for each session
  const sessionPids = new Map(); // sessionKey → Set<pid>
  for (const [key, rootPid] of rootPids) {
    sessionPids.set(key, bfsDescendants(rootPid, childrenByPpid));
  }

  // Collect all PIDs that need usage info
  const allPids = new Set();
  for (const pids of sessionPids.values()) {
    for (const pid of pids) allPids.add(pid);
  }

  // Get CPU/memory for all PIDs in one batched call
  const usage = await pidusage([...allPids]);

  // Aggregate per session
  const result = new Map();
  for (const [key, pids] of sessionPids) {
    let totalCpu = 0;
    let totalMemory = 0;
    const rootPid = rootPids.get(key);
    const processList = [];
    for (const pid of pids) {
      const u = usage.get(pid);
      if (u) {
        totalCpu += u.cpu;
        totalMemory += u.memory;
        const info = snapshot.get(pid);
        processList.push({ pid, cpu: u.cpu, memory: u.memory, args: (info && info.args) || "", isRoot: pid === rootPid });
      }
    }
    const rootInfo = snapshot.get(rootPid);
    result.set(key, {
      pids: pids.size,
      cpu: Math.round(totalCpu * 10) / 10,
      memory: totalMemory,
      command: rootInfo ? rootInfo.args : "",
      processList,
    });
  }

  return result;
}

// Merge recently-exited processes back into processList for PROC_LINGER_TICKS cycles.
function applyProcLinger(key, pm) {
  if (!_procGhostCache.has(key)) _procGhostCache.set(key, new Map());
  const ghost = _procGhostCache.get(key);
  const currentPids = new Set(pm.processList.map((p) => p.pid));
  // Refresh cache for still-alive pids
  for (const p of pm.processList) {
    ghost.set(p.pid, { entry: { ...p }, remaining: PROC_LINGER_TICKS });
  }
  // Re-inject recently exited pids as ghost entries
  for (const [pid, cached] of ghost) {
    if (currentPids.has(pid)) continue;
    if (cached.remaining > 0) {
      pm.processList.push({ ...cached.entry, ghost: true, cpu: 0 });
      cached.remaining--;
    } else {
      ghost.delete(pid);
    }
  }
}

// ---------------------------------------------------------------------------
// TUI state
// ---------------------------------------------------------------------------

function createState() {
  return {
    sessions: [],
    filtered: [],
    sortCol: "active",
    sortAsc: true,
    _tabSort: [{ col: "active", asc: true }, { col: "active", asc: true }], // per list-tab sort
    scrollOffset: 0,
    hScroll: 0,
    selectedRow: 0,
    searchQuery: "",
    inactivityFilter: null, // null | "1d" | "1w" | "1mo"
    _inactivityCursor: 3, // index into INACTIVITY_OPTIONS (default: "No filter")
    mode: "list", // "list" | "detail" | "search" | "help" | "sortby" | "delete" | "inactivity"
    sortbyIdx: 0, // cursor position in sort-by sidebar
    detailSession: null,
    detailData: null,
    panelData: null,
    _panelSessionId: null,
    _needsPanelLoad: false,
    codexPlan: "retail",
    claudePlan: "retail",
    stats: null,
    dirty: true,
    quit: false,
    headerLines: 4, // number of header lines (boxTop + 2 content + boxBottom)
    _processMetrics: new Map(),
    _tier2Tick: TIER2_INTERVAL_TICKS - 1,
    bottomTab: 0, // 0=Info, 1=Performance, 2=Processes, 3=Tool Activity, 4=Cost, 5=Config
    hoverTab: -1, // tab index being hovered, -1 = none
    listTab: 0, // 0=Sessions, 1=Live Sessions
    hoverListTab: -1, // list tab hover, -1 = none
    configSubTab: 0, // active sub-tab in Config panel
    procSort: "cpu",    // "pid" | "cpu" | "mem" | "cmd" — Processes panel sort column
    procSortDesc: true, // sort direction for Processes panel
    procScroll: 0,      // scroll offset in Processes panel
    _procHeaderRow: 0,  // 1-based row of the Processes panel header line
    infoScroll: 0, // scroll offset in Info panel content
    _infoScrollbar: null, // scrollbar geometry for Info panel
    _infoScrollbarHover: false,
    _infoScrollbarDrag: false,
    _infoDragStartRow: 0,
    _infoDragStartScroll: 0,
    costScroll: 0, // scroll offset in Cost panel content
    _costScrollbar: null, // scrollbar geometry for Cost panel
    _agentScrollbar: null, // scrollbar geometry for Tool Activity panel
    _costScrollbarHover: false,
    _costScrollbarDrag: false,
    _costDragStartRow: 0,
    _costDragStartScroll: 0,
    configScroll: 0, // scroll offset in Config panel content
    subagentScroll: 0, // scroll offset in Subagents panel
    expandedSubagents: new Set(), // session keys ("provider:session_id") with subagents expanded in the list
    flatList: [],     // virtual rows: [{type:"session"|"marker"|"subagent", session, subagent?, expanded?}]
    configSubTabHover: -1, // hover over config sub-tab
    _configPanelTop: 0, // 1-based row of first content row in config panel
    _configCopyTargets: [], // [{row, copyPath}]
    _configCopyFlash: -1, // row index of flashing copy icon
    _configCopyFlashTs: 0, // timestamp of copy flash
    _configScrollbar: null, // scrollbar geometry {col, thumbStart, thumbEnd, ...}
    _configScrollbarHover: false, // mouse over scrollbar thumb
    _configScrollbarDrag: false, // dragging scrollbar
    _configDragStartRow: 0, // row where drag started
    _configDragStartScroll: 0, // scroll offset when drag started
    agentToolTab: 0, // selected tool tab index in Tool Activity panel
    agentToolScroll: -1, // scroll offset in tool invocation list (-1 = auto-scroll to bottom)
    agentLiveFilter: false, // show only invocations since agtop started
    agentTabScroll: 0, // scroll offset for tool sidebar (when many tools)
    hoverAgentToolTab: -1, // hover over tool tab, -1 = none
    _agentToolTabs: [], // [{row, idx}] computed during render
    _agentCopyTargets: [], // [{row, value}] for copy icons
    _agentCopyFlash: -1, // content index of flashing copy icon
    _agentCopyFlashTs: 0, // timestamp of copy flash
    _agentToolCounts: {}, // previous tool counts for flash detection
    _agentToolFlash: {}, // {toolName: timestamp} for count-change flash
    _agentPrevMaxScroll: undefined, // previous maxContentScroll for auto-scroll tracking
    _colFlash: {}, // {sessionKey: {tools: ts, tools_rate: ts}} flash timestamps
    _colPrev: {},  // {sessionKey: {tools: count, tools_rate: count}} previous values
    _hoverAgentArrow: "", // "up" or "down" or ""
    _hoverColKey: null, // column key being hovered on header row
    _quota: { ts: 0, fetched: false, claude: null, codex: null }, // provider quota data
    _quotaTick: QUOTA_INTERVAL_TICKS - 1, // fetch on first tick
  };
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function computeStats(sessions) {
  let totalClaude = 0, totalCodex = 0;
  let active1h = 0, active24h = 0, active7d = 0;
  let totalInput = 0, totalOutput = 0;
  let spendClaude = 0, spendCodex = 0;
  const models = {};
  let oldestStart = null;
  const now = Date.now();
  const h1 = 3600_000, h24 = 86400_000, d7 = 604800_000;

  // Spend windows (local-time boundaries)
  const nowMs = Date.now();
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
  const todayKey  = localDateKey(today);
  const weekKey   = localDateKey(new Date(today.getTime() - 6 * 86400_000));
  const monthKey  = localDateKey(new Date(today.getTime() - 29 * 86400_000));
  const hourKey   = localHourKey(new Date(nowMs));
  let spendToday = 0, spendWeek = 0, spendMonth = 0, spendHour = 0;

  let totalCpu = 0, totalMemory = 0, totalTools = 0;

  for (const s of sessions) {
    if (s.provider === "claude") totalClaude++;
    else totalCodex++;

    const lastActive = parseTimestamp(s.last_active);
    if (lastActive) {
      const age = now - lastActive.getTime();
      if (age < h1) active1h++;
      if (age < h24) active24h++;
      if (age < d7) active7d++;
    }

    const started = parseTimestamp(s.started_at);
    if (started && (!oldestStart || started < oldestStart)) oldestStart = started;

    totalInput += s.list_input_tokens || 0;
    totalOutput += s.list_output_tokens || 0;
    totalTools += s.list_tool_count || 0;

    if (s.process) {
      totalCpu += s.process.cpu || 0;
      totalMemory += s.process.memory || 0;
    }

    const cost = s.list_total_cost;
    if (cost && cost !== "included") {
      const v = parseFloat(cost);
      if (!isNaN(v)) {
        if (s.provider === "claude") spendClaude += v;
        else spendCodex += v;
      }
    }

    // Spend window accumulation
    if (s.costs_by_day) {
      for (const [day, models] of Object.entries(s.costs_by_day)) {
        const amt = typeof models === "object" ? Object.values(models).reduce((a, b) => a + b, 0) : models;
        if (day >= monthKey) spendMonth += amt;
        if (day >= weekKey)  spendWeek  += amt;
        if (day >= todayKey) spendToday += amt;
      }
    }
    if (s.costs_by_hour) {
      const amt = s.costs_by_hour[hourKey];
      if (amt) spendHour += typeof amt === "object" ? Object.values(amt).reduce((a, b) => a + b, 0) : amt;
    }

    if (s.model) {
      // Shorten model name for stats display
      const short = s.model.replace(/^claude-/, "").replace(/-202\d+$/, "");
      models[short] = (models[short] || 0) + 1;
    }
  }

  let uptime = "n/a";
  if (oldestStart) {
    const secs = Math.floor((now - oldestStart.getTime()) / 1000);
    if (secs < 3600) uptime = `${Math.floor(secs / 60)}m`;
    else if (secs < 86400) uptime = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
    else uptime = `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
  }

  return {
    total: sessions.length,
    totalClaude, totalCodex,
    active1h, active24h, active7d,
    totalInput, totalOutput,
    totalCpu: Math.round(totalCpu * 10) / 10,
    totalMemory,
    totalTools,
    spendTotal: spendClaude + spendCodex,
    spendClaude, spendCodex,
    spendHour, spendToday, spendWeek, spendMonth,
    models,
    uptime,
  };
}

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------

function applySortAndFilter(state) {
  let list = state.sessions;

  // Live tab: only show sessions with a running process
  if (state.listTab === 1) {
    list = list.filter((s) => !!s.process);
  }

  // Inactivity filter
  if (state.inactivityFilter) {
    const now = Date.now();
    const ms = { "1d": 86400000, "1w": 604800000, "1mo": 2592000000 }[state.inactivityFilter] || 0;
    if (ms) list = list.filter(s => {
      const t = s.last_active || s.started_at || "";
      return t && (now - new Date(t).getTime()) <= ms;
    });
  }

  // Filter by search query
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter((s) => {
      const project = (s.label_source || "").toLowerCase();
      const model = (s.model || "").toLowerCase();
      const provider = (s.provider || "").toLowerCase();
      const sid = (s.session_id || "").toLowerCase();
      return project.includes(q) || model.includes(q) || provider.includes(q) || sid.includes(q);
    });
  }

  // Sort using active column set
  const cols = activeColumns(state);
  const col = cols.find((c) => c.key === state.sortCol);
  if (col) {
    list = [...list].sort((a, b) => {
      const cmp = col.compare(a, b);
      return state.sortAsc ? cmp : -cmp;
    });
  }

  // Abbreviate project labels
  const labels = abbreviatePaths(list.map((s) => s.label_source));
  for (let i = 0; i < list.length; i++) {
    list[i]._abbrevLabel = labels[i];
  }

  state.filtered = list;
  state.stats = computeStats(state.sessions);

  // Rebuild the virtual (flat) list of rows that the UI iterates over: sessions
  // plus expansion markers and subagent children when a session is expanded.
  state.flatList = buildFlatList(state);

  // Clamp selection against virtual-row count
  if (state.selectedRow >= state.flatList.length) state.selectedRow = Math.max(0, state.flatList.length - 1);
}

/** Unique key for the expandedSubagents set; same shape used as session map keys. */
function sessionKey(s) {
  return `${s.provider}:${s.session_id}`;
}

/** Build the virtual row list: each session, plus a marker + child rows when expanded. */
function buildFlatList(state) {
  const flat = [];
  const expanded = state.expandedSubagents || new Set();
  for (const s of state.filtered) {
    flat.push({ type: "session", session: s });
    const subs = Array.isArray(s.list_subagents) ? s.list_subagents : null;
    if (subs && subs.length > 0) {
      const isExpanded = expanded.has(sessionKey(s));
      flat.push({ type: "marker", session: s, expanded: isExpanded, count: subs.length });
      if (isExpanded) {
        flat.push({ type: "subagent-header", session: s });
        const sorted = subs.slice().sort((a, b) => {
          if (a.status !== b.status) return a.status === "running" ? -1 : 1;
          return (b.started_at || "").localeCompare(a.started_at || "");
        });
        for (const sa of sorted) flat.push({ type: "subagent", session: s, subagent: sa });
      }
    }
  }
  return flat;
}

/** Return the session that "owns" the selected row (parent for marker/subagent). */
function getSelectedSession(state) {
  const row = state.flatList[state.selectedRow];
  return row ? row.session : null;
}

/** Build a session-like object representing a subagent so the existing panel
 *  renderers can consume it without modification. data_file points at the
 *  subagent's own jsonl; ghost subagents (no on-disk transcript) get a null
 *  data_file which yields the empty stub in safeExtractSessionData. */
function subagentToSession(parent, sa) {
  const subFile = (parent.data_file && !sa.ghost)
    ? parent.data_file.replace(/\.jsonl$/, "") + "/subagents/" + sa.agent_id + ".jsonl"
    : null;
  return {
    provider: parent.provider,
    session_id: sa.agent_id,
    data_file: subFile,
    title: sa.description || null,
    label_source: parent.label_source,
    _abbrevLabel: parent._abbrevLabel,
    started_at: sa.started_at,
    last_active: sa.last_active || sa.started_at,
    model: sa.model,
    process: null,                  // subagents share the parent's PID
    list_total_cost: sa.cost,
    _isSubagent: true,
    _parentSession: parent,
    _subagent: sa,
  };
}

/** Return the session whose data the bottom panels should display.
 *  For subagent rows this is a synthesized subagent-as-session; otherwise the
 *  same as getSelectedSession. */
function getSelectedPanelSession(state) {
  const row = state.flatList[state.selectedRow];
  if (!row) return null;
  if (row.type === "subagent") return subagentToSession(row.session, row.subagent);
  return row.session;
}

/** Find the flat-list index of the session row that owns the given flat-list row index. */
function findParentSessionIndex(state, flatIdx) {
  for (let i = flatIdx; i >= 0; i--) {
    if (state.flatList[i] && state.flatList[i].type === "session") return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function costColor(value) {
  if (value === null || value === undefined || value === "included") return C.dimText;
  const v = parseFloat(value);
  if (isNaN(v)) return C.dimText;
  if (v < 1) return C.costGreen;
  if (v < 10) return C.costYellow;
  return C.costRed;
}

/** Count visible (non-ANSI) character length of a string. */
function ansiLen(str) {
  let len = 0;
  for (let i = 0; i < str.length; ) {
    if (str[i] === "\x1b") {
      const mEnd = str.indexOf("m", i);
      if (mEnd !== -1) { i = mEnd + 1; continue; }
    }
    len++;
    i++;
  }
  return len;
}

/** Slice an ANSI-colored string by visible column range [start, start+len). */
function ansiSlice(str, start, len) {
  let vis = 0;       // visible column position
  let i = 0;         // string index
  let out = "";
  let collecting = false;  // inside the visible window
  const end = start + len;

  while (i < str.length && vis < end) {
    // ANSI escape sequence — zero width, always include if we're past start
    if (str[i] === "\x1b") {
      const mEnd = str.indexOf("m", i);
      if (mEnd !== -1) {
        const seq = str.substring(i, mEnd + 1);
        if (vis >= start) out += seq;
        i = mEnd + 1;
        continue;
      }
    }
    if (vis >= start && vis < end) {
      collecting = true;
      out += str[i];
    }
    vis++;
    i++;
  }
  // If line was shorter than requested, pad with spaces
  const outVis = out.replace(/\x1b\[[^m]*m/g, "").length;
  if (outVis < len) out += " ".repeat(len - outVis);
  return out;
}

function padOrClip(text, width, align) {
  const visLen = ansiLen(text);
  if (visLen > width) {
    return width <= 3 ? ansiSlice(text, 0, width) : ansiSlice(text, 0, width - 1) + "…";
  }
  const pad = " ".repeat(width - visLen);
  return align === "right" ? pad + text : text + pad;
}

// ---------------------------------------------------------------------------
// Render: header area
// ---------------------------------------------------------------------------

// Global history for overview sparklines
const _globalCpuHist = [];
const _globalMemHist = [];
const _globalSpendDeltaHist = [];
const _globalTokenDeltaHist = [];
let _prevSpendTotal = null;
let _prevTokenTotal = null;
let _deltaWarmup = 0;

function pushGlobalHistory(arr, value) {
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

/** Push sparkline history — call once per data refresh tick, not per render. */
function updateOverviewHistory(stats) {
  const curSpend = stats.spendTotal || 0;
  const curTokens = (stats.totalInput || 0) + (stats.totalOutput || 0);

  _deltaWarmup = (_deltaWarmup || 0) + 1;
  if (_prevSpendTotal !== null && _deltaWarmup > 3) {
    pushGlobalHistory(_globalSpendDeltaHist, Math.max(0, curSpend - _prevSpendTotal));
    pushGlobalHistory(_globalTokenDeltaHist, Math.max(0, curTokens - _prevTokenTotal));
  }
  _prevSpendTotal = curSpend;
  _prevTokenTotal = curTokens;

  pushGlobalHistory(_globalCpuHist, stats.totalCpu || 0);
  pushGlobalHistory(_globalMemHist, (stats.totalMemory || 0) / (1024 * 1024));
}

function renderHeader(stats, width, state) {
  const lines = [];
  lines.push(boxTop(width, "Overview"));

  const curSpend = stats.spendTotal || 0;
  const curTokens = (stats.totalInput || 0) + (stats.totalOutput || 0);
  const memMB = (stats.totalMemory || 0) / (1024 * 1024);

  const inner = width - 4; // inside box borders
  // Two columns: each has label + chart, separated by a gap
  const gap = 2;
  const colW = Math.floor((inner - gap) / 2);
  const labelW = 22;
  const chartW = Math.max(4, colW - labelW - 1);

  // Row 1: Spend + CPU
  const spendLabel = `${C.hdrLabel}Total Spend${RESET} ${C.hdrYellow}$${curSpend.toFixed(2)}${RESET}`;
  const spendChart = renderBrailleSparkline(_globalSpendDeltaHist, chartW, 0, "spend");
  const cpuLabel = `${C.hdrLabel}Agents CPU${RESET} ${C.hdrValue}${stats.totalCpu}%${RESET}`;
  const cpuChart = renderBrailleSparkline(_globalCpuHist, chartW, 100, "cpu");
  const row1Left = buildOverviewCell(spendLabel, spendChart, labelW, chartW, colW);
  const row1Right = buildOverviewCell(cpuLabel, cpuChart, labelW, chartW, colW);
  lines.push(boxLine(row1Left + " ".repeat(gap) + row1Right, width));

  // Row 2: Tokens + Memory
  const tokLabel = `${C.hdrLabel}Total Tokens${RESET} ${C.hdrValue}${compactTokens(curTokens)}${RESET}`;
  const tokChart = renderBrailleSparkline(_globalTokenDeltaHist, chartW, 0, "spend");
  const memLabel = `${C.hdrLabel}Agents Mem${RESET} ${C.hdrValue}${memMB.toFixed(0)} MB${RESET}`;
  const row2Left = buildOverviewCell(tokLabel, tokChart, labelW, chartW, colW);
  const row2Right = buildOverviewCell(memLabel, "", labelW, 0, colW);
  lines.push(boxLine(row2Left + " ".repeat(gap) + row2Right, width));

  lines.push(boxBottom(width));
  return lines;
}

/** Render the Limits box below Overview showing account-wide quota for each provider */
function renderLimitsPanel(width, state) {
  const quota = state && state._quota;
  if (!quota) return [];

  const lines = [];
  lines.push(boxTop(width, "Limits"));

  const inner = width - 4;
  const gap = 2;
  const colW = Math.floor((inner - gap) / 2);

  function quotaCell(provLabel, q) {
    if (!q) {
      if (!quota.fetched) return `${C.hdrLabel}${provLabel}${RESET} ${C.dimText}...${RESET}`;
      return `${C.hdrLabel}${provLabel}${RESET} ${C.dimText}no credentials${RESET}`;
    }
    if (q.api_billing) {
      return `${C.hdrLabel}${provLabel}${RESET} ${C.dimText}API billing, no limits${RESET}`;
    }
    const windows = [];
    if (q.five_hour) windows.push({ label: "5h", pct: q.five_hour.pct, reset: q.five_hour.resets_at });
    if (q.seven_day) windows.push({ label: "7d", pct: q.seven_day.pct, reset: q.seven_day.resets_at });
    if (q.primary) windows.push({ label: "5h", pct: q.primary.pct, reset: q.primary.resets_at });
    // secondary_window.used_percent is a rate-throttle pressure metric, not actual quota — omit.
    if (q.code_review) windows.push({ label: "cr", pct: q.code_review.pct, reset: q.code_review.resets_at });
    const planPlain = q.plan ? ` (${q.plan})` : "";
    const planStr = q.plan ? ` ${C.dimText}(${q.plan})${RESET}` : "";
    let parts = `${C.hdrLabel}${provLabel}${RESET}${planStr}`;
    // Each window needs at minimum: " XX YYY%" = 8 visible chars.
    const fixedVis = provLabel.length + planPlain.length + windows.length * 8;
    const spare = colW - fixedVis;
    const barW = windows.length > 0 ? Math.max(0, Math.min(8, Math.floor(spare / windows.length))) : 0;
    // Show reset time for the most-used window only, and only if space allows.
    const showResetIdx = spare - windows.length * barW >= 7
      ? windows.reduce((best, w, i) => w.pct > windows[best].pct ? i : best, 0)
      : -1;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const color = w.pct >= 90 ? C.costRed : w.pct >= 70 ? C.costYellow : C.chartBarLow;
      const filled = Math.round((w.pct / 100) * barW);
      let bar = "";
      for (let b = 0; b < barW; b++) {
        bar += (b < filled ? color + "━" : "\x1b[38;5;244m─") + RESET;
      }
      let resetStr = "";
      if (i === showResetIdx && w.reset) {
        const resetMs = w.reset > 1e12 ? w.reset : w.reset * 1000;
        const diffMs = resetMs - Date.now();
        if (diffMs > 0) {
          const h = Math.floor(diffMs / 3600_000);
          const m = Math.floor((diffMs % 3600_000) / 60_000);
          resetStr = ` ${C.dimText}${h}h${String(m).padStart(2, "0")}m${RESET}`;
        }
      }
      parts += ` ${C.hdrLabel}${w.label}${RESET} ${color}${String(w.pct).padStart(3)}%${RESET}${bar}${resetStr}`;
    }
    if (q.limit_reached) parts += ` ${C.costRed}⚠ limit${RESET}`;
    return parts;
  }

  const leftCell = quotaCell("Claude", quota.claude);
  const rightCell = quotaCell("Codex", quota.codex);
  const leftPlain = leftCell.replace(/\x1b\[[^m]*m/g, "");
  const leftPad = Math.max(1, colW - leftPlain.length);
  lines.push(boxLine(leftCell + " ".repeat(leftPad) + " ".repeat(gap) + rightCell, width));

  lines.push(boxBottom(width));
  return lines;
}

/** Build one cell: label padded to labelW, then sparkline, total padded to cellW */
function buildOverviewCell(label, chart, labelW, chartW, cellW) {
  const labelPlain = label.replace(/\x1b\[[^m]*m/g, "");
  const pad = Math.max(1, labelW - labelPlain.length);
  const content = label + " ".repeat(pad) + chart;
  const contentLen = labelPlain.length + pad + chartW;
  const trailing = Math.max(0, cellW - contentLen);
  return content + " ".repeat(trailing);
}

// ---------------------------------------------------------------------------
// Render: column headers
// ---------------------------------------------------------------------------

function renderColumnHeaders(state, width) {
  const cols = activeColumns(state);
  const totalW = columnsFullWidth(width, cols);
  let line = C.colHdrBg + " ";
  let used = 1;

  for (const col of cols) {
    const w = col.flex ? Math.max(8, totalW - used) : col.width;
    let label = col.label;
    if (col.key === state.sortCol) {
      label += state.sortAsc ? "▲" : "▼";
    }
    label = padOrClip(label, w, col.align);
    line += label;
    used += w;
    if (!col.flex && used < totalW) { line += " "; used++; }
  }

  return C.colHdrBg + ansiSlice(line, state.hScroll, width) + RESET;
}

/** Total width of all columns (flex column gets at least its content width). */
function columnsFullWidth(termWidth, cols) {
  cols = cols || SUMMARY_COLUMNS;
  let fixed = 0;
  for (const col of cols) {
    if (!col.flex) fixed += col.width + 1; // +1 separator
  }
  return Math.max(termWidth, fixed + 40);
}

// ---------------------------------------------------------------------------
// Render: session row
// ---------------------------------------------------------------------------

/** Compute age-based dim color for a session row (btop style).
 *  Continuous fade from 255 (bright white) to 238 (dim). */
function ageDimColor(session, now) {
  const la = parseTimestamp(session.last_active);
  if (!la) return "\x1b[38;5;238m";
  if (session.process) return "\x1b[1;37m"; // running: bold white
  const ageSec = Math.max(0, (now.getTime() - la.getTime()) / 1000);
  // Log scale so recent sessions get more contrast, old ones flatten out
  // At 0s → 255, at 1h → ~251, at 1d → ~246, at 7d → ~240, at 30d → ~238
  const logAge = Math.log1p(ageSec / 3600); // hours on log scale
  const logMax = Math.log1p(720); // ~30 days in hours
  const ratio = Math.min(1, logAge / logMax);
  const shade = Math.round(255 - ratio * 17); // 255 → 238
  return `\x1b[38;5;${shade}m`;
}

/** Model column color: muted orange for Anthropic, muted blue for OpenAI */
function modelColor(session) {
  const m = (session.model || "").toLowerCase();
  if (m.startsWith("claude")) return "\x1b[38;5;173m"; // muted orange
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "\x1b[38;5;110m"; // muted blue
  return C.dimText;
}

function renderSessionRow(session, index, isSelected, width, now, hScroll, state) {
  const cols = state ? activeColumns(state) : SUMMARY_COLUMNS;
  const totalW = columnsFullWidth(width, cols);
  const bg = isSelected ? C.selBg : "";
  const fg = isSelected ? C.selFg : "";
  const base = bg + fg;
  let line = base + " ";
  let used = 1;

  for (const col of cols) {
    const w = col.flex ? Math.max(8, totalW - used) : col.width;
    let text = col.render(session, now, index);
    text = padOrClip(text, w, col.align);

    // Per-column coloring (preserved even when selected)
    let colColor = "";
    if (col.key === "status") {
      if (!session.process) {
        colColor = C.dimText;
      } else {
        // Shade of green by recency: bright = just active, dark = idle but still running.
        const la = parseTimestamp(session.last_active);
        const ageSec = la ? Math.max(0, (now.getTime() - la.getTime()) / 1000) : null;
        if      (ageSec === null) colColor = C.chartBarLow;    // no data: medium green
        else if (ageSec < 30)   colColor = "\x1b[38;5;82m";   // <30s  bright green
        else if (ageSec < 300)  colColor = C.chartBarLow;      // <5m   medium green
        else if (ageSec < 1800) colColor = "\x1b[38;5;71m";   // <30m  muted green
        else if (ageSec < 7200) colColor = "\x1b[38;5;28m";   // <2h   dark green
        else                    colColor = "\x1b[38;5;22m";   // 2h+   dim green
      }
    } else if (col.key === "active") {
      colColor = ageDimColor(session, now);
    } else if (col.key === "model") {
      colColor = modelColor(session);
    } else if (col.key === "cost") {
      colColor = costColor(session.list_total_cost);
    } else if (col.key === "cpu") {
      const cpu = session.process ? session.process.cpu : 0;
      colColor = cpu > 80 ? C.chartBarHi : cpu > 40 ? C.chartBarMed : cpu > 0 ? C.chartBarLow : C.dimText;
    } else if (col.key === "ctx") {
      const ctx = session.list_context;
      if (ctx && ctx.compacting) {
        const flash = Math.floor(Date.now() / 600) % 2 === 0;
        colColor = flash ? "\x1b[1;31m" : "\x1b[38;5;52m";
      } else {
        const usedPct = ctx ? (ctx.used / (ctx.max * COMPACT_THRESHOLD)) * 100 : 0;
        colColor = usedPct > 85 ? C.costRed : usedPct > 65 ? C.costYellow : ctx ? C.chartBarLow : C.dimText;
      }
    } else if (col.key === "tok_rate") {
      const r = session.list_tokens_per_min || 0;
      colColor = r > 5000 ? C.chartBarHi : r > 1000 ? C.chartBarMed : r > 0 ? C.chartBarLow : C.dimText;
    } else if (col.key === "cost_rate") {
      const r = session.list_cost_per_min || 0;
      colColor = r > 0.50 ? C.costRed : r > 0.10 ? C.costYellow : r > 0.001 ? C.chartBarLow : C.dimText;
    } else if (col.key === "tools" || col.key === "tools_rate" || col.key === "in_tokens" || col.key === "out_tokens"
            || col.key === "cost" || col.key === "cost_hour" || col.key === "cost_today") {
      const skey = session.provider + ":" + session.session_id;
      const cur = col.key === "tools" ? (session.list_tool_count || 0)
        : col.key === "tools_rate" ? (session.list_tools_since_start || 0)
        : col.key === "in_tokens" ? (session.list_input_tokens || 0)
        : col.key === "out_tokens" ? (session.list_output_tokens || 0)
        : col.key === "cost_hour" ? (session.list_cost_hour || 0)
        : col.key === "cost_today" ? (session.list_cost_today || 0)
        : parseFloat(session.list_total_cost || 0) || 0;
      if (!state._colPrev[skey]) state._colPrev[skey] = {};
      const prev = state._colPrev[skey][col.key];
      if (prev !== undefined && prev !== cur) {
        if (!state._colFlash[skey]) state._colFlash[skey] = {};
        state._colFlash[skey][col.key] = now;
      }
      state._colPrev[skey][col.key] = cur;
      const flashTs = (state._colFlash[skey] && state._colFlash[skey][col.key]) || 0;
      if (flashTs && (now - flashTs < 1500)) {
        colColor = "\x1b[1;38;5;105m";
      } else if (col.key === "cost_hour" && session.list_cost_hour > 0) {
        colColor = costColor(session.list_cost_hour);
      } else if (col.key === "cost_today" && session.list_cost_today > 0) {
        colColor = costColor(session.list_cost_today);
      }
    }
    if (colColor) {
      line += bg + colColor + text + RESET + base;
    } else {
      line += text + base; // re-apply selection bg after any embedded RESET in text
    }

    used += w;
    if (!col.flex && used < totalW) { line += " "; used++; }
  }

  return base + ansiSlice(line, hScroll, width) + RESET;
}

/** Dispatch one virtual row (session, marker, or subagent) to the appropriate renderer. */
function renderFlatRow(row, index, isSelected, width, now, hScroll, state) {
  if (!row) return "";
  if (row.type === "session") {
    return renderSessionRow(row.session, index, isSelected, width, now, hScroll, state);
  }
  if (row.type === "marker") {
    return renderSubagentMarkerRow(row.session, row.expanded, row.count, isSelected, width, hScroll, state);
  }
  if (row.type === "subagent-header") {
    return renderSubagentHeaderRow(isSelected, width, hScroll, state);
  }
  if (row.type === "subagent") {
    return renderSubagentChildRow(row.subagent, isSelected, width, hScroll, state);
  }
  return "";
}

/** Indented "▶ N subagents ($X.XX)" marker shown beneath a session that has subagents. */
function renderSubagentMarkerRow(session, expanded, count, isSelected, width, hScroll, state) {
  const bg = isSelected ? C.selBg : "";
  const fg = isSelected ? C.selFg : "";
  const base = bg + fg;
  const chev = expanded ? "▼" : "▶";
  const subs = session.list_subagents || [];
  const cost = typeof session.list_subagents_cost === "number"
    ? "$" + session.list_subagents_cost.toFixed(2)
    : null;
  const ghosts = subs.filter(s => s.ghost).length;
  const ghostNote = ghosts > 0 ? `  ${ghosts} purged` : "";
  // Average duration is only worth showing once there are enough samples to
  // be representative. Ghosts contribute no duration so they're excluded.
  let avgNote = "";
  if (count > 3) {
    const durations = subs.filter(s => !s.ghost && typeof s.duration_ms === "number" && s.duration_ms > 0)
      .map(s => s.duration_ms);
    if (durations.length > 0) {
      const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      const s = Math.round(avgMs / 1000);
      let avgStr;
      if (s < 60)      avgStr = `${s}s`;
      else if (s < 3600) {
        const m = Math.floor(s / 60); const r = s % 60;
        avgStr = `${m}m${String(r).padStart(2, "0")}s`;
      } else {
        const h = Math.floor(s / 3600); const mr = Math.floor((s % 3600) / 60);
        avgStr = `${h}h${String(mr).padStart(2, "0")}m`;
      }
      avgNote = `  avg ${avgStr}`;
    }
  }
  const label = `  └${chev} ${count} subagent${count === 1 ? "" : "s"}${cost ? `  (${cost})` : ""}${avgNote}${ghostNote}`;
  const text = label.length > width - 2 ? label.slice(0, width - 3) + "…" : label;
  const color = isSelected ? "" : C.dimText;
  const line = base + color + text + RESET + base;
  return base + ansiSlice(line, hScroll, width) + RESET;
}

/** Indented child row for a single subagent under an expanded session. */
function renderSubagentChildRow(sa, isSelected, width, hScroll, state) {
  const bg = isSelected ? C.selBg : "";
  const fg = isSelected ? C.selFg : "";
  const base = bg + fg;
  const isGhost = sa.ghost === true;
  const isRunning = sa.status === "running";
  const icon = isGhost ? "◌" : (isRunning ? "●" : "○");
  const iconColor = isSelected ? "" : (isGhost ? C.dimText : (isRunning ? C.chartBarHi : C.dimText));
  const ts = sa.started_at ? new Date(sa.started_at) : null;
  const startStr = (ts && !isNaN(ts.getTime()))
    ? String(ts.getHours()).padStart(2, "0") + ":" + String(ts.getMinutes()).padStart(2, "0")
    : "  —  ".slice(0, 5);
  const cost = (isGhost || typeof sa.cost !== "number")
    ? "      —"   // 7-char column, right-aligned em-dash to match $N.NN values
    : ("$" + sa.cost.toFixed(2)).padStart(7);
  const tools = (isGhost ? "    —" : String(sa.tool_count || 0).padStart(5));
  const dur = (isGhost || !sa.duration_ms)
    ? "     —"
    : (() => {
        const s = Math.round(sa.duration_ms / 1000);
        if (s < 60)    return `${s}s`.padStart(6);
        const m = Math.floor(s / 60);
        const r = s % 60;
        if (m < 60)    return `${m}m${String(r).padStart(2, "0")}s`.padStart(6);
        const h = Math.floor(m / 60);
        const mr = m % 60;
        return `${h}h${String(mr).padStart(2, "0")}m`.padStart(6);
      })();
  const desc = sa.description || "(no description)";
  const model = (sa.model || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  // Layout: "     ◌ 10:18  3m12s  $0.42   142  haiku-4-5     Implement Task 1"
  const modelCell = (model.length > 12 ? model.slice(0, 11) + "…" : model).padEnd(12);
  const prefix = `     ${icon} ${startStr}  ${dur}  ${cost}  ${tools}  ${modelCell}  `;
  const maxDesc = Math.max(8, width - 2 - prefix.replace(/\x1b\[[^m]*m/g, "").length);
  const descShort = desc.length > maxDesc ? desc.slice(0, maxDesc - 1) + "…" : desc;
  const rowColor = isSelected ? "" : (isGhost ? C.dimText : "\x1b[38;5;250m");
  // Match the parent session row's per-column color rules. When selected, keep
  // the selection foreground (no override) so the highlight remains readable.
  const costNum = typeof sa.cost === "number" ? sa.cost : Number(sa.cost) || 0;
  const costCol  = isSelected || isGhost ? rowColor : costColor(costNum);
  const modelCol = isSelected || isGhost ? rowColor : modelColor({ model: sa.model || "" });
  // START column mirrors the parent's LAST column: ageDimColor on dispatch time.
  const startCol = isSelected || isGhost
    ? rowColor
    : ageDimColor({ last_active: sa.started_at, process: isRunning }, new Date());
  // DUR thresholds: ≤10m row color, >10m yellow, >30m red.
  const durMs = sa.duration_ms || 0;
  const durCol = isSelected || isGhost
    ? rowColor
    : durMs > 1800000 ? C.costRed
    : durMs > 600000  ? C.costYellow
    : rowColor;
  const line = base + " ".repeat(5) + (iconColor || "") + icon + RESET + base +
    " " + startCol + startStr + RESET + base +
    "  " + durCol + dur + RESET + base +
    "  " + costCol + cost + RESET + base +
    rowColor + `  ${tools}  ` + RESET + base +
    modelCol + modelCell + RESET + base +
    rowColor + `  ${descShort}` + RESET + base;
  return base + ansiSlice(line, hScroll, width) + RESET;
}

/** Column-label row shown right after the expansion marker so subagent rows
 *  are self-describing. Aligns with renderSubagentChildRow's column widths.
 *  Uses the same bold-white-on-dark-gray style as the session-list header. */
function renderSubagentHeaderRow(isSelected, width, hScroll, state) {
  const bg = isSelected ? C.selBg : "";
  const fg = isSelected ? C.selFg : "";
  const base = bg + fg;
  // 5sp indent + 1ch icon-placeholder + 1sp gap before headers begin.
  const indent = "       ";
  // 5ch START + 2sp + 6ch DUR + 2sp + 7ch COST + 2sp + 5ch TOOLS + 2sp + 12ch MODEL + 2sp + DESCRIPTION
  const labels = "START" + "  " + "   DUR" + "  " + "   COST" + "  " + "TOOLS" + "  " + "MODEL       " + "  " + "DESCRIPTION";
  const headerStyle = isSelected ? "" : C.colHdrBg;
  // No intermediate RESET so ansiSlice's trailing-space padding inherits the bg
  // and the header bar extends across the full row.
  const line = base + headerStyle + indent + labels;
  return base + ansiSlice(line, hScroll, width) + RESET;
}

// ---------------------------------------------------------------------------
// Render: footer
// ---------------------------------------------------------------------------

function renderFooter(state, width) {
  const items = [
    ["F1", "Help", "f1"], ["F3", "Filter", "f3"], ["F5", "Refresh", "f5"],
    ["F6", "SortBy", "f6"], ["F7", "Age", "f7"], ["Tab", "Panel", "tab"], ["`", "Live", "backtick"], ["d", "Delete", "d_delete"], ["F10", "Quit", "f10"],
  ];
  let line = "";
  state._footerItems = [];
  for (const [key, label, action] of items) {
    const startCol = line.replace(/\x1b\[[^m]*m/g, "").length + 1; // 1-based
    line += C.footerKey + key + RESET + C.footerLabel + label + " " + RESET;
    const endCol = line.replace(/\x1b\[[^m]*m/g, "").length; // 1-based inclusive
    state._footerItems.push({ start: startCol, end: endCol, action });
  }
  const toolbarLen = line.replace(/\x1b\[[^m]*m/g, "").length;
  let remaining = width - toolbarLen;

  state._ageFilterXCol = -1;
  if (state.inactivityFilter) {
    const label = { "1d": "1 day", "1w": "1 week", "1mo": "1 month" }[state.inactivityFilter] || state.inactivityFilter;
    const chunk = " Age: <" + label + " ✕ ";
    if (remaining >= chunk.length) {
      line += "\x1b[1;38;5;179m" + " Age: <" + label + " " + RESET;
      const beforeAgeX = line.replace(/\x1b\[[^m]*m/g, "").length;
      const ageXStyle = state._hoverAgeX ? "\x1b[1;4;38;5;203m" : "\x1b[38;5;167m";
      line += ageXStyle + "✕" + RESET + " ";
      state._ageFilterXCol = beforeAgeX + 1;
      remaining -= chunk.length;
    }
  }

  state._filterXCol = -1;
  if (state.searchQuery && state.mode !== "search") {
    const chunk = " Filter: " + state.searchQuery + " ✕ ";
    if (remaining >= chunk.length) {
      line += C.searchFg + " Filter: " + state.searchQuery + " " + RESET;
      const beforeX = line.replace(/\x1b\[[^m]*m/g, "").length;
      const xStyle = state._hoverFilterX ? "\x1b[1;4;38;5;203m" : "\x1b[38;5;167m";
      line += xStyle + "✕" + RESET + " ";
      state._filterXCol = beforeX + 1;
      remaining -= chunk.length;
    }
  }

  const plain = line.replace(/\x1b\[[^m]*m/g, "");
  const pad = Math.max(0, width - plain.length);
  return line + C.footerBg + " ".repeat(pad) + RESET;
}

// ---------------------------------------------------------------------------
// Render: detail view
// ---------------------------------------------------------------------------

function renderDetailView(session, data, plan, width, height) {
  const lines = [];

  const prov = session.provider === "claude" ? "Claude" : "Codex";
  lines.push(boxTop(width - 1, `Session Detail — ${prov} ${session.session_id || "unknown"}`));
  lines.push("");

  if (data) {
    if (session.provider === "codex") {
      const incl = planIncludesProvider(plan, "codex");
      if (incl) {
        lines.push(`  Billable cost: Not Billed (plan: ${plan})`);
        lines.push(`  Retail-equivalent: ${usd(data.costs.total)}`);
      } else {
        lines.push(`  ${BOLD}Total cost: ${C.costYellow}${usd(data.costs.total)}${RESET}`);
      }
      lines.push(`  Breakdown: input ${usd(data.costs.input)} | cached ${usd(data.costs.cached_input)} | output ${usd(data.costs.output)}`);
      lines.push("");
      lines.push(`  Model: ${data.model || "unknown"}`);
      lines.push(`  Plan: ${plan}`);
      lines.push(`  Project: ${session.label_source || "unknown"}`);
      lines.push("");
      lines.push("  Tokens:");
      lines.push(`    Input (uncached):  ${numberWithCommas(data.tokens.input)}`);
      lines.push(`    Input (total):     ${numberWithCommas(data.tokens.input_total)}`);
      lines.push(`    Cached input:      ${numberWithCommas(data.tokens.cached_input)}`);
      lines.push(`    Output:            ${numberWithCommas(data.tokens.output)}`);
      lines.push(`    Reasoning output:  ${numberWithCommas(data.tokens.reasoning_output)}`);
      lines.push(`    Total:             ${numberWithCommas(data.tokens.total)}`);
      lines.push("");
      lines.push(`  Rates (USD / 1M tokens):`);
      lines.push(`    Input: $${data.rates.input}  Cached: $${data.rates.cached_input}  Output: $${data.rates.output}`);
    } else if (session.provider === "claude") {
      const incl = planIncludesProvider(plan, "claude");
      if (incl) {
        lines.push(`  Billable cost: Not Billed (plan: ${plan})`);
        lines.push(`  Retail-equivalent: ${usd(data.costs.total)}`);
      } else {
        lines.push(`  ${BOLD}Total cost: ${C.costYellow}${usd(data.costs.total)}${RESET}`);
      }
      lines.push(`  Breakdown: input ${usd(data.costs.input)} | cache write 5m ${usd(data.costs.cache_write_5m)} | cache write 1h ${usd(data.costs.cache_write_1h)} | cache read ${usd(data.costs.cache_read)} | output ${usd(data.costs.output)}`);
      lines.push("");
      lines.push(`  Model${data.models.length > 1 ? "s" : ""}: ${data.models.join(", ")}`);
      lines.push(`  Plan: ${plan}`);
      lines.push(`  Project: ${session.label_source || "unknown"}`);
      lines.push("");
      lines.push("  Tokens:");
      lines.push(`    Input:           ${numberWithCommas(data.tokens.input)}`);
      lines.push(`    Cache write 5m:  ${numberWithCommas(data.tokens.cache_write_5m)}`);
      lines.push(`    Cache write 1h:  ${numberWithCommas(data.tokens.cache_write_1h)}`);
      lines.push(`    Cache read:      ${numberWithCommas(data.tokens.cache_read)}`);
      lines.push(`    Output:          ${numberWithCommas(data.tokens.output)}`);
      lines.push(`    Total:           ${numberWithCommas(data.tokens.total)}`);
      lines.push("");
      lines.push("  Rates (USD / 1M tokens):");
      for (const model of data.models) {
        const p = resolveClaudePricing(model);
        lines.push(`    ${model}:`);
        lines.push(`      Input: $${p.input_per_million}  Cache write 5m: $${p.cache_write_5m_per_million}  Cache write 1h: $${p.cache_write_1h_per_million}  Cache read: $${p.cache_read_per_million}  Output: $${p.output_per_million}`);
      }
    }

    // --- Metrics section ---
    const m = safeMetrics(data);
    if (m.tool_count > 0 || m.skill_count > 0 || m.web_fetch_count > 0 || m.web_search_count > 0 || m.mcp_tool_count > 0) {
      lines.push("");
      lines.push(BOLD + "  Activity Metrics:" + RESET);

      if (m.tool_count > 0) {
        lines.push(`    Tool invocations: ${numberWithCommas(m.tool_count)}`);
        const sorted = Object.entries(m.tools)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15);
        for (const [name, count] of sorted) {
          lines.push(`      ${count.toString().padStart(6)}x  ${name}`);
        }
      }

      if (m.skill_count > 0) {
        lines.push(`    Skill invocations: ${numberWithCommas(m.skill_count)}`);
        for (const [name, count] of Object.entries(m.skills).sort((a, b) => b[1] - a[1])) {
          lines.push(`      ${count.toString().padStart(6)}x  /${name}`);
        }
      }

      if (m.web_fetch_count > 0) {
        lines.push(`    Web fetches: ${m.web_fetch_count}`);
        for (const url of m.web_fetches.slice(0, 10)) {
          lines.push(`      - ${url}`);
        }
      }

      if (m.web_search_count > 0) {
        lines.push(`    Web searches: ${m.web_search_count}`);
        for (const q of m.web_searches.slice(0, 10)) {
          lines.push(`      - "${q}"`);
        }
      }

      if (m.mcp_tool_count > 0) {
        lines.push(`    MCP tool calls: ${m.mcp_tool_count}`);
        for (const name of m.mcp_tools.slice(0, 10)) {
          lines.push(`      - ${name}`);
        }
      }
    }

    // --- Process metrics (Tier 2) ---
    if (session.process) {
      const pm = session.process;
      const memMB = (pm.memory / (1024 * 1024)).toFixed(1);
      lines.push("");
      lines.push(BOLD + "  Process:" + RESET);
      lines.push(`    CPU:     ${pm.cpu}%`);
      lines.push(`    Memory:  ${memMB} MB`);
      lines.push(`    PIDs:    ${pm.pids}`);
      if (pm.command) lines.push(`    Command: ${pm.command}`);
    }
  } else {
    lines.push("  (No cost data available for this session)");
  }

  lines.push("");
  lines.push(C.dimText + "  Press q, Esc, or ← to return to list" + RESET);

  // Pad to fill screen
  while (lines.length < height - 1) lines.push("");
  return lines.slice(0, height - 1);
}

// ---------------------------------------------------------------------------
// Render: bottom panels (btop-style three-column layout)
// ---------------------------------------------------------------------------

const MIN_PANEL = 10;
const MAX_PANEL = 30;

/**
 * Build content lines for each of the three bottom panels, then merge
 * them side-by-side with box borders into composite screen lines.
 */
const BOTTOM_TABS = ["Info", "Performance", "Processes", "Tool Activity", "Cost", "Config", "Subagents"];
// Tabs that are hidden unless the session has data for them. Map: tabIdx → predicate(data).
const CONDITIONAL_TABS = {
  6: (data) => !!(data && Array.isArray(data.subagents) && data.subagents.length > 0),
};

/** Return the indices of BOTTOM_TABS visible for this session's data, in display order. */
function visibleBottomTabs(data) {
  const out = [];
  for (let i = 0; i < BOTTOM_TABS.length; i++) {
    const cond = CONDITIONAL_TABS[i];
    if (cond && !cond(data)) continue;
    out.push(i);
  }
  return out;
}

/** Resolve state.bottomTab against visible tabs. Falls back to first visible if hidden. */
function resolveActiveTab(state, data) {
  const vis = visibleBottomTabs(data);
  const wanted = state.bottomTab;
  if (vis.includes(wanted)) return wanted;
  return vis[0] || 0;
}

/** Select the Nth (0-based) tab in the static BOTTOM_TABS list, skipping if hidden for the current session. */
function selectBottomTabByNumber(state, staticIdx) {
  const cond = CONDITIONAL_TABS[staticIdx];
  if (cond && !cond(state.panelData)) return; // tab not visible right now — ignore the keypress
  state.bottomTab = staticIdx;
  state.dirty = true;
  saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
}

/** Cycle to the next visible bottom tab (delta = +1 or -1). */
function cycleBottomTab(state, delta) {
  const vis = visibleBottomTabs(state.panelData);
  if (vis.length === 0) return;
  const cur = vis.indexOf(resolveActiveTab(state, state.panelData));
  const next = vis[((cur < 0 ? 0 : cur) + delta + vis.length) % vis.length];
  state.bottomTab = next;
  state.dirty = true;
  saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
}

function renderBottomPanels(session, data, plan, width, panelHeight, activeTab, hoverTab, state) {
  const bc = C.border;
  const innerW = width - 4; // content inside │ ... │
  const innerH = panelHeight - 3; // top border + tab/rule line + bottom border

  // Compute visible tabs for this session. Conditional tabs (e.g. Subagents) may be hidden.
  const visIdxs = visibleBottomTabs(data);

  // Build tab positions first (shared between top border and rule line)
  // Layout: ╭─ Session  System  Tool Activity ──────────╮
  //         │  ───────━━━━━━━━──────────────────────────  │
  const tabParts = []; // [{col, len, idx}]
  let col = 3; // after "╭─ " or "│  "
  for (let i = 0; i < visIdxs.length; i++) {
    if (i > 0) col += 2; // 2-space gap
    const ti = visIdxs[i];
    tabParts.push({ col, len: BOTTOM_TABS[ti].length, idx: ti });
    col += BOTTOM_TABS[ti].length;
  }
  const labelsEnd = col; // first char after last label

  // --- Top border with tab labels ---
  let topLine = bc + BOX.tl + BOX.h + " " + RESET;
  for (let i = 0; i < visIdxs.length; i++) {
    if (i > 0) topLine += "  ";
    const ti = visIdxs[i];
    const name = BOTTOM_TABS[ti];
    if (ti === activeTab) {
      topLine += C.panelTitle + name + RESET;
    } else if (ti === hoverTab) {
      topLine += "\x1b[4;38;5;179m" + name + RESET; // underline amber on hover
    } else {
      topLine += "\x1b[38;5;245m" + name + RESET;
    }
  }
  topLine += " ";
  const remaining = Math.max(0, width - labelsEnd - 2);
  topLine += bc + BOX.h.repeat(remaining) + BOX.tr + RESET;

  // --- Underline rule: bright under active tab, dim elsewhere ---
  const dimRule = "\x1b[38;5;238m";
  let ruleLine = bc + BOX.v + RESET + dimRule + "──" + RESET;
  for (let i = 0; i < visIdxs.length; i++) {
    if (i > 0) ruleLine += dimRule + "──" + RESET;
    const ti = visIdxs[i];
    const name = BOTTOM_TABS[ti];
    if (ti === activeTab) {
      ruleLine += C.borderHi + "━".repeat(name.length) + RESET;
    } else if (ti === hoverTab) {
      ruleLine += "\x1b[38;5;245m" + "━".repeat(name.length) + RESET; // subtle underline on hover
    } else {
      ruleLine += dimRule + "─".repeat(name.length) + RESET;
    }
  }
  ruleLine += dimRule + "─" + RESET;
  const ruleRemain = Math.max(0, width - labelsEnd - 2);
  ruleLine += dimRule + "─".repeat(ruleRemain) + RESET + bc + BOX.v + RESET;

  // --- Content ---
  let contentLines;
  switch (activeTab) {
    case 0: contentLines = renderSessionInfoPanel(session, data, plan, width, innerH, state?.infoScroll || 0, state); break;
    case 1: contentLines = renderSystemPanel(session, data, width, innerH); break;
    case 2: contentLines = renderProcessesPanel(session, width, innerH, state); break;
    case 3: contentLines = renderAgentPanel(session, data, width, innerH, state); break;
    case 4: contentLines = renderCostPanel(session, data, plan, width, innerH, state.costScroll, state); break;
    case 5: contentLines = renderConfigPanel(session, width, innerH, state); break;
    case 6: contentLines = renderSubagentsPanel(session, data, width, innerH, state); break;
    default: contentLines = renderSessionInfoPanel(session, data, plan, width, innerH);
  }

  const result = [];
  result.push(topLine);
  result.push(ruleLine);
  for (let i = 0; i < innerH; i++) {
    result.push(boxLine(contentLines[i] || "", width));
  }
  result.push(boxBottom(width));
  return result;
}

/** Info panel: session identity, model, project, cost, tokens */
function renderSessionInfoPanel(session, data, plan, panelW, rows, scrollTop, state) {
  const allLines = [];
  const w = panelW - 4; // inner content width
  const dimRule = "\x1b[38;5;238m";

  if (!session) {
    allLines.push(C.dimText + "No session selected" + RESET);
    while (allLines.length < rows) allLines.push("");
    return allLines;
  }
  if (!data) {
    allLines.push(C.dimText + "Loading..." + RESET);
    while (allLines.length < rows) allLines.push("");
    return allLines;
  }
  if (data._error) {
    allLines.push(C.costRed + "Error reading session data:" + RESET);
    allLines.push(C.dimText + data._error + RESET);
    while (allLines.length < rows) allLines.push("");
    return allLines;
  }

  // Alias: allLines as lines inside the generation block for readability
  const lines = allLines;

  session._copyTargets = [];
  const prov = session.provider === "claude" ? "Claude" : "Codex";
  const sid = session.session_id || "unknown";
  const pm = session.process;
  const now = Date.now();

  // Two-column layout when wide enough; otherwise single column.
  const twoCol = w >= 70;
  const leftW = twoCol ? Math.floor((w - 3) / 2) : w; // 3 for "  │ " divider
  const rightW = twoCol ? (w - leftW - 3) : 0;
  const rightStartCol = leftW + 4; // column offset for right-side copy targets ("  │ ")

  // Helper: copy icon with flash
  function copyIcon(field) {
    const flash = session._copyFlash === field && session._copyFlashTs && (now - session._copyFlashTs < 1500);
    return flash ? `\x1b[38;5;114m✓${RESET}` : `\x1b[38;5;60m⧉${RESET}`;
  }

  // Layout: "LABEL ⧉" right after label, then pad to a fixed value column.
  // Both renderField and renderPlain put VALUE at the same column (labelW + 2)
  // so values line up regardless of label length or whether there's an icon.

  // Helper: render label + icon + value.
  // Returns { rendered, iconCol } where iconCol is the column index of ⧉.
  function renderField(label, value, fullValue, field, labelW, maxWidth) {
    // Value column = labelW + 2 (room for " ⧉" right after label, then a space)
    const valueAvail = maxWidth - labelW - 2;
    const truncated = (value && value.length > valueAvail) ? value.slice(0, Math.max(1, valueAvail - 1)) + "…" : value;
    // "LABEL ⧉" + spaces to reach labelW + " " + VALUE
    // Icon is at column label.length + 1 (right after first space)
    const padAfterIcon = Math.max(0, labelW - label.length - 1); // -1 accounts for icon (treated as 1 wide)
    const rendered = `${C.hdrLabel}${label}${RESET} ${copyIcon(field)}${" ".repeat(padAfterIcon)} ${C.hdrValue}${truncated || ""}${RESET}`;
    return { rendered, iconCol: label.length + 1, fullValue: fullValue || value };
  }

  // Render a plain label/value at the same value column as renderField.
  function renderPlain(label, value, labelW) {
    // Match renderField alignment: label + (labelW - label.length) spaces + " " + value
    // = total labelW + 1 chars before value (vs renderField also labelW + 1)
    const labelPad = " ".repeat(Math.max(0, labelW - label.length));
    return `${C.hdrLabel}${label}${labelPad}${RESET}  ${C.hdrValue}${value || ""}${RESET}`;
  }

  // Helper: pad an ANSI-colored string to a target visible width.
  function padAnsi(s, w) {
    const plain = (s || "").replace(/\x1b\[[^m]*m/g, "");
    return (s || "") + " ".repeat(Math.max(0, w - plain.length));
  }

  // Track copy target with its column offset (for click detection)
  function trackCopy(lineIdx, field, value, col) {
    session._copyTargets.push({ line: lineIdx, field, value, col });
  }

  // ── Build left and right field sets ──
  const m = safeMetrics(data);
  const displayModel = data.lastModel || session.model || (data.models || [data.model])[0] || "?";
  const provColor = session.provider === "claude" ? "\x1b[38;5;173m" : "\x1b[38;5;110m";
  const ml = displayModel.toLowerCase();
  const mdlColor = ml.startsWith("claude") ? "\x1b[38;5;173m"
    : (ml.startsWith("gpt") || ml.startsWith("o1") || ml.startsWith("o3") || ml.startsWith("o4")) ? "\x1b[38;5;110m"
    : C.hdrValue;

  const fullCmd = (pm && pm.command) || (session.provider === "claude" ? `claude --resume ${sid}` : `codex resume ${sid}`);
  const title = data.title || session.title;
  const proj = session.label_source || "unknown";
  const acct = session.provider === "claude" ? readClaudeAccount() : readCodexAccount();

  // Started + durations
  let startedStr = null, apiStr = null, wallStr = null;
  if (session.started_at) {
    const d = parseTimestamp(session.started_at);
    startedStr = d ? d.toLocaleString() : session.started_at;
    if (session.provider === "claude") {
      if (m.api_duration_ms > 0) {
        const apiSec = Math.round(m.api_duration_ms / 1000);
        const apiH = Math.floor(apiSec / 3600);
        const apiM = Math.floor((apiSec % 3600) / 60);
        const apiS = apiSec % 60;
        apiStr = apiH > 0 ? `${apiH}h ${apiM}m ${apiS}s` : apiM > 0 ? `${apiM}m ${apiS}s` : `${apiS}s`;
      }
      if (session.last_active) {
        const start = parseTimestamp(session.started_at);
        const end = parseTimestamp(session.last_active);
        if (start && end) {
          const wallSec = Math.max(0, Math.round((end - start) / 1000));
          const wH = Math.floor(wallSec / 3600);
          const wM = Math.floor((wallSec % 3600) / 60);
          const wS = wallSec % 60;
          wallStr = wH > 0 ? `${wH}h ${wM}m ${wS}s` : wM > 0 ? `${wM}m ${wS}s` : `${wS}s`;
        }
      }
    }
  }

  const labelW = 8; // must be >= max(label.length) + 1 for icon padding to work

  // ── Header row spans full width: Type + Model together ──
  // Aligns "Type" value column with the rows below (value at col labelW+2).
  const typeLabel = `${C.hdrLabel}Type${" ".repeat(labelW - 4)}${RESET}  ${provColor}${prov}${RESET}`;
  const modelLabel = `${C.hdrLabel}Model${RESET}   ${mdlColor}${displayModel}${RESET}`;
  lines.push(`${typeLabel}    ${modelLabel}`);

  // Left column: identity fields (with copy icons)
  // Right column: account/timing info
  const leftRows = [];
  const rightRows = [];

  // Left rows: identity & location
  {
    const r = renderField("ID", sid, sid, "id", labelW, twoCol ? leftW : w);
    leftRows.push({ rendered: r.rendered, copy: { field: "id", value: sid, iconCol: r.iconCol } });
  }
  if (title) {
    const r = renderField("Title", title, title, "title", labelW, twoCol ? leftW : w);
    leftRows.push({ rendered: r.rendered, copy: { field: "title", value: title, iconCol: r.iconCol } });
  }
  {
    const r = renderField("Dir", proj, proj, "dir", labelW, twoCol ? leftW : w);
    leftRows.push({ rendered: r.rendered, copy: { field: "dir", value: proj, iconCol: r.iconCol } });
  }
  {
    const r = renderField("Cmd", fullCmd, fullCmd, "cmd", labelW, twoCol ? leftW : w);
    leftRows.push({ rendered: r.rendered, copy: { field: "cmd", value: fullCmd, iconCol: r.iconCol } });
  }

  // Right rows: account & timing
  if (acct && acct.email) {
    const r = renderField("Account", acct.email, acct.email, "account", labelW, twoCol ? rightW : w);
    rightRows.push({ rendered: r.rendered, copy: { field: "account", value: acct.email, iconCol: r.iconCol } });
  }
  if (acct && acct.organization) {
    rightRows.push({ rendered: renderPlain("Org", acct.organization, labelW) });
  }
  if (startedStr) rightRows.push({ rendered: renderPlain("Started", startedStr, labelW) });
  if (apiStr)     rightRows.push({ rendered: renderPlain("API", apiStr, labelW) });
  if (wallStr)    rightRows.push({ rendered: renderPlain("Wall", wallStr, labelW) });

  // Render side-by-side (or stacked if narrow)
  if (twoCol) {
    const totalL = Math.max(leftRows.length, rightRows.length);
    for (let i = 0; i < totalL; i++) {
      const L = leftRows[i] || { rendered: "" };
      const R = rightRows[i] || { rendered: "" };
      lines.push(padAnsi(L.rendered, leftW) + "  " + "\x1b[38;5;238m│\x1b[0m " + R.rendered);
      const lineIdx = lines.length - 1;
      if (L.copy) trackCopy(lineIdx, L.copy.field, L.copy.value, L.copy.iconCol);
      if (R.copy) trackCopy(lineIdx, R.copy.field, R.copy.value, rightStartCol + R.copy.iconCol);
    }
  } else {
    // Single column: left rows then right rows
    for (const row of leftRows) {
      lines.push(row.rendered);
      if (row.copy) trackCopy(lines.length - 1, row.copy.field, row.copy.value, row.copy.iconCol);
    }
    for (const row of rightRows) {
      lines.push(row.rendered);
      if (row.copy) trackCopy(lines.length - 1, row.copy.field, row.copy.value, row.copy.iconCol);
    }
  }

  // Build a horizontal separator that joins the column divider with a T-junction.
  // When in two-column mode, put a ┴ at the column where │ was.
  function fullSep() {
    if (!twoCol) return dimRule + "─".repeat(w) + RESET;
    // 0..leftW+1 : ─, then ┴ at leftW+2, then ─ to end
    const leftPart = "─".repeat(leftW + 2);
    const rightPart = "─".repeat(Math.max(0, w - leftW - 3));
    return dimRule + leftPart + "┴" + rightPart + RESET;
  }

  // ── Lines added/removed (Claude only) ──
  let linesAddedRemoved = false;
  if (session.provider === "claude" && (m.lines_added > 0 || m.lines_removed > 0)) {
    lines.push(fullSep());
    linesAddedRemoved = true;
    const addStr = m.lines_added > 0 ? `${C.hdrLabel}+${RESET}\x1b[38;5;114m${m.lines_added.toLocaleString()}${RESET}` : "";
    const remStr = m.lines_removed > 0 ? `${C.hdrLabel}-${RESET}\x1b[38;5;203m${m.lines_removed.toLocaleString()}${RESET}` : "";
    const sep = m.lines_added > 0 && m.lines_removed > 0 ? `  ` : "";
    lines.push(`${C.hdrLabel}Lines${RESET}     ${addStr}${sep}${remStr}`);
  }

  // ── Context headroom ──
  const ctx = session.list_context;
  if (ctx) {
    // Only show the joining T-junction separator if we haven't already drawn one above
    lines.push(linesAddedRemoved ? dimRule + "─".repeat(w) + RESET : fullSep());

    if (ctx.compacting) {
      const flash = Math.floor(Date.now() / 600) % 2 === 0;
      const compactColor = flash ? "\x1b[1;31m" : "\x1b[38;5;52m";
      lines.push(`${C.hdrLabel}Compaction${RESET} ${compactColor}compacting...${RESET}`);
      const barW = Math.min(w - 2, 40);
      let bar = "";
      for (let b = 0; b < barW; b++) bar += compactColor + "━" + RESET;
      lines.push(`           ${bar}`);
    } else {
      const compactAt = Math.round(ctx.max * COMPACT_THRESHOLD);
      const headroom = Math.max(0, compactAt - ctx.used);
      const headroomPct = Math.round((headroom / compactAt) * 100);
      const pctColor = headroomPct < 15 ? C.costRed : headroomPct < 35 ? C.costYellow : C.chartBarLow;
      const usedPct = Math.round((ctx.used / compactAt) * 100);
      const usedStr = compactTokens(ctx.used);
      const limitStr = compactTokens(compactAt);
      lines.push(`${C.hdrLabel}Compaction${RESET} ${pctColor}${String(usedPct).padStart(3)}%${RESET}  ${C.hdrLabel}used${RESET} ${C.hdrValue}${usedStr}${RESET} ${C.hdrLabel}of${RESET} ${C.hdrValue}${limitStr}${RESET} ${C.hdrLabel}tokens${RESET}`);
      const barW = Math.min(w - 2, 40);
      const usedRatio = Math.min(1, ctx.used / compactAt);
      const filled = Math.round(usedRatio * barW);
      let bar = "";
      for (let b = 0; b < barW; b++) {
        bar += (b < filled ? pctColor + "━" : "\x1b[38;5;244m─") + RESET;
      }
      lines.push(`           ${bar}`);
    }
  }

  // Clamp and apply scroll
  const maxScroll = Math.max(0, allLines.length - rows);
  const scroll = Math.min(scrollTop || 0, maxScroll);
  if (state) state.infoScroll = scroll;

  // Scrollbar geometry
  const hasScrollbar = allLines.length > rows;
  if (hasScrollbar && state) {
    const thumbSize = Math.max(1, Math.round((rows / allLines.length) * rows));
    const thumbStart = maxScroll > 0 ? Math.round((scroll / maxScroll) * (rows - thumbSize)) : 0;
    const thumbEnd = thumbStart + thumbSize;
    state._infoScrollbar = { col: panelW - 3, thumbStart, thumbEnd, thumbSize, rows, maxScroll, totalLines: allLines.length };
  } else if (state) {
    state._infoScrollbar = null;
  }

  const visible = allLines.slice(scroll, scroll + rows);
  while (visible.length < rows) visible.push("");

  if (!hasScrollbar || !state) return visible;

  const contentW = panelW - 5;
  return visible.map((line, r) => {
    const isThumb = r >= (state._infoScrollbar?.thumbStart || 0) && r < (state._infoScrollbar?.thumbEnd || 0);
    const padded = ansiSlice(line, 0, contentW);
    if (isThumb) {
      const color = (state._infoScrollbarHover || state._infoScrollbarDrag) ? "\x1b[1;38;5;255m" : "\x1b[38;5;245m";
      return padded + color + "┃" + RESET;
    }
    return padded + "\x1b[38;5;238m│" + RESET;
  });
}

/** Cost panel: /cost-style breakdown — total, API duration, wall time, lines, per-model */
function renderCostPanel(session, data, plan, panelW, rows, scrollTop, state) {
  const allLines = [];
  const dimRule = "\x1b[38;5;238m";

  if (!session) {
    allLines.push(C.dimText + "No session selected" + RESET);
    while (allLines.length < rows) allLines.push("");
    return allLines;
  }
  if (!data) {
    allLines.push(C.dimText + "Loading..." + RESET);
    while (allLines.length < rows) allLines.push("");
    return allLines;
  }

  const incl = planIncludesProvider(plan, session.provider);
  const isClaude = session.provider === "claude";

  const fmtAmt = (v) => v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  const shortModel = (m) => m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/^gpt-/, "");

  // ── LEFT: Total cost + spend windows ──
  const leftLines = [];
  const costVal = incl ? "included" : usd(data.costs.total);
  const totalCostColor = incl ? C.dimText : costColor(data.costs.total);
  leftLines.push(`${C.hdrLabel}Total cost${RESET}  ${totalCostColor}${costVal}${RESET}`);
  if (!incl && isClaude) {
    leftLines.push(`${C.dimText}  (est: tokens × LiteLLM)${RESET}`);
  }

  if (!incl && (data.costsByDay || data.costsByHour)) {
    const nowMs = Date.now();
    const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
    const todayKey = localDateKey(today);
    const weekKey  = localDateKey(new Date(today.getTime() - 6 * 86400_000));
    const monthKey = localDateKey(new Date(today.getTime() - 29 * 86400_000));
    const hourKey  = localHourKey(new Date(nowMs));

    const mergeInto = (acc, dict) => {
      for (const [m, v] of Object.entries(dict || {})) acc[m] = (acc[m] || 0) + v;
    };
    const hourModels = {}, todayModels = {}, weekModels = {}, monthModels = {};
    if (data.costsByHour) {
      const h = data.costsByHour[hourKey];
      if (h) mergeInto(hourModels, typeof h === "object" ? h : { _: h });
    }
    for (const [day, models] of Object.entries(data.costsByDay || {})) {
      const dict = typeof models === "object" ? models : { _: models };
      if (day >= monthKey) mergeInto(monthModels, dict);
      if (day >= weekKey)  mergeInto(weekModels,  dict);
      if (day >= todayKey) mergeInto(todayModels, dict);
    }

    const totalOf = (d) => Object.values(d).reduce((a, b) => a + b, 0);
    const renderWindow = (label, modelMap) => {
      const tot = totalOf(modelMap);
      leftLines.push(`  ${C.hdrLabel}${label}${RESET}    ${costColor(tot)}${fmtAmt(tot)}${RESET}`);
      for (const [m, v] of Object.entries(modelMap).sort((a, b) => b[1] - a[1])) {
        if (m === "_") continue;
        leftLines.push(`    ${C.hdrValue}${shortModel(m)}${RESET}  ${costColor(v)}${fmtAmt(v)}${RESET}`);
      }
    };

    renderWindow("last hour", hourModels);
    renderWindow("today",     todayModels);
    renderWindow("7 days",    weekModels);
    renderWindow("30 days",   monthModels);
  }

  // ── RIGHT: Model breakdown ──
  const rightLines = [];
  if (!incl) {
    if (isClaude && data.modelBreakdown && data.modelBreakdown.length > 0) {
      for (const mb of data.modelBreakdown) {
        const modelTotal = parseFloat(mb.total) || 0;
        const modelTotalColor = costColor(mb.total);
        const t = mb.tokens || {};
        const c = mb.costs  || {};
        const cwTok  = (t.cache_write_5m || 0) + (t.cache_write_1h || 0);
        const cwCost = (c.cache_write_5m || 0) + (c.cache_write_1h || 0);
        rightLines.push(dimRule + "─".repeat(30) + RESET);
        rightLines.push(`${C.hdrValue}${mb.model}${RESET}  ${modelTotalColor}$${modelTotal.toFixed(2)}${RESET}`);
        rightLines.push(`  ${C.hdrLabel}in${RESET}       ${C.hdrValue}${compactTokens(t.input || 0).padStart(6)}${RESET}  ${costColor(c.input || 0)}$${(c.input || 0).toFixed(4)}${RESET}`);
        rightLines.push(`  ${C.hdrLabel}out${RESET}      ${C.hdrValue}${compactTokens(t.output || 0).padStart(6)}${RESET}  ${costColor(c.output || 0)}$${(c.output || 0).toFixed(4)}${RESET}`);
        if ((t.cache_read || 0) > 0) {
          rightLines.push(`  ${C.hdrLabel}cache↓${RESET}   ${C.hdrValue}${compactTokens(t.cache_read || 0).padStart(6)}${RESET}  ${costColor(c.cache_read || 0)}$${(c.cache_read || 0).toFixed(4)}${RESET}`);
        }
        if (cwTok > 0) {
          rightLines.push(`  ${C.hdrLabel}cache↑${RESET}   ${C.hdrValue}${compactTokens(cwTok).padStart(6)}${RESET}  ${costColor(cwCost)}$${cwCost.toFixed(4)}${RESET}`);
        }
      }
    } else if (!isClaude) {
      // Codex: single model token/cost breakdown
      const model = data.model || "";
      const t = data.tokens || {};
      const c = data.costs  || {};
      const r = data.rates  || {};
      const totalColor = costColor(data.costs.total);
      if (model) {
        rightLines.push(dimRule + "─".repeat(30) + RESET);
        rightLines.push(`${C.hdrValue}${shortModel(model)}${RESET}  ${totalColor}${usd(data.costs.total)}${RESET}`);
      }
      rightLines.push(`  ${C.hdrLabel}in${RESET}       ${C.hdrValue}${compactTokens(t.input || 0).padStart(6)}${RESET}  ${costColor(parseFloat(c.input || 0))}$${parseFloat(c.input || 0).toFixed(4)}${RESET}`);
      if ((t.cached_input || 0) > 0) {
        rightLines.push(`  ${C.hdrLabel}cached${RESET}   ${C.hdrValue}${compactTokens(t.cached_input || 0).padStart(6)}${RESET}  ${costColor(parseFloat(c.cached_input || 0))}$${parseFloat(c.cached_input || 0).toFixed(4)}${RESET}`);
      }
      rightLines.push(`  ${C.hdrLabel}out${RESET}      ${C.hdrValue}${compactTokens(t.output || 0).padStart(6)}${RESET}  ${costColor(parseFloat(c.output || 0))}$${parseFloat(c.output || 0).toFixed(4)}${RESET}`);
      if (r.input) {
        rightLines.push(`  ${C.dimText}rates: in $${r.input}  out $${r.output}${RESET}`);
      }
    }
  }

  // ── Combine left + right side by side ──
  const sepCol = Math.floor((panelW - 2) / 2);
  const rightStart = sepCol + 2; // after "│ "
  const rightW = panelW - rightStart;
  const totalL = Math.max(leftLines.length, rightLines.length);
  const padTo = (line, w) => {
    const plain = (line || "").replace(/\x1b\[[^m]*m/g, "");
    return (line || "") + " ".repeat(Math.max(0, w - plain.length));
  };
  const divider = "\x1b[38;5;238m│\x1b[0m ";
  for (let i = 0; i < totalL; i++) {
    allLines.push(padTo(leftLines[i] || "", sepCol) + divider + (rightLines[i] || ""));
  }

  // Clamp and apply scroll
  const maxScroll = Math.max(0, allLines.length - rows);
  const scroll = Math.min(scrollTop || 0, maxScroll);
  if (state) state.costScroll = scroll;

  // Scrollbar geometry
  const hasScrollbar = allLines.length > rows;
  let thumbStart = 0, thumbEnd = 0, thumbSize = 0;
  if (hasScrollbar && state) {
    thumbSize = Math.max(1, Math.round((rows / allLines.length) * rows));
    thumbStart = maxScroll > 0 ? Math.round((scroll / maxScroll) * (rows - thumbSize)) : 0;
    thumbEnd = thumbStart + thumbSize;
    state._costScrollbar = { col: panelW - 3, thumbStart, thumbEnd, thumbSize, rows, maxScroll, totalLines: allLines.length };
  } else if (state) {
    state._costScrollbar = null;
  }

  const visible = allLines.slice(scroll, scroll + rows);
  while (visible.length < rows) visible.push("");

  if (!hasScrollbar || !state) return visible;

  // Append scrollbar column to each line
  const contentW = panelW - 5; // one less than full content width to make room for scrollbar
  return visible.map((line, r) => {
    const isThumb = r >= thumbStart && r < thumbEnd;
    const padded = ansiSlice(line, 0, contentW);
    if (isThumb) {
      const color = (state._costScrollbarHover || state._costScrollbarDrag) ? "\x1b[1;38;5;255m" : "\x1b[38;5;245m";
      return padded + color + "┃" + RESET;
    }
    return padded + "\x1b[38;5;238m│" + RESET;
  });
}

/** Center panel: CPU, memory, PIDs with strip charts */
function renderSystemPanel(session, data, panelW, rows) {
  const lines = [];

  if (!session) {
    lines.push(C.dimText + "No session selected" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  if (session._isSubagent) {
    lines.push(C.dimText + "Shared with parent process — no per-subagent OS metrics." + RESET);
    lines.push(C.dimText + "Select the parent session row to see CPU/memory for the whole session." + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const pm = session.process;

  if (!pm) {
    lines.push(C.dimText + "Performance data is only available for running sessions" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const sessionKey = `${session.provider}:${session.session_id}`;

  const cpuHist = _cpuHistory.get(sessionKey) || [];
  const memHist = _memHistory.get(sessionKey) || [];

  const memMB = pm.memory / (1024 * 1024);
  const memMaxRaw = memHist.length > 0 ? Math.max(...memHist) : 100;
  const memMax = niceMax(memMaxRaw);
  const cpuColor = pm.cpu > 80 ? C.chartBarHi : pm.cpu > 40 ? C.chartBarMed : C.hdrValue;

  // PIDs + command info line
  const pidLine = `${C.hdrLabel}PIDs${RESET} ${C.hdrValue}${pm.pids}${RESET}`
    + (pm.command ? `  ${C.hdrLabel}Cmd${RESET} ${C.hdrDim}${pm.command}${RESET}` : "");

  // Layout: side-by-side with braille charts when there's enough room
  const sideBySide = panelW >= 60;

  if (sideBySide) {
    // Side-by-side: header row + braille charts + PIDs row
    // renderBrailleChart returns chartRows + 1 lines (data + axis)
    const gap = 3;
    const halfW = Math.floor((panelW - gap) / 2);
    const chartRows = Math.max(2, rows - 3); // -1 header, -1 axis (shared), -1 PIDs

    // Header line: CPU info (left half) + Mem info (right half)
    const cpuInfoPlain = `CPU ${(pm.cpu + "%").padStart(5)}  PIDs ${pm.pids}`;
    const memInfoPlain = `Mem ${(memMB.toFixed(0) + " MB").padStart(7)}`;
    const headerPad = Math.max(1, halfW + gap - cpuInfoPlain.length);
    lines.push(
      `${C.hdrLabel}CPU${RESET} ${cpuColor}${(pm.cpu + "%").padStart(5)}${RESET}  `
      + `${C.hdrLabel}PIDs${RESET} ${C.hdrValue}${pm.pids}${RESET}`
      + " ".repeat(headerPad)
      + `${C.hdrLabel}Mem${RESET} ${C.hdrValue}${(memMB.toFixed(0) + " MB").padStart(7)}${RESET}`
    );

    // Braille charts — use same axis width so data columns align
    const cpuAxisW = Math.max(1, String(100).length) + 2;
    const memAxisW = Math.max(1, String(Math.ceil(memMax)).length) + 2;
    const sharedAxisW = Math.max(cpuAxisW, memAxisW);
    const cpuChart = renderBrailleChart(cpuHist, halfW, chartRows, 100, "cpu", sharedAxisW);
    const memChart = renderBrailleChart(memHist, halfW, chartRows, memMax, "accent", sharedAxisW);
    for (let i = 0; i < cpuChart.length; i++) {
      lines.push(cpuChart[i] + " ".repeat(gap) + memChart[i]);
    }
  } else {
    // Stacked layout for narrow panels
    // Each chart: 1 header + chartRows + 1 axis = chartRows + 2
    // Total: 2 * (chartRows + 2) + 1 PIDs = 2*chartRows + 5
    const chartRows = Math.max(2, Math.floor((rows - 5) / 2));
    const chartW = Math.max(10, panelW - 2);

    if (rows >= 9) {
      // Braille charts stacked
      lines.push(`${C.hdrLabel}CPU${RESET}  ${cpuColor}${(pm.cpu + "%").padStart(6)}${RESET}`);
      for (const cl of renderBrailleChart(cpuHist, chartW, chartRows, 100, "cpu")) lines.push(cl);

      lines.push(`${C.hdrLabel}Mem${RESET}  ${C.hdrValue}${(memMB.toFixed(0) + " MB").padStart(8)}${RESET}`);
      for (const cl of renderBrailleChart(memHist, chartW, chartRows, memMax, "accent")) lines.push(cl);
    } else {
      // Sparkline fallback for very small panels
      const sparkW = Math.max(8, panelW - 14);
      lines.push(`${C.hdrLabel}CPU${RESET}  ${cpuColor}${(pm.cpu + "%").padStart(6)}${RESET}`);
      lines.push(renderSparkline(cpuHist, sparkW, 100, "cpu"));
      lines.push(`${C.hdrLabel}Mem${RESET}  ${C.hdrValue}${(memMB.toFixed(0) + " MB").padStart(8)}${RESET}`);
      lines.push(renderSparkline(memHist, sparkW, memMax, "accent"));
    }
    if (lines.length < rows) lines.push(pidLine);
  }

  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

const AGENT_TAB_WIDTH_MIN = 12;
const AGENT_TAB_WIDTH_FRAC = 0.20; // 20% of panel width

/** Tool Activity panel: vertical tabs with per-tool invocation details */
function renderAgentPanel(session, data, panelW, rows, state) {
  const lines = [];
  const AGENT_TAB_WIDTH = Math.max(AGENT_TAB_WIDTH_MIN, Math.floor(panelW * AGENT_TAB_WIDTH_FRAC));
  state._agentTabWidth = AGENT_TAB_WIDTH;

  if (!session || !data) {
    if (session) lines.push(C.dimText + "Loading..." + RESET);
    state._agentToolTabs = [];
    state._agentCopyTargets = [];
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const m = safeMetrics(data);

  if (m.tool_count === 0) {
    lines.push(C.dimText + "No tool invocations" + RESET);
    state._agentToolTabs = [];
    state._agentCopyTargets = [];
    while (lines.length < rows) lines.push("");
    return lines;
  }

  // Build sorted tool list (by count descending), with "All" virtual entry at index 0
  const toolList = [["*All", m.tool_count], ...Object.entries(m.tools).sort((a, b) => b[1] - a[1])];

  // Ensure selected tab is valid
  if (state.agentToolTab >= toolList.length) state.agentToolTab = 0;

  // Header row takes 1 line from content area; sidebar uses full rows
  const sidebarRows = rows;
  const contentRows = rows - 1; // 1 row for header

  // Sidebar scroll
  if (state.agentTabScroll === undefined) state.agentTabScroll = 0;
  if (state.agentTabScroll < 0) state.agentTabScroll = 0;

  // Compute sidebar layout for a given scroll position
  function sidebarLayout(scroll) {
    const up = scroll > 0;
    const slotsIfNoDown = sidebarRows - (up ? 1 : 0);
    const needDown = scroll + slotsIfNoDown < toolList.length;
    const slots = needDown ? slotsIfNoDown - 1 : slotsIfNoDown;
    return { up, down: needDown, slots: Math.max(1, slots) };
  }

  // When selected tab changes (e.g. click on tool name), scroll to keep it visible
  if (state._agentScrollToTab) {
    state._agentScrollToTab = false;
    while (state.agentToolTab < state.agentTabScroll) state.agentTabScroll--;
    while (state.agentToolTab >= state.agentTabScroll + sidebarLayout(state.agentTabScroll).slots) state.agentTabScroll++;
  }

  // Clamp: don't scroll past the last tool
  {
    let maxScroll = 0;
    for (let s = 0; s <= toolList.length; s++) {
      if (s + sidebarLayout(s).slots >= toolList.length) { maxScroll = s; break; }
      maxScroll = s + 1;
    }
    if (state.agentTabScroll > maxScroll) state.agentTabScroll = maxScroll;
  }

  // Content area
  let contentW = panelW - 4 - AGENT_TAB_WIDTH - 1; // inner width minus tab sidebar minus separator
  const HOME = process.env.HOME || "";

  // Compute per-tool live counts (entries since agtop started). The "live since
  // agtop started" filter doesn't make sense for a subagent drill-down: subagents
  // are point-in-time records, and applying the filter would silently zero out
  // every count for any subagent whose timestamps predate agtop's launch (while
  // the same subagent's row in the list keeps showing its raw tool count).
  const liveFilterActive = state.agentLiveFilter && !session._isSubagent;
  const startTime = state._startTime || "";
  const liveCountByTool = {};
  if (liveFilterActive && m.tool_details) {
    let allLive = 0;
    for (const [tName] of toolList) {
      if (tName === "*All") continue;
      const details = m.tool_details[tName] || [];
      const cnt = details.filter(e => {
        const ts = typeof e === "string" ? "" : (e.ts || "");
        return ts >= startTime;
      }).length;
      liveCountByTool[tName] = cnt;
      allLive += cnt;
    }
    liveCountByTool["*All"] = allLive;
  }

  // Selected tool details — sorted chronologically (oldest first, newest at bottom)
  const [toolName, toolCount] = toolList[state.agentToolTab];
  const isAllTab = toolName === "*All";
  let rawDetails;
  if (isAllTab && m.tool_details) {
    // Merge all tool details with tool name tag
    rawDetails = [];
    for (const [tName, entries] of Object.entries(m.tool_details)) {
      for (const e of entries) {
        const base = typeof e === "string" ? { d: e, ts: "" } : e;
        rawDetails.push({ ...base, _tool: tName });
      }
    }
  } else {
    rawDetails = ((m.tool_details && m.tool_details[toolName]) || []).map(e => ({ ...e, _tool: toolName }));
  }
  const allSorted = [...rawDetails].sort((a, b) => {
    const ta = a.ts || "";
    const tb = b.ts || "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  // Apply live filter if active
  const sorted = liveFilterActive
    ? allSorted.filter(e => {
        const ts = typeof e === "string" ? "" : (e.ts || "");
        return ts >= startTime;
      })
    : allSorted;

  // Content scroll — stick to bottom unless user has scrolled up
  const maxContentScroll = Math.max(0, sorted.length - contentRows);
  const wasAtBottom = state.agentToolScroll === -1 ||
    (state._agentPrevMaxScroll !== undefined && state.agentToolScroll >= state._agentPrevMaxScroll);
  state._agentPrevMaxScroll = maxContentScroll;
  if (wasAtBottom || state.agentToolScroll > maxContentScroll) {
    state.agentToolScroll = maxContentScroll;
  }

  // Scrollbar geometry (computed before loop so contentW can be adjusted)
  const hasScrollbar = sorted.length > contentRows;
  if (hasScrollbar) contentW -= 1;
  let sbThumbStart = 0, sbThumbEnd = 0;
  if (hasScrollbar) {
    const sbThumbSize = Math.max(1, Math.round((contentRows / sorted.length) * contentRows));
    sbThumbStart = maxContentScroll > 0 ? Math.round((state.agentToolScroll / maxContentScroll) * (contentRows - sbThumbSize)) : 0;
    sbThumbEnd = sbThumbStart + sbThumbSize;
    state._agentScrollbar = { thumbStart: sbThumbStart, thumbEnd: sbThumbEnd, thumbSize: sbThumbSize, contentRows, rows, maxScroll: maxContentScroll, col: panelW - 3 };
  } else {
    state._agentScrollbar = null;
  }

  // Detect count changes and trigger flash
  const FLASH_DURATION = 1500;
  const now = Date.now();
  for (const [tName, tCount] of toolList) {
    const prev = state._agentToolCounts[tName];
    if (prev !== undefined && prev !== tCount) {
      state._agentToolFlash[tName] = now;
    }
    state._agentToolCounts[tName] = tCount;
  }

  // Store tab info for click detection
  state._agentToolTabs = [];
  state._agentCopyTargets = [];
  state._agentLiveBtn = null;
  state._agentUpArrowRow = -1;
  state._agentDownArrowRow = -1;

  // Pre-compute sidebar layout: which row shows what
  const layout = sidebarLayout(state.agentTabScroll);
  const hasUpArrow = layout.up;
  const hasDownArrow = layout.down;

  for (let r = 0; r < rows; r++) {
    let line = "";

    // --- Vertical tab sidebar ---
    const isUpArrow = r === 0 && hasUpArrow;
    const isDownArrow = r === sidebarRows - 1 && hasDownArrow;
    // Map row to tool index: skip up arrow row
    const toolSlot = r - (hasUpArrow ? 1 : 0);
    const tabIdx = state.agentTabScroll + toolSlot;

    if (isUpArrow) {
      const isHoverArrow = state._hoverAgentArrow === "up";
      const arrowStyle = isHoverArrow ? "\x1b[1;38;5;255m" : C.dimText;
      const arrow = arrowStyle + " ".repeat(Math.floor(AGENT_TAB_WIDTH / 2) - 1) + "▲" + RESET;
      line += arrow + " ".repeat(Math.max(0, AGENT_TAB_WIDTH - Math.floor(AGENT_TAB_WIDTH / 2)));
      state._agentUpArrowRow = r;
    } else if (isDownArrow) {
      const isHoverArrow = state._hoverAgentArrow === "down";
      const arrowStyle = isHoverArrow ? "\x1b[1;38;5;255m" : C.dimText;
      const arrow = arrowStyle + " ".repeat(Math.floor(AGENT_TAB_WIDTH / 2) - 1) + "▼" + RESET;
      line += arrow + " ".repeat(Math.max(0, AGENT_TAB_WIDTH - Math.floor(AGENT_TAB_WIDTH / 2)));
      state._agentDownArrowRow = r;
    } else if (tabIdx < toolList.length) {
      const [tName, tCount] = toolList[tabIdx];
      const displayCount = liveFilterActive ? (liveCountByTool[tName] || 0) : tCount;
      const isActive = tabIdx === state.agentToolTab;
      const isHover = tabIdx === state.hoverAgentToolTab;
      const flashTs = state._agentToolFlash[tName] || 0;
      const isFlashing = flashTs && (now - flashTs < FLASH_DURATION);
      // Highlight tools with recent activity (within last interval)
      const hasRecentActivity = isFlashing;

      // Format: " Name   42 " (fixed width)
      const isAllEntry = tName === "*All";
      const shortName = isAllEntry ? "All" : tName.replace(/^mcp__/, "");
      const countStr = String(displayCount);
      const maxNameLen = AGENT_TAB_WIDTH - countStr.length - 3; // space + name + space + count + space
      const trimName = shortName.length > maxNameLen ? shortName.slice(0, maxNameLen - 1) + "…" : shortName;
      const pad = " ".repeat(Math.max(0, maxNameLen - trimName.length));

      // Count style: flash bright when count changes
      const countStyle = isFlashing ? "\x1b[1;38;5;114m" : C.hdrDim;

      if (isActive) {
        const nameStyle = hasRecentActivity ? "\x1b[1;38;5;114m" : "\x1b[1;38;5;255m";
        line += " " + nameStyle + trimName + RESET + pad + " " + countStyle + countStr + RESET + " ";
      } else if (isHover) {
        const nameStyle = hasRecentActivity ? "\x1b[4;38;5;114m" : "\x1b[4;38;5;250m";
        line += " " + nameStyle + trimName + RESET + pad + " " + countStyle + countStr + RESET + " ";
      } else {
        const nameStyle = hasRecentActivity ? "\x1b[38;5;114m" : "\x1b[38;5;245m";
        line += " " + nameStyle + trimName + RESET + pad + " " + countStyle + countStr + RESET + " ";
      }

      // Store for click detection
      state._agentToolTabs.push({ row: r, idx: tabIdx });
    } else {
      line += " ".repeat(AGENT_TAB_WIDTH);
    }

    // --- Separator ---
    const isActiveSep = !isUpArrow && !isDownArrow && tabIdx >= 0 && tabIdx < toolList.length && tabIdx === state.agentToolTab;
    if (isActiveSep) {
      line += C.borderHi + "┃" + RESET;
    } else {
      line += "\x1b[38;5;238m│" + RESET;
    }

    // --- Header row (first content row) ---
    if (r === 0) {
      // Hide the Live toggle for subagent drill-downs — the filter doesn't apply
      // there (see liveFilterActive computation above), so showing the button
      // would suggest a toggle that has no effect.
      if (session._isSubagent) {
        state._agentLiveBtn = null;
        lines.push(line);
        continue;
      }
      const liveOn = state.agentLiveFilter;
      const btnInner = liveOn ? "● Live" : "○ Live";
      const btnInnerLen = btnInner.length;
      const btn = liveOn
        ? "\x1b[1;38;5;114m[" + RESET + "\x1b[1;38;5;16;48;5;114m " + btnInner + " " + RESET + "\x1b[1;38;5;114m]" + RESET
        : "\x1b[38;5;245m[ " + btnInner + " ]" + RESET;
      const btnLen = btnInnerLen + 4;
      const pad = Math.max(0, contentW - btnLen);
      line += " ".repeat(pad) + btn;
      const btnStart = AGENT_TAB_WIDTH + 1 + pad;
      state._agentLiveBtn = { row: r, colStart: btnStart, colEnd: btnStart + btnLen };
      lines.push(line);
      continue;
    }

    // --- Content: timestamp + invocation detail + copy icon ---
    const ci = (r - 1) + state.agentToolScroll;
    if (ci < sorted.length) {
      const entry = sorted[ci];
      const rawDetail = typeof entry === "string" ? entry : (entry.d || "");
      const rawTs = typeof entry === "string" ? "" : (entry.ts || "");

      let display = rawDetail.replace(/[\r\n\t]/g, " ").trimEnd();
      if (HOME && display.startsWith(HOME)) display = "~" + display.slice(HOME.length);

      // Compact timestamp: "14:32" (today) or "Mar 5 14:32" (older)
      let tsLabel = "";
      if (rawTs) {
        const d = new Date(rawTs);
        if (!isNaN(d.getTime())) {
          const todayStr = new Date().toDateString();
          if (d.toDateString() === todayStr) {
            tsLabel = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
          } else {
            const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
            tsLabel = mon + " " + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
          }
        }
      }

      // Copy icon on the right
      const copyFlash = state._agentCopyFlash === ci && state._agentCopyFlashTs && (now - state._agentCopyFlashTs < 1500);
      const icon = copyFlash ? `\x1b[38;5;114m✓${RESET}` : `\x1b[38;5;60m⧉${RESET}`;
      const copyValue = typeof entry === "string" ? entry : (entry.full || entry.d || "");
      state._agentCopyTargets.push({ row: r, value: copyValue });

      // Tool name prefix for "All" view
      const entryTool = isAllTab ? (entry._tool || "") : "";
      const toolLabel = entryTool ? entryTool.replace(/^mcp__[^_]+__/, "mcp:") : "";
      const toolLabelW = toolLabel ? toolLabel.length + 1 : 0; // +1 trailing space

      const tsW = tsLabel ? tsLabel.length + 1 : 0; // +1 for trailing space
      const iconW = 2; // icon char may be double-width in some fonts
      const availW = contentW - 3 - tsW - toolLabelW - iconW; // space + ts + toolLabel + text + space + icon
      if (display.length > availW) display = display.slice(0, Math.max(0, availW - 1)) + "…";
      line += " ";
      if (tsLabel) line += C.dimText + tsLabel + RESET + " ";
      if (toolLabel) {
        // Stable color per tool name (cycle through palette)
        const TOOL_COLORS = [75, 114, 173, 180, 139, 109, 146, 215, 152, 167];
        let hash = 0;
        for (let c = 0; c < entryTool.length; c++) hash = ((hash << 5) - hash + entryTool.charCodeAt(c)) | 0;
        const colorIdx = ((hash % TOOL_COLORS.length) + TOOL_COLORS.length) % TOOL_COLORS.length;
        line += `\x1b[38;5;${TOOL_COLORS[colorIdx]}m` + toolLabel + RESET + " ";
      }
      line += C.hdrValue + display + RESET;
      const textLen = display.length;
      const fillLen = Math.max(0, availW - textLen);
      line += " ".repeat(fillLen) + " " + icon;
    } else {
      line += " ".repeat(contentW);
    }

    // Append scrollbar character for content rows (r >= 1)
    if (hasScrollbar) {
      const trackPos = r - 1; // 0-based track position
      const isThumb = trackPos >= sbThumbStart && trackPos < sbThumbEnd;
      line += isThumb ? "\x1b[38;5;245m┃" + RESET : "\x1b[38;5;238m│" + RESET;
    }

    lines.push(line);
  }

  // Clip all lines to panel inner width to prevent overflow
  const maxW = panelW - 4;
  return lines.slice(0, rows).map(l => {
    const vLen = ansiLen(l);
    if (vLen > maxW) return ansiSlice(l, 0, maxW);
    if (vLen < maxW) return l + " ".repeat(maxW - vLen);
    return l;
  });
}

// ---------------------------------------------------------------------------
// Render: subagents panel
// ---------------------------------------------------------------------------

/** Render the Subagents panel: one row per subagent the session has spawned.
 *  Read-only listing. Sorted with running entries first, then newest started_at first. */
function renderSubagentsPanel(session, data, panelW, rows, state) {
  const lines = [];
  const w = panelW - 4;

  if (!session) {
    lines.push(C.dimText + "No session selected" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }
  if (!data) {
    lines.push(C.dimText + "Loading..." + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const list = (data.subagents || []).slice();
  if (list.length === 0) {
    lines.push(C.dimText + "No subagents" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  // Running first; within each status group, newest started_at first.
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === "running" ? -1 : 1;
    const aTs = a.started_at || "";
    const bTs = b.started_at || "";
    return bTs.localeCompare(aTs);
  });

  // Column widths (status icon is 1 col wide; we add a trailing space after each column)
  const startW = 5;  // "HH:MM" — when the parent's Agent tool_use was dispatched
  const typeW = 12;
  const modelW = 12;
  const costW = 7;   // up to "$999.99"
  const toolsW = 5;  // up to 99999
  const ctxW = 4;    // "100%"
  const timeW = 7;   // "MM:SS", "Xm SSs", "Xh YYm"
  const fixedW = startW + 1 + 1 + 1 + typeW + 1 + modelW + 1 + 1 + costW + 1 + toolsW + 1 + ctxW + 1 + timeW;
  const descW = Math.max(10, w - fixedW);

  const fmtStart = (ts) => {
    if (!ts) return "—".padStart(startW);
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "?".padStart(startW);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };

  const shortModel = (m) => (m || "?")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^gpt-/, "");

  const fmtDur = (ms) => {
    if (!ms || ms <= 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60)    return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60)    return `${m}m${String(r).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    const mr = m % 60;
    return `${h}h${String(mr).padStart(2, "0")}m`;
  };

  const truncate = (s, n) => {
    s = String(s ?? "");
    if (s.length <= n) return s;
    return s.slice(0, Math.max(1, n - 1)) + "…";
  };

  // Header row — uses the same bold-white-on-dark-gray style as the session list
  // column header (C.colHdrBg). No trailing RESET so boxLine's ansiSlice pads the
  // remainder of the row with bg-bearing spaces, extending the bar to full width.
  const hdr = C.colHdrBg;
  lines.push(
    hdr + "START".padEnd(startW) +
    "   " +
    truncate("TYPE", typeW).padEnd(typeW) + " " +
    truncate("MODEL", modelW).padEnd(modelW) + " " +
    truncate("DESCRIPTION", descW).padEnd(descW) + " " +
    "COST".padStart(costW) + " " +
    "TOOLS".padStart(toolsW) + " " +
    "CTX".padStart(ctxW) + " " +
    "TIME".padStart(timeW)
  );

  // Scroll handling (auto-clamp; default top)
  if (state.subagentScroll === undefined) state.subagentScroll = 0;
  if (state.subagentScroll < 0) state.subagentScroll = 0;
  const visibleRows = Math.max(0, rows - 1);
  const maxScroll = Math.max(0, list.length - visibleRows);
  if (state.subagentScroll > maxScroll) state.subagentScroll = maxScroll;

  for (let i = 0; i < visibleRows; i++) {
    const sa = list[i + state.subagentScroll];
    if (!sa) { lines.push(""); continue; }
    const isRunning = sa.status === "running";
    const isGhost = sa.ghost === true;

    // Status icon: bright ● running / plain ○ done; ghost rows use a dotted ◌ to flag
    // that the on-disk transcript is gone and per-agent metrics aren't available.
    let statusIcon;
    if (isGhost) {
      statusIcon = C.dimText + "◌" + RESET;
    } else if (isRunning) {
      statusIcon = C.chartBarHi + "●" + RESET;
    } else {
      statusIcon = C.dimText + "○" + RESET;
    }

    const typeStr = truncate(sa.type || "?", typeW).padEnd(typeW);
    const modelStr = truncate(shortModel(sa.model), modelW).padEnd(modelW);
    const descStr = truncate(sa.description || "(no description)", descW).padEnd(descW);
    const costNum = typeof sa.cost === "number" ? sa.cost : Number(sa.cost) || 0;
    // Ghost rows: we don't know cost/tools/duration — show em-dash placeholders.
    const costStr  = (isGhost ? "—"  : ("$" + costNum.toFixed(2))).padStart(costW);
    const toolsStr = (isGhost ? "—"  : String(sa.tool_count || 0)).padStart(toolsW);
    // CTX% against the model's compact threshold (same formula as the parent CTX column).
    const ctx = sa.context;
    const ctxPct = ctx ? (ctx.used / (ctx.max * COMPACT_THRESHOLD)) * 100 : 0;
    const ctxStr = (isGhost || !ctx)
      ? "—".padStart(ctxW)
      : (Math.round(ctxPct) + "%").padStart(ctxW);
    const timeStr  = (isGhost ? "—"  : fmtDur(sa.duration_ms)).padStart(timeW);

    // Ghost rows are dimmed overall; live rows use brighter row color when running.
    const rowColor = isGhost ? C.dimText : (isRunning ? C.hdrValue : "\x1b[38;5;250m");
    // Match the parent session row's per-column color rules where they apply.
    const costColForCol = isGhost ? rowColor : costColor(costNum);
    const ctxColForCol = isGhost || !ctx ? C.dimText
      : ctxPct > 85 ? C.costRed
      : ctxPct > 65 ? C.costYellow
      : ctxPct > 0  ? C.chartBarLow
      : C.dimText;
    const modelColForCol = isGhost ? rowColor : modelColor({ model: sa.model || "" });
    // START column mirrors the parent's LAST column: ageDimColor on dispatch time.
    const startColForCol = isGhost
      ? C.dimText
      : ageDimColor({ last_active: sa.started_at, process: isRunning }, new Date());
    // DUR/TIME thresholds: ≤10m row color, >10m yellow, >30m red.
    const durMs = sa.duration_ms || 0;
    const timeColForCol = isGhost
      ? rowColor
      : durMs > 1800000 ? C.costRed
      : durMs > 600000  ? C.costYellow
      : rowColor;
    const startStr = fmtStart(sa.started_at);
    lines.push(
      startColForCol + startStr + RESET + " " +
      statusIcon + " " +
      rowColor + typeStr + RESET + " " +
      modelColForCol + modelStr + RESET + " " +
      rowColor + descStr + RESET + " " +
      costColForCol + costStr + RESET + " " +
      rowColor + toolsStr + RESET + " " +
      ctxColForCol + ctxStr + RESET + " " +
      timeColForCol + timeStr + RESET
    );
  }

  while (lines.length < rows) lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Render: config panel
// ---------------------------------------------------------------------------

const CONFIG_TAB_WIDTH = 14; // width of the vertical tab sidebar

/** Render the Config panel with vertical sub-tabs and scrollable content. */
function renderConfigPanel(session, panelW, rows, state) {
  const lines = [];

  if (!session) {
    lines.push(C.dimText + "No session selected" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const sections = getSessionConfig(session);
  if (sections.length === 0) {
    lines.push(C.dimText + "No configuration files found" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  // Ensure configSubTab is valid
  if (state.configSubTab >= sections.length) state.configSubTab = 0;

  const activeSection = sections[state.configSubTab];
  const contentW = panelW - 4 - CONFIG_TAB_WIDTH - 1; // inner width minus tab sidebar minus separator

  // Build content lines for the active section — one display line per source line, clipped with …
  const rawLines = activeSection ? activeSection.lines : [];
  const contentLines = [];
  const clipW = contentW - 2; // -2 for leading space + margin
  for (const rl of rawLines) {
    const cleaned = rl.replace(/\t/g, "    ").replace(/[\r\n]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1a]/g, "");
    const vLen = ansiLen(cleaned);
    contentLines.push(vLen > clipW ? ansiSlice(cleaned, 0, clipW - 1) + "…" : cleaned);
  }

  // Ensure scroll is valid
  const maxScroll = Math.max(0, contentLines.length - rows);
  if (state.configScroll > maxScroll) state.configScroll = maxScroll;
  if (state.configScroll < 0) state.configScroll = 0;

  // Build the scrollbar
  const hasScrollbar = contentLines.length > rows;
  const scrollbarW = hasScrollbar ? 1 : 0;
  const visibleContentW = contentW - scrollbarW;

  // Scrollbar geometry (stored on state for mouse interaction)
  let thumbStart = 0, thumbEnd = 0, thumbSize = 0;
  if (hasScrollbar) {
    thumbSize = Math.max(1, Math.round((rows / contentLines.length) * rows));
    thumbStart = maxScroll > 0 ? Math.round((state.configScroll / maxScroll) * (rows - thumbSize)) : 0;
    thumbEnd = thumbStart + thumbSize;
  }
  // The scrollbar column in terminal coords: box border (1) + space (1) + content inner offset
  // boxLine adds │ + space = 2 chars, so inner col 1 starts at terminal col 3
  state._configScrollbar = hasScrollbar ? {
    col: 2 + CONFIG_TAB_WIDTH + 1 + visibleContentW, // terminal col (1-based) of scrollbar
    thumbStart, thumbEnd, thumbSize, rows, maxScroll,
    totalLines: contentLines.length,
  } : null;

  // Copy targets for config panel
  state._configCopyTargets = [];
  const now = Date.now();

  // Render each row
  for (let r = 0; r < rows; r++) {
    let line = "";

    // --- Vertical tab sidebar with copy icon ---
    if (r < sections.length) {
      const sec = sections[r];
      const label = sec.label;
      const isActive = r === state.configSubTab;
      const isHover = r === state.configSubTabHover;
      // Copy icon (⧉) at the end of the label
      const copyFlash = state._configCopyFlash === r && state._configCopyFlashTs && (now - state._configCopyFlashTs < 1500);
      const icon = copyFlash ? `\x1b[38;5;114m✓${RESET}` : `\x1b[38;5;60m⧉${RESET}`;
      const maxLabelLen = CONFIG_TAB_WIDTH - 4; // space + label + space + icon + space
      const trimLabel = label.length > maxLabelLen ? label.slice(0, maxLabelLen) : label;
      const pad = " ".repeat(Math.max(0, maxLabelLen - trimLabel.length));
      if (isActive) {
        line += " \x1b[1;38;5;255m" + trimLabel + RESET + pad + " " + icon + " ";
      } else if (isHover) {
        line += " \x1b[4;38;5;250m" + trimLabel + RESET + pad + " " + icon + " ";
      } else {
        line += " \x1b[38;5;245m" + trimLabel + RESET + pad + " " + icon + " ";
      }
      if (sec.copyPath) {
        state._configCopyTargets.push({ row: r, copyPath: sec.copyPath });
      }
    } else {
      line += " ".repeat(CONFIG_TAB_WIDTH);
    }

    // --- Separator ---
    if (r < sections.length && r === state.configSubTab) {
      line += C.borderHi + "┃" + RESET;
    } else {
      line += "\x1b[38;5;238m" + "│" + RESET;
    }

    // --- Content ---
    const ci = r + state.configScroll;
    if (ci < contentLines.length) {
      line += " " + ansiSlice(contentLines[ci], 0, visibleContentW - 1);
    }

    // --- Scrollbar ---
    if (hasScrollbar) {
      const padTo = CONFIG_TAB_WIDTH + 1 + visibleContentW;
      const isThumb = r >= thumbStart && r < thumbEnd;
      const isScrollHover = state._configScrollbarHover && r >= thumbStart && r < thumbEnd;
      if (isThumb) {
        const color = (isScrollHover || state._configScrollbarDrag) ? "\x1b[1;38;5;255m" : "\x1b[38;5;245m";
        line = ansiSlice(line, 0, padTo) + color + "┃" + RESET;
      } else {
        line = ansiSlice(line, 0, padTo) + "\x1b[38;5;238m" + "│" + RESET;
      }
    }

    // Hard-clip to inner width as safety net against any miscounting
    lines.push(ansiSlice(line, 0, panelW - 4));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Render: help view
// ---------------------------------------------------------------------------

function renderHelpView(width, height) {
  const lines = [];
  lines.push(boxTop(width - 1, "Help"));
  lines.push("");
  lines.push(BOLD + "  Navigation:" + RESET);
  lines.push("    ↑/k, ↓/j        Move cursor up/down");
  lines.push("    ←, →            Scroll left/right");
  lines.push("    PgUp, PgDn       Scroll page up/down");
  lines.push("    Home, End        Jump to first/last session");
  lines.push("    Enter, l         Open session detail");
  lines.push("");
  lines.push(BOLD + "  Sorting:" + RESET);
  lines.push("    F6, >, <         Open sort-by panel");
  lines.push("    P                Sort by status");
  lines.push("    M                Sort by memory");
  lines.push("    T                Sort by cost");
  lines.push("    Click header     Sort by that column");
  lines.push("");
  lines.push(BOLD + "  Tabs:" + RESET);
  lines.push("    Tab              Cycle bottom panel tabs");
  lines.push("    1-6              Switch to Info/Performance/Processes/Tool Activity/Cost/Config");
  lines.push("    Shift+Tab / `    Toggle Live filter (show only running sessions)");
  lines.push("");
  lines.push(BOLD + "  Other:" + RESET);
  lines.push("    /, F3            Filter sessions by text");
  lines.push("    F7               Filter sessions by age (1d / 1w / 1mo)");
  lines.push("    d                Delete selected session (not running)");
  lines.push("    F5, r            Refresh session data");
  lines.push("    F1, ?, h         Show this help");
  lines.push("    q, F10           Quit");
  lines.push("    Ctrl+C           Quit");
  lines.push("");
  lines.push(BOLD + "  Mouse:" + RESET);
  lines.push("    Click row        Select session");
  lines.push("    Click header     Sort by column");
  lines.push("    Click tab        Switch tab");
  lines.push("    Scroll wheel     Scroll up/down");
  lines.push("    Shift+drag       Select text for copy");
  lines.push("");
  lines.push(BOLD + "  Cost estimation:" + RESET);
  lines.push("    Costs are estimates based on per-token API pricing (LiteLLM).");
  lines.push("    Flat-rate plans (Max, Pro, Team) are billed differently, so");
  lines.push("    reported costs may not match your actual bill.");
  lines.push("");
  lines.push(C.dimText + "  Press any key to return" + RESET);

  while (lines.length < height - 1) lines.push("");
  return lines.slice(0, height - 1);
}

// ---------------------------------------------------------------------------
// Delete session
// ---------------------------------------------------------------------------

function deleteSession(session) {
  const f = session.data_file;
  if (!f) return;
  if (session.provider === "claude") {
    // Remove main transcript
    try { rmSync(f); } catch {}
    // Remove subagent dir (same stem as the .jsonl)
    const stem = f.replace(/\.jsonl$/, "");
    try { rmSync(stem, { recursive: true, force: true }); } catch {}
  } else {
    // Codex: just the single JSONL file
    try { rmSync(f); } catch {}
  }
  // Evict from in-memory and disk cache
  const memKey = `${session.provider}:${f}`;
  SESSION_DATA_CACHE.delete(memKey);
  SESSION_DATA_MTIME.delete(memKey);
  const cache = loadDiskCache();
  for (const k of Object.keys(cache)) {
    if (k.startsWith(f + "|")) { delete cache[k]; _diskCacheDirty = true; }
  }
}

// ---------------------------------------------------------------------------
// Render: delete confirmation overlay
// ---------------------------------------------------------------------------

function renderDeleteConfirm(session, width) {
  const modalW = Math.min(60, width - 6);
  const boxLeft = Math.floor((width - modalW) / 2);
  const border = "\x1b[38;5;196;48;5;52m"; // red on dark-red
  const labelC = "\x1b[1;38;5;203;48;5;52m";
  const pathC = "\x1b[38;5;252;48;5;52m";
  const hintC = "\x1b[38;5;245;48;5;52m";
  const inner = modalW - 2;

  const title = " Delete session? ";
  const name = (session.label || session.session_id || "").slice(0, inner - 4);
  const hint = "  [y] confirm   [n / Esc] cancel";

  const pad = (s) => {
    const plain = s.replace(/\x1b\[[^m]*m/g, "");
    return s + " ".repeat(Math.max(0, inner - plain.length));
  };

  const topLine    = border + "╭" + "─".repeat(inner) + "╮" + RESET;
  const titleLine  = border + "│" + RESET + labelC + pad(" " + title) + RESET + border + "│" + RESET;
  const sepLine    = border + "├" + "─".repeat(inner) + "┤" + RESET;
  const nameLine   = border + "│" + RESET + pathC + pad("  " + name) + RESET + border + "│" + RESET;
  const emptyLine  = border + "│" + " ".repeat(inner) + "│" + RESET;
  const hintLine   = border + "│" + RESET + hintC + pad(hint) + RESET + border + "│" + RESET;
  const botLine    = border + "╰" + "─".repeat(inner) + "╯" + RESET;

  return { lines: [topLine, titleLine, sepLine, nameLine, emptyLine, hintLine, botLine], boxLeft, modalW };
}

// ---------------------------------------------------------------------------
// Render: processes panel (top-like per-process list for running session)
// ---------------------------------------------------------------------------

function renderProcessesPanel(session, panelW, rows, state) {
  const lines = [];
  const inner = panelW - 4;

  if (session && session._isSubagent) {
    lines.push(C.dimText + "Shared with parent process — no per-subagent OS process list." + RESET);
    lines.push(C.dimText + "Select the parent session row to see its process tree." + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  if (!session || !session.process) {
    lines.push(C.dimText + "Performance data is only available for running sessions" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  const pm = session.process;
  const procs = (pm.processList || []).slice();

  if (procs.length === 0) {
    lines.push(C.dimText + "No process data available" + RESET);
    while (lines.length < rows) lines.push("");
    return lines;
  }

  // Column widths
  const pidW  = 7;
  const cpuW  = 6;
  const memW  = 8;
  const cmdW  = Math.max(10, inner - pidW - cpuW - memW - 3); // 3 gaps

  // Sort
  const sortKey = state ? state.procSort : "cpu";
  const desc    = state ? state.procSortDesc : true;
  procs.sort((a, b) => {
    let av, bv;
    if (sortKey === "pid") { av = a.pid; bv = b.pid; }
    else if (sortKey === "cpu") { av = a.cpu; bv = b.cpu; }
    else if (sortKey === "mem") { av = a.memory; bv = b.memory; }
    else { av = a.args; bv = b.args; }
    if (av < bv) return desc ? 1 : -1;
    if (av > bv) return desc ? -1 : 1;
    return 0;
  });

  // Header row
  const sortArrow = desc ? "▼" : "▲";
  const hPid  = (sortKey === "pid"  ? C.hdrLabel + sortArrow : C.dimText + " ") + "PID".padStart(pidW - 1)  + RESET;
  const hCpu  = (sortKey === "cpu"  ? C.hdrLabel + sortArrow : C.dimText + " ") + "CPU%".padStart(cpuW - 1) + RESET;
  const hMem  = (sortKey === "mem"  ? C.hdrLabel + sortArrow : C.dimText + " ") + "MEM".padStart(memW - 1)  + RESET;
  const hCmd  = (sortKey === "cmd"  ? C.hdrLabel + sortArrow : C.dimText + " ") + "COMMAND" + RESET;
  const headerLine = hPid + "  " + hCpu + "  " + hMem + "  " + hCmd;
  lines.push(headerLine);
  if (state) state._procHeaderRow = 1; // relative to panel content

  const ruleColor = "\x1b[38;5;238m";
  lines.push(ruleColor + "─".repeat(Math.min(inner, pidW + cpuW + memW + 20)) + RESET);

  // Process rows
  for (const p of procs) {
    const cpu = p.cpu;
    const memMB = p.memory / (1024 * 1024);
    const cpuColor = p.ghost ? C.dimText : cpu > 80 ? C.chartBarHi : cpu > 40 ? C.chartBarMed : cpu > 5 ? C.chartBarLow : C.dimText;
    const memColor = p.ghost ? C.dimText : memMB > 500 ? C.costRed : memMB > 100 ? C.costYellow : C.dimText;
    const pidColor = p.ghost ? C.dimText : p.isRoot ? C.hdrLabel : C.dimText;
    const cmdColor = p.ghost ? C.dimText : p.isRoot ? C.hdrValue : "\x1b[38;5;250m";

    // Derive short process name from args (basename of first token)
    const firstToken = (p.args || "").split(" ")[0];
    const procName = firstToken.replace(/.*[/\\]/, "");
    const rest = p.args.slice(firstToken.length).trimStart();
    const cmd = (procName + (rest ? " " + rest : "")).slice(0, cmdW);

    const pidStr  = String(p.pid).padStart(pidW);
    const cpuStr  = (cpu.toFixed(1) + "%").padStart(cpuW);
    const memStr  = (memMB >= 1000 ? (memMB / 1024).toFixed(1) + "G"
                    : memMB >= 1 ? memMB.toFixed(0) + "M"
                    : (p.memory / 1024).toFixed(0) + "K").padStart(memW);

    lines.push(
      pidColor + pidStr + RESET + "  " +
      cpuColor + cpuStr + RESET + "  " +
      memColor + memStr + RESET + "  " +
      cmdColor + cmd + RESET
    );
  }

  // Scroll
  const contentRows = rows; // header(1) + rule(1) + procs
  const allLines = lines;
  const maxScroll = Math.max(0, allLines.length - contentRows);
  const scroll = state ? Math.min(state.procScroll, maxScroll) : 0;
  if (state) state.procScroll = scroll;

  const visible = allLines.slice(scroll, scroll + contentRows);
  while (visible.length < contentRows) visible.push("");
  return visible;
}

// ---------------------------------------------------------------------------
// Render: can't-delete-live-session modal
// ---------------------------------------------------------------------------

function renderDeleteLiveBlocked(session, width) {
  const modalW = Math.min(60, width - 6);
  const boxLeft = Math.floor((width - modalW) / 2);
  const border = "\x1b[38;5;214;48;5;58m"; // amber on dark-yellow
  const labelC = "\x1b[1;38;5;221;48;5;58m";
  const bodyC  = "\x1b[38;5;252;48;5;58m";
  const hintC  = "\x1b[38;5;245;48;5;58m";
  const inner  = modalW - 2;

  const pad = (s) => {
    const plain = s.replace(/\x1b\[[^m]*m/g, "");
    return s + " ".repeat(Math.max(0, inner - plain.length));
  };

  const name = (session.list_label || session.label || session.session_id || "").slice(0, inner - 4);
  const topLine   = border + "╭" + "─".repeat(inner) + "╮" + RESET;
  const titleLine = border + "│" + RESET + labelC + pad("  Session is running") + RESET + border + "│" + RESET;
  const sepLine   = border + "├" + "─".repeat(inner) + "┤" + RESET;
  const nameLine  = border + "│" + RESET + bodyC + pad("  " + name) + RESET + border + "│" + RESET;
  const emptyLine = border + "│" + " ".repeat(inner) + "│" + RESET;
  const bodyLine  = border + "│" + RESET + bodyC + pad("  Cannot delete a session that is currently running.") + RESET + border + "│" + RESET;
  const body2Line = border + "│" + RESET + bodyC + pad("  Stop the agent first, then delete.") + RESET + border + "│" + RESET;
  const hintLine  = border + "│" + RESET + hintC + pad("  [Esc / any key] dismiss") + RESET + border + "│" + RESET;
  const botLine   = border + "╰" + "─".repeat(inner) + "╯" + RESET;

  return { lines: [topLine, titleLine, sepLine, nameLine, emptyLine, bodyLine, body2Line, emptyLine, hintLine, botLine], boxLeft, modalW };
}

// ---------------------------------------------------------------------------
// Render: sort-by sidebar (htop-style)
// ---------------------------------------------------------------------------

function renderSortBySidebar(state, width, height) {
  const sortableColumns = activeColumns(state);
  const sidebarW = 28;
  const boxLeft = Math.floor((width - sidebarW) / 2);

  const lines = [];
  for (let row = 0; row < height; row++) lines.push("");

  // Title row
  const titleRow = 1;
  const title = " Sort by ";
  const titleLine = C.colHdrBg + BOLD + " " + title + " ".repeat(Math.max(0, sidebarW - title.length - 2)) + " " + RESET;

  // Build sidebar rows
  const startRow = titleRow + 1;
  const items = [];
  for (let i = 0; i < sortableColumns.length; i++) {
    const col = sortableColumns[i];
    const isActive = col.key === state.sortCol;
    const isCursor = i === state.sortbyIdx;
    let label = col.label;
    if (isActive) label += state.sortAsc ? " ▲" : " ▼";
    label = padOrClip(label, sidebarW - 2, "left");
    if (isCursor) {
      items.push(C.selBg + " " + label + " " + RESET);
    } else if (isActive) {
      items.push(C.hdrCyan + " " + label + " " + RESET);
    } else {
      items.push(C.normalFg + " " + label + " " + RESET);
    }
  }

  // Footer hint
  const hint = C.dimText + " Enter=select Esc=cancel " + RESET;

  return { boxLeft, sidebarW, titleLine, items, hint };
}

function renderSearchModal(state, width) {
  const modalW = Math.min(50, width - 6);
  const boxLeft = Math.floor((width - modalW) / 2);
  const q = state.searchQuery || "";

  // Title
  const title = " Filter sessions ";
  const titleLine = C.colHdrBg + BOLD + " " + title
    + " ".repeat(Math.max(0, modalW - title.length - 2)) + " " + RESET;

  // Input field with cursor
  const inputLabel = " > ";
  const inputW = modalW - inputLabel.length - 2;
  const displayQ = q.length > inputW ? q.slice(q.length - inputW) : q;
  const pad = Math.max(0, inputW - displayQ.length);
  const inputLine = C.normalFg + inputLabel + RESET
    + "\x1b[1;38;5;255m" + displayQ + RESET
    + "\x1b[7m \x1b[27m" + RESET // cursor block
    + " ".repeat(Math.max(0, pad - 1))
    + " ";

  // Hint
  const matchCount = state.filtered ? state.filtered.length : 0;
  const hintText = ` ${matchCount} match${matchCount !== 1 ? "es" : ""}  Enter/Esc=close `;
  const hint = C.dimText + hintText
    + " ".repeat(Math.max(0, modalW - hintText.length)) + RESET;

  return { boxLeft, modalW, lines: [titleLine, inputLine, hint] };
}

// ---------------------------------------------------------------------------
// Render: inactivity filter modal (F7)
// ---------------------------------------------------------------------------

const INACTIVITY_OPTIONS = [
  { key: "1d",  label: "Last 24 hours" },
  { key: "1w",  label: "Last 7 days"   },
  { key: "1mo", label: "Last 30 days"  },
  { key: null,  label: "No filter"     },
];

function renderInactivityModal(state, width) {
  const modalW = Math.min(40, width - 6);
  const boxLeft = Math.floor((width - modalW) / 2);
  const border = C.border;
  const inner = modalW - 2; // chars between │ and │

  // Pad a string (may contain ANSI) to exactly `w` plain chars
  const padTo = (s, w) => {
    const plain = s.replace(/\x1b\[[^m]*m/g, "");
    return s + " ".repeat(Math.max(0, w - plain.length));
  };
  const row = (content) => border + "│" + RESET + content + border + "│" + RESET;

  const topLine = border + "╭" + "─".repeat(inner) + "╮" + RESET;
  const botLine = border + "╰" + "─".repeat(inner) + "╯" + RESET;
  const sepLine = border + "├" + "─".repeat(inner) + "┤" + RESET;

  const titleText = " Age filter ";
  const titleLine = row(
    C.colHdrBg + BOLD + padTo(titleText, inner) + RESET
  );

  const descText = "  Show only sessions active within:";
  const descLine = row(padTo(C.dimText + descText + RESET, inner));

  const lines = [topLine, titleLine, sepLine, descLine, sepLine];

  for (let i = 0; i < INACTIVITY_OPTIONS.length; i++) {
    const opt = INACTIVITY_OPTIONS[i];
    const isActive = state.inactivityFilter === opt.key;
    const isCursor = state._inactivityCursor === i;
    const checkC = isActive ? "\x1b[1;38;5;114m" : "\x1b[38;5;240m";
    const check = checkC + (isActive ? "●" : "○") + RESET;
    const textC = isCursor ? "\x1b[1;38;5;255;48;5;238m" : (isActive ? "\x1b[38;5;252m" : "\x1b[38;5;245m");
    const bg    = isCursor ? "\x1b[48;5;238m" : "";
    const rowInner = bg + padTo(" " + check + " " + textC + opt.label + RESET + bg, inner) + RESET;
    lines.push(row(rowInner));
  }

  const hintText = "  ↑/↓  Enter=apply  Esc=cancel";
  const hintLine = row(padTo(C.dimText + hintText + RESET, inner));
  lines.push(sepLine, hintLine, botLine);

  return { boxLeft, modalW, lines };
}

// ---------------------------------------------------------------------------
// Session list tab bar (posting.sh style)
// ---------------------------------------------------------------------------

function renderListTabBar(state, width) {
  const bc = C.border;

  const totalCount = state.sessions.length;
  const liveCount = state.sessions.filter((s) => !!s.process).length;
  const isLive = state.listTab === 1;

  // Title always uses the same format so nothing shifts when toggled
  const title = `Sessions (${isLive ? liveCount + "/" : ""}${totalCount})`;

  // Live button fixed to the right, just before the closing ╮
  const liveLabel = isLive ? "[Live ●]" : "[Live ○]";
  // Button sits at fixed right position regardless of title length
  // 1-based: width - ╮(1) - space(1) - label = width - liveLabel.length - 1
  const liveBtnCol = width - liveLabel.length - 1;
  state._liveBtn = { col: liveBtnCol, len: liveLabel.length };

  // Top border: ╭─ <title> ─────── [Live ○] ╮
  // Fixed visible widths: ╭(1) ─(1) space(1) title space(1) ─*filler space(1) label space(1) ╮(1) = title+label+7
  const fillerLen = Math.max(0, width - title.length - liveLabel.length - 7);
  let topLine = bc + BOX.tl + BOX.h + " " + RESET;
  topLine += C.hdrLabel + title + RESET + " ";
  topLine += bc + BOX.h.repeat(fillerLen) + RESET + " ";
  if (isLive) {
    topLine += "\x1b[1;38;5;114m" + liveLabel + RESET;
  } else if (state._liveHover) {
    topLine += "\x1b[4;38;5;179m" + liveLabel + RESET;
  } else {
    topLine += "\x1b[38;5;245m" + liveLabel + RESET;
  }
  topLine += " " + bc + BOX.tr + RESET;

  return topLine;
}

/** Given a 1-based column, return 1 if the Live button was clicked, or -1. */
function listTabAtX(col, state) {
  const btn = state && state._liveBtn;
  if (btn && col >= btn.col && col < btn.col + btn.len) {
    // Toggle: return the opposite tab
    return state.listTab === 1 ? 0 : 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Master render
// ---------------------------------------------------------------------------

function render(state) {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 24;
  let buf = SYNC_START + "\x1b[H" + RESET; // move cursor to top-left, reset colors

  if (state.mode === "help") {
    const lines = renderHelpView(width - 1, height);
    for (const line of lines) buf += ansiSlice(line, 0, width - 1) + "\x1b[K\n";
    buf += ansiSlice(renderFooter(state, width - 1), 0, width - 1);
    buf += SYNC_END;
    process.stdout.write(buf);
    return;
  }

  if (state.mode === "detail") {
    const plan = state.detailSession.provider === "codex" ? state.codexPlan : state.claudePlan;
    const lines = renderDetailView(state.detailSession, state.detailData, plan, width - 1, height);
    for (const line of lines) buf += ansiSlice(line, 0, width - 1) + "\x1b[K\n";
    buf += ansiSlice(renderFooter(state, width - 1), 0, width - 1);
    buf += SYNC_END;
    process.stdout.write(buf);
    return;
  }

  // --- List mode (also used as background for sortby mode) ---
  // boxW = width - 1 to prevent terminal right-edge wrapping
  const boxW = width - 1;

  // Overview panel (top)
  const headerLines = renderHeader(state.stats || computeStats([]), boxW, state);
  const limitsLines = renderLimitsPanel(boxW, state);
  const limitsH = limitsLines.length;

  // Collect all screen lines
  const screenLines = [];
  for (const line of headerLines) screenLines.push(line);
  state.headerLines = headerLines.length; // update for mouse position calculations

  // Bottom panels height (adaptive) — reserve space for limits panel at the bottom
  const usedByHeader = headerLines.length;
  const totalBody = height - usedByHeader - 1 - limitsH; // -1 footer, -limitsH for limits panel
  const rawPanelH = Math.min(MAX_PANEL, Math.max(MIN_PANEL, Math.floor(totalBody * 0.4)));
  const panelHeight = Math.min(rawPanelH, Math.max(3, totalBody - 5)); // ensure list gets at least 5 rows
  const listAreaH = totalBody - panelHeight;
  // List area = boxTop(1) + colHeader(1) + rows + boxBottom(1)
  const listHeight = Math.max(1, listAreaH - 3);
  const now = new Date();
  // Recompute the virtual row list (sessions + markers + expanded children) every render
  // so changes to filtered/sorted sessions or expansion state are picked up.
  state.flatList = buildFlatList(state);
  const flat = state.flatList;

  // Adjust scroll to keep selection visible
  if (state.selectedRow < state.scrollOffset) {
    state.scrollOffset = state.selectedRow;
  } else if (state.selectedRow >= state.scrollOffset + listHeight) {
    state.scrollOffset = state.selectedRow - listHeight + 1;
  }

  // Session list box with tabs (2 lines: top border + underline rule)
  state._listTabBarRow = screenLines.length + 1; // 1-based row
  const tabBarLines = renderListTabBar(state, boxW).split("\n");
  for (const tbl of tabBarLines) screenLines.push(tbl);
  state._colHeaderRow = screenLines.length + 1; // 1-based row of column header
  screenLines.push(renderColumnHeaders(state, boxW));

  if (state.filtered.length === 0 && state.listTab === 1) {
    // Empty Live tab
    const emptyMsg = C.dimText + "  No active sessions running" + RESET;
    screenLines.push(emptyMsg);
    for (let i = 1; i < listHeight; i++) screenLines.push("");
  } else {
    for (let i = 0; i < listHeight; i++) {
      const idx = state.scrollOffset + i;
      if (idx < flat.length) {
        const isSelected = idx === state.selectedRow;
        screenLines.push(renderFlatRow(flat[idx], idx, isSelected, boxW, now, state.hScroll, state));
      } else {
        screenLines.push("");
      }
    }
  }
  screenLines.push(boxBottom(boxW));

  // Bottom detail panels (tabbed) — for subagent rows we synthesize a session-like
  // object so the existing panel renderers can consume the subagent's own data.
  const selected = getSelectedPanelSession(state);
  const panelPlan = selected ? (selected.provider === "codex" ? state.codexPlan : state.claudePlan) : null;
  state._tabBarRow = screenLines.length + 1; // 1-based row of the tab bar
  state._configPanelTop = screenLines.length + 3; // 1-based: tab bar + rule line → first content row
  const bottomLines = renderBottomPanels(selected, state.panelData, panelPlan, boxW, panelHeight, resolveActiveTab(state, state.panelData), state.hoverTab, state);
  for (const pl of bottomLines) screenLines.push(pl);

  // Limits panel (below bottom panels)
  for (const line of limitsLines) screenLines.push(line);

  // Overlay sort-by sidebar if in sortby mode
  if (state.mode === "sortby") {
    const sb = renderSortBySidebar(state, width, height);
    // Center the sidebar vertically
    const totalH = 1 + sb.items.length + 1; // title + items + hint
    const startRow = Math.max(0, Math.floor((screenLines.length - totalH) / 2));

    for (let r = 0; r < screenLines.length; r++) {
      const relRow = r - startRow;
      if (relRow >= 0 && relRow < totalH) {
        let overlay;
        if (relRow === 0) {
          overlay = sb.titleLine;
        } else if (relRow <= sb.items.length) {
          overlay = sb.items[relRow - 1];
        } else {
          overlay = sb.hint;
        }
        // Splice the sidebar into the line
        const bgLine = screenLines[r] || "";
        const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
        const left = ansiSlice(bgLine, 0, sb.boxLeft);
        const ovPlain = overlay.replace(/\x1b\[[^m]*m/g, "");
        const rightStart = sb.boxLeft + sb.sidebarW;
        const right = rightStart < bgPlain.length
          ? ansiSlice(bgLine, rightStart, width - rightStart)
          : " ".repeat(Math.max(0, width - rightStart));
        screenLines[r] = left + overlay + right + RESET;
      }
    }
  }

  // Overlay search modal if in search mode
  if (state.mode === "search") {
    const sm = renderSearchModal(state, width);
    const startRow = Math.max(0, Math.floor((screenLines.length - sm.lines.length) / 2));
    for (let r = 0; r < screenLines.length; r++) {
      const relRow = r - startRow;
      if (relRow >= 0 && relRow < sm.lines.length) {
        const overlay = sm.lines[relRow];
        const bgLine = screenLines[r] || "";
        const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
        const left = ansiSlice(bgLine, 0, sm.boxLeft);
        const rightStart = sm.boxLeft + sm.modalW;
        const right = rightStart < bgPlain.length
          ? ansiSlice(bgLine, rightStart, width - rightStart)
          : " ".repeat(Math.max(0, width - rightStart));
        screenLines[r] = left + overlay + right + RESET;
      }
    }
  }

  // Overlay delete confirmation
  if (state.mode === "delete") {
    const sel = getSelectedSession(state);
    if (sel) {
      const dm = renderDeleteConfirm(sel, width);
      const startRow = Math.max(0, Math.floor((screenLines.length - dm.lines.length) / 2));
      for (let r = 0; r < screenLines.length; r++) {
        const relRow = r - startRow;
        if (relRow >= 0 && relRow < dm.lines.length) {
          const overlay = dm.lines[relRow];
          const bgLine = screenLines[r] || "";
          const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
          const left = ansiSlice(bgLine, 0, dm.boxLeft);
          const rightStart = dm.boxLeft + dm.modalW;
          const right = rightStart < bgPlain.length
            ? ansiSlice(bgLine, rightStart, width - rightStart)
            : " ".repeat(Math.max(0, width - rightStart));
          screenLines[r] = left + overlay + right + RESET;
        }
      }
    }
  }

  // Overlay delete-blocked modal (live session)
  if (state.mode === "delete_live") {
    const sel = getSelectedSession(state);
    if (sel) {
      const dm = renderDeleteLiveBlocked(sel, width);
      const startRow = Math.max(0, Math.floor((screenLines.length - dm.lines.length) / 2));
      for (let r = 0; r < screenLines.length; r++) {
        const relRow = r - startRow;
        if (relRow >= 0 && relRow < dm.lines.length) {
          const overlay = dm.lines[relRow];
          const bgLine = screenLines[r] || "";
          const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
          const left = ansiSlice(bgLine, 0, dm.boxLeft);
          const rightStart = dm.boxLeft + dm.modalW;
          const right = rightStart < bgPlain.length
            ? ansiSlice(bgLine, rightStart, width - rightStart)
            : " ".repeat(Math.max(0, width - rightStart));
          screenLines[r] = left + overlay + right + RESET;
        }
      }
    }
  }

  // Overlay inactivity filter modal
  if (state.mode === "inactivity") {
    const im = renderInactivityModal(state, width);
    const startRow = Math.max(0, Math.floor((screenLines.length - im.lines.length) / 2));
    for (let r = 0; r < screenLines.length; r++) {
      const relRow = r - startRow;
      if (relRow >= 0 && relRow < im.lines.length) {
        const overlay = im.lines[relRow];
        const bgLine = screenLines[r] || "";
        const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
        const left = ansiSlice(bgLine, 0, im.boxLeft);
        const rightStart = im.boxLeft + im.modalW;
        const right = rightStart < bgPlain.length
          ? ansiSlice(bgLine, rightStart, width - rightStart)
          : " ".repeat(Math.max(0, width - rightStart));
        screenLines[r] = left + overlay + right + RESET;
      }
    }
  }

  // Overlay column header tooltip on hover
  if (state._hoverColKey && state._colHeaderRow) {
    const cols = activeColumns(state);
    const col = cols.find(c => c.key === state._hoverColKey);
    if (col && col.desc) {
      const cpos = columnScreenPos(state._hoverColKey, state.hScroll, state);
      if (cpos) {
        const label = col.label.trim() || "Status";
        const descLines = col.desc.split("\n");
        const tipBorder = "\x1b[38;5;60;48;5;236m";
        const tipLabel = "\x1b[1;38;5;75;48;5;236m";
        const tipText = "\x1b[38;5;252;48;5;236m";
        const headerStr = label + ": " + descLines[0];
        const maxLen = Math.max(headerStr.length, ...descLines.slice(1).map(l => l.length));
        const tipW = maxLen + 4;
        const tipX = Math.max(0, Math.min(cpos.x, width - tipW));
        const tipRow = state._colHeaderRow;
        const topLine = tipBorder + "╭" + "─".repeat(tipW - 2) + "╮" + RESET;
        const firstLine = tipBorder + "│" + RESET + tipLabel + " " + label + ": " + RESET + tipText + descLines[0] + " ".repeat(Math.max(0, maxLen - headerStr.length)) + " " + RESET + tipBorder + "│" + RESET;
        const tipLines = [topLine, firstLine];
        for (let di = 1; di < descLines.length; di++) {
          const dl = descLines[di];
          tipLines.push(tipBorder + "│" + RESET + tipText + " " + dl + " ".repeat(Math.max(0, maxLen - dl.length)) + " " + RESET + tipBorder + "│" + RESET);
        }
        tipLines.push(tipBorder + "╰" + "─".repeat(tipW - 2) + "╯" + RESET);
        for (let t = 0; t < tipLines.length; t++) {
          const row = tipRow + t;
          if (row >= screenLines.length) break;
          const bgLine = screenLines[row] || "";
          const bgPlain = bgLine.replace(/\x1b\[[^m]*m/g, "");
          const left = ansiSlice(bgLine, 0, tipX);
          const rightStart = tipX + tipW;
          const right = rightStart < bgPlain.length
            ? ansiSlice(bgLine, rightStart, width - rightStart)
            : " ".repeat(Math.max(0, width - rightStart));
          screenLines[row] = left + tipLines[t] + right + RESET;
        }
      }
    }
  }

  // Write all lines (clip to width-1 to prevent terminal right-edge wrapping)
  // RESET before \x1b[K so erase-to-EOL uses default background, not selection color
  for (const line of screenLines) buf += ansiSlice(line, 0, boxW) + RESET + "\x1b[K\n";

  // Footer + clear any stale lines below
  state._footerRow = screenLines.length + 1; // 1-based
  buf += ansiSlice(renderFooter(state, boxW), 0, boxW) + RESET + "\x1b[J";
  buf += SYNC_END;
  process.stdout.write(buf);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseInputSequence(buf) {
  // SGR mouse: \x1b[<btn;col;row[Mm]
  const mouseMatch = buf.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (mouseMatch) {
    const btn = parseInt(mouseMatch[1], 10);
    const col = parseInt(mouseMatch[2], 10);
    const row = parseInt(mouseMatch[3], 10);
    const release = mouseMatch[4] === "m";
    if (btn === 64) return { type: "scroll_up", col, row };
    if (btn === 65) return { type: "scroll_down", col, row };
    if (btn === 0 && !release) return { type: "click", col, row };
    if (btn === 0 && release) return { type: "mouseup", col, row };
    if (btn === 32) return { type: "drag", col, row }; // motion with button held
    if (btn === 35) return { type: "hover", col, row }; // motion, no button
    return null;
  }

  // F-keys
  if (buf === "\x1bOP" || buf === "\x1b[11~") return { type: "f1" };
  if (buf === "\x1bOR" || buf === "\x1b[13~") return { type: "f3" };
  if (buf === "\x1b[15~") return { type: "f5" };
  if (buf === "\x1b[17~") return { type: "f6" };
  if (buf === "\x1b[18~") return { type: "f7" };
  if (buf === "\x1b[21~") return { type: "f10" };

  // Shift+Tab (backtab)
  if (buf === "\x1b[Z") return { type: "btab" };

  // Arrow keys
  if (buf === "\x1b[A") return { type: "up" };
  if (buf === "\x1b[B") return { type: "down" };
  if (buf === "\x1b[C") return { type: "right" };
  if (buf === "\x1b[D") return { type: "left" };

  // Page Up/Down, Home/End
  if (buf === "\x1b[5~") return { type: "pageup" };
  if (buf === "\x1b[6~") return { type: "pagedown" };
  if (buf === "\x1b[H" || buf === "\x1b[1~") return { type: "home" };
  if (buf === "\x1b[F" || buf === "\x1b[4~") return { type: "end" };

  // Escape
  if (buf === "\x1b") return { type: "escape" };

  // Single characters
  if (buf.length === 1) {
    const ch = buf.charCodeAt(0);
    if (ch === 3) return { type: "ctrl_c" };  // Ctrl+C
    if (ch === 9) return { type: "tab" };      // Tab
    if (ch === 13 || ch === 10) return { type: "enter" };
    if (ch === 127 || ch === 8) return { type: "backspace" };
    return { type: "char", char: buf };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Buffered input: handles fragmented/concatenated SGR mouse sequences
// ---------------------------------------------------------------------------
const SGR_MOUSE_RE = /\x1b\[<\d+;\d+;\d+[Mm]/g;

function extractInputEvents(inputBuf) {
  const events = [];
  let remaining = inputBuf;

  while (remaining.length > 0) {
    // Try to find an SGR mouse sequence anywhere in the buffer
    SGR_MOUSE_RE.lastIndex = 0;
    const m = SGR_MOUSE_RE.exec(remaining);

    if (m) {
      // Parse anything before the mouse sequence as separate events
      if (m.index > 0) {
        const before = remaining.slice(0, m.index);
        for (const seq of splitEscapeSequences(before)) {
          const ev = parseInputSequence(seq);
          if (ev) events.push(ev);
        }
      }
      // Parse the mouse sequence itself
      const ev = parseInputSequence(m[0]);
      if (ev) events.push(ev);
      remaining = remaining.slice(m.index + m[0].length);
    } else {
      // No mouse sequence found — check for incomplete escape sequence at the end
      // Matches: partial mouse (\x1b[<...), partial CSI (\x1b[...), partial SS3 (\x1bO), or bare \x1b
      const partial = remaining.match(/\x1b(\[<[\d;]*|\[[0-9;]*|O?)$/);
      if (partial && partial[0] !== remaining) {
        // There's content before the partial — parse it, keep partial for next chunk
        const before = remaining.slice(0, partial.index);
        for (const seq of splitEscapeSequences(before)) {
          const ev = parseInputSequence(seq);
          if (ev) events.push(ev);
        }
        return { events, leftover: partial[0] };
      }
      if (partial && partial[0] === remaining && remaining.length < 8) {
        // Entire buffer is just a partial escape — wait for more data
        return { events, leftover: remaining };
      }
      // No partial escape sequence — parse as normal escape sequences
      for (const seq of splitEscapeSequences(remaining)) {
        const ev = parseInputSequence(seq);
        if (ev) events.push(ev);
      }
      remaining = "";
    }
  }
  return { events, leftover: "" };
}

function splitEscapeSequences(str) {
  const seqs = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\x1b" && i + 1 < str.length) {
      // CSI sequence: \x1b[ ... (letter or ~)
      if (str[i + 1] === "[") {
        const end = str.slice(i + 2).search(/[A-Za-z~]/);
        if (end >= 0) {
          seqs.push(str.slice(i, i + 2 + end + 1));
          i += 2 + end + 1;
          continue;
        }
      }
      // SS3 sequence: \x1bO(letter)
      if (str[i + 1] === "O" && i + 2 < str.length) {
        seqs.push(str.slice(i, i + 3));
        i += 3;
        continue;
      }
      // Bare escape
      seqs.push("\x1b");
      i += 1;
    } else {
      seqs.push(str[i]);
      i += 1;
    }
  }
  return seqs;
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

function columnAtX(x, hScroll, state) {
  const cols = state ? activeColumns(state) : SUMMARY_COLUMNS;
  const adjusted = x + (hScroll || 0);
  let pos = 1; // 1-based terminal columns
  for (const col of cols) {
    const w = col.flex ? 999 : col.width + 1; // +1 for space separator
    if (adjusted >= pos && adjusted < pos + w) return col.key;
    pos += w;
  }
  return null;
}

/** Return {x, width} (0-based screen coords) for a column key, accounting for hScroll. */
function columnScreenPos(colKey, hScroll, state) {
  const cols = state ? activeColumns(state) : SUMMARY_COLUMNS;
  let pos = 1; // 1-based
  for (const col of cols) {
    const w = col.flex ? 999 : col.width;
    if (col.key === colKey) return { x: pos - 1 - (hScroll || 0), w };
    pos += w + (col.flex ? 0 : 1); // +1 separator
  }
  return null;
}

/** Given a 1-based column and the panel data (for visible-tab filtering), return the
 *  static BOTTOM_TABS index that was clicked, or -1. Hidden conditional tabs are skipped
 *  so click coordinates line up with what's actually drawn. */
function tabAtX(col, data) {
  const vis = visibleBottomTabs(data);
  let pos = 4; // skip ╭─ + space (1-based)
  for (let i = 0; i < vis.length; i++) {
    if (i > 0) pos += 2; // 2-space gap between tabs
    const staticIdx = vis[i];
    const w = BOTTOM_TABS[staticIdx].length;
    if (col >= pos && col < pos + w) return staticIdx;
    pos += w;
  }
  return -1;
}

/** Copy text to system clipboard. Platform-native first, OSC 52 as fallback. */
function copyToClipboard(text) {
  if (process.platform === "darwin") {
    try {
      execSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return;
    } catch {}
  } else if (process.platform === "win32") {
    try {
      // `clip` is built-in on all Windows versions; requires UTF-16LE input.
      execSync("clip", { input: Buffer.from(text, "utf16le"), stdio: ["pipe", "ignore", "ignore"] });
      return;
    } catch {}
  } else {
    // Linux: try Wayland (wl-copy) then X11 (xclip / xsel)
    const cmds = [
      ["wl-copy"],
      ["xclip", "-selection", "clipboard"],
      ["xsel", "--clipboard", "--input"],
    ];
    for (const [cmd, ...args] of cmds) {
      try {
        execSync([cmd, ...args].join(" "), { input: text, stdio: ["pipe", "ignore", "ignore"] });
        return;
      } catch {}
    }
  }
  // OSC 52 fallback (works in many modern terminals regardless of platform)
  const b64 = Buffer.from(text).toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

function handleEvent(event, state) {
  if (!event) return;

  // --- Search mode ---
  if (state.mode === "search") {
    if (event.type === "escape" || event.type === "enter") {
      state.mode = "list";
      state.dirty = true;
      return;
    }
    if (event.type === "backspace") {
      state.searchQuery = state.searchQuery.slice(0, -1);
      applySortAndFilter(state);
      state.dirty = true;
      return;
    }
    if (event.type === "char") {
      state.searchQuery += event.char;
      applySortAndFilter(state);
      state.dirty = true;
      return;
    }
    return;
  }

  // --- Help mode ---
  if (state.mode === "help") {
    // Dismiss on keypress or click, but not on hover/mouseup/drag
    if (event.type !== "hover" && event.type !== "mouseup" && event.type !== "drag") {
      state.mode = "list";
      state.dirty = true;
    }
    return;
  }

  // --- Sort-by mode ---
  if (state.mode === "sortby") {
    const sortableColumns = activeColumns(state);
    const count = sortableColumns.length;
    if (event.type === "escape" || event.type === "f6") {
      state.mode = "list";
      state.dirty = true;
      return;
    }
    if (event.type === "up" || (event.type === "char" && event.char === "k")) {
      state.sortbyIdx = (state.sortbyIdx - 1 + count) % count;
      state.dirty = true;
      return;
    }
    if (event.type === "down" || (event.type === "char" && event.char === "j")) {
      state.sortbyIdx = (state.sortbyIdx + 1) % count;
      state.dirty = true;
      return;
    }
    if (event.type === "enter") {
      const col = sortableColumns[state.sortbyIdx];
      if (state.sortCol === col.key) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortCol = col.key;
        state.sortAsc = true;
      }
      applySortAndFilter(state);
      state.mode = "list";
      state.dirty = true;
      return;
    }
    if (event.type === "ctrl_c" || event.type === "f10") { state.quit = true; return; }
    if (event.type === "char" && event.char === "q") { state.quit = true; return; }
    return;
  }

  // --- Inactivity filter mode ---
  if (state.mode === "inactivity") {
    if (event.type === "ctrl_c" || event.type === "f10") { state.quit = true; return; }
    if (event.type === "escape" || event.type === "f7") {
      state.mode = "list"; state.dirty = true; return;
    }
    if (event.type === "up" || (event.type === "char" && event.char === "k")) {
      state._inactivityCursor = (state._inactivityCursor - 1 + INACTIVITY_OPTIONS.length) % INACTIVITY_OPTIONS.length;
      state.dirty = true; return;
    }
    if (event.type === "down" || (event.type === "char" && event.char === "j")) {
      state._inactivityCursor = (state._inactivityCursor + 1) % INACTIVITY_OPTIONS.length;
      state.dirty = true; return;
    }
    if (event.type === "enter") {
      state.inactivityFilter = INACTIVITY_OPTIONS[state._inactivityCursor].key;
      applySortAndFilter(state);
      saveUiPrefs({ inactivityFilter: state.inactivityFilter });
      state.mode = "list"; state.dirty = true; return;
    }
    return;
  }

  // --- Delete blocked (live session) modal ---
  if (state.mode === "delete_live") {
    state.mode = "list"; state.dirty = true; return;
  }

  // --- Delete confirm mode ---
  if (state.mode === "delete") {
    if (event.type === "ctrl_c" || event.type === "f10") { state.quit = true; return; }
    if (event.type === "escape" || (event.type === "char" && event.char === "n")) {
      state.mode = "list"; state.dirty = true; return;
    }
    if (event.type === "char" && event.char === "y") {
      const sel = getSelectedSession(state);
      if (sel) {
        deleteSession(sel);
        // Remove from sessions list and refilter
        state.sessions = state.sessions.filter(s => s !== sel);
        state.selectedRow = Math.max(0, Math.min(state.selectedRow, state.sessions.length - 1));
        applySortAndFilter(state);
      }
      state.mode = "list"; state.dirty = true; return;
    }
    return;
  }

  // --- Detail mode ---
  if (state.mode === "detail") {
    if (event.type === "char" && event.char === "q") { state.mode = "list"; state.dirty = true; return; }
    if (event.type === "escape" || event.type === "left") { state.mode = "list"; state.dirty = true; return; }
    if (event.type === "ctrl_c" || event.type === "f10") { state.quit = true; return; }
    return;
  }

  // --- List mode ---
  const listLen = (state.flatList && state.flatList.length) || state.filtered.length;
  const bodyHeight = Math.max(1, (process.stdout.rows || 24) - (state.headerLines + 2));

  switch (event.type) {
    case "ctrl_c":
    case "f10":
      state.quit = true;
      return;

    case "char":
      switch (event.char) {
        case "q": state.quit = true; return;
        case "k": event.type = "up"; break;
        case "j": event.type = "down"; break;
        // case "l": event.type = "enter"; break; // detail view disabled
        case "/": state.mode = "search"; state.dirty = true; return;
        case "?": case "h": state.mode = "help"; state.dirty = true; return;
        case ">": openSortBy(state); return;
        case "<": openSortBy(state); return;
        case "r": state._needsRefresh = true; return;
        case "d": {
          const sel = getSelectedSession(state);
          if (sel && sel.process) { state.mode = "delete_live"; state.dirty = true; }
          else if (sel) { state.mode = "delete"; state.dirty = true; }
          return;
        }
        case "P": setSortColumn(state, "status"); return;
        case "M": setSortColumn(state, "mem"); return;
        case "T": setSortColumn(state, "cost"); return;
        case "1": selectBottomTabByNumber(state, 0); return;
        case "2": selectBottomTabByNumber(state, 1); return;
        case "3": selectBottomTabByNumber(state, 2); return;
        case "4": selectBottomTabByNumber(state, 3); return;
        case "5": selectBottomTabByNumber(state, 4); return;
        case "6": selectBottomTabByNumber(state, 5); return;
        case "7": selectBottomTabByNumber(state, 6); return;
        case "`": switchListTab(state); return;
        default: return;
      }
      break; // fall through for remapped keys (k->up, j->down, l->enter)

    case "btab":
      switchListTab(state);
      return;
    case "tab":
      cycleBottomTab(state, 1);
      return;
    case "f1": state.mode = "help"; state.dirty = true; return;
    case "f3": state.mode = "search"; state.dirty = true; return;
    case "f5": state._needsRefresh = true; return;
    case "f6": openSortBy(state); return;
    case "f7": {
      // Sync cursor to current filter value
      const idx = INACTIVITY_OPTIONS.findIndex(o => o.key === state.inactivityFilter);
      state._inactivityCursor = idx >= 0 ? idx : INACTIVITY_OPTIONS.length - 1;
      state.mode = "inactivity"; state.dirty = true; return;
    }
  }

  // Subagent expansion (Right expands on session/marker, Left collapses)
  const flatRow = state.flatList && state.flatList[state.selectedRow];
  if (event.type === "right" && flatRow) {
    if ((flatRow.type === "session" || flatRow.type === "marker")) {
      const s = flatRow.session;
      const hasSubs = Array.isArray(s.list_subagents) && s.list_subagents.length > 0;
      if (hasSubs && !state.expandedSubagents.has(sessionKey(s))) {
        state.expandedSubagents.add(sessionKey(s));
        state.flatList = buildFlatList(state);
        state.dirty = true;
        return;
      }
    }
  }
  if (event.type === "left" && flatRow) {
    if (flatRow.type === "subagent" || flatRow.type === "subagent-header" || flatRow.type === "marker" || flatRow.type === "session") {
      const s = flatRow.session;
      if (state.expandedSubagents.has(sessionKey(s))) {
        state.expandedSubagents.delete(sessionKey(s));
        // Move selection up to the parent session row (it may have moved indexes after collapse)
        state.flatList = buildFlatList(state);
        const parentIdx = state.flatList.findIndex(r => r.type === "session" && r.session === s);
        if (parentIdx >= 0) state.selectedRow = parentIdx;
        state.dirty = true;
        return;
      }
    }
  }
  // Enter on a marker or sub-header toggles the expansion of its parent
  if (event.type === "enter" && flatRow && (flatRow.type === "marker" || flatRow.type === "subagent-header")) {
    const s = flatRow.session;
    if (state.expandedSubagents.has(sessionKey(s))) {
      state.expandedSubagents.delete(sessionKey(s));
    } else {
      state.expandedSubagents.add(sessionKey(s));
    }
    state.flatList = buildFlatList(state);
    state.dirty = true;
    return;
  }

  // Navigation
  switch (event.type) {
    case "up":
      if (state.selectedRow > 0) {
        state.selectedRow--;
        state.dirty = true;
      }
      return;
    case "down":
      if (state.selectedRow < listLen - 1) {
        state.selectedRow++;
        state.dirty = true;
      }
      return;
    case "pageup":
      state.selectedRow = Math.max(0, state.selectedRow - bodyHeight);
      state.dirty = true;
      return;
    case "pagedown":
      state.selectedRow = Math.min(listLen - 1, state.selectedRow + bodyHeight);
      state.dirty = true;
      return;
    case "home":
      state.selectedRow = 0;
      state.hScroll = 0;
      state.dirty = true;
      return;
    case "end":
      state.selectedRow = Math.max(0, listLen - 1);
      state.dirty = true;
      return;
    case "left":
      if (state.hScroll > 0) {
        state.hScroll = Math.max(0, state.hScroll - 4);
        state.dirty = true;
      }
      return;
    case "right": {
      state.hScroll += 4;
      state.dirty = true;
      return;
    }
    case "scroll_up":
      if (state.bottomTab === 0 && state._configPanelTop && event.row >= state._configPanelTop) {
        if (state.infoScroll > 0) { state.infoScroll--; state.dirty = true; }
      } else if (state.bottomTab === 2 && state._configPanelTop && event.row >= state._configPanelTop) {
        if (state.procScroll > 0) { state.procScroll--; state.dirty = true; }
      } else if (state.bottomTab === 4 && state._configPanelTop && event.row >= state._configPanelTop) {
        if (state.costScroll > 0) { state.costScroll--; state.dirty = true; }
      } else if (state.bottomTab === 5 && state._configPanelTop && event.row >= state._configPanelTop) {
        if (state.configScroll > 0) { state.configScroll--; state.dirty = true; }
      } else if (state.bottomTab === 3 && state._configPanelTop && event.row >= state._configPanelTop) {
        const hoverCol = event.col - 2;
        if (hoverCol >= 0 && hoverCol <= (state._agentTabWidth || 14)) {
          // Scroll sidebar
          if (state.agentTabScroll > 0) { state.agentTabScroll--; state.dirty = true; }
        } else {
          if (state.agentToolScroll > 0) { state.agentToolScroll--; state.dirty = true; }
        }
      } else if (state.bottomTab === 6 && state._configPanelTop && event.row >= state._configPanelTop) {
        if ((state.subagentScroll || 0) > 0) { state.subagentScroll = (state.subagentScroll || 0) - 1; state.dirty = true; }
      } else {
        if (state.selectedRow > 0) { state.selectedRow--; state.dirty = true; }
      }
      return;
    case "scroll_down":
      if (state.bottomTab === 0 && state._configPanelTop && event.row >= state._configPanelTop) {
        state.infoScroll++; state.dirty = true; // clamped in render
      } else if (state.bottomTab === 2 && state._configPanelTop && event.row >= state._configPanelTop) {
        state.procScroll++; state.dirty = true; // clamped in render
      } else if (state.bottomTab === 4 && state._configPanelTop && event.row >= state._configPanelTop) {
        state.costScroll++; state.dirty = true; // clamped in render
      } else if (state.bottomTab === 5 && state._configPanelTop && event.row >= state._configPanelTop) {
        state.configScroll++; state.dirty = true; // clamped in render
      } else if (state.bottomTab === 3 && state._configPanelTop && event.row >= state._configPanelTop) {
        const hoverCol = event.col - 2;
        if (hoverCol >= 0 && hoverCol <= (state._agentTabWidth || 14)) {
          state.agentTabScroll++; state.dirty = true; // clamped in render
        } else {
          state.agentToolScroll++; state.dirty = true; // clamped in render
        }
      } else if (state.bottomTab === 6 && state._configPanelTop && event.row >= state._configPanelTop) {
        state.subagentScroll = (state.subagentScroll || 0) + 1; state.dirty = true; // clamped in render
      } else {
        if (state.selectedRow < listLen - 1) { state.selectedRow++; state.dirty = true; }
      }
      return;

    case "enter":
      return; // detail view disabled

    case "click": {
      // Check footer row FIRST — panel handlers use >= _configPanelTop and would swallow the footer row
      if (state._footerRow && event.row === state._footerRow) {
        // Age filter ✕
        if (state._ageFilterXCol > 0 && event.col >= state._ageFilterXCol && event.col <= state._ageFilterXCol + 1) {
          state.inactivityFilter = null;
          saveUiPrefs({ inactivityFilter: null });
          applySortAndFilter(state);
          state.dirty = true;
          return;
        }
        // Text filter ✕
        if (state._filterXCol > 0 && event.col >= state._filterXCol && event.col <= state._filterXCol + 1) {
          state.searchQuery = "";
          applySortAndFilter(state);
          state.dirty = true;
          return;
        }
        // Menu bar items
        if (state._footerItems) {
          const item = state._footerItems.find(f => event.col >= f.start && event.col <= f.end);
          if (item) {
            switch (item.action) {
              case "f1": state.mode = "help"; state.dirty = true; break;
              case "f3": state.mode = "search"; state.dirty = true; break;
              case "f5": state._needsRefresh = true; break;
              case "f6": openSortBy(state); break;
              case "tab": cycleBottomTab(state, 1); break;
              case "backtick": switchListTab(state); break;
              case "d_delete": { const sel = getSelectedSession(state); if (sel && !sel.process) { state.mode = "delete"; state.dirty = true; } break; }
              case "f7": { const idx = INACTIVITY_OPTIONS.findIndex(o => o.key === state.inactivityFilter); state._inactivityCursor = idx >= 0 ? idx : INACTIVITY_OPTIONS.length - 1; state.mode = "inactivity"; state.dirty = true; break; }
              case "f10": state.quit = true; break;
            }
            return;
          }
        }
        return;
      }
      // Check if click is on the list tab bar (top border or underline row)
      if (state._listTabBarRow && event.row === state._listTabBarRow) {
        const ltIdx = listTabAtX(event.col, state);
        if (ltIdx >= 0 && ltIdx !== state.listTab) {
          switchToListTab(state, ltIdx);
          return;
        }
      }
      // Check if click is on the bottom tab bar (top border row or underline row)
      if (state._tabBarRow && (event.row === state._tabBarRow || event.row === state._tabBarRow + 1)) {
        const tabIdx = tabAtX(event.col, state.panelData);
        if (tabIdx >= 0) {
          state.bottomTab = tabIdx;
          state.dirty = true;
          saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab });
          return;
        }
      }
      // Check if click is on a copy icon (⧉) in the Info panel
      if (state.bottomTab === 0 && state._tabBarRow) {
        const selected = getSelectedSession(state);
        if (selected && selected._copyTargets) {
          for (const target of selected._copyTargets) {
            const screenRow = state._tabBarRow + 2 + target.line; // +2 for tab bar + rule
            if (event.row !== screenRow) continue;
            // Account for panel border "│ " (cols 0-1) when computing icon column
            // target.col is the column inside the inner content area
            const iconScreenCol = 2 + (target.col || 0);
            if (event.col >= iconScreenCol && event.col <= iconScreenCol + 2) {
              copyToClipboard(target.value);
              selected._copyFlash = target.field;
              selected._copyFlashTs = Date.now();
              state.dirty = true;
              return;
            }
          }
        }
      }
      // Check if click is in Tool Activity panel
      if (state.bottomTab === 3 && state._configPanelTop && event.row >= state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const clickCol = event.col - 2; // adjust for panel border "│ "
        // Click on vertical tab sidebar
        if (clickCol >= 0 && clickCol <= (state._agentTabWidth || 14)) {
          // Click on scroll arrows
          if (state._agentUpArrowRow >= 0 && rowInPanel === state._agentUpArrowRow) {
            if (state.agentTabScroll > 0) { state.agentTabScroll--; state.dirty = true; }
            return;
          }
          if (state._agentDownArrowRow >= 0 && rowInPanel === state._agentDownArrowRow) {
            state.agentTabScroll++; state.dirty = true; // clamped in render
            return;
          }
          const tab = state._agentToolTabs.find(t => t.row === rowInPanel);
          if (tab && tab.idx !== state.agentToolTab) {
            state.agentToolTab = tab.idx;
            state.agentToolScroll = -1;
            state._agentScrollToTab = true;
            state.dirty = true;
          }
          return;
        }
        // Click on Live button (header row)
        if (state._agentLiveBtn && rowInPanel === state._agentLiveBtn.row) {
          if (clickCol >= state._agentLiveBtn.colStart && clickCol < state._agentLiveBtn.colEnd) {
            state.agentLiveFilter = !state.agentLiveFilter;
            state.agentToolScroll = -1;
            state.dirty = true;
            saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab, tabSort: state._tabSort, agentLiveFilter: state.agentLiveFilter });
            return;
          }
        }
        // Click on scrollbar track
        const sb = state._agentScrollbar;
        if (sb && event.col === sb.col) {
          const trackPos = rowInPanel - 1; // 0-based, skip header row
          if (trackPos >= 0) {
            if (trackPos < sb.thumbStart) {
              state.agentToolScroll = Math.max(0, state.agentToolScroll - sb.contentRows);
            } else if (trackPos >= sb.thumbEnd) {
              state.agentToolScroll = Math.min(sb.maxScroll, state.agentToolScroll + sb.contentRows);
            }
            state.dirty = true;
          }
          return;
        }
        // Click on copy icon (rightmost area of content)
        const copyTarget = state._agentCopyTargets.find(t => t.row === rowInPanel);
        if (copyTarget) {
          // Check if click is near the copy icon (right side of panel)
          const boxW = (process.stdout.columns || 100) - 1;
          if (event.col >= boxW - 5) {
            copyToClipboard(copyTarget.value);
            const ci = (rowInPanel - 1) + state.agentToolScroll;
            state._agentCopyFlash = ci;
            state._agentCopyFlashTs = Date.now();
            state.dirty = true;
          }
        }
        return; // consume clicks in agent panel area
      }
      // Check if click is in Processes panel header (sort by column)
      if (state.bottomTab === 2 && state._configPanelTop && event.row >= state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        if (rowInPanel === 0) { // header row
          const pidW = 7, cpuW = 6, memW = 8;
          const col = event.col - 2; // subtract box padding
          if (col >= 0 && col < pidW) {
            if (state.procSort === "pid") state.procSortDesc = !state.procSortDesc;
            else { state.procSort = "pid"; state.procSortDesc = true; }
          } else if (col >= pidW + 2 && col < pidW + 2 + cpuW) {
            if (state.procSort === "cpu") state.procSortDesc = !state.procSortDesc;
            else { state.procSort = "cpu"; state.procSortDesc = true; }
          } else if (col >= pidW + cpuW + 4 && col < pidW + cpuW + 4 + memW) {
            if (state.procSort === "mem") state.procSortDesc = !state.procSortDesc;
            else { state.procSort = "mem"; state.procSortDesc = true; }
          } else if (col >= pidW + cpuW + memW + 6) {
            if (state.procSort === "cmd") state.procSortDesc = !state.procSortDesc;
            else { state.procSort = "cmd"; state.procSortDesc = false; }
          }
          state.dirty = true;
          return;
        }
      }
      // Check if click is in Info panel scrollbar
      if (state.bottomTab === 0 && state._configPanelTop && event.row >= state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const sb = state._infoScrollbar;
        if (sb && event.col === sb.col) {
          if (rowInPanel >= sb.thumbStart && rowInPanel < sb.thumbEnd) {
            state._infoScrollbarDrag = true;
            state._infoDragStartRow = rowInPanel;
            state._infoDragStartScroll = state.infoScroll;
            state.dirty = true;
          } else if (rowInPanel < sb.thumbStart) {
            state.infoScroll = Math.max(0, state.infoScroll - sb.rows);
            state.dirty = true;
          } else {
            state.infoScroll = Math.min(sb.maxScroll, state.infoScroll + sb.rows);
            state.dirty = true;
          }
          return;
        }
      }
      // Check if click is in Cost panel scrollbar
      if (state.bottomTab === 4 && state._configPanelTop && event.row >= state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const sb = state._costScrollbar;
        if (sb && event.col === sb.col) {
          if (rowInPanel >= sb.thumbStart && rowInPanel < sb.thumbEnd) {
            state._costScrollbarDrag = true;
            state._costDragStartRow = rowInPanel;
            state._costDragStartScroll = state.costScroll;
            state.dirty = true;
          } else if (rowInPanel < sb.thumbStart) {
            state.costScroll = Math.max(0, state.costScroll - sb.rows);
            state.dirty = true;
          } else {
            state.costScroll = Math.min(sb.maxScroll, state.costScroll + sb.rows);
            state.dirty = true;
          }
          return;
        }
      }
      // Check if click is in Config panel area
      if (state.bottomTab === 5 && state._configPanelTop && event.row >= state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const selected = getSelectedSession(state);
        const sections = getSessionConfig(selected);
        const sb = state._configScrollbar;
        // Click on scrollbar
        if (sb && event.col === sb.col) {
          if (rowInPanel >= sb.thumbStart && rowInPanel < sb.thumbEnd) {
            // Start drag
            state._configScrollbarDrag = true;
            state._configDragStartRow = rowInPanel;
            state._configDragStartScroll = state.configScroll;
            state.dirty = true;
          } else {
            // Click above/below thumb → page scroll
            if (rowInPanel < sb.thumbStart) {
              state.configScroll = Math.max(0, state.configScroll - sb.rows);
            } else {
              state.configScroll = Math.min(sb.maxScroll, state.configScroll + sb.rows);
            }
            state.dirty = true;
          }
          return;
        }
        // Click on vertical tab labels or copy icon
        if (event.col <= CONFIG_TAB_WIDTH + 2 && rowInPanel >= 0 && rowInPanel < sections.length) {
          // Check if click is on copy icon (icon is near end of tab label area)
          const iconCol = 2 + CONFIG_TAB_WIDTH - 1; // terminal col of icon character
          if (event.col >= iconCol - 1 && event.col <= iconCol + 1) {
            const target = state._configCopyTargets.find(t => t.row === rowInPanel);
            if (target && target.copyPath) {
              copyToClipboard(target.copyPath);
              state._configCopyFlash = rowInPanel;
              state._configCopyFlashTs = Date.now();
              state.dirty = true;
            }
          } else {
            state.configSubTab = rowInPanel;
            state.configScroll = 0;
            state.dirty = true;
          }
        }
        return; // consume all clicks in config panel area
      }
      // Consume any click inside the bottom panel area so it doesn't
      // accidentally change the session selection.
      if (state._tabBarRow && event.row >= state._tabBarRow) {
        return;
      }

      if (state._colHeaderRow && event.row === state._colHeaderRow) {
        // Click on column header → sort
        const colKey = columnAtX(event.col, state.hScroll, state);
        if (colKey) setSortColumn(state, colKey);
      } else if (state._colHeaderRow && event.row > state._colHeaderRow) {
        // Click on a virtual row (session, marker, or subagent)
        const rowIdx = state.scrollOffset + (event.row - state._colHeaderRow - 1);
        if (rowIdx >= 0 && rowIdx < listLen) {
          state.selectedRow = rowIdx;
          state.dirty = true;
          // Clicking the marker (or its sub-header) toggles expansion immediately
          // on the first click — the chevron is the marker's primary affordance.
          const r = state.flatList[rowIdx];
          if (r && (r.type === "marker" || r.type === "subagent-header")) {
            const s = r.session;
            if (state.expandedSubagents.has(sessionKey(s))) state.expandedSubagents.delete(sessionKey(s));
            else state.expandedSubagents.add(sessionKey(s));
            state.flatList = buildFlatList(state);
          }
        }
      }
      return;
    }

    case "hover": {
      // Track hover over bottom tab bar
      let newHover = -1;
      if (state._tabBarRow && (event.row === state._tabBarRow || event.row === state._tabBarRow + 1)) {
        const idx = tabAtX(event.col, state.panelData);
        if (idx >= 0) newHover = idx;
      }
      // Track hover over Live button in list tab bar
      let newListHover = -1;
      let newLiveHover = false;
      if (state._listTabBarRow && event.row === state._listTabBarRow) {
        const idx = listTabAtX(event.col, state);
        if (idx >= 0) { newListHover = idx; newLiveHover = true; }
      }
      // Track hover over config sub-tabs and scrollbar
      let newConfigHover = -1;
      let newScrollHover = false;
      if (state.bottomTab === 0 && state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const sb = state._infoScrollbar;
        if (sb && event.col === sb.col && rowInPanel >= sb.thumbStart && rowInPanel < sb.thumbEnd) {
          newScrollHover = true;
        }
        if (newScrollHover !== state._infoScrollbarHover) {
          state._infoScrollbarHover = newScrollHover;
          state.dirty = true;
        }
      }
      if (state.bottomTab === 4 && state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const sb = state._costScrollbar;
        if (sb && event.col === sb.col && rowInPanel >= sb.thumbStart && rowInPanel < sb.thumbEnd) {
          newScrollHover = true;
        }
        if (newScrollHover !== state._costScrollbarHover) {
          state._costScrollbarHover = newScrollHover;
          state.dirty = true;
        }
      }
      if (state.bottomTab === 5 && state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const selected = getSelectedSession(state);
        const sections = getSessionConfig(selected);
        if (rowInPanel >= 0 && event.col <= CONFIG_TAB_WIDTH + 2 && rowInPanel < sections.length) {
          newConfigHover = rowInPanel;
        }
        const sb = state._configScrollbar;
        if (sb && event.col === sb.col && rowInPanel >= sb.thumbStart && rowInPanel < sb.thumbEnd) {
          newScrollHover = true;
        }
      }
      // Track hover over agent tool tabs and arrows (vertical sidebar)
      let newAgentToolHover = -1;
      let newAgentArrowHover = "";
      if (state.bottomTab === 3 && state._configPanelTop) {
        const rowInPanel = event.row - state._configPanelTop;
        const hoverCol = event.col - 2;
        if (hoverCol >= 0 && hoverCol <= (state._agentTabWidth || 14)) {
          if (state._agentUpArrowRow >= 0 && rowInPanel === state._agentUpArrowRow) {
            newAgentArrowHover = "up";
          } else if (state._agentDownArrowRow >= 0 && rowInPanel === state._agentDownArrowRow) {
            newAgentArrowHover = "down";
          } else {
            const tab = state._agentToolTabs.find(t => t.row === rowInPanel);
            if (tab) newAgentToolHover = tab.idx;
          }
        }
      }
      // Track hover over column headers
      let newColHover = null;
      if (state._colHeaderRow && event.row === state._colHeaderRow) {
        newColHover = columnAtX(event.col, state.hScroll, state);
      }
      // Track hover over filter ✕ and age filter ✕ in footer
      let newFilterXHover = false;
      let newAgeXHover = false;
      if (state._footerRow && event.row === state._footerRow) {
        if (state._filterXCol > 0 && event.col >= state._filterXCol && event.col <= state._filterXCol + 1)
          newFilterXHover = true;
        if (state._ageFilterXCol > 0 && event.col >= state._ageFilterXCol && event.col <= state._ageFilterXCol + 1)
          newAgeXHover = true;
      }
      if (newHover !== state.hoverTab || newListHover !== state.hoverListTab || newLiveHover !== !!state._liveHover ||
          newConfigHover !== state.configSubTabHover || newScrollHover !== state._configScrollbarHover ||
          newAgentToolHover !== state.hoverAgentToolTab || newAgentArrowHover !== state._hoverAgentArrow ||
          newFilterXHover !== state._hoverFilterX || newAgeXHover !== state._hoverAgeX ||
          newColHover !== state._hoverColKey) {
        state.hoverTab = newHover;
        state.hoverListTab = newListHover;
        state._liveHover = newLiveHover;
        state.configSubTabHover = newConfigHover;
        state._configScrollbarHover = newScrollHover;
        state.hoverAgentToolTab = newAgentToolHover;
        state._hoverAgentArrow = newAgentArrowHover;
        state._hoverFilterX = newFilterXHover;
        state._hoverAgeX = newAgeXHover;
        state._hoverColKey = newColHover;
        state.dirty = true;
      }
      return;
    }

    case "drag": {
      if (state._infoScrollbarDrag && state._infoScrollbar && state._configPanelTop) {
        const sb = state._infoScrollbar;
        const rowInPanel = event.row - state._configPanelTop;
        const delta = rowInPanel - state._infoDragStartRow;
        const track = sb.rows - sb.thumbSize;
        if (track > 0) {
          const scrollDelta = Math.round((delta / track) * sb.maxScroll);
          state.infoScroll = Math.max(0, Math.min(sb.maxScroll, state._infoDragStartScroll + scrollDelta));
          state.dirty = true;
        }
      }
      if (state._costScrollbarDrag && state._costScrollbar && state._configPanelTop) {
        const sb = state._costScrollbar;
        const rowInPanel = event.row - state._configPanelTop;
        const delta = rowInPanel - state._costDragStartRow;
        const track = sb.rows - sb.thumbSize;
        if (track > 0) {
          const scrollDelta = Math.round((delta / track) * sb.maxScroll);
          state.costScroll = Math.max(0, Math.min(sb.maxScroll, state._costDragStartScroll + scrollDelta));
          state.dirty = true;
        }
      }
      if (state._configScrollbarDrag && state._configScrollbar && state._configPanelTop) {
        const sb = state._configScrollbar;
        const rowInPanel = event.row - state._configPanelTop;
        const delta = rowInPanel - state._configDragStartRow;
        // Map row delta to scroll delta: full track = sb.rows - sb.thumbSize, full scroll = sb.maxScroll
        const track = sb.rows - sb.thumbSize;
        if (track > 0) {
          const scrollDelta = Math.round((delta / track) * sb.maxScroll);
          state.configScroll = Math.max(0, Math.min(sb.maxScroll, state._configDragStartScroll + scrollDelta));
          state.dirty = true;
        }
      }
      return;
    }

    case "mouseup": {
      if (state._infoScrollbarDrag) {
        state._infoScrollbarDrag = false;
        state.dirty = true;
      }
      if (state._costScrollbarDrag) {
        state._costScrollbarDrag = false;
        state.dirty = true;
      }
      if (state._configScrollbarDrag) {
        state._configScrollbarDrag = false;
        state.dirty = true;
      }
      return;
    }
  }
}

/** Save current sort to per-tab state, switch to newTab, restore its sort. */
function switchToListTab(state, newTab) {
  state.listTab = newTab;
  state.selectedRow = 0;
  state.scrollOffset = 0;
  applySortAndFilter(state);
  state.dirty = true;
  saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab, tabSort: state._tabSort });
}

function switchListTab(state) {
  switchToListTab(state, state.listTab === 0 ? 1 : 0);
}

function openSortBy(state) {
  const cols = activeColumns(state);
  const idx = cols.findIndex((c) => c.key === state.sortCol);
  state.sortbyIdx = idx >= 0 ? idx : 0;
  state.mode = "sortby";
  state.dirty = true;
}

function setSortColumn(state, key) {
  if (state.sortCol === key) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortCol = key;
    state.sortAsc = true;
  }
  state._tabSort[state.listTab] = { col: state.sortCol, asc: state.sortAsc };
  applySortAndFilter(state);
  state.dirty = true;
  saveUiPrefs({ bottomTab: state.bottomTab, listTab: state.listTab, tabSort: state._tabSort });
}

// ---------------------------------------------------------------------------
// Non-interactive output (preserved for -l, -j, -s flags)
// ---------------------------------------------------------------------------

function formatSessionLine(index, session, label, width) {
  const now = new Date();
  const prefix = `${index}. `;
  const fixedWidth = prefix.length + 4 + 2 + 4 + 2 + 6 + 2 + 6 + 2 + 8 + 2;
  const remaining = Math.max(16, width - fixedWidth);

  const modelWidth = Math.min(22, Math.max(8, Math.floor(remaining / 3)));
  let labelWidth = Math.max(8, remaining - modelWidth - 2);
  if (labelWidth + modelWidth + 2 > remaining)
    labelWidth = Math.max(8, remaining - modelWidth - 2);

  const line =
    prefix +
    relativeAge(session.started_at, now).padStart(4) +
    "  " +
    relativeAge(session.last_active, now).padStart(4) +
    "  " +
    compactTokens(session.list_input_tokens).padStart(6) +
    "  " +
    compactTokens(session.list_output_tokens).padStart(6) +
    "  " +
    compactUsd(session.list_total_cost).padStart(8) +
    "  " +
    fitText(label, labelWidth) +
    "  " +
    fitText(session.model, modelWidth);

  return clipLine(line, width);
}

function renderGroupedLines(codexSessions, claudeSessions, codexPlan, claudePlan) {
  const width = displayWidth();
  let label = "cost";
  if (
    planMode(codexPlan, "codex") === "retail" &&
    planMode(claudePlan, "claude") === "retail"
  )
    label = "est";

  const lines = [];
  lines.push("Codex:");
  if (!codexSessions.length) {
    lines.push("  (none)");
  } else {
    lines.push(
      `    start  last     in    out      ${label.padStart(5)}  session                        model`
    );
    const labels = abbreviatePaths(codexSessions.map((s) => s.label_source));
    for (let i = 0; i < codexSessions.length; i++) {
      const label = codexSessions[i].title || labels[i];
      lines.push(formatSessionLine(i + 1, codexSessions[i], label, width));
    }
  }
  lines.push("");
  lines.push("Claude:");
  if (!claudeSessions.length) {
    lines.push("  (none)");
  } else {
    lines.push(
      `    start  last     in    out      ${label.padStart(5)}  session                        model`
    );
    const labels = abbreviatePaths(claudeSessions.map((s) => s.label_source));
    for (let i = 0; i < claudeSessions.length; i++) {
      const label = claudeSessions[i].title || labels[i];
      lines.push(formatSessionLine(
        codexSessions.length + i + 1,
        claudeSessions[i],
        label,
        width
      ));
    }
  }
  return lines;
}


// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

function tuiStartup() {
  process.stdout.write(ALT_SCREEN_ON + "\x1b[2J" + CURSOR_HIDE + MOUSE_ON);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
}

function tuiShutdown() {
  process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
  try { process.stdin.setRawMode(false); } catch { /* may already be closed */ }
  saveDiskCache();
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

async function loadSessions(state) {
  const [codexSessions, claudeSessions] = listAllSessions();
  applyCurrentDirectoryOverride(codexSessions);
  await annotateListCosts(codexSessions, state.codexPlan);
  await annotateListCosts(claudeSessions, state.claudePlan);
  state.sessions = [...codexSessions, ...claudeSessions];

  // Quota: fetch provider usage limits periodically
  state._quotaTick = (state._quotaTick || 0) + 1;
  if (state._quotaTick >= QUOTA_INTERVAL_TICKS) {
    state._quotaTick = 0;
    try {
      state._quota = await fetchQuota();
    } catch { /* best effort */ }
  }

  // Tier 2: collect OS process metrics periodically
  state._tier2Tick = (state._tier2Tick || 0) + 1;
  if (state._tier2Tick >= TIER2_INTERVAL_TICKS) {
    state._tier2Tick = 0;
    try {
      state._processMetrics = await collectProcessMetrics(state.sessions);
    } catch { /* best effort */ }
  }
  // Attach process metrics to sessions and accumulate chart history
  const matchedKeys = new Set();
  for (const s of state.sessions) {
    const key = `${s.provider}:${s.session_id}`;
    const pm = state._processMetrics.get(key);
    if (pm) {
      applyProcLinger(key, pm);
      s.process = pm;
      matchedKeys.add(key);
      // Push history here (not in renderSystemPanel) so charts accumulate
      // regardless of which panel is currently visible.
      pushHistory(_cpuHistory, key, pm.cpu);
      pushHistory(_memHistory, key, pm.memory / (1024 * 1024));
    } else {
      s.process = null;
    }
  }

  // Create virtual sessions for running processes with no transcript match
  for (const [key, pm] of state._processMetrics) {
    if (matchedKeys.has(key)) continue;
    const orphan = _orphanProcessInfo.get(key);
    const cwd = orphan ? orphan.cwd : "";
    const provider = orphan ? orphan.provider : key.split(":")[0];
    const label = cwd
      ? (cwd.startsWith(HOME) ? cwd.slice(HOME.length + 1) || "~" : cwd)
      : `(${provider})`;
    const now = new Date().toISOString();
    state.sessions.push({
      provider,
      session_id: key.split(":")[1],
      data_file: null,
      label_source: cwd,
      list_label: label,
      started_at: now,
      last_active: now,
      model: "",
      list_input_tokens: 0,
      list_output_tokens: 0,
      list_total_cost: "0.00",
      list_tool_count: 0,
      process: pm,
    });
  }

  // Extract last active tool and context usage for running sessions
  // Cache last known good context so it doesn't flicker when tail read misses
  if (!state._contextCache) state._contextCache = new Map();
  for (const s of state.sessions) {
    const ckey = `${s.provider}:${s.session_id}`;
    if (s.process) {
      s.list_last_tool = extractLastToolName(s);
      const fresh = extractContextUsage(s);
      if (fresh) {
        s.list_context = fresh;
        state._contextCache.set(ckey, fresh);
      } else {
        // Keep previous value if current read returned null
        s.list_context = state._contextCache.get(ckey) || null;
      }
    } else {
      s.list_last_tool = "";
      // Extract context usage for non-running sessions once
      if (s.list_context === undefined) {
        s.list_context = extractContextUsage(s);
        if (s.list_context) state._contextCache.set(ckey, s.list_context);
      }
    }
  }

  updateSessionRates(state.sessions);
  applySortAndFilter(state);
  state.stats = computeStats(state.sessions);
  updateOverviewHistory(state.stats);
  state.dirty = true;
}

// ---------------------------------------------------------------------------
// Plan selection helpers (for non-interactive and TUI modes)
// ---------------------------------------------------------------------------

function resolveProviderPlansFromArg(plan) {
  if (plan === "select") return null; // needs interactive selection
  return resolveProviderPlans(plan);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs();

  // Fetch LiteLLM pricing (best effort, uses 24h disk cache)
  await fetchLitellmPricing();

  // Non-interactive modes: -l, -j, -s
  if (args.listSessions || args.json) {
    try {
      const plans = resolveProviderPlansFromArg(args.plan);
      if (!plans) {
        process.stderr.write("error: -p select requires interactive mode\n");
        return 1;
      }
      const [codexPlan, claudePlan] = plans;
      const [codexSessions, claudeSessions] = listAllSessions();
      applyCurrentDirectoryOverride(codexSessions);
      await annotateListCosts(codexSessions, codexPlan);
      await annotateListCosts(claudeSessions, claudePlan);
      const allSessions = [...codexSessions, ...claudeSessions];

      if (args.listSessions) {
        for (const line of renderGroupedLines(codexSessions, claudeSessions, codexPlan, claudePlan))
          console.log(line);
        saveDiskCache();
        return 0;
      }

      if (args.json) {
        const jsonSessions = await Promise.all(allSessions.map(async (s) => {
          const data = await safeExtractSessionData(s);
          const m = safeMetrics(data);
          const plan = s.provider === "codex" ? codexPlan : claudePlan;
          const incl = planIncludesProvider(plan, s.provider);
          const acct = s.provider === "claude" ? readClaudeAccount() : readCodexAccount();
          const obj = {
            provider: s.provider,
            session_id: s.session_id,
            started_at: s.started_at,
            last_active: s.last_active,
            project: s.label_source || null,
            title: (data && data.title) || s.title || null,
            account: acct,
            model: s.model || (data && data.model) || null,
            models: (data && data.models) || [s.model || null],
            plan,
            cost: {
              total: s.list_total_cost ?? null,
              included: incl,
            },
            tokens: {
              input: s.list_input_tokens ?? null,
              output: s.list_output_tokens ?? null,
              total: ((s.list_input_tokens || 0) + (s.list_output_tokens || 0)) || null,
            },
            activity: {
              tool_count: m.tool_count,
              tools: m.tools,
              skill_count: m.skill_count,
              skills: m.skills,
              web_fetch_count: m.web_fetch_count,
              web_fetches: m.web_fetches,
              web_search_count: m.web_search_count,
              web_searches: m.web_searches,
              mcp_tool_count: m.mcp_tool_count,
              mcp_tools: m.mcp_tools,
            },
          };
          if (data && data.costs) {
            obj.cost.breakdown = data.costs;
          }
          if (data && data.tokens) {
            obj.tokens.detail = data.tokens;
          }
          if (data && data.rates) {
            obj.rates = data.rates;
          }
          if (data && Array.isArray(data.subagents)) {
            obj.subagents = data.subagents;
          }
          return obj;
        }));
        console.log(JSON.stringify(jsonSessions, null, 2));
        saveDiskCache();
        return 0;
      }
    } catch (err) {
      if (err instanceof SessionCostError) {
        process.stderr.write(`error: ${err.message}\n`);
        saveDiskCache();
        return 1;
      }
      throw err;
    }
    return 0;
  }

  // --- TUI mode ---
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("error: TUI requires a TTY. Use -l, -j, or -s flags.\n");
    return 1;
  }

  const state = createState();
  state._startTime = new Date().toISOString();

  // Load persisted UI preferences
  const _savedPrefs = loadUiPrefs();
  if (typeof _savedPrefs.bottomTab === "number") state.bottomTab = _savedPrefs.bottomTab;
  if (typeof _savedPrefs.listTab === "number") state.listTab = _savedPrefs.listTab;
  if (typeof _savedPrefs.agentLiveFilter === "boolean") state.agentLiveFilter = _savedPrefs.agentLiveFilter;
  if (_savedPrefs.inactivityFilter !== undefined) {
    state.inactivityFilter = _savedPrefs.inactivityFilter || null;
    const idx = INACTIVITY_OPTIONS.findIndex(o => o.key === state.inactivityFilter);
    state._inactivityCursor = idx >= 0 ? idx : INACTIVITY_OPTIONS.length - 1;
  }
  if (Array.isArray(_savedPrefs.tabSort)) {
    for (let i = 0; i < _savedPrefs.tabSort.length && i < state._tabSort.length; i++) {
      const s = _savedPrefs.tabSort[i];
      if (s && s.col) state._tabSort[i] = { col: s.col, asc: s.asc !== false };
    }
    // Apply the current tab's saved sort
    const cur = state._tabSort[state.listTab];
    if (cur) { state.sortCol = cur.col; state.sortAsc = cur.asc; }
  }

  // Resolve plans
  if (args.plan === "select") {
    // Default to retail for TUI mode (plan selection is for CLI mode)
    state.codexPlan = "retail";
    state.claudePlan = "retail";
  } else {
    const [cp, clp] = resolveProviderPlans(args.plan);
    state.codexPlan = cp;
    state.claudePlan = clp;
  }

  tuiStartup();

  // Clean shutdown on signals
  const cleanup = () => { tuiShutdown(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Handle resize
  process.stdout.on("resize", () => { state.dirty = true; renderIfDirty(state); });

  // Initial load
  try {
    await loadSessions(state);
  } catch (err) {
    tuiShutdown();
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  // Load panel data for the initially selected row (subagent-aware)
  const initSel = getSelectedPanelSession(state);
  if (initSel) {
    state._panelSessionId = initSel.session_id;
    state.panelData = await safeExtractSessionData(initSel);
  }

  render(state);
  state.dirty = false;

  // Auto-refresh timer
  const delayMs = args.delay * 1000;
  const doRefresh = async () => {
    await loadSessions(state);
    // Re-load panel data for current selection (subagent-aware)
    state._panelSessionId = null;
    const panelSel = getSelectedPanelSession(state);
    if (panelSel) {
      state._panelSessionId = panelSel.session_id;
      state.panelData = await safeExtractSessionData(panelSel);
    }
    if (state.dirty) {
      render(state);
      state.dirty = false;
    }
  };
  const refreshTimer = setInterval(() => {
    doRefresh().catch(() => {}); // best-effort, ignore errors
  }, delayMs);

  // Event loop
  let _inputLeftover = "";
  let _inputFlushTimer = null;
  const onData = async (buf) => {
    if (_inputFlushTimer) { clearTimeout(_inputFlushTimer); _inputFlushTimer = null; }
    const { events, leftover } = extractInputEvents(_inputLeftover + buf);
    _inputLeftover = leftover;
    // Flush leftover after a short timeout (handles bare Escape key)
    if (leftover) {
      _inputFlushTimer = setTimeout(() => {
        _inputFlushTimer = null;
        if (_inputLeftover) {
          for (const seq of splitEscapeSequences(_inputLeftover)) {
            const ev = parseInputSequence(seq);
            if (ev) handleEvent(ev, state);
          }
          _inputLeftover = "";
          if (state.dirty) { render(state); state.dirty = false; }
        }
      }, 50);
    }
    for (const event of events) {
      handleEvent(event, state);
    }

    if (state.quit) {
      clearInterval(refreshTimer);
      tuiShutdown();
      process.exit(0);
    }

    // Load detail data if needed
    if (state._needsDetailLoad) {
      state._needsDetailLoad = false;
      state.detailData = await safeExtractSessionData(state.detailSession);
      state.dirty = true;
    }

    // Load panel data when selection changes (subagent-aware)
    const panelSel = getSelectedPanelSession(state);
    if (panelSel && panelSel.session_id !== state._panelSessionId) {
      state._panelSessionId = panelSel.session_id;
      state.panelData = null; // show "Loading..." immediately
      state.infoScroll = 0;
      state.procScroll = 0;
      state.costScroll = 0;
      state.configScroll = 0;
      state.configSubTab = 0;
      state.agentToolTab = 0;
      state.agentToolScroll = -1;
      state.agentTabScroll = 0;
      state._agentToolCounts = {};
      state._agentToolFlash = {};
      state._agentPrevMaxScroll = undefined;
      render(state);
      state.dirty = false;
      state.panelData = await safeExtractSessionData(panelSel);
      state.dirty = true;
    }

    // Manual refresh (F5 / r key)
    if (state._needsRefresh) {
      state._needsRefresh = false;
      await doRefresh();
    }

    if (state.dirty) {
      render(state);
      state.dirty = false;
    }
  };

  process.stdin.on("data", onData);

  // Keep process alive
  await new Promise(() => {});
}

function renderIfDirty(state) {
  if (state.dirty) {
    render(state);
    state.dirty = false;
  }
}

main().then((code) => process.exit(code));
