const fs = require('fs');
const path = require('path');

/**
 * Quick replies — stored under DATA_DIR so they survive panel/Docker restarts.
 * Seeds from repo-root quick-replies.json on first run.
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'quick-replies.json');
const BAK_PATH = path.join(DATA_DIR, 'quick-replies.json.bak');
const SEED_PATH = path.join(__dirname, 'quick-replies.json');

let cache = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWrite(filePath, contents) {
  ensureDataDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function loadSeed() {
  try {
    if (!fs.existsSync(SEED_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function tryParse(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty file');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : null;
  } catch (err) {
    const corrupt = `${file}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(file, corrupt); } catch { /* ignore */ }
    console.error(`${label} unreadable (${err.message}). Kept copy at ${corrupt}`);
    return null;
  }
}

function readFromDisk() {
  ensureDataDir();
  const primary = tryParse(DB_PATH, 'quick-replies.json');
  const backup = tryParse(BAK_PATH, 'quick-replies.json.bak');

  if (backup && (!primary || backup.length > primary.length)) {
    console.warn('⚠️  Restored quick-replies from .bak');
    atomicWrite(DB_PATH, JSON.stringify(backup, null, 2));
    try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch { /* ignore */ }
    return backup.map(r => ({ ...r }));
  }

  if (primary) return primary.map(r => ({ ...r }));

  // Migrate legacy repo-root file into DATA_DIR if present and richer than seed
  const legacy = tryParse(SEED_PATH, 'seed quick-replies.json') || loadSeed();
  const seed = legacy.length ? legacy : [];
  atomicWrite(DB_PATH, JSON.stringify(seed, null, 2));
  try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch { /* ignore */ }
  return seed.map(r => ({ ...r }));
}

function getList() {
  if (!cache) cache = readFromDisk();
  return cache;
}

function persist(list) {
  ensureDataDir();
  atomicWrite(DB_PATH, JSON.stringify(list, null, 2));
  try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch (err) {
    console.error('Failed to write quick-replies backup:', err.message);
  }
  cache = list.map(r => ({ ...r }));
}

/** Normalize a reply id: lowercase, letters/numbers/underscore only */
function normalizeId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
}

function getAll() {
  return getList().map(r => ({ ...r }));
}

function getById(id) {
  const key = normalizeId(id);
  const hit = getList().find(r => r.id === key);
  return hit ? { ...hit } : null;
}

/**
 * Add a quick reply.
 * @returns {{ ok: true, reply } | { ok: false, error: string }}
 */
function add(id, label, message) {
  const cleanId = normalizeId(id);
  if (!cleanId || cleanId.length < 2) {
    return { ok: false, error: 'ID must be at least 2 characters (letters, numbers, underscores).' };
  }
  if (!label || !String(label).trim()) {
    return { ok: false, error: 'Label is required.' };
  }
  if (!message || !String(message).trim()) {
    return { ok: false, error: 'Message is required.' };
  }
  if (String(message).length > 2000) {
    return { ok: false, error: 'Message must be 2000 characters or less.' };
  }

  const list = getList().map(r => ({ ...r }));
  if (list.some(r => r.id === cleanId)) {
    return { ok: false, error: `A quick reply with id \`${cleanId}\` already exists. Remove it first or pick another id.` };
  }

  const reply = {
    id: cleanId,
    label: String(label).trim().slice(0, 100),
    message: String(message).trim(),
  };
  list.push(reply);
  persist(list);
  return { ok: true, reply: { ...reply } };
}

/**
 * Update an existing quick reply's message/label.
 * @returns {{ ok: true, reply } | { ok: false, error: string }}
 */
function update(id, { label, message } = {}) {
  const cleanId = normalizeId(id);
  const list = getList().map(r => ({ ...r }));
  const idx = list.findIndex(r => r.id === cleanId);
  if (idx === -1) return { ok: false, error: `No quick reply \`${cleanId}\` found.` };

  if (label != null && String(label).trim()) list[idx].label = String(label).trim().slice(0, 100);
  if (message != null && String(message).trim()) {
    if (String(message).trim().length > 2000) {
      return { ok: false, error: 'Message must be 2000 characters or less.' };
    }
    list[idx].message = String(message).trim();
  }
  persist(list);
  return { ok: true, reply: { ...list[idx] } };
}

/**
 * Remove a quick reply by id.
 * @returns {{ ok: true, reply } | { ok: false, error: string }}
 */
function remove(id) {
  const cleanId = normalizeId(id);
  const list = getList().map(r => ({ ...r }));
  const idx = list.findIndex(r => r.id === cleanId);
  if (idx === -1) return { ok: false, error: `No quick reply \`${cleanId}\` found.` };
  const [reply] = list.splice(idx, 1);
  persist(list);
  return { ok: true, reply: { ...reply } };
}

function _resetForTests() {
  cache = null;
}

module.exports = {
  normalizeId,
  getAll,
  getById,
  add,
  update,
  remove,
  _resetForTests,
};
