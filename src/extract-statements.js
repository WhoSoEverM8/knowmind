/**
 * Pre-Ingest-Extraktor für Preference-, Fact- und Update-Statements.
 *
 * Knowmind-CLI ergänzt jedes Upload um kurze, getaggte Zusatz-Chunks aus
 * dem User-Anteil des Textes. Die Recall-Pipeline auf dem Server boostet
 * diese Chunks gezielt, wenn die spätere Query nach genau diesem Statement-
 * Typ fragt (siehe services/memory/app/recall_pipeline.py:fuse_and_rerank).
 *
 * Bewusst Regex statt LLM:
 *   - Reproduzierbar — kein Zufalls-Output
 *   - Schnell — kein Round-Trip, keine API-Kosten
 *   - Funktioniert für die häufigsten Pattern in Englisch und Deutsch
 *
 * Spiegelt die Logik aus services/memory/app/extractor.py — wenn der CLI
 * die Extraction macht, läuft der Server-Fallback nicht doppelt.
 */

const PREFERENCE_PATTERNS = [
  /\b(i (?:really )?(?:prefer|love|like|enjoy|adore|fancy)\b[^.!?]{4,200})/gi,
  /\b(i (?:am|'m) into\b[^.!?]{4,200})/gi,
  /\b(my (?:favou?rite|preferred)\b[^.!?]{4,200})/gi,
  /\b(i (?:can'?t stand|hate|dislike|despise|avoid)\b[^.!?]{4,200})/gi,
  /\b(i (?:always|usually|never|tend to)\b[^.!?]{4,200})/gi,
  /\b(i (?:want|need|would like|wish|hope) to\b[^.!?]{4,200})/gi,
  /\b(ich (?:mag|liebe|bevorzuge|hasse|vermeide)\b[^.!?]{4,200})/gi,
  /\b(mein lieblings\b[^.!?]{4,200})/gi,
  /\b(ich (?:bin|möchte|will)\b[^.!?]{4,200})/gi,
];

const FACT_PATTERNS = [
  /\b(i (?:am|'m) (?:a|an|the)\b[^.!?]{4,150})/gi,
  /\b(i (?:live|work|grew up|was born) (?:in|at|near|as)\b[^.!?]{4,200})/gi,
  /\b(my (?:name|age|job|wife|husband|partner|daughter|son|brother|sister|mother|father|dog|cat|car|home|house|apartment|address) (?:is|was|will be)\b[^.!?]{2,200})/gi,
  /\b(i have (?:a|an|two|three|four|five|six|seven|several|many)\b[^.!?]{4,200})/gi,
  /\b(i (?:work|worked) (?:at|for|with|as)\b[^.!?]{4,200})/gi,
  /\b(i'?(?:ve| have) been\b[^.!?]{4,200})/gi,
  /\b(i (?:graduated|studied|majored|earned|completed|finished|received|got|hold)\b[^.!?]{4,200})/gi,
  /\b(i (?:learned|trained|specialized|certified)\b[^.!?]{4,200})/gi,
  /\b(my (?:degree|major|education|background|profession|career|salary|company|employer|school|university|college|alma mater) (?:is|was|in)\b[^.!?]{2,200})/gi,
  /\b(i (?:weigh|measure) [0-9]+[^.!?]{0,80})/gi,
  /\b(my (?:weight|height|blood pressure|score|rate|count|record|target|budget|salary|rent|mortgage) (?:is|was|of) [^.!?]{2,150})/gi,
  /\b(i (?:set|achieved|finished|completed|won|reached) (?:a|an|the|my)?\s*(?:personal best|record|goal|milestone|time)\b[^.!?]{2,200})/gi,
  /\b(ich (?:bin|war|heiße|wohne|arbeite|lebe|studiere|studierte|wiege)\b[^.!?]{4,200})/gi,
  /\b(mein (?:name|alter|beruf|haus|auto|hund|katze|partner|gewicht|gehalt|abschluss|studium) (?:ist|war)\b[^.!?]{2,200})/gi,
];

const UPDATE_PATTERNS = [
  /\b(actually,?\s[^.!?]{4,200})/gi,
  /\b(i (?:changed my mind|no longer|don'?t .* anymore)\b[^.!?]{4,200})/gi,
  /\b((?:now|recently|since) i (?:prefer|like|love|work|live|use)\b[^.!?]{4,200})/gi,
  /\b(i (?:moved|switched|changed) to\b[^.!?]{4,200})/gi,
  /\b(inzwischen (?:bevorzuge|mag|wohne|arbeite) ich\b[^.!?]{4,200})/gi,
  /\b(ich habe (?:gewechselt|umgezogen|gekündigt)\b[^.!?]{4,200})/gi,
];

const USER_MARKER = /^\s*(?:\[user\]|user\s*:|frage\s*:)/i;
const ROLE_MARKER = /^\s*(?:\[[a-z_]+\]|[a-z_]+\s*:)/i;

/**
 * Liefert nur den User-Anteil eines Chat-Logs. Wenn keine Rollen-Markierung
 * vorkommt (klassische Markdown-Notiz), wird der gesamte Text behandelt.
 */
function extractUserBlocks(text) {
  if (!ROLE_MARKER.test(text)) return text;
  const out = [];
  let currentRole = null;
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    if (USER_MARKER.test(line)) {
      if (currentRole === "user" && buf.length) out.push(buf.join("\n"));
      currentRole = "user";
      buf = [];
    } else if (ROLE_MARKER.test(line)) {
      if (currentRole === "user" && buf.length) out.push(buf.join("\n"));
      currentRole = "other";
      buf = [];
    } else if (currentRole === "user") {
      buf.push(line);
    }
  }
  if (currentRole === "user" && buf.length) out.push(buf.join("\n"));
  return out.join("\n");
}

/**
 * Findet alle Statements im User-Anteil. Liefert [{text, type}], wobei type
 * ∈ {preference, fact, update}.
 */
export function extractUserStatements(text) {
  if (!text || !text.trim()) return [];
  const userText = extractUserBlocks(text);
  if (!userText.trim()) return [];

  const out = [];
  const seen = new Set();

  const groups = [
    ["preference", PREFERENCE_PATTERNS],
    ["fact", FACT_PATTERNS],
    ["update", UPDATE_PATTERNS],
  ];

  for (const [type, patterns] of groups) {
    for (const pat of patterns) {
      const matches = userText.matchAll(pat);
      for (const m of matches) {
        const start = m.index;
        let end = m.index + m[0].length;
        const tail = userText.slice(end, end + 180);
        const stop = tail.search(/[.!?]/);
        if (stop !== -1) end += stop + 1;
        const snippet = userText.slice(start, end).trim().replace(/\s+/g, " ");
        const key = snippet.toLowerCase();
        if (snippet.length >= 8 && snippet.length <= 280 && !seen.has(key)) {
          out.push({ text: snippet, type });
          seen.add(key);
        }
      }
    }
  }
  return out;
}

/**
 * Konstruiert Pre-Ingest-Zusatz-Chunks aus dem Roh-Text.
 * Liefert {content, metadata}-Paare. Hard cap maxChunks pro Dokument.
 */
export function synthChunks(text, maxChunks = 24) {
  const statements = extractUserStatements(text).slice(0, maxChunks);
  return statements.map(({ text: snippet, type }) => ({
    content: `[${type}] ${snippet}`,
    metadata: { type, extracted: true },
  }));
}
