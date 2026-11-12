/**
 * Is a message for the basefyio assistant at all?
 *
 * The old pre-filter was an English keyword list, so "Bu projede hangi
 * tablolar var?" was refused while "Which tables exist?" was answered. This
 * check never refuses on its own. It answers 'in' when the message is
 * recognisably about the product or the project (in any of the languages
 * people use here, or by naming the project's own tables), and 'unsure'
 * otherwise. An 'unsure' message goes to a short model call that judges scope
 * in whatever language it was written in — so a missing keyword can no longer
 * turn a legitimate question away.
 */

export type ScopeVerdict = 'in' | 'unsure';

export interface ScopeContext {
  /** Names of the caller's team projects. */
  projectNames?: string[];
  /** Table names of the active project. */
  tableNames?: string[];
  /** The conversation already has turns (a follow-up like "yes, do it"). */
  hasHistory?: boolean;
}

/**
 * Stems in English, Turkish, German, Spanish, French, Portuguese and Italian.
 * Matched against word starts, so "tablo" covers "tablolar", "tablosuna".
 * Turkish dotted/dotless i are folded before matching.
 */
const PRODUCT_STEMS = [
  // product + project
  'basefyio', 'project', 'proje', 'projekt', 'proyect', 'projet', 'progett', 'dashboard', 'panel', 'team', 'takım', 'takim', 'ekip',
  // database
  'database', 'veritaban', 'veri taban', 'datenbank', 'base de datos', 'banco de dados', 'base de données', 'base de donnees',
  'postgres', 'sql', 'table', 'tablo', 'tabelle', 'tabla', 'tabel', 'column', 'kolon', 'sütun', 'sutun', 'spalte', 'columna', 'colonne',
  'row', 'satır', 'satir', 'zeile', 'fila', 'ligne', 'record', 'kayıt', 'kayit', 'registro', 'enregistrement',
  'query', 'sorgu', 'abfrage', 'consulta', 'requête', 'requete', 'index', 'indeks', 'schema', 'şema', 'sema', 'esquema',
  'migration', 'migrasyon', 'geçiş', 'gecis', 'join', 'select', 'insert', 'update', 'delete', 'trigger', 'tetikleyici',
  'function', 'fonksiyon', 'funktion', 'función', 'funcion', 'view', 'görünüm', 'gorunum', 'constraint', 'kısıt', 'kisit',
  'foreign key', 'primary key', 'yabancı anahtar', 'birincil anahtar', 'data', 'veri', 'daten', 'datos', 'données', 'donnees', 'dados',
  // security
  'rls', 'row level', 'policy', 'policies', 'politika', 'politik', 'richtlinie', 'política', 'politica', 'güvenlik', 'guvenlik',
  'security', 'sicherheit', 'seguridad', 'sécurité', 'permission', 'yetki', 'izin', 'role', 'rol',
  // auth
  'auth', 'kimlik', 'oturum', 'giriş', 'giris', 'login', 'sign in', 'sign up', 'kayıt ol', 'üye', 'uye', 'user', 'kullanıcı', 'kullanici',
  'benutzer', 'usuario', 'utilisateur', 'password', 'şifre', 'sifre', 'parola', 'jwt', 'token', 'oauth', 'sso', 'mfa',
  // platform features
  'storage', 'depolama', 'dosya', 'file', 'datei', 'archivo', 'fichier', 'bucket', 'upload', 'yükle', 'yukle',
  'backup', 'yedek', 'sicherung', 'respaldo', 'sauvegarde', 'restore', 'geri yükle', 'export', 'dışa aktar', 'disa aktar',
  'import', 'içe aktar', 'ice aktar', 'realtime', 'gerçek zaman', 'gercek zaman', 'echtzeit', 'tiempo real', 'temps réel',
  'flow', 'akış', 'akis', 'workflow', 'webhook', 'cron', 'embedding', 'vektör', 'vektor', 'vector', 'pgvector', 'nosql', 'collection', 'koleksiyon',
  'api', 'endpoint', 'rest', 'sdk', 'cli', 'key', 'anahtar', 'schlüssel', 'clave', 'clé', 'cle',
  'billing', 'fatura', 'ödeme', 'odeme', 'abonelik', 'subscription', 'rechnung', 'factura', 'facture', 'plan', 'quota', 'kota',
  'log', 'audit', 'denetim', 'trace', 'alert', 'uyarı', 'uyari', 'error', 'hata', 'fehler', 'erreur',
  'connection', 'bağlantı', 'baglanti', 'verbindung', 'conexión', 'conexion', 'pgbouncer', 'branch', 'dal',
];

