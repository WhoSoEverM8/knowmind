#!/usr/bin/env node
/**
 * Knowmind CLI Entry-Point.
 *
 * Verfügbare Befehle:
 *   knowmind login [--token kmt_…]   — API-Token speichern
 *   knowmind config                  — aktuelle Config anzeigen
 *   knowmind search "Frage" [-k 5]   — Recall
 *   knowmind upload <file> [--title] — Dokument-Ingestion
 *   knowmind stats                   — Korpus-Statistik
 *   knowmind health                  — Service-Health
 *   knowmind mcp                     — Stdio-MCP-Server
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { stdin as input } from "node:process";
import {
  recall,
  uploadDocument,
  stats,
  health,
} from "../src/client.js";
import { loadConfig, saveConfig, configPath, VERSION } from "../src/config.js";
import { runStdioServer } from "../src/mcp-stdio.js";
import { syncDirectory } from "../src/sync.js";

const args = process.argv.slice(2);
const cmd = args[0];

function parseFlag(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] ?? fallback;
}

async function readStdin() {
  return await new Promise((resolve) => {
    let data = "";
    input.setEncoding("utf-8");
    input.on("data", (c) => (data += c));
    input.on("end", () => resolve(data));
  });
}

function help() {
  console.log(`
Knowmind ${VERSION} — Das Gedächtnis für Ihre KI

Befehle:
  knowmind login [--token kmt_TOKEN] [--api https://knowmind.de]
                       Token speichern
  knowmind config      Aktuelle Konfiguration anzeigen
  knowmind search "Frage" [-k 5] [--hops 2]
                       Hybrid-Recall gegen den Tenant-Korpus
  knowmind upload <file> [--title "..."]
                       Markdown-/Text-Datei indexieren (stdin: knowmind upload -)
  knowmind sync <dir>  [--ext .md,.txt] [--verbose] [--title-from-content]
                       Ordner mit dem Korpus abgleichen. Idempotent über
                       Content-Hash, Manifest in <dir>/.knowmind-manifest.json.
  knowmind stats       Memory- und Edge-Counter des Tenants
  knowmind health      Health-Check der Plattform
  knowmind mcp         Stdio-MCP-Server für lokale AI-Clients

ENV-Override:
  KNOWMIND_API_URL     z. B. https://knowmind.de
  KNOWMIND_TOKEN       Bearer-Token (überschreibt Config-File)
`);
}

async function runLogin() {
  let token = parseFlag("--token", null);
  const api = parseFlag("--api", null);
  if (!token) {
    // Interaktiv von stdin lesen
    process.stdout.write("API-Token (kmt_…): ");
    const line = await new Promise((resolve) => {
      input.once("data", (d) => resolve(d.toString().trim()));
    });
    token = line;
  }
  if (!token || !token.startsWith("kmt_"))
    throw new Error("Token muss mit kmt_ beginnen.");

  // Vor dem Speichern: Token gegen Server verifizieren. Sonst wäre jeder
  // Phantasie-String akzeptiert und alle späteren Aufrufe scheitern erst
  // beim ersten echten Call — das ist verwirrend.
  const apiUrl = api || process.env.KNOWMIND_API_URL || loadConfig().apiUrl;
  process.stdout.write("Token wird gegen Server verifiziert … ");
  const r = await fetch(`${apiUrl}/api/mcp/v1`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "knowmind.health", arguments: {} },
    }),
  }).catch((e) => ({ ok: false, _netError: e.message }));
  if (r._netError) {
    process.stdout.write("FEHLER\n");
    throw new Error(`Server nicht erreichbar (${apiUrl}): ${r._netError}`);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    process.stdout.write("ABGELEHNT\n");
    const code = data.error?.code ?? r.status;
    const msg = data.error?.message ?? `HTTP ${r.status}`;
    throw new Error(`Token ungültig: ${code} — ${msg}`);
  }
  process.stdout.write("ok\n");
  const where = saveConfig({ token, ...(api ? { apiUrl: api } : {}) });
  console.log(`Token gespeichert in ${where}.`);
}

async function runSearch() {
  const query = args.slice(1).filter((a) => !a.startsWith("-")).join(" ");
  if (!query) throw new Error('Usage: knowmind search "Ihre Frage"');
  const k = Number(parseFlag("-k", parseFlag("--k", 5)));
  const hops = Number(parseFlag("--hops", 2));
  const result = await recall(query, { k, hops });
  if (!result?.hits?.length) {
    console.log("Keine Treffer.");
    return;
  }
  for (const [i, hit] of result.hits.entries()) {
    const src = hit.metadata?.source_id ?? hit.chunk_id;
    const name = hit.metadata?.name ?? src;
    console.log(`\n#${i + 1}  ${name}  (score ${hit.score.toFixed(3)})`);
    console.log("  " + hit.content.slice(0, 280).replace(/\n/g, "\n  "));
  }
  console.log(`\n${result.hits.length} Treffer in ${result.latency_ms} ms.`);
}

async function runUpload() {
  const path = args[1];
  if (!path) throw new Error("Usage: knowmind upload <file>  (oder `-` für stdin)");
  let content;
  let title = parseFlag("--title", null);
  if (path === "-") {
    content = await readStdin();
    title = title ?? "stdin";
  } else {
    content = readFileSync(path, "utf-8");
    title = title ?? basename(path);
  }
  const data = await uploadDocument(title, content);
  console.log(`Indexiert: ${data.chunksWritten} Chunks (Provider ${data.embeddingProvider}).`);
}

async function runSync() {
  const dir = args[1];
  if (!dir) throw new Error("Usage: knowmind sync <directory>");
  const extFlag = parseFlag("--ext", null);
  const options = {
    extensions: extFlag ? extFlag.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`)) : undefined,
    verbose: args.includes("--verbose"),
    titleFromContent: args.includes("--title-from-content"),
  };
  const result = await syncDirectory(dir, options);
  if (result.failed > 0) process.exitCode = 3;
}


async function runStats() {
  console.log(JSON.stringify(await stats(), null, 2));
}

async function runHealth() {
  console.log(JSON.stringify(await health(), null, 2));
}

async function runConfig() {
  const c = loadConfig();
  console.log(`Config-Datei: ${configPath()}`);
  console.log(`API-URL: ${c.apiUrl}`);
  console.log(`Token:   ${c.token ? c.token.slice(0, 12) + "…" : "(keiner)"}`);
}

// Wichtig: `process.exit(N)` reißt offene Sockets/fetch-Verbindungen mit
// rein und triggert auf Windows/Node 22 die libuv-Assertion
// `!(handle->flags & UV_HANDLE_CLOSING)`. Stattdessen `exitCode` setzen
// und sauber zurückkehren — Node beendet sich von selbst, sobald keine
// offenen Handles mehr da sind.
try {
  switch (cmd) {
    case "login":
      await runLogin();
      break;
    case "config":
      await runConfig();
      break;
    case "search":
      await runSearch();
      break;
    case "upload":
      await runUpload();
      break;
    case "sync":
      await runSync();
      break;
    case "stats":
      await runStats();
      break;
    case "health":
      await runHealth();
      break;
    case "mcp":
      await runStdioServer();
      break;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      help();
      break;
    default:
      console.error(`Unbekannter Befehl: ${cmd}`);
      help();
      process.exitCode = 1;
  }
} catch (e) {
  console.error(`Fehler: ${e.message}`);
  process.exitCode = 2;
}
