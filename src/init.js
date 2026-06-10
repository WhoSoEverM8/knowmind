/**
 * `knowmind init` — client-aware Onboarding.
 *
 * Richtet die AUTOMATISCHE Gedächtnis-Pflege im erkannten KI-Client ein, damit
 * die Kunden-KI knowmind ohne manuelles Hook-Gefrickel pflegt:
 *
 *   - Claude Code: schreibt projektlokale Hooks (UserPromptSubmit -> Recall-Hint
 *     via knowmind_recall; Stop -> Capture-Reminder, der an knowmind_store_memory
 *     erinnert, wenn die Runde Sicherungswürdiges enthielt) und einen
 *     Memory-First-Block in ./CLAUDE.md (idempotent, BEGIN/END-Marker).
 *   - Cursor: schreibt .cursor/rules/knowmind.mdc mit der Memory-First-Regel.
 *   - generisch / Claude Desktop: erklärt, dass die MCP-instructions automatisch
 *     wirken, und zeigt den manuellen Memory-First-Text zum Einfügen.
 *
 * Garantien:
 *   - IDEMPOTENT: zweiter Lauf erzeugt keine Duplikate. Eingefügte Blöcke werden
 *     mit BEGIN/END-knowmind-Markern umschlossen und beim erneuten Lauf ersetzt,
 *     nie ein zweites Mal angehängt.
 *   - NICHT-DESTRUKTIV: ohne Marker wird keine fremde Datei überschrieben; eigene
 *     Dateien (Hook-Skripte, .mdc) werden nur ge-/überschrieben, wenn sie einen
 *     knowmind-Marker tragen ODER neu sind.
 *   - --dry-run zeigt jede Aktion, schreibt aber nichts.
 *
 * Die Hooks rufen NICHT lokale .md-Dateien an (das ist der interne SC-Weg),
 * sondern reden gegen die Plattform: `npx knowmind search` für Recall.
 * Token/apiUrl kommen aus der knowmind-Config (~/.knowmind/config.json) bzw. ENV.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { loadConfig, VERSION } from "./config.js";

// ─── Marker (für idempotente Block-Ersetzung) ────────────────────────
const BEGIN = "<!-- BEGIN knowmind -->";
const END = "<!-- END knowmind -->";
const BEGIN_HASH = "# >>> BEGIN knowmind >>>";
const END_HASH = "# <<< END knowmind <<<";

// ─── Memory-First-Text (Kunden-Variante, gegen die Plattform) ────────
// Bewusst kurz und client-neutral. Verweist auf die MCP-Tools, die der
// knowmind-MCP-Server bereitstellt (knowmind_recall / knowmind_store_memory).
function memoryFirstBlock() {
  return [
    BEGIN,
    "## knowmind — automatische Gedächtnis-Pflege",
    "",
    "Dieses Projekt nutzt **knowmind** (Langzeitgedächtnis & Wissensgraph) als MCP-Server.",
    "Halte dich an die Memory-First-Regel:",
    "",
    "1. **Recall zuerst.** Bevor du eine inhaltliche Frage beantwortest oder eine",
    "   Aufgabe planst, rufe `knowmind_recall` (oder `knowmind search`) auf und prüfe,",
    "   ob es bereits relevantes Wissen gibt. Erst danach Dateien lesen/Web suchen.",
    "2. **Wissen sichern.** Wenn eine Runde etwas Sicherungswürdiges hervorbringt —",
    "   eine Entscheidung, eine neue Regel, ein Ergebnis, ein Fakt über Personen/",
    "   Projekte/Systeme — lege es mit `knowmind_store_memory` (Titel + Inhalt) ab,",
    "   bevor du fortfährst. Reine Recherche oder Wegwerf-Tests müssen nicht gesichert werden.",
    "3. **Beziehungen pflegen.** Verknüpfe zusammengehörige Erinnerungen mit",
    "   `knowmind_link`, damit der Graph nutzbar bleibt.",
    "",
    "Das Gedächtnis lebt auf der knowmind-Plattform (Server in Deutschland), nicht in",
    "lokalen Dateien. Es ist über Sessions und Clients hinweg dasselbe Gehirn.",
    END,
  ].join("\n");
}

// ─── Generischer Hinweis-Text (manuell einfügbar) ────────────────────
function manualSnippet() {
  return memoryFirstBlock();
}

// ─── Datei-Helfer ────────────────────────────────────────────────────

/**
 * Fügt einen marker-umschlossenen Block in eine Textdatei ein bzw. ersetzt
 * einen bereits vorhandenen. Liefert { action, content } ohne zu schreiben.
 *   action: "create" | "replace" | "append" | "unchanged"
 */
