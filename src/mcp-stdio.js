/**
 * Lokaler MCP-Stdio-Server — dünner Proxy auf die Knowmind-Plattform.
 *
 * Forwarded JSON-RPC-Requests von stdin an den Remote-MCP-Endpoint
 * (POST {apiUrl}/api/mcp/v1) und schreibt die Antworten auf stdout. Damit kann
 * Knowmind in jeden lokalen MCP-fähigen Client (Claude Code, Claude Desktop,
 * ChatGPT, Cursor, ...) eingebunden werden, ohne dass der Client Bearer-Token
 * kennen muss — der CLI-Wrapper verwaltet die Auth.
 *
 * DESIGN: Seit 0.1.18 ist dieser Server ein reiner Proxy. Tool-Definitionen,
 * Namen (knowmind_recall, knowmind_store_memory, ...), Schemas und
 * Safety-Annotations kommen direkt vom Server (tools/list wird durchgereicht).
 * Dadurch können lokale Definitionen nie mehr vom Server-Stand abweichen —
 * genau diese Abweichung (Punkt- vs. Unterstrich-Namen) hatte 0.1.17 unbrauchbar
 * gemacht, nachdem die Plattform auf das MCP-Namensschema umgestellt wurde.
 *
 * Seit 0.1.20 wird auch `initialize` an den Server durchgereicht, damit die
 * serverseitigen `instructions` (der client-übergreifende Pflege-Hebel) und die
 * tatsächlichen serverInfo/capabilities den Client erreichen. Bei Server-
 * Fehler/Offline fällt der Proxy auf einen lokalen Default zurück.
 *
 * Seit 0.1.22 gibt es einen DISCOVERY-MODUS: Ist KEIN Token konfiguriert,
 * beantwortet der Proxy `initialize`, `tools/list` und `prompts/list` über die
 * ÖFFENTLICHE Server-Discovery (GET {apiUrl}/api/mcp/v1 — liefert Name, Version
 * und alle Tool-Definitionen ohne Auth). Damit funktioniert Introspection
 * (z. B. Verzeichnis-Crawler wie Glama) ohne Account; erst `tools/call`
 * verlangt einen Token und verweist klar auf `knowmind login`. Ein
 * konfigurierter, aber UNGÜLTIGER Token führt weiterhin zum harten
 * Verbindungsfehler, damit MCP-Clients nicht fälschlich „connected" anzeigen.
 *
 * Protokoll: stdio mit zeilenweise JSON (NDJSON-Style). Jedes Frame ist ein
 * vollständiges JSON-RPC-Objekt.
 */
import { loadConfig, VERSION } from "./config.js";
import { createInterface } from "node:readline";

/** Methoden, die lokal beantwortet werden (alles andere geht an den Server). */
const LOCAL_METHODS = new Set(["initialize", "ping"]);

/**
 * Lokaler Fallback-result für `initialize`, falls der Server nicht erreichbar
 * ist oder keine verwertbare Antwort liefert. Hält den Proxy offline-robust.
 * Die serverInfo.version stammt aus der package.json (VERSION).
 */
function localInitializeResult() {
  return {
    protocolVersion: "2025-06-18",
    serverInfo: { name: "knowmind", version: VERSION },
    capabilities: { tools: {}, prompts: {} },
  };
}

async function forwardToServer(method, params) {
  const { apiUrl, token } = loadConfig();
  if (!token)
    throw new Error("Knowmind: kein Token konfiguriert. `knowmind login` zuerst.");

  const r = await fetch(`${apiUrl}/api/mcp/v1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    // HTTP-Status ohne parsebaren JSON-Body sauber als JSON-RPC-Fehler melden.
    return {
      error: {
        code: r.ok ? -32700 : -32000,
        message: r.ok
          ? "Knowmind-Server lieferte kein gültiges JSON."
          : `Knowmind-Server: HTTP ${r.status}`,
      },
    };
  }
  return data;
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Öffentliche Server-Discovery (kein Auth nötig): GET {apiUrl}/api/mcp/v1
 * liefert { name, version, protocolVersion, tools: [...] }. Grundlage des
 * Discovery-Modus ohne Token.
 */
async function fetchPublicDiscovery() {
  const { apiUrl } = loadConfig();
  const r = await fetch(`${apiUrl}/api/mcp/v1`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Knowmind-Server: HTTP ${r.status}`);
  return await r.json();
}

