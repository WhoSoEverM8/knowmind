/**
 * Lokale Embedding-Berechnung im Client.
 *
 * Skalierungs-Pattern: Knowmind speichert + sucht, der Client rechnet
 * Embeddings selbst. Server-CPU bleibt frei, jeder Kunde bringt seine
 * eigene CPU mit.
 *
 * Modell: Xenova/multilingual-e5-large (1024d, mehrsprachig, ONNX-quantisiert).
 * Beim ersten Aufruf wird das Modell nach ~/.knowmind/models/ heruntergeladen
 * (rund 400 MB nach Komprimierung). Danach läuft alles offline.
 *
 * Wird nicht eager geladen — nur wenn der CLI tatsächlich einen
 * embedding-basierten Befehl ausführt (store, upload). recall, health
 * und stats brauchen das Modell nicht.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const MODEL_ID = process.env.KNOWMIND_EMBED_MODEL || "Xenova/multilingual-e5-large";
const TARGET_DIM = 1024;
const CHUNK_TARGET = 1200; // Zeichen pro Chunk — identisch zum Server-Default

const CACHE_DIR = join(homedir(), ".knowmind", "models");
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

let pipelinePromise = null;

async function loadPipeline() {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    // Cache-Verzeichnis explizit setzen — sonst landet das Modell in
    // unklaren Pfaden und der Cache wirkt nicht zwischen CLI-Aufrufen.
    env.cacheDir = CACHE_DIR;
    env.allowLocalModels = true;
    // ONNX-Quantisierte Variante laden — kleiner und auf CPU spürbar schneller.
    const extractor = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
    });
    return extractor;
  })();
  return pipelinePromise;
}

/** Modell explizit vorab laden — sinnvoll für CLI-Init oder lange Sessions. */
export async function warmup() {
  await loadPipeline();
  return { model: MODEL_ID, cacheDir: CACHE_DIR };
}

/**
 * Zerlegt Text in Chunks identisch zum Server-Default (1200 Zeichen).
 */
export function chunkText(text, size = CHUNK_TARGET) {
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    const seg = text.slice(i, i + size);
    if (seg.trim()) out.push(seg);
  }
  return out.length > 0 ? out : [""];
}

/**
 * Pre-Ingest-Pipeline: zerlegt Text in Standard-Chunks UND extrahiert
 * heuristisch Preference-/Fact-/Update-Statements als Zusatz-Chunks mit
 * metadata.type. Liefert {chunks: [{content, metadata?}]}, das direkt an
 * /api/documents geschickt werden kann.
 */
export async function prepareChunks(text) {
  const { synthChunks } = await import("./extract-statements.js");
  const baseChunks = chunkText(text).map((content) => ({ content }));
  const extras = synthChunks(text);
  return [...baseChunks, ...extras];
}

/**
 * Einzelnes Embedding für eine Query oder Passage.
 * mode='passage' (Default) prefixt mit "passage: ", 'query' mit "query: ".
 * Das ist Pflicht beim e5-Modell.
 */
export async function embed(text, mode = "passage") {
  const extractor = await loadPipeline();
  const prefix = mode === "query" ? "query: " : "passage: ";
  const out = await extractor(prefix + text, { pooling: "mean", normalize: true });
  const vec = Array.from(out.data);
  if (vec.length !== TARGET_DIM) {
    throw new Error(
      `Embedding-Dim ${vec.length} ≠ erwartet ${TARGET_DIM}. Modell stimmt nicht.`,
    );
  }
  return vec;
}

/**
 * Batch-Embedding für mehrere Passagen.
 * Wenn der Aufrufer eine ganze Notiz mit vielen Chunks hat, soll er das
 * in einem Schwung machen, damit das Modell die Inferenz batched.
 */
export async function embedBatch(texts, mode = "passage") {
  if (!texts || texts.length === 0) return [];
  const extractor = await loadPipeline();
  const prefix = mode === "query" ? "query: " : "passage: ";
  const inputs = texts.map((t) => prefix + t);
  const out = await extractor(inputs, { pooling: "mean", normalize: true });
  // out.dims = [batch, dim]
  const dim = out.dims[1];
  if (dim !== TARGET_DIM) {
    throw new Error(`Embedding-Dim ${dim} ≠ erwartet ${TARGET_DIM}.`);
  }
  const data = Array.from(out.data);
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(data.slice(i * dim, (i + 1) * dim));
  }
  return vectors;
}

export const MODEL = MODEL_ID;
export const EMBED_DIM = TARGET_DIM;