function upsertMarkedBlock(filePath, block, { begin = BEGIN, end = END } = {}) {
  const existed = existsSync(filePath);
  const current = existed ? readFileSync(filePath, "utf-8") : "";

  // Bereits ein Block vorhanden? -> ersetzen.
  const bi = current.indexOf(begin);
  const ei = current.indexOf(end);
  if (bi !== -1 && ei !== -1 && ei > bi) {
    const before = current.slice(0, bi);
    const after = current.slice(ei + end.length);
    const next = (before + block + after).replace(/\n{3,}/g, "\n\n");
    if (next === current) return { action: "unchanged", content: current };
    return { action: "replace", content: next };
  }

  // Kein Block -> anhängen (oder Datei neu).
  if (!existed) {
    return { action: "create", content: block + "\n" };
  }
  const sep = current.endsWith("\n") ? "\n" : "\n\n";
  return { action: "append", content: current + sep + block + "\n" };
}

/** Schreibt eine eigene knowmind-Datei nur, wenn neu ODER marker-getragen. */
function writeOwnFile(filePath, content, marker) {
  if (existsSync(filePath)) {
    const cur = readFileSync(filePath, "utf-8");
    if (!cur.includes(marker)) {
      return { action: "skip-foreign", reason: "Datei existiert ohne knowmind-Marker" };
    }
    if (cur === content) return { action: "unchanged" };
    return { action: "overwrite", content };
  }
  return { action: "create", content };
}

// ─── Client-Erkennung ────────────────────────────────────────────────

/**
 * Erkennt den/die wahrscheinlichen Client(s) anhand von Projekt- und
 * Home-Verzeichnis. Liefert eine Liste, weil mehrere zugleich plausibel sind.
 */