/**
 * Probiert den konfigurierten Token gegen den Server. Liefert
 * { ok: true } oder { ok: false, reason: "..." }. Wird in der
 * `initialize`-Phase aufgerufen, damit der MCP-Client (Claude Code,
 * Codex, Cursor) bei ungültigem Token NICHT „connected ✓" anzeigt,
 * sondern eine klare Fehlermeldung.
 */
async function probeAuth() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    return { ok: false, reason: `Config nicht lesbar: ${e.message}` };
  }
  if (!cfg.token) {
    return {
      ok: false,
      reason:
        "Kein Knowmind-Token konfiguriert. Bitte `knowmind login` im Terminal ausführen.",
    };
  }
  if (!cfg.token.startsWith("kmt_")) {
    return {
      ok: false,
      reason:
        "Konfigurierter Token hat ein ungültiges Format (erwartet: kmt_…). Bitte `knowmind login` neu ausführen.",
    };
  }
  try {
    const r = await fetch(`${cfg.apiUrl}/api/mcp/v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "knowmind_health", arguments: {} },
      }),
    });
    if (!r.ok) {
      return {
        ok: false,
        reason:
          `Knowmind-Server antwortet mit HTTP ${r.status}. Token wahrscheinlich abgelaufen — bitte "knowmind login" neu ausführen.`,
      };
    }
    const data = await r.json();
    if (data.error) {
      return {
        ok: false,
        reason:
          `Knowmind-Server lehnt Token ab: ${data.error.message ?? "unbekannter Grund"}. Bitte "knowmind login" neu ausführen.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: `Knowmind-Server nicht erreichbar (${cfg.apiUrl}): ${e.message}`,
    };
  }
}