/** Lower-case and fold Turkish İ/I/ı so "İndeks" and "indeks" match alike. */
export function foldText(s: string): string {
  return s.replace(/İ/g, 'i').replace(/I/g, 'ı').toLocaleLowerCase('tr').replace(/ı/g, 'i');
}

const FOLDED_STEMS = Array.from(new Set(PRODUCT_STEMS.map(foldText)));

/** Something that reads like SQL: a statement verb followed by its clause word. */
const SQL_SHAPE = /\b(select\b[\s\S]*\bfrom|insert\s+into|update\b[\s\S]*\bset|delete\s+from|create\s+(table|index|policy|view|function)|alter\s+table|drop\s+(table|index|policy))\b/i;

function startsWord(haystack: string, needle: string): boolean {
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx === 0 ? ' ' : haystack[idx - 1];
    if (!/[\p{L}\p{N}_]/u.test(before)) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

/** Table-name tokens worth matching: "qa_e2e_ai_posts" → qa_e2e_ai_posts, posts. */
function tableTokens(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const n = foldText(name);
    if (n.length >= 3) out.add(n);
    for (const part of n.split(/[_\s.-]+/)) if (part.length >= 4) out.add(part);
  }
  return [...out];
}

export function quickScope(message: string, ctx: ScopeContext = {}): ScopeVerdict {
  const m = foldText(message);
  if (!m.trim()) return 'unsure';
  if (ctx.hasHistory) return 'in';
  if (SQL_SHAPE.test(message)) return 'in';
  if (FOLDED_STEMS.some((stem) => startsWord(m, stem))) return 'in';
  if ((ctx.projectNames ?? []).some((p) => p.trim().length >= 2 && m.includes(foldText(p.trim())))) return 'in';
  if (tableTokens(ctx.tableNames ?? []).some((t) => startsWord(m, t))) return 'in';
  return 'unsure';
}

/**
 * System prompt for the scope judge used on 'unsure' messages. It answers IN,
 * or with one short refusal written in the user's own language.
 */
export const SCOPE_JUDGE_PROMPT = `You decide whether a message is for the basefyio assistant.
basefyio is a hosted backend platform: PostgreSQL databases, SQL, row level security, authentication, storage, realtime, NoSQL collections, flows, embeddings/pgvector, backups, import/export, API keys, billing and team management.

A message is IN when it is about any of these, about the user's project, data, tables, code that talks to the project, or software/database work in general, or when it is a greeting or a follow-up in a conversation about them.
Otherwise it is OUT (for example: recipes, poems, homework unrelated to software, general trivia).

Reply with exactly IN for an IN message.
For an OUT message, reply with one short, friendly sentence in the same language as the message, saying you can only help with basefyio and the user's projects.`;

/** Interpret the judge's reply. Unclear answers count as IN — refusing a real question is the worse error. */
export function parseScopeJudgement(reply: string): { inScope: boolean; refusal: string | null } {
  const text = reply.trim();
  if (!text || /^["'`*\s]*IN\b/i.test(text) || text.length < 4) return { inScope: true, refusal: null };
  return { inScope: false, refusal: text.slice(0, 300) };
}