export function detectClients(cwd, home) {
  const found = new Set();
  // Claude Code: projektlokales .claude/ ODER globale ~/.claude.json / ~/.claude
  if (existsSync(join(cwd, ".claude"))) found.add("claude-code");
  if (existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude")))
    found.add("claude-code");
  // Cursor: projektlokales .cursor/ ODER globale ~/.cursor
  if (existsSync(join(cwd, ".cursor"))) found.add("cursor");
  if (existsSync(join(home, ".cursor"))) found.add("cursor");
  // Codex CLI
  if (existsSync(join(home, ".codex", "config.toml"))) found.add("codex");
  return [...found];
}

// ─── Hook-Skripte (Claude-Code-Vorlage, gegen die Plattform) ─────────
// Reines Node, keine externen Deps — laufen über `node`. Sie rufen die CLI
// per `npx -y knowmind ...` bzw. direkt die Bearer-API, ohne SC-spezifische
// Pfade. Token/apiUrl über ENV oder ~/.knowmind/config.json.

function autoRecallHookSource() {
  return `#!/usr/bin/env node
// >>> knowmind auto-recall hook (UserPromptSubmit)
// Erzeugt von: knowmind init. Idempotent ersetzbar (trägt diesen Marker).
//
// Ruft vor jeder echten Frage knowmind_recall auf und injiziert die Top-Treffer
// als zusätzlichen Kontext (stdout). Direkter HTTPS-Call gegen die Plattform —
// KEIN Subprozess/npx: das vermeidet den Windows-.cmd-Spawn-Fehler (EINVAL bei
// spawn von npx.cmd ohne Shell, Node-Härtung CVE-2024-27980) und den langsamen
// npx-Kaltstart; und es gibt KEINE Command-Injection, weil die Nutzer-Frage als
// JSON-Body und nicht als Shell-Argument übergeben wird. Fail-open: jeder
// Fehler / fehlendes Token -> exit 0 ohne Ausgabe, blockiert nie.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TRIVIAL = new Set([
  "ok","okay","go","ja","nein","weiter","stop","danke","thanks","thx",
  "yes","no","yep","nope","perfekt","passt","super","gut",
]);
const TRIGGER = [
  "kunde","kunden","projekt","tool","server","domain","wer ist","was ist",
  "welche","liste","übersicht","status","wo ","wann","wieso","warum",
  "recherche","research","info zu","infos zu","memory","graph","datenbank",
];

function shouldRecall(p) {
  const s = (p || "").trim().toLowerCase();
  if (s.length < 8) return false;
  if (TRIVIAL.has(s)) return false;
  if (s.startsWith("/")) return false;
  if (TRIGGER.some((k) => s.includes(k))) return true;
  if (s.endsWith("?")) return true;
  return s.length >= 40;
}

// Token + apiUrl: ENV hat Vorrang, sonst ~/.knowmind/config.json (gleiche
// Reihenfolge wie die CLI). Kein Token -> kein Recall (fail-open).
function loadCreds() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".knowmind", "config.json"), "utf-8"));
  } catch { /* keine/kaputte Config -> ENV/Default */ }
  let apiUrl = process.env.KNOWMIND_API_URL || file.apiUrl || "https://knowmind.de";
  if (apiUrl.endsWith("/")) apiUrl = apiUrl.slice(0, -1);
  return { apiUrl, token: process.env.KNOWMIND_TOKEN || file.token || null };
}

// Antwort von /api/mcp/v1 ist Standard-SSE (data:-Frames) ODER plain JSON.
// Beides robust auf das JSON-RPC-Objekt mit result/error reduzieren.
function parseBody(raw) {
  raw = (raw || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) { try { return JSON.parse(raw); } catch { return null; } }
  let found = null;
  for (const lineRaw of raw.split("\\n")) {
    const line = lineRaw.trim();
    if (line.indexOf("data:") !== 0) continue;
    try {
      const obj = JSON.parse(line.slice(5).trim());
      if (obj && (obj.result || obj.error)) found = obj;
    } catch { /* nicht-JSON data-Zeile überspringen */ }
  }
  return found;
}

// knowmind_recall liefert result.content[].text = JSON-String mit hits[].
// Lesbar verdichten; bei Parse-Fehler den Rohtext durchreichen.
function formatHits(rpc) {
  const c = rpc && rpc.result && rpc.result.content;
  const text = Array.isArray(c)
    ? c.filter((b) => b && b.type === "text" && b.text).map((b) => b.text).join("\\n").trim()
    : "";
  if (!text) return "";
  try {
    const o = JSON.parse(text);
    if (Array.isArray(o.hits)) {
      if (o.hits.length === 0) return "";
      return o.hits.slice(0, 5).map((h, i) => {
        const m = h.metadata || {};
        const title = m.title || m.name || h.source || ("Treffer " + (i + 1));
        const score = typeof h.score === "number" ? " (" + h.score.toFixed(2) + ")" : "";
        const snip = String(h.content || "").replace(/\\s+/g, " ").trim().slice(0, 280);
        return "• " + title + score + ": " + snip;
      }).join("\\n");
    }
  } catch { /* kein hits-JSON -> Rohtext */ }
  return text;
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf-8");
  for await (const c of process.stdin) raw += c;
  let prompt = "";
  try {
    const data = raw ? JSON.parse(raw) : {};
    prompt = data.prompt || data.user_prompt || data.user_message || "";
  } catch { return; }
  if (!shouldRecall(prompt)) return;

  const { apiUrl, token } = loadCreds();
  if (!token) return;
  const query = prompt.trim().slice(0, 500);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let rpc = null;
  try {
    const res = await fetch(apiUrl + "/api/mcp/v1", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "knowmind_recall", arguments: { query, k: 5, hops: 2 } },
      }),
      signal: ctrl.signal,
    });
    rpc = parseBody(await res.text());
  } catch { return; } finally { clearTimeout(timer); }

  const hits = formatHits(rpc);
  if (!hits) return;

  process.stdout.write(
    "═════════ knowmind RECALL (auto) ═════════\\n" +
    hits + "\\n" +
    "Diese Treffer wurden automatisch vor deiner Antwort abgerufen.\\n" +
    "Erst hier prüfen, dann Dateien lesen / Web suchen.\\n" +
    "══════════════════════════════════════════\\n"
  );
}

main().catch(() => process.exit(0));
// <<< knowmind auto-recall hook
`;
}

function captureGateHookSource() {
  return `#!/usr/bin/env node
// >>> knowmind capture-gate hook (Stop)
// Erzeugt von: knowmind init. Idempotent ersetzbar (trägt diesen Marker).
//
// Prüft nach jeder Antwort, ob die Runde Sicherungswürdiges enthielt
// (Code-/Config-Änderung, Deploy/Commit, neue Regel/Entscheidung) UND ob ein
// knowmind_store_memory aufgerufen wurde. Wenn nicht -> {"decision":"block"},
// damit die KI vor dem Stoppen eine Erinnerung ablegt.
// Rein heuristisch (kein LLM). Loop-Schutz via stop_hook_active. Fail-open.
import { readFileSync } from "node:fs";

const DEPLOY = /\\b(git\\s+commit|git\\s+push|docker\\s+compose[^\\n]*\\bup\\b|docker\\s+build|deploy|scp|rsync|npm\\s+publish|kubectl\\s+apply)\\b/i;
const RULE = /(ab sofort|ab jetzt|von nun an|merk(e)? dir|neue regel|regel:|harte regel|standing order|niemals wieder|nie wieder)/i;
const ARCH = /(architektur-?entscheid|\\bADR\\b|wir stellen um|grundsatzentscheidung|wir migrieren auf|umstellung auf|wir setzen auf)/i;
const CODE_EXT = [".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".php",".go",".rs",".java",".rb",".css",".scss",".html",".vue",".svelte",".json",".yml",".yaml",".toml",".prisma",".sql",".sh",".ps1"];
const STORE_HINTS = ["knowmind_store","store_memory","update_fact","knowmind_update_fact"];

function isUserMsg(e) {
  if (e.type !== "user") return false;
  const c = e.message?.content;
  if (typeof c === "string") return !!c.trim();
  if (Array.isArray(c)) {
    const text = c.some((b) => b?.type === "text");
    const tr = c.some((b) => b?.type === "tool_result");
    return text && !tr;
  }
  return false;
}
function userText(e) {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === "text").map((b) => b.text || "").join(" ");
  return "";
}
function collectRound(path) {
  const lines = readFileSync(path, "utf-8").split(/\\r?\\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (isUserMsg(lines[i])) { start = i; break; }
  const utext = lines.length ? userText(lines[start]) : "";
  const tools = [];
  for (const e of lines.slice(start)) {
    if (e.type !== "assistant") continue;
    const c = e.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_use") tools.push(b);
  }
  return { utext, tools };
}
function hasStore(tools) {
  for (const t of tools) {
    const n = (t.name || "").toLowerCase();
    if (STORE_HINTS.some((h) => n.includes(h))) return true;
  }
  return false;
}
function detect(utext, tools) {
  const sig = [];
  for (const t of tools) if (t.name === "Bash" && DEPLOY.test((t.input?.command) || "")) { sig.push("Deploy/Commit"); break; }
  for (const t of tools) {
    if (["Write","Edit","MultiEdit"].includes(t.name)) {
      const fp = (t.input?.file_path || "").toLowerCase();
      if (fp && CODE_EXT.some((x) => fp.endsWith(x))) { sig.push("Code-/Config-Änderung"); break; }
    }
  }
  if (RULE.test(utext)) sig.push("neue Regel/Standing Order");
  if (ARCH.test(utext)) sig.push("Architektur-Entscheidung");
  return [...new Set(sig)];
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf-8");
  for await (const c of process.stdin) raw += c;
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { return; }
  if (data.stop_hook_active) return;            // Loop-Schutz
  const tp = data.transcript_path;
  if (!tp) return;
  let round;
  try { round = collectRound(tp); } catch { return; }
  if (hasStore(round.tools)) return;            // schon gesichert
  const sig = detect(round.utext, round.tools);
  if (!sig.length) return;                      // nichts Sicherungswürdiges

  const reason =
    "STOP-GATE (knowmind): Diese Runde enthielt Sicherungswürdiges (" + sig.join(", ") + "), " +
    "aber es wurde kein knowmind_store_memory aufgerufen.\\n" +
    "Bevor du stoppst: lege das Ergebnis mit knowmind_store_memory ab (Titel + Inhalt) " +
    "und verknüpfe es ggf. mit knowmind_link. Ist der Vorgang wirklich nicht " +
    "sicherungswürdig (reine Recherche, Wegwerf-Test), begründe es in einem Satz, dann stoppe.";
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

main().catch(() => process.exit(0));
// <<< knowmind capture-gate hook
`;
}

// ─── Cursor-Rule (.mdc) ──────────────────────────────────────────────
function cursorRuleSource() {
  return `---
description: knowmind — Memory-First-Regel (automatisches Langzeitgedächtnis)
alwaysApply: true
---
${BEGIN}
# knowmind — automatische Gedächtnis-Pflege

Dieses Projekt nutzt **knowmind** (Langzeitgedächtnis & Wissensgraph) als MCP-Server.

1. **Recall zuerst.** Bevor du eine inhaltliche Frage beantwortest oder eine Aufgabe
   planst, rufe \`knowmind_recall\` auf und prüfe, ob bereits relevantes Wissen vorliegt.
   Erst danach Dateien lesen / Web suchen.
2. **Wissen sichern.** Bringt eine Runde Sicherungswürdiges hervor (Entscheidung, neue
   Regel, Ergebnis, Fakt über Personen/Projekte/Systeme), lege es mit
   \`knowmind_store_memory\` ab, bevor du fortfährst.
3. **Beziehungen pflegen.** Verknüpfe zusammengehörige Erinnerungen mit \`knowmind_link\`.

Das Gedächtnis lebt auf der knowmind-Plattform (Server in Deutschland), nicht in lokalen
Dateien — über Sessions und Clients hinweg dasselbe Gehirn.
${END}
`;
}

// ─── Claude-settings.json: Hook-Registrierung (idempotent) ───────────

function ensureClaudeHookEntry(settings, eventName, scriptRel) {
  // settings.hooks[eventName] ist ein Array von { matcher?, hooks: [{type,command}] }.
  // Wir registrieren genau EINEN knowmind-Eintrag pro Event, marker-erkennbar am command.
  const cmd = `node "${scriptRel}"`;
  settings.hooks = settings.hooks || {};
  const arr = settings.hooks[eventName] || [];
  // Existierenden knowmind-Eintrag finden (command enthält den Skriptnamen).
  const scriptName = scriptRel.split(/[\\/]/).pop();
  let mutated = false;
  let present = false;
  for (const group of arr) {
    for (const h of group.hooks || []) {
      if (typeof h.command === "string" && h.command.includes(scriptName)) {
        present = true;
        if (h.command !== cmd) {
          h.command = cmd;
          mutated = true;
        }
      }
    }
  }
  if (!present) {
    arr.push({ hooks: [{ type: "command", command: cmd }] });
    mutated = true;
  }
  settings.hooks[eventName] = arr;
  return mutated;
}

// ─── Plan-Bauer pro Client ───────────────────────────────────────────
// Jeder Eintrag: { path, kind, render() -> {action, content?} oder Info }

function planClaudeCode(cwd) {
  const actions = [];
  const hooksDir = join(cwd, ".claude", "hooks");
  const recallPath = join(hooksDir, "knowmind_recall.mjs");
  const capturePath = join(hooksDir, "knowmind_capture.mjs");
  const settingsPath = join(cwd, ".claude", "settings.json");
  const claudeMdPath = join(cwd, "CLAUDE.md");

  // 1) Recall-Hook
  const recallSrc = autoRecallHookSource();
  actions.push({
    label: "Claude-Code Recall-Hook",
    path: recallPath,
    ...writeOwnFile(recallPath, recallSrc, ">>> knowmind auto-recall hook"),
    content: recallSrc,
    _own: true,
    _exec: true,
  });

  // 2) Capture-Gate-Hook
  const captureSrc = captureGateHookSource();
  actions.push({
    label: "Claude-Code Capture-Gate-Hook",
    path: capturePath,
    ...writeOwnFile(capturePath, captureSrc, ">>> knowmind capture-gate hook"),
    content: captureSrc,
    _own: true,
    _exec: true,
  });

  // 3) settings.json — Hooks registrieren
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      settings = { _parseError: true };
    }
  }
  if (settings._parseError) {
    actions.push({
      label: "Claude-Code settings.json",
      path: settingsPath,
      action: "skip-foreign",
      reason: "settings.json ist kein gültiges JSON — bitte Hooks manuell eintragen",
    });
  } else {
    const relRecall = ".claude/hooks/knowmind_recall.mjs";
    const relCapture = ".claude/hooks/knowmind_capture.mjs";
    const m1 = ensureClaudeHookEntry(settings, "UserPromptSubmit", relRecall);
    const m2 = ensureClaudeHookEntry(settings, "Stop", relCapture);
    actions.push({
      label: "Claude-Code settings.json (Hook-Registrierung)",
      path: settingsPath,
      action: m1 || m2 ? (existsSync(settingsPath) ? "patch" : "create") : "unchanged",
      content: JSON.stringify(settings, null, 2) + "\n",
    });
  }

  // 4) CLAUDE.md — Memory-First-Block
  const md = upsertMarkedBlock(claudeMdPath, memoryFirstBlock());
  actions.push({
    label: "CLAUDE.md (Memory-First-Block)",
    path: claudeMdPath,
    action: md.action,
    content: md.content,
  });

  return actions;
}

