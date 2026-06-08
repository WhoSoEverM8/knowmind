# knowmind

**Das Agentengehirn aus Deutschland.** Langzeitgedächtnis und Wissensgraph für Ihre KI —
CLI + MCP-Server. Inhalte und Server in Deutschland (Hetzner-Rechenzentrum).

<!-- mcp-name: io.github.Schubeler-Consulting/knowmind -->

[![npm](https://img.shields.io/npm/v/knowmind)](https://www.npmjs.com/package/knowmind) · Apache-2.0 · [knowmind.de](https://knowmind.de)

## Installation

```
npm install -g knowmind
```

Oder ohne Installation direkt als MCP-Server: `npx -y knowmind mcp`

## Setup

1. Token auf knowmind.de anlegen: Dashboard → API-Tokens
2. Lokal speichern:

```
knowmind login --token kmt_xxxxxxxx
```

Alternativ über ENV:

```
export KNOWMIND_TOKEN=kmt_xxxxxxxx
export KNOWMIND_API_URL=https://knowmind.de
```

## Befehle

```
knowmind search "Wo läuft die OKR-App?"
knowmind upload notizen.md --title "Meeting Notizen 2026-05-12"
knowmind stats
knowmind health
knowmind config
```

## MCP-Server einrichten

knowmind ist ein MCP-Server (`npx -y knowmind mcp`, stdio). Token aus dem knowmind.de-Dashboard
(→ API-Tokens) als `KNOWMIND_TOKEN`; optional `KNOWMIND_API_URL` (Standard `https://knowmind.de`).

**Claude Code**
```
claude mcp add knowmind --env KNOWMIND_TOKEN=kmt_xxx --env KNOWMIND_API_URL=https://knowmind.de -- npx -y knowmind mcp
```

**Claude Desktop / Cursor / Windsurf / Cline / Continue / Goose / Zed** (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …)
```json
{
  "mcpServers": {
    "knowmind": {
      "command": "npx",
      "args": ["-y", "knowmind", "mcp"],
      "env": { "KNOWMIND_TOKEN": "kmt_xxx", "KNOWMIND_API_URL": "https://knowmind.de" }
    }
  }
}
```
> Windows-Hinweis: falls `npx` nicht direkt startet, `"command": "cmd"`, `"args": ["/c", "npx", "-y", "knowmind", "mcp"]`.

**VS Code / GitHub Copilot** (`.vscode/mcp.json` — Top-Level `servers` + `inputs`)
```json
{
  "inputs": [{ "id": "knowmind_token", "type": "promptString", "description": "Knowmind API token", "password": true }],
  "servers": {
    "knowmind": {
      "command": "npx",
      "args": ["-y", "knowmind", "mcp"],
      "env": { "KNOWMIND_TOKEN": "${input:knowmind_token}", "KNOWMIND_API_URL": "https://knowmind.de" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)
```toml
[mcp_servers.knowmind]
command = "npx"
args = ["-y", "knowmind", "mcp"]
env = { KNOWMIND_TOKEN = "kmt_xxx", KNOWMIND_API_URL = "https://knowmind.de" }
```

**Gemini CLI** (`~/.gemini/settings.json`) — gleiche `mcpServers`-Struktur wie Claude Desktop.

**Remote (ohne lokale Installation)** — für Clients mit HTTP-MCP-Support direkt der gehostete Endpoint:
```json
{ "type": "http", "url": "https://knowmind.de/api/mcp/v1", "headers": { "Authorization": "Bearer kmt_xxx" } }
```

Token kann statt per `env` auch lokal via `knowmind login --token kmt_xxx` (→ `~/.knowmind/config.json`) hinterlegt werden.

## Tools (im MCP-Modus)

- `knowmind.recall` — Hybride Suche im Wissensspeicher des Mandanten
- `knowmind.store` — Neue Erinnerung anlegen (Titel + Inhalt)
- `knowmind.link` — Typisierte Beziehung zwischen zwei Erinnerungen anlegen (Inverse wird automatisch gesetzt)
- `knowmind.unlink` — Beziehung wieder entfernen (samt Inverse)
- `knowmind.relations` — Beziehungen einer Erinnerung auflisten
- `knowmind.stats` — Statistik über gespeicherte Erinnerungen und Beziehungen
- `knowmind.health` — Verfügbarkeits-Status der Plattform

Die zulässigen Beziehungstypen sind im Tool-Schema von `knowmind.link` als Enum hinterlegt — der Agent sieht sie direkt bei der Werkzeug-Auswahl. Inverse-Beziehungen (z. B. `IS_EMPLOYEE_OF` zu `HAS_EMPLOYEE`) werden serverseitig automatisch mit angelegt.

## Daten in Deutschland

knowmind ist das Agentengehirn aus Deutschland: Ihre Inhalte (Memories, Account- und Metadaten) werden
ausschließlich auf Servern in Deutschland (Hetzner-Rechenzentrum) gespeichert und verlassen Deutschland nicht.
Auftragsverarbeitung (AVV) nach Art. 28 DSGVO verfügbar: https://knowmind.de/legal/avv

**Hinweis (Bring-your-own-Key):** Wenn Sie eigene Schlüssel externer KI-Anbieter hinterlegen, werden Ihre
Anfragen direkt an den von Ihnen gewählten Anbieter übermittelt. Sitzt dieser außerhalb der EU, kann dabei
ein Drittlandtransfer stattfinden, für den Sie als Verantwortlicher zuständig sind.

## Haftung & Nutzung (Disclaimer)

- **Software:** Dieses Paket steht unter der **Apache-Lizenz 2.0** und wird „AS IS" ohne jegliche
  Gewährleistung bereitgestellt; die Haftung ist im Rahmen der Lizenz (Abschnitte 7 und 8)
  ausgeschlossen bzw. beschränkt. Siehe `LICENSE`.
- **Eigenes Konto, eigener Token:** knowmind bündelt keine Zugangsdaten. Sie nutzen Ihren eigenen
  knowmind.de-Account und API-Token. Anlegen: https://knowmind.de/dashboard/api-tokens
- **Eigene Kosten/Verbrauch:** Jede Nutzung (API-Anfragen, Token-/Kontingentverbrauch, ggf.
  modellbezogene Kosten) erfolgt über Ihren eigenen Account und auf Ihre Verantwortung. Verbrauch
  und Kosten sind im knowmind.de-Dashboard transparent einsehbar.
- **Service-Bedingungen:** Für die Nutzung der gehosteten Plattform gelten die AGB und die
  Datenschutzerklärung von knowmind.de:
  [AGB](https://knowmind.de/legal/agb) · [Datenschutz](https://knowmind.de/legal/datenschutz) ·
  [AVV](https://knowmind.de/legal/avv) · [Impressum](https://knowmind.de/legal/impressum)
- **Kein Einsatz in sicherheitskritischen Bereichen:** knowmind ist ein Gedächtnis-/Recall-Dienst und
  **nicht** für den Betrieb von selbstfahrenden Fahrzeugen, kritischer Infrastruktur, medizinischen oder
  lebenserhaltenden Systemen oder sonstigen Anwendungen bestimmt, bei denen ein Fehler oder Ausfall zu Tod,
  Personen-, Umwelt- oder schweren Sachschäden führen kann. Ein Einsatz in solchen Umgebungen erfolgt auf
  alleiniges Risiko des Nutzers.

Anbieter: Schübeler Consulting — Johann Jörgen Schübeler. Kontakt: info@schuebeler-consulting.de
