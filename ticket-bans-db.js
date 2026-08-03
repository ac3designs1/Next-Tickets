const fs = require('fs');
const path = require('path');

/**
 * Ticket ban list — users who cannot open new tickets.
 *
 * Stored under DATA_DIR as ticket-bans.json (same volume as tickets.json).
 * In-memory cache + atomic write + rolling .bak.
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'ticket-bans.json');
const BAK_PATH = path.join(DATA_DIR, 'ticket-bans.json.bak');

let cache = null;

function emptyDb() {
  return { bans: {} };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWrite(filePath, contents) {
  ensureDataDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function tryParse(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty file');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('invalid db shape');
    if (!data.bans || typeof data.bans !== 'object') data.bans = {};
    return data;
  } catch (err) {
    const corrupt = `${file}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(file, corrupt); } catch { /* ignore */ }
    console.error(`${label} unreadable (${err.message}). Kept copy at ${corrupt}`);
    return null;
  }
}

function banCount(data) {
  return data?.bans ? Object.keys(data.bans).length : 0;
}

function readFromDisk() {
  ensureDataDir();
  const primary = tryParse(DB_PATH, 'ticket-bans.json');
  const backup = tryParse(BAK_PATH, 'ticket-bans.json.bak');

  if (backup && banCount(backup) > banCount(primary || emptyDb())) {
    console.warn('⚠️  Restored ticket-bans from .bak (richer than primary)');
    atomicWrite(DB_PATH, JSON.stringify(backup, null, 2));
    try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch { /* ignore */ }
    return backup;
  }

  if (primary) return primary;

  const empty = emptyDb();
  atomicWrite(DB_PATH, JSON.stringify(empty, null, 2));
  try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch { /* ignore */ }
  return empty;
}

function getDb() {
  if (!cache) cache = readFromDisk();
  return cache;
}

function persist(data) {
  ensureDataDir();
  atomicWrite(DB_PATH, JSON.stringify(data, null, 2));
  try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch (err) {
    console.error('Failed to write ticket-bans backup:', err.message);
  }
  cache = data;
}

function mutate(fn) {
  const data = getDb();
  const result = fn(data);
  persist(data);
  return result;
}

/** @returns {boolean} */
function isBanned(userId) {
  const uid = String(userId);
  return Boolean(getDb().bans[uid]);
}

/** @returns {object|null} */
function getBan(userId) {
  const uid = String(userId);
  const ban = getDb().bans[uid];
  return ban ? { ...ban } : null;
}

/**
 * Ban a user from opening tickets.
 * @returns {{ ok: boolean, message: string, ban?: object }}
 */
function banUser(userId, username, reason, bannedBy) {
  return mutate(db => {
    const uid = String(userId);
    if (db.bans[uid]) {
      return {
        ok: false,
        message: `**${username || uid}** is already banned from opening tickets.`,
        ban: { ...db.bans[uid] },
      };
    }

    const ban = {
      userId: uid,
      username: username || 'unknown',
      reason: (reason && String(reason).trim()) || 'No reason provided',
      bannedBy: bannedBy || 'unknown',
      bannedAt: new Date().toISOString(),
    };

    db.bans[uid] = ban;
    return { ok: true, message: `Banned **${ban.username}** from opening tickets.`, ban: { ...ban } };
  });
}

/**
 * Remove a ticket ban.
 * @returns {{ ok: boolean, message: string, ban?: object }}
 */
function unbanUser(userId) {
  return mutate(db => {
    const uid = String(userId);
    const existing = db.bans[uid];
    if (!existing) {
      return { ok: false, message: `User \`${uid}\` is not banned from tickets.` };
    }
    delete db.bans[uid];
    return {
      ok: true,
      message: `Unbanned **${existing.username || uid}** — they can open tickets again.`,
      ban: { ...existing },
    };
  });
}

/** @returns {object[]} */
function listBans() {
  return Object.values(getDb().bans)
    .map(b => ({ ...b }))
    .sort((a, b) => {
      const ta = a.bannedAt ? Date.parse(a.bannedAt) : 0;
      const tb = b.bannedAt ? Date.parse(b.bannedAt) : 0;
      return tb - ta;
    });
}

function _resetForTests() {
  cache = null;
}

module.exports = {
  isBanned,
  getBan,
  banUser,
  unbanUser,
  listBans,
  _resetForTests,
};
