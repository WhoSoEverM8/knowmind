# Knowmind CLI — Änderungen

## 0.1.22 (2026-06-11)

**Discovery-Modus ohne Token (Introspection-fähig)**
- Ist KEIN Token konfiguriert, beantwortet `knowmind mcp` jetzt `initialize`,
  `tools/list` und `prompts/list` über die ÖFFENTLICHE Server-Discovery
  (`GET /api/mcp/v1` — liefert Name, Version und alle Tool-Definitionen ohne
  Auth). Vorher schlugen ohne Token ALLE Requests inkl. `initialize` mit
  `-32001` fehl — Verzeichnis-Crawler (z. B. Glama) konnten den Server nicht
  inspizieren.
- `tools/call` verlangt weiterhin einen Token und verweist klar auf
  `knowmind login`. Ein konfigurierter, aber ungültiger Token führt unverändert
  zum harten Verbindungsfehler (kein falsches „connected ✓").
- Neu: `Dockerfile` im Repo (node:20-alpine, `knowmind mcp` als Entrypoint) —
  für Container-basierte Inspection/Nutzung.

## 0.1.21 (2026-06-10)

**Bugfix: `knowmind init`-Recall-Hook funktioniert jetzt auf Windows**
- Der von `knowmind init --client claude-code` erzeugte Recall-Hook rief die Plattform
  bisher über einen Subprozess auf (`spawnSync("npx.cmd", …)`). Auf Windows mit Node
  ≥ 18.20.2/20.12/21.6/22 wirft das `EINVAL` (Node-Härtung CVE-2024-27980 gegen das
  direkte Spawnen von `.cmd`/`.bat` ohne Shell) — der Hook feuerte dort nie. Gefunden im
  echten Claude-Code-Realtest.
- Fix: Der Hook ruft die Plattform jetzt per **direktem HTTPS-Call** (`fetch` gegen
  `/api/mcp/v1`, `tools/call knowmind_recall`) auf — kein Subprozess, kein npx-Kaltstart
  (Timeout 6 s, schneller), und **keine Command-Injection** mehr, weil die Nutzer-Frage
  als JSON-Body statt als Shell-Argument übergeben wird. Token/apiUrl aus ENV oder
  `~/.knowmind/config.json`. Treffer werden lesbar verdichtet ausgegeben (Titel + Score +
  Auszug). Weiterhin fail-open (jeder Fehler/kein Token → exit 0). SSE- und Plain-JSON-
  Antworten werden robust geparst.

## 0.1.20 (2026-06-10)

**MCP-`instructions` erreichen jetzt den Client (initialize wird durchgereicht)**
- `knowmind mcp` beantwortete `initialize` bisher lokal und unterschlug damit das
  serverseitige `instructions`-Feld. Der Proxy fragt `initialize` nun beim Server an und
  übernimmt `serverInfo` (Name/Version aus zentraler Quelle), `capabilities` und
  `instructions` aus der Server-Antwort. Damit liest jeder MCP-Client beim Verbinden die
  Memory-First-Betriebsanweisung des Servers — der client-übergreifende Pflege-Hebel
  OHNE manuelles Setup. Bei Server-Fehler/Offline fällt der Proxy auf den lokalen Default
  zurück (Proxy-Charakter + Offline-Robustheit bleiben).
- Serverseitig (knowmind.de) liefert das `initialize`-Result jetzt ein `instructions`-Feld
  (Recall-First + proaktives Speichern) sowie `serverInfo.version` aus einer einzigen Quelle.

**Neuer Befehl: `knowmind init` — automatische Gedächtnis-Pflege einrichten**
- `knowmind init [--client claude-code|cursor|auto] [--dry-run]` richtet die
  Memory-First-Automatik im KI-Client des Nutzers ein, ohne manuelles Hook-Gefrickel.
  Client wird am Projekt-/Home-Verzeichnis erkannt (`.claude/`, `.cursor/`, `~/.codex/`)
  oder explizit gewählt.
- **Claude Code:** schreibt projektlokale Hooks (`UserPromptSubmit` → `knowmind_recall`
  vor jeder Frage; `Stop` → Capture-Reminder, der an `knowmind_store_memory` erinnert,
  wenn die Runde Sicherungswürdiges enthielt) + einen Memory-First-Block in `./CLAUDE.md`.
  Die Hooks reden gegen die Plattform (`npx knowmind search` / die MCP-Tools), nicht
  gegen lokale `.md`-Dateien.
- **Cursor:** schreibt `.cursor/rules/knowmind.mdc` (Memory-First-Regel, `alwaysApply`).
- **Claude Desktop / Codex / generisch:** kein Hook-Mechanismus — zeigt den
  Memory-First-Text zum manuellen Einfügen und benennt die ehrliche Grenze (nur
  MCP-instructions + MCP-prompts wirken, keine harte Erzwingung).
- **Idempotent & nicht-destruktiv:** marker-/befehls-basierte Ersetzung
  (`<!-- BEGIN/END knowmind -->`); zweiter Lauf erzeugt keine Duplikate, fremde Dateien
  und Hooks bleiben unangetastet. `--dry-run` zeigt jede Aktion ohne zu schreiben.
- Tests in `src/init.test.js` (Idempotenz, Client-Erkennung, dry-run, Marker-Upsert).

## 0.1.19 (2026-06-10)

**CLI-Befehle repariert (search/stats/health/login)**
- `knowmind search`, `knowmind stats`, `knowmind health` und die Token-Verifikation in
  `knowmind login` riefen noch die alten Punkt-Tool-Namen (`knowmind.recall`, `knowmind.stats`,
  `knowmind.health`) auf — der Server kennt seit der MCP-Namensschema-Umstellung nur noch
  Unterstrich-Namen (`knowmind_recall`, …). Alle direkten Tool-Calls umgestellt; der
  `knowmind mcp`-Proxy war nicht betroffen (reicht seit 0.1.18 alles durch).

**Sync-Härtung**
- `knowmind sync` speichert das Manifest jetzt nach JEDEM erfolgreichen Upload statt in
  10er-Batches. Bricht der Prozess mitten im Lauf ab, gehen keine Manifest-Stände mehr
  verloren — identischer Inhalt wurde sonst beim nächsten Lauf endlos re-POSTet.
- Server-Antwort `unchanged:true` (sha-identischer Inhalt, historisch `duplicate:true`)
  wird in Manifest und Ausgabe sauber erkannt.

**Saubere Upload-Meldung**
- `knowmind upload` meldet bei unverändertem/dupliziertem Inhalt jetzt verständlich
  „Unverändert/Duplikat …" statt `undefined Chunks (Provider undefined)`.

**Doku**
- README: Tool-Liste auf die 11 Server-Tools aktualisiert (`knowmind_list_recent` ergänzt);
  `knowmind_upload_document` als Upsert-per-Titel beschrieben.

## 0.1.18 (2026-06-09)

**MCP-stdio als reiner Server-Proxy**
- `knowmind mcp` hält keine lokalen Tool-Definitionen mehr: `tools/list`, `tools/call`,
  `prompts/*` und alle weiteren Methoden werden 1:1 an den Remote-Endpoint
  (`/api/mcp/v1`) durchgereicht. Tool-Namen, Schemas und Safety-Annotations kommen
  direkt vom Server — eine Abweichung wie der Namens-Drift `knowmind.*` vs.
  `knowmind_*` (machte 0.1.17 gegen den aktualisierten Endpoint unbrauchbar) ist
  damit konstruktiv ausgeschlossen.
- `initialize` meldet die echte Paketversion; Notifications werden korrekt ignoriert.

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