function planCursor(cwd) {
  const rulePath = join(cwd, ".cursor", "rules", "knowmind.mdc");
  const src = cursorRuleSource();
  return [
    {
      label: "Cursor-Rule .cursor/rules/knowmind.mdc",
      path: rulePath,
      ...writeOwnFile(rulePath, src, BEGIN),
      content: src,
      _own: true,
    },
  ];
}

// ─── Ausführung ──────────────────────────────────────────────────────

function applyAction(a) {
  if (!a.action || ["unchanged", "skip-foreign"].includes(a.action)) return;
  if (a.content == null) return;
  mkdirSync(dirname(a.path), { recursive: true });
  writeFileSync(a.path, a.content, "utf-8");
  if (a._exec && platform() !== "win32") {
    try {
      chmodSync(a.path, 0o755);
    } catch {
      /* best effort */
    }
  }
}

const ICON = {
  create: "+",
  replace: "~",
  overwrite: "~",
  patch: "~",
  append: "~",
  unchanged: "=",
  "skip-foreign": "!",
};

/**
 * Haupteinstieg. options: { client, dryRun, cwd, home }
 */
export async function runInit({ client = "auto", dryRun = false, cwd = process.cwd(), home = homedir() } = {}) {
  const cfg = loadConfig();
  const lines = [];
  lines.push(`knowmind init ${VERSION}${dryRun ? "  (dry-run — es wird NICHTS geschrieben)" : ""}`);
  lines.push(`Projekt: ${resolve(cwd)}`);
  lines.push(`Plattform: ${cfg.apiUrl}${cfg.token ? "  (Token konfiguriert)" : "  (KEIN Token — `knowmind login` zuerst!)"}`);
  lines.push("");

  // Client wählen
  let target = client;
  if (client === "auto") {
    const detected = detectClients(cwd, home);
    if (detected.length === 0) {
      target = "generic";
      lines.push("Kein Client automatisch erkannt — generische Anleitung.");
    } else if (detected.length === 1) {
      target = detected[0];
      lines.push(`Erkannter Client: ${target}`);
    } else {
      // Mehrere -> alle einrichten, klar ausweisen.
      target = detected;
      lines.push(`Erkannte Clients: ${detected.join(", ")} — alle werden eingerichtet.`);
    }
  } else {
    lines.push(`Client (explizit): ${client}`);
  }
  lines.push("");

  const targets = Array.isArray(target) ? target : [target];
  const allActions = [];
  for (const t of targets) {
    if (t === "claude-code") allActions.push(...planClaudeCode(cwd));
    else if (t === "cursor") allActions.push(...planCursor(cwd));
    else {
      // generic / claude-desktop / codex und alles ohne Hook-Mechanismus.
      const heading =
        t === "codex"
          ? "Codex CLI:"
          : t === "claude-desktop"
            ? "Claude Desktop:"
            : "Generischer Client:";
      lines.push(heading);
      lines.push("  Dieser Client kennt keinen Hook-Mechanismus, der die Pflege HART erzwingt.");
      lines.push("  Es wirken automatisch: die MCP-instructions (werden beim Verbinden gelesen)");
      lines.push("  und die MCP-prompts. Für eine zusätzliche, weiche Memory-First-Regel den");
      lines.push("  folgenden Block in deine System-/Projekt-Anweisung (z. B. AGENTS.md, CLAUDE.md,");
      lines.push("  Custom Instructions) einfügen:");
      lines.push("");
      lines.push(manualSnippet().split("\n").map((l) => "    " + l).join("\n"));
      lines.push("");
    }
  }

  // Plan ausgeben + ggf. anwenden
  if (allActions.length) {
    lines.push("Aktionen:");
    for (const a of allActions) {
      const icon = ICON[a.action] || "?";
      let note = "";
      if (a.action === "skip-foreign") note = `  (übersprungen: ${a.reason})`;
      if (a.action === "unchanged") note = "  (bereits aktuell)";
      lines.push(`  [${icon}] ${a.label}`);
      lines.push(`        ${a.path}${note}`);
    }
    lines.push("");
    if (!dryRun) {
      for (const a of allActions) applyAction(a);
      lines.push("Eingerichtet. Starte deinen KI-Client neu, damit Hooks/Regeln greifen.");
    } else {
      lines.push("Dry-Run: keine Datei wurde geändert. Ohne --dry-run erneut ausführen.");
    }
  }

  return lines.join("\n");
}

// Für Tests exportiert.
export const _internals = {
  upsertMarkedBlock,
  writeOwnFile,
  ensureClaudeHookEntry,
  detectClients,
  memoryFirstBlock,
  BEGIN,
  END,
};
