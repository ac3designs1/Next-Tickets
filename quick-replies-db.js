const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'quick-replies.json');

function ensureFile() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
  }
}

function read() {
  ensureFile();
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  return Array.isArray(data) ? data : [];
}

function write(list) {
  ensureFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2));
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
  return read();
}

function getById(id) {
  const key = normalizeId(id);
  return read().find(r => r.id === key) ?? null;
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

  const list = read();
  if (list.some(r => r.id === cleanId)) {
    return { ok: false, error: `A quick reply with id \`${cleanId}\` already exists. Remove it first or pick another id.` };
  }

  const reply = {
    id: cleanId,
    label: String(label).trim().slice(0, 100),
    message: String(message).trim(),
  };
  list.push(reply);
  write(list);
  return { ok: true, reply };
}

/**
 * Update an existing quick reply's message/label.
 * @returns {{ ok: true, reply } | { ok: false, error: string }}
 */
function update(id, { label, message } = {}) {
  const cleanId = normalizeId(id);
  const list = read();
  const idx = list.findIndex(r => r.id === cleanId);
  if (idx === -1) return { ok: false, error: `No quick reply \`${cleanId}\` found.` };

  if (label != null && String(label).trim()) list[idx].label = String(label).trim().slice(0, 100);
  if (message != null && String(message).trim()) {
    if (String(message).trim().length > 2000) {
      return { ok: false, error: 'Message must be 2000 characters or less.' };
    }
    list[idx].message = String(message).trim();
  }
  write(list);
  return { ok: true, reply: list[idx] };
}

/**
 * Remove a quick reply by id.
 * @returns {{ ok: true, reply } | { ok: false, error: string }}
 */
function remove(id) {
  const cleanId = normalizeId(id);
  const list = read();
  const idx = list.findIndex(r => r.id === cleanId);
  if (idx === -1) return { ok: false, error: `No quick reply \`${cleanId}\` found.` };
  const [reply] = list.splice(idx, 1);
  write(list);
  return { ok: true, reply };
}

module.exports = {
  normalizeId,
  getAll,
  getById,
  add,
  update,
  remove,
};
