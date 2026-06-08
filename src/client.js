/**
 * Knowmind-API-Client.
 *
 * Spricht ausschließlich gegen den MCP-Endpoint /api/mcp/v1 (JSON-RPC),
 * weil dieser bereits Bearer-Auth + Tools für recall/stats/health bietet.
 * Document-Upload geht zusätzlich gegen die REST-API /api/documents.
 */
import { loadConfig } from "./config.js";

let rpcId = 1;

async function rpc(method, params, options = {}) {
  const { apiUrl, token } = loadConfig();
  if (!token) throw new Error("Kein Token konfiguriert — bitte `knowmind login` ausführen.");
  const r = await fetch(`${apiUrl}/api/mcp/v1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal: options.signal,
  });
  const data = await r.json();
  if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data.result;
}

export async function recall(query, { k = 5, hops = 2 } = {}) {
  const res = await rpc("tools/call", {
    name: "knowmind.recall",
    arguments: { query, k, hops },
  });
  // MCP-Antwort: { content: [{ type: "text", text: "<JSON>" }] }
  const text = res.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

export async function stats() {
  const res = await rpc("tools/call", { name: "knowmind.stats", arguments: {} });
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

export async function health() {
  const res = await rpc("tools/call", { name: "knowmind.health", arguments: {} });
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

/**
 * Lädt ein Dokument hoch. Default-Pfad: Client rechnet die Embeddings
 * lokal und schickt sie mit — der Server speichert nur noch, ohne eigene
 * Berechnung. Skaliert deutlich besser.
 *
 * Wird KNOWMIND_EMBED_MODE=server gesetzt, geht der alte Pfad: Server
 * rechnet selbst. Sinnvoll als Fallback, wenn der Client kein Modell
 * laden kann (z. B. RAM-knapp).
 */
export async function uploadDocument(title, content) {
  const { apiUrl, token } = loadConfig();
  if (!token) throw new Error("Kein Token konfiguriert.");

  const mode = (process.env.KNOWMIND_EMBED_MODE || "client").toLowerCase();
  let body;
  if (mode === "client") {
    try {
      const { prepareChunks, embedBatch, MODEL } = await import("./local-embedding.js");
      // prepareChunks zerlegt Text in Standard-Chunks UND extrahiert
      // Preference-/Fact-/Update-Statements als Zusatz-Chunks mit type-Tag.
      // Recall-Server boostet die getaggten Chunks für passende Queries.
      const prepared = await prepareChunks(content);
      const vectors = await embedBatch(prepared.map((c) => c.content), "passage");
      body = {
        title,
        content,
        chunks: prepared.map((c, i) => ({
          content: c.content,
          embedding: vectors[i],
          ...(c.metadata ? { metadata: c.metadata } : {}),
        })),
        embeddingModel: MODEL,
      };
    } catch (err) {
      process.stderr.write(
        `[knowmind] lokales Embedding fehlgeschlagen, fallback auf Server: ${err.message}\n`,
      );
      body = { title, content };
    }
  } else {
    body = { title, content };
  }

  const r = await fetch(`${apiUrl}/api/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText} — ${text.slice(0, 200)}`);
    }
    throw new Error(`HTTP ${r.status} lieferte ungültiges JSON: ${text.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status} ${r.statusText}`);
  return data;
}

export async function listTools() {
  return await rpc("tools/list", {});
}
