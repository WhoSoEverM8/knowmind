/**
 * `knowmind sync <directory>` — synchronisiert einen lokalen Ordner mit dem
 * Knowmind-Korpus. Idempotent: bereits hochgeladene und unveränderte Dateien
 * werden über einen Manifest-Vergleich übersprungen.
 *
 * Manifest: `<directory>/.knowmind-manifest.json`
 *   { "files": { "<relpath>": { sha256, documentId, lastSync } },
 *     "version": 1 }
 *
 * Server-seitige Dedup (HTTP 200 + duplicate:true) wird als Erfolg behandelt
 * und das Manifest aktualisiert.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { uploadDocument } from "./client.js";

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".txt"];
const MANIFEST_NAME = ".knowmind-manifest.json";
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build",
  ".venv", "venv", "__pycache__", ".cache",
]);
// Reine Navigations-/Index-Dateien sind KEIN Recall-Ziel: ihre Einzeiler-Hooks
// matchen schwach fast jede Query und verdrängen die echten Detail-Dokumente.
// MEMORY.md änderte sich bei jedem Memory-Write → der Sync legte jedes Mal ein
// NEUES Dokument an (kein Replace), Ergebnis waren 24 Versionen / 1224 Chunks
// (~38 % des Stores). Index-Dateien werden daher nie synchronisiert.
const IGNORE_FILES = new Set(["MEMORY.md"]);

function* walk(root, exts) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      yield* walk(full, exts);
    } else if (e.isFile()) {
      if (IGNORE_FILES.has(e.name)) continue;
      const ext = extname(e.name).toLowerCase();
      if (exts.includes(ext)) yield full;
    }
  }
}

function sha256(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function loadManifest(path) {
  if (!existsSync(path)) return { version: 1, files: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && data.version === 1 && data.files ? data : { version: 1, files: {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function saveManifest(path, manifest) {
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function deriveTitle(content, filePath) {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const m2 = content.match(/^name:\s*([^\n\r]+)$/m);
  if (m2) return m2[1].trim();
  return basename(filePath, extname(filePath));
}

export async function syncDirectory(dir, options = {}) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Verzeichnis nicht gefunden: ${dir}`);
  }
  const exts = options.extensions ?? DEFAULT_EXTENSIONS;
  const manifestPath = join(dir, MANIFEST_NAME);
  const manifest = loadManifest(manifestPath);

  const files = [...walk(dir, exts)].sort();
  const total = files.length;
  let scanned = 0;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  console.log(`Knowmind sync: ${total} Dateien in ${dir}`);

  for (const file of files) {
    scanned += 1;
    const rel = relative(dir, file).replace(/\\/g, "/");
    if (basename(file) === MANIFEST_NAME) continue;
    const content = readFileSync(file, "utf-8");
    const hash = sha256(content);
    const known = manifest.files[rel];

    if (known && known.sha256 === hash) {
      skipped += 1;
      if (options.verbose) console.log(`  skip  ${rel}`);
      continue;
    }

    const title = options.titleFromContent ? deriveTitle(content, file) : basename(file, extname(file));
    try {
      const result = await uploadDocument(title, content);
      uploaded += 1;
      manifest.files[rel] = {
        sha256: hash,
        documentId: result.id ?? null,
        lastSync: new Date().toISOString(),
        duplicate: Boolean(result.duplicate),
      };
      // Manifest regelmäßig zwischenspeichern, damit ein Abbruch mid-run
      // nicht alle Fortschritte verliert.
      if (uploaded % 10 === 0) saveManifest(manifestPath, manifest);
      const flag = result.duplicate ? "dup " : "new ";
      process.stdout.write(`  [${scanned}/${total}] ${flag} ${rel}\n`);
    } catch (e) {
      failed += 1;
      failures.push({ file: rel, error: e.message });
      process.stderr.write(`  [${scanned}/${total}] FAIL ${rel} — ${e.message}\n`);
    }
  }

  saveManifest(manifestPath, manifest);
  console.log(`\nFertig: ${uploaded} hochgeladen, ${skipped} unverändert, ${failed} fehlerhaft.`);
  if (failed > 0) {
    console.log(`Fehler-Übersicht (max 10):`);
    failures.slice(0, 10).forEach((f) => console.log(`  ${f.file}: ${f.error}`));
    return { uploaded, skipped, failed, failures };
  }
  return { uploaded, skipped, failed, failures };
}
