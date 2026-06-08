# Knowmind CLI — Änderungen

## 0.1.17 (2026-06-08)

**Rechts-Korrekturen (nach anwaltlicher Vorprüfung)**
- Datenresidenz-Aussage korrigiert: keine widersprüchliche Stadt-Angabe mehr, und der absolute
  Satz „verlassen den deutschen Rechtsraum nicht" um den **Bring-your-own-Key-Vorbehalt** ergänzt
  (bei eigenen US-Anbieter-Schlüsseln kann ein Drittlandtransfer stattfinden).
- **High-Risk-Ausschluss** ergänzt: knowmind ist nicht für selbstfahrende Fahrzeuge, kritische
  Infrastruktur oder lebenserhaltende/medizinische Systeme bestimmt; Einsatz dort auf eigenes Risiko.

## 0.1.16 (2026-06-08)

**Positionierung + rechtliche Absicherung**
- „Das Agentengehirn aus Deutschland" als Positionierung in README + npm/Registry-Beschreibung
  (Server in Deutschland, Hetzner/Nürnberg).
- Volle **Apache-2.0-Lizenz** in `LICENSE` (vorher nur 17-Zeilen-Header-Stub ohne die bindenden
  Abschnitte 7 Disclaimer of Warranty + 8 Limitation of Liability).
- **Haftung & Nutzung**-Abschnitt im README: „AS IS" ohne Gewährleistung, Bring-your-own-Token,
  eigener Verbrauch/eigene Kosten, Verweis auf AGB/Datenschutz/AVV/Impressum von knowmind.de.

## 0.1.15 (2026-06-08)

**Marken-Namensraum**
- Repo in die Organisation `Schubeler-Consulting` verschoben; MCP-Registry-Namespace
  von `io.github.WhoSoEverM8/knowmind` auf `io.github.Schubeler-Consulting/knowmind`
  (saubere, firmenkonforme Schreibweise). `mcpName`, `server.json` und `repository`
  entsprechend angepasst.

## 0.1.14 (2026-06-08)

**MCP-Registry-Namespace**
- `mcpName` auf die korrekte, case-sensitive Schreibweise `io.github.WhoSoEverM8/knowmind`
  gesetzt (muss dem GitHub-Benutzernamen exakt entsprechen, sonst lehnt die offizielle
  MCP-Registry den Publish mit 403 ab).

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
