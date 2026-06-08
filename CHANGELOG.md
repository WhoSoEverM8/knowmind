# Knowmind CLI — Änderungen

## 0.1.13 (2026-06-08)

**Konsistenz**
- Der MCP-Server meldet im `initialize`-Handshake jetzt die echte Paketversion
  (`serverInfo.version` = `VERSION` aus package.json) statt eines hartcodierten,
  veralteten Werts. Damit sind npm-Version, Server-Selbstauskunft, Hermes-Pin und
  das `server.json` der MCP-Registry identisch — eine Quelle der Wahrheit.

## 0.1.12 (2026-06-08)

**MCP-Registry-Reife**
- `package.json` um `mcpName` (`io.github.whosoeverm8/knowmind`) und `repository`
  ergänzt — Voraussetzung für die offizielle MCP-Registry
  (registry.modelcontextprotocol.io) und damit für PulseMCP, Glama, die
  GitHub-MCP-Registry (VS Code/Cursor) u. a.
- `server.json` (MCP-Registry-Manifest, Schema 2025-12-11) hinzugefügt.

**Sync-Korrektur (war 0.1.11, nie publiziert)**
- `knowmind sync` ignoriert jetzt reine Index-/Navigationsdateien (`MEMORY.md`).
  Diese änderten sich bei jedem Memory-Write und legten beim Sync jedes Mal ein
  NEUES Dokument an (kein Replace) — bis zu 24 Versionen / 1224 Chunks (~38 % des
  Stores), die mit schwachen Einzeiler-Hooks die echten Detail-Dokumente aus dem
  Recall verdrängten. Index-Dateien werden nicht mehr synchronisiert.

## 0.1.10 (2026-05-22)

**Install-Sauberkeit**
- Deprecation-Warnung `boolean@3.2.0 is no longer supported` beim Install
  beseitigt. Ursache war `onnxruntime-node → global-agent@3.0.0 → boolean`.
  Per npm-`overrides` wird `global-agent@^4.1.3` erzwungen, das die
  veraltete `boolean`/`roarr`-Kette nicht mehr braucht. `npm install -g
  knowmind` läuft jetzt ohne Warnungen durch.

## 0.1.9 (2026-05-22)

**Neuer Befehl**
- `knowmind sync <dir>` synchronisiert einen lokalen Ordner mit dem
  Knowmind-Korpus. Idempotent über Content-Hash, Manifest in
  `<dir>/.knowmind-manifest.json`. Wiederholte Aufrufe übertragen nur das
  Delta. Optional `--ext .md,.txt`, `--verbose`, `--title-from-content`.

**Korrekturen**
- Upload-Fehlerpfad gehärtet: leere oder ungültige Server-Antworten werfen
  jetzt eine sprechende Fehlermeldung statt eines kryptischen
  „Unexpected end of JSON input" (siehe `src/client.js`).
- Sichtbare CLI-Hilfe enthält den neuen `sync`-Befehl.

**Bekannte Punkte**
- `--watch` für `sync` (Datei-Beobachter mit Live-Upload) ist vorgesehen,
  aber noch nicht implementiert.
