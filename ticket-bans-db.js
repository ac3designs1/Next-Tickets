const fs = require('fs');
const path = require('path');

/**
 * Ticket ban list — users who cannot open new tickets.
 *
 * Stored under DATA_DIR as ticket-bans.json (same volume as tickets.json).
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'ticket-bans.json');

function atomicWrite(filePath, contents) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function emptyDb() {
  return { bans: {} };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    atomicWrite(DB_PATH, JSON.stringify(emptyDb(), null, 2));
  }
}

function read() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('invalid db shape');
    if (!data.bans || typeof data.bans !== 'object') data.bans = {};
    return data;
  } catch (err) {
    const bak = `${DB_PATH}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(DB_PATH, bak); } catch { /* ignore */ }
    console.error(`ticket-bans.json unreadable (${err.message}); starting empty. Backup: ${bak}`);
    const empty = emptyDb();
    atomicWrite(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
}

function write(data) {
  ensureDataDir();
  atomicWrite(DB_PATH, JSON.stringify(data, null, 2));
}

/** @returns {boolean} */
function isBanned(userId) {
  const uid = String(userId);
  return Boolean(read().bans[uid]);
}

/** @returns {object|null} */
function getBan(userId) {
  const uid = String(userId);
  return read().bans[uid] ?? null;
}

/**
 * Ban a user from opening tickets.
 * @returns {{ ok: boolean, message: string, ban?: object }}
 */
function banUser(userId, username, reason, bannedBy) {
  const uid = String(userId);
  const db = read();

  if (db.bans[uid]) {
    return {
      ok: false,
      message: `**${username || uid}** is already banned from opening tickets.`,
      ban: db.bans[uid],
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
  write(db);
  return { ok: true, message: `Banned **${ban.username}** from opening tickets.`, ban };
}

/**
 * Remove a ticket ban.
 * @returns {{ ok: boolean, message: string, ban?: object }}
 */
function unbanUser(userId) {
  const uid = String(userId);
  const db = read();
  const existing = db.bans[uid];

  if (!existing) {
    return { ok: false, message: `User \`${uid}\` is not banned from tickets.` };
  }

  delete db.bans[uid];
  write(db);
  return {
    ok: true,
    message: `Unbanned **${existing.username || uid}** — they can open tickets again.`,
    ban: existing,
  };
}

/** @returns {object[]} */
function listBans() {
  return Object.values(read().bans).sort((a, b) => {
    const ta = a.bannedAt ? Date.parse(a.bannedAt) : 0;
    const tb = b.bannedAt ? Date.parse(b.bannedAt) : 0;
    return tb - ta;
  });
}

module.exports = {
  isBanned,
  getBan,
  banUser,
  unbanUser,
  listBans,
};
