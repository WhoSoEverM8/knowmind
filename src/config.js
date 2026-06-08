/**
 * Knowmind-CLI Konfiguration.
 *
 * Lese-Reihenfolge:
 *   1. ENV (KNOWMIND_API_URL, KNOWMIND_TOKEN)
 *   2. ~/.knowmind/config.json
 *   3. Defaults
 *
 * Sicherheits-Garantien beim Schreiben:
 *   - Unix: chmod 600 auf config.json und 700 auf dem Ordner
 *   - Windows: aktive NTFS-ACL via icacls — nur der aktuelle User, SYSTEM
 *     und Administratoren behalten Zugriff. Das ist nötig, weil Node auf
 *     Windows `mode: 0o600` ignoriert.
 *   - Beim Start löschen wir Backup-Files (`config.json.bak*`,
 *     `config.json.sc-backup`), die frühere Versionen hinterlassen haben.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir, userInfo, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_API = "https://knowmind.de";
const CONFIG_DIR = join(homedir(), ".knowmind");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function _readPackageVersion() {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = _readPackageVersion();

/**
 * Löscht alle `config.json.bak*`- und `config.json.sc-backup`-Files im
 * Knowmind-Konfig-Ordner. Frühere CLI-Versionen haben solche Backups
 * geschrieben, die den Token in Klartext-Kopien hinterlassen haben.
 */
function _purgeStaleBackups() {
  if (!existsSync(CONFIG_DIR)) return;
  try {
    for (const entry of readdirSync(CONFIG_DIR)) {
      if (
        entry.startsWith("config.json.bak") ||
        entry === "config.json.sc-backup"
      ) {
        try {
          unlinkSync(join(CONFIG_DIR, entry));
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // best effort
  }
}

/**
 * Windows: NTFS-ACL hart auf den aktuellen User + SYSTEM + Administratoren
 * beschränken. Vererbung deaktiviert. Auf Unix ist `chmod` ausreichend.
 */
function _lockdown(target) {
  if (platform() !== "win32") return;
  try {
    const user = userInfo().username;
    // /reset alleine reicht nicht — die geerbten Berechtigungen müssen weg.
    spawnSync("icacls", [target, "/inheritance:r"], { stdio: "ignore" });
    spawnSync("icacls", [target, "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
    spawnSync("icacls", [target, "/grant:r", "SYSTEM:(OI)(CI)F"], { stdio: "ignore" });
    spawnSync("icacls", [target, "/grant:r", "Administratoren:(OI)(CI)F"], {
      stdio: "ignore",
    });
    // EN-Variante als Fallback (icacls akzeptiert beide nur in jeweiliger Locale)
    spawnSync("icacls", [target, "/grant:r", "Administrators:(OI)(CI)F"], {
      stdio: "ignore",
    });
  } catch {
    // best effort — wenn icacls fehlt, fallen wir auf Standard-NTFS zurück
  }
}

export function loadConfig() {
  _purgeStaleBackups();
  let fileConfig = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      /* corrupt — ignore */
    }
  }
  return {
    apiUrl: process.env.KNOWMIND_API_URL ?? fileConfig.apiUrl ?? DEFAULT_API,
    token: process.env.KNOWMIND_TOKEN ?? fileConfig.token ?? null,
  };
}

export function saveConfig(partial) {
  const merged = { ...loadConfig(), ...partial };
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    _lockdown(CONFIG_DIR);
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  _lockdown(CONFIG_DIR);
  _lockdown(CONFIG_FILE);
  return CONFIG_FILE;
}

export function configPath() {
  return CONFIG_FILE;
}