export async function runStdioServer() {
  // Kein Token konfiguriert → Discovery-Modus: initialize/tools/list laufen
  // über die öffentliche Server-Discovery, tools/call verlangt Login.
  let discoveryMode = false;
  try {
    discoveryMode = !loadConfig().token;
  } catch {
    discoveryMode = true;
  }

  // Auth einmal am Start prüfen (nur wenn ein Token vorhanden ist). Das
  // Ergebnis cachen — der MCP-Client soll sofort beim initialize wissen,
  // ob die Verbindung wirklich steht.
  const auth = discoveryMode
    ? {
        ok: false,
        reason:
          "Kein Knowmind-Token konfiguriert. Bitte `knowmind login` im Terminal ausführen.",
      }
    : await probeAuth();
  if (discoveryMode) {
    process.stderr.write(
      "[knowmind] Kein Token — Discovery-Modus: initialize/tools/list öffentlich, tools/call erfordert `knowmind login`.\n",
    );
  } else if (!auth.ok) {
    process.stderr.write(`[knowmind] AUTH-FEHLER: ${auth.reason}\n`);
  }

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    try {
      // Notifications (kein id-Feld) bekommen per JSON-RPC keine Antwort.
      const isNotification = req.id === undefined && typeof req.method === "string" && req.method.startsWith("notifications/");
      if (isNotification) continue;

      if (discoveryMode) {
        if (req.method === "ping") {
          write({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
          continue;
        }
        if (req.method === "initialize") {
          // serverInfo/protocolVersion möglichst aus der öffentlichen
          // Discovery übernehmen; bei Fehler lokaler Default.
          const initResult = localInitializeResult();
          try {
            const pub = await fetchPublicDiscovery();
            if (pub && typeof pub === "object") {
              if (typeof pub.protocolVersion === "string")
                initResult.protocolVersion = pub.protocolVersion;
              initResult.serverInfo = {
                name: "knowmind",
                version:
                  typeof pub.version === "string" ? pub.version : VERSION,
              };
            }
          } catch {
            // offline → lokaler Default reicht für initialize.
          }
          write({ jsonrpc: "2.0", id: req.id ?? null, result: initResult });
          continue;
        }
        if (req.method === "tools/list") {
          try {
            const pub = await fetchPublicDiscovery();
            const tools = Array.isArray(pub?.tools) ? pub.tools : [];
            write({ jsonrpc: "2.0", id: req.id ?? null, result: { tools } });
          } catch (e) {
            write({
              jsonrpc: "2.0",
              id: req.id ?? null,
              error: {
                code: -32000,
                message: `Knowmind-Discovery nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`,
              },
            });
          }
          continue;
        }
        if (req.method === "prompts/list") {
          write({ jsonrpc: "2.0", id: req.id ?? null, result: { prompts: [] } });
          continue;
        }
        // tools/call & Co. brauchen einen Token → klare Fehlermeldung.
        write({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: {
            code: -32001,
            message: `Knowmind: ${auth.reason}`,
          },
        });
        continue;
      }

      if (!auth.ok && req.method !== "ping") {
        // Initialize (und alles weitere) FEHLSCHLAGEN lassen, damit der
        // MCP-Client „connected" nicht fälschlich anzeigt. Claude Code,
        // Codex und Cursor werten -32001 als harte Connection-Failure.
        write({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: {
            code: -32001,
            message: `Knowmind nicht verbunden: ${auth.reason}`,
          },
        });
        continue;
      }

      if (LOCAL_METHODS.has(req.method)) {
        if (req.method === "ping") {
          write({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
          continue;
        }
        // initialize: An den Server durchreichen und serverInfo / instructions /
        // capabilities aus der Server-Antwort übernehmen. Nur so erreichen die
        // serverseitigen `instructions` (der automatische Pflege-Hebel) den
        // MCP-Client. Bei Server-Fehler/Offline auf den lokalen Default
        // zurückfallen — Proxy-Charakter und Offline-Robustheit bleiben.
        let initResult = localInitializeResult();
        try {
          const upstreamInit = await forwardToServer("initialize", req.params);
          const serverResult =
            upstreamInit && typeof upstreamInit === "object" && "result" in upstreamInit
              ? upstreamInit.result
              : null;
          if (serverResult && typeof serverResult === "object") {
            initResult = {
              // protocolVersion vom Server, sonst lokaler Default.
              protocolVersion: serverResult.protocolVersion ?? initResult.protocolVersion,
              // serverInfo vom Server (Name/Version aus zentraler Quelle), sonst lokal.
              serverInfo: serverResult.serverInfo ?? initResult.serverInfo,
              // capabilities vom Server, sonst lokal.
              capabilities: serverResult.capabilities ?? initResult.capabilities,
              // instructions NUR übernehmen, wenn der Server sie liefert.
              ...(typeof serverResult.instructions === "string"
                ? { instructions: serverResult.instructions }
                : {}),
            };
          }
        } catch (e) {
          // Server nicht erreichbar o.Ä. → lokaler Default. Der Client soll trotzdem
          // initialisieren können; Tool-Calls scheitern dann ohnehin mit klarer Meldung.
          process.stderr.write(
            `[knowmind] initialize-Forward fehlgeschlagen, lokaler Default: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
        write({ jsonrpc: "2.0", id: req.id ?? null, result: initResult });
        continue;
      }

      // Alles andere (tools/list, tools/call, prompts/list, prompts/get, …)
      // geht 1:1 an den Server — Definitionen bleiben dadurch immer synchron.
      const upstream = await forwardToServer(req.method, req.params);
      // Upstream-Response hat eigene jsonrpc/id-Felder — die müssen durch
      // die Client-id ersetzt werden, damit der Client korrekt zuordnet.
      const response = {
        jsonrpc: "2.0",
        id: req.id ?? null,
      };
      if (upstream && typeof upstream === "object" && "result" in upstream) {
        response.result = upstream.result;
      } else if (upstream && typeof upstream === "object" && "error" in upstream) {
        response.error = upstream.error;
      } else {
        response.result = upstream;
      }
      write(response);
    } catch (e) {
      write({
        jsonrpc: "2.0",
        id: req?.id ?? null,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}
