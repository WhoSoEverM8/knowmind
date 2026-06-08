/**
 * Lokaler MCP-Stdio-Server.
 *
 * Forwarded JSON-RPC-Requests von stdin an die Knowmind-Plattform (HTTP-MCP)
 * und schreibt die Antworten auf stdout. Damit kann Knowmind in jeden lokalen
 * MCP-fähigen Client (Claude Code, ChatGPT-Desktop, Cursor, ...) eingebunden
 * werden, ohne dass der Client Bearer-Token kennen muss — der CLI-Wrapper
 * verwaltet die Auth.
 *
 * Protokoll: stdio mit zeilenweise JSON (NDJSON-Style). Jedes Frame ist ein
 * vollständiges JSON-RPC-Objekt.
 */
import { loadConfig, VERSION } from "./config.js";
import { createInterface } from "node:readline";

// Typisierte Beziehungen zwischen Erinnerungen. Diese Liste ist die einzige
// Quelle der Wahrheit für Agents. Inverse-Beziehungen werden serverseitig
// automatisch materialisiert — der Agent setzt nur die Vorwärtsrichtung.
const REL_TYPES = [
  "HAS_EMPLOYEE", "IS_EMPLOYEE_OF",
  "IS_LED_BY", "LEADS_ORGANIZATION",
  "OWNS", "OWNED_BY",
  "HAS_SKILL", "WORKS_ON", "FOR_CLIENT",
  "HAS_VERSION", "IS_VERSION_OF",
  "HAS_CHUNK", "CHUNK_OF",
  "HAS_EMBEDDING", "EMBEDDING_OF",
  "INDEXED_IN",
  "REFERENCES_ENTITY", "REFERENCED_BY",
  "PRODUCES", "PRODUCED_BY",
  "DEPENDS_ON", "ENABLES",
  "APPLIES_TO", "HAS_RULE",
  "REFERENCES", "SUPERSEDES", "SUPERSEDED_BY",
  "WAS_GENERATED_BY", "GENERATED",
  "USED", "USED_BY",
  "WAS_DERIVED_FROM", "DERIVATION_TARGET_OF",
  "WAS_ASSOCIATED_WITH",
  "MEASURED_METRIC",
];

const KNOWMIND_TOOLS = [
  {
    name: "knowmind.recall",
    description:
      "Hybride Suche im Knowmind-Wissensspeicher des aktuellen Mandanten. Liefert die passendsten Treffer mit Quellenverweis und Trefferqualität.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natürlichsprachliche Frage" },
        k: { type: "integer", minimum: 1, maximum: 25, default: 5 },
        hops: { type: "integer", minimum: 0, maximum: 3, default: 2 },
      },
      required: ["query"],
    },
  },
  {
    name: "knowmind.store",
    description:
      "Speichert eine neue Erinnerung im aktuellen Mandanten. Liefert die Dokument-ID und die Anzahl der indexierten Abschnitte zurück. Sofort über knowmind.recall auffindbar.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Kurzer Titel für die Erinnerung (max. 500 Zeichen)",
        },
        content: {
          type: "string",
          description: "Inhalt der Erinnerung als Text oder Markdown (max. 1 MB)",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "knowmind.link",
    description:
      "Legt eine typisierte Beziehung zwischen zwei Erinnerungen an. Die Gegen-Beziehung wird automatisch mit angelegt (zum Beispiel HAS_EMPLOYEE → IS_EMPLOYEE_OF). Der Agent setzt also nur die Vorwärtsrichtung. Verwende knowmind.recall, um zuvor die IDs zu finden.",
    inputSchema: {
      type: "object",
      properties: {
        fromId: { type: "string", description: "ID der Quell-Erinnerung" },
        toId: { type: "string", description: "ID der Ziel-Erinnerung" },
        relType: {
          type: "string",
          enum: REL_TYPES,
          description: "Beziehungstyp aus der zulässigen Liste",
        },
      },
      required: ["fromId", "toId", "relType"],
    },
  },
  {
    name: "knowmind.unlink",
    description:
      "Entfernt eine typisierte Beziehung. Die Gegen-Beziehung wird ebenfalls gelöscht.",
    inputSchema: {
      type: "object",
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        relType: { type: "string", enum: REL_TYPES },
      },
      required: ["fromId", "toId", "relType"],
    },
  },
  {
    name: "knowmind.relations",
    description:
      "Listet alle bestehenden Beziehungen einer Erinnerung. Hilfreich bevor neue Beziehungen angelegt werden, um Duplikate zu vermeiden.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "ID der Erinnerung" },
      },
      required: ["memoryId"],
    },
  },
  {
    name: "knowmind.health",
    description: "Service-Verfügbarkeit prüfen.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "knowmind.stats",
    description: "Statistik des aktuellen Mandanten (Anzahl Erinnerungen, Beziehungen).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "knowmind.update_fact",
    description:
      "Bi-temporales Update: ersetzt eine bestehende Erinnerung durch eine neue. Die alte Erinnerung bleibt im Audit-Log mit validTo=now und wird per SUPERSEDES-Beziehung mit der neuen verbunden — so bleibt die Historie nachvollziehbar. Verwende dies, wenn sich Fakten ändern (Adresse, Vertragsstatus, Personen).",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "ID der zu aktualisierenden Erinnerung" },
        newTitle: { type: "string", description: "Titel der neuen, gültigen Version" },
        newContent: { type: "string", description: "Inhalt der neuen Version" },
        updateReason: {
          type: "string",
          description: "Warum hat sich der Fakt geändert (z. B. 'Umzug', 'Vertrag erneuert')",
        },
      },
      required: ["targetId", "newTitle", "newContent"],
    },
  },
  {
    name: "knowmind.recall_at_time",
    description:
      "Recall mit Zeitfilter: liefert nur Erinnerungen, die zum gegebenen Zeitpunkt gültig waren. Antwort auf Fragen wie 'Was wussten wir am 14. März über den Kunden?' — der Knowmind-Vorteil gegenüber reinen Vector-Stores ohne Validity-Tracking.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natürlichsprachliche Frage" },
        asOf: {
          type: "string",
          description:
            "ISO-8601-Zeitstempel des Bezugszeitpunkts (Default: jetzt). Beispiel: '2026-03-14T00:00:00Z'",
        },
        k: { type: "integer", minimum: 1, maximum: 25, default: 5 },
      },
      required: ["query"],
    },
  },
];

/** Hilfsfunktion: ruft einen REST-Endpunkt mit Bearer-Token auf und verpackt
 *  die Antwort im MCP-Tool-Result-Format. */
async function restCall(apiUrl, token, path, init) {
  const r = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  let data;
  try {
    data = await r.json();
  } catch {
    data = { error: `HTTP ${r.status}` };
  }
  if (!r.ok) {
    return {
      error: {
        code: -32000,
        message: data.error ?? `HTTP ${r.status}`,
        data,
      },
    };
  }
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
    },
  };
}

async function callRestTool(apiUrl, token, name, args) {
  switch (name) {
    case "knowmind.store": {
      const { title, content } = args;
      if (!title || !content) {
        return {
          error: {
            code: -32602,
            message: "knowmind.store benötigt title und content.",
          },
        };
      }
      return await restCall(apiUrl, token, "/api/documents", {
        method: "POST",
        body: JSON.stringify({ title, content }),
      });
    }
    case "knowmind.link": {
      const { fromId, toId, relType } = args;
      if (!fromId || !toId || !relType) {
        return {
          error: {
            code: -32602,
            message: "knowmind.link benötigt fromId, toId, relType.",
          },
        };
      }
      return await restCall(apiUrl, token, "/api/graph/relations", {
        method: "POST",
        body: JSON.stringify({ fromId, toId, relType }),
      });
    }
    case "knowmind.unlink": {
      const { fromId, toId, relType } = args;
      if (!fromId || !toId || !relType) {
        return {
          error: {
            code: -32602,
            message: "knowmind.unlink benötigt fromId, toId, relType.",
          },
        };
      }
      const params = new URLSearchParams({ fromId, toId, relType });
      return await restCall(apiUrl, token, `/api/graph/relations?${params.toString()}`, {
        method: "DELETE",
      });
    }
    case "knowmind.relations": {
      const { memoryId } = args;
      if (!memoryId) {
        return {
          error: {
            code: -32602,
            message: "knowmind.relations benötigt memoryId.",
          },
        };
      }
      const params = new URLSearchParams({ memoryId });
      return await restCall(apiUrl, token, `/api/graph/relations?${params.toString()}`, {
        method: "GET",
      });
    }
    default:
      return {
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
  }
}

async function forwardToServer(method, params) {
  const { apiUrl, token } = loadConfig();
  if (!token)
    throw new Error("Knowmind: kein Token konfiguriert. `knowmind login` zuerst.");

  // Tools, die nicht über den MCP-Endpoint, sondern direkt gegen die
  // REST-Schnittstelle laufen (Anlegen + Graph-Beziehungen).
  if (
    method === "tools/call" &&
    params &&
    typeof params.name === "string" &&
    ["knowmind.store", "knowmind.link", "knowmind.unlink", "knowmind.relations"].includes(
      params.name,
    )
  ) {
    return await callRestTool(apiUrl, token, params.name, params.arguments ?? {});
  }

  const r = await fetch(`${apiUrl}/api/mcp/v1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return await r.json();
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
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
        params: { name: "knowmind.health", arguments: {} },
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
  // Auth einmal am Start prüfen. Das Ergebnis cachen — der MCP-Client
  // soll sofort beim initialize wissen, ob die Verbindung wirklich
  // steht.
  const auth = await probeAuth();
  if (!auth.ok) {
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
      switch (req.method) {
        case "initialize":
          if (!auth.ok) {
            // Initialize FEHLSCHLAGEN, damit der MCP-Client „connected"
            // nicht fälschlich anzeigt. Claude Code, Codex und Cursor
            // werten -32001 als harte Connection-Failure.
            write({
              jsonrpc: "2.0",
              id: req.id ?? null,
              error: {
                code: -32001,
                message: `Knowmind nicht verbunden: ${auth.reason}`,
              },
            });
            break;
          }
          write({
            jsonrpc: "2.0",
            id: req.id ?? null,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "knowmind", version: VERSION },
              capabilities: { tools: {} },
            },
          });
          break;
        case "tools/list":
          if (!auth.ok) {
            write({
              jsonrpc: "2.0",
              id: req.id ?? null,
              error: {
                code: -32001,
                message: `Knowmind nicht verbunden: ${auth.reason}`,
              },
            });
            break;
          }
          write({
            jsonrpc: "2.0",
            id: req.id ?? null,
            result: { tools: KNOWMIND_TOOLS },
          });
          break;
        case "tools/call": {
          if (!auth.ok) {
            write({
              jsonrpc: "2.0",
              id: req.id ?? null,
              error: {
                code: -32001,
                message: `Knowmind nicht verbunden: ${auth.reason}`,
              },
            });
            break;
          }
          const upstream = await forwardToServer(req.method, req.params);
          // Upstream-Response hat eigene jsonrpc/id-Felder — die müssen
          // durch die Client-id ersetzt werden, damit Claude Code, Codex
          // und Gemini ihre Anfragen korrekt zuordnen können.
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
          break;
        }
        default:
          write({
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          });
      }
    } catch (e) {
      write({
        jsonrpc: "2.0",
        id: req?.id ?? null,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}
