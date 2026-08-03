const fs = require('fs');
const path = require('path');

/**
 * Ticket persistence.
 *
 * - DATA_DIR env can point at a persistent volume (recommended in production)
 * - In-memory cache avoids lost updates from overlapping read/modify/write
 * - Atomic writes + rolling .bak so a crash cannot wipe the ticket book
 * - channelId is unique across tickets
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const DB_PATH = path.join(DATA_DIR, 'tickets.json');
const BAK_PATH = path.join(DATA_DIR, 'tickets.json.bak');

let cache = null;
/** When true, persist() will not overwrite .bak with a thinner snapshot */
let protectBackup = false;

function emptyDb() {
  return { tickets: {}, counter: 0 };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Write atomically so a crash mid-write cannot wipe the ticket DB */
function atomicWrite(filePath, contents) {
  ensureDataDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function normalizeTicket(ticket, key) {
  if (!ticket || typeof ticket !== 'object') return null;
  const idNum = Number(ticket.id ?? key);
  if (!Number.isFinite(idNum)) return null;
  const status = ticket.status === 'closed' ? 'closed' : 'open';
  const createdAt = ticket.createdAt || new Date().toISOString();
  return {
    id: idNum,
    userId: ticket.userId != null ? String(ticket.userId) : '',
    username: ticket.username || 'unknown',
    channelId: ticket.channelId || null,
    fallbackChannelId: ticket.fallbackChannelId || null,
    status,
    department: ticket.department || null,
    subject: ticket.subject || null,
    claimedBy: ticket.claimedBy != null ? String(ticket.claimedBy) : null,
    claimedByTag: ticket.claimedByTag || null,
    claimedAt: ticket.claimedAt || null,
    createdAt,
    closedAt: status === 'closed' ? (ticket.closedAt || null) : null,
    lastActivityAt: ticket.lastActivityAt || createdAt,
  };
}

function parseDb(raw, label) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error(`${label}: invalid db shape`);
  if (!data.tickets || typeof data.tickets !== 'object') data.tickets = {};
  if (typeof data.counter !== 'number' || !Number.isFinite(data.counter)) data.counter = 0;

  const normalized = {};
  for (const [key, ticket] of Object.entries(data.tickets)) {
    const row = normalizeTicket(ticket, key);
    if (!row) continue;
    normalized[String(row.id)] = row;
    if (row.id > data.counter) data.counter = row.id;
  }
  data.tickets = normalized;
  return data;
}

function tryLoadFile(file, label) {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty file');
    return parseDb(raw, label);
  } catch (err) {
    const corrupt = `${file}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(file, corrupt); } catch { /* ignore */ }
    console.error(`${label} unreadable (${err.message}). Kept copy at ${corrupt}`);
    return null;
  }
}

function ticketCount(data) {
  return data?.tickets ? Object.keys(data.tickets).length : 0;
}

function openCount(data) {
  if (!data?.tickets) return 0;
  return Object.values(data.tickets).filter(t => t.status === 'open').length;
}

function scoreSnapshot(data) {
  if (!data) return -1;
  // Prefer more tickets, then more open tickets, then higher counter
  return (ticketCount(data) * 1_000_000) + (openCount(data) * 1_000) + (data.counter || 0);
}

function readFromDisk() {
  ensureDataDir();

  const primary = tryLoadFile(DB_PATH, 'tickets.json');
  const backup = tryLoadFile(BAK_PATH, 'tickets.json.bak');

  const primaryScore = scoreSnapshot(primary);
  const backupScore = scoreSnapshot(backup);

  // Prefer the richer snapshot — protects against partial wipes that leave
  // a non-empty but incomplete primary while .bak still has the full book.
  if (backupScore > primaryScore && ticketCount(backup) > 0) {
    console.warn(
      `⚠️  Restored tickets from tickets.json.bak `
      + `(primary=${ticketCount(primary)} tickets/${openCount(primary)} open, `
      + `bak=${ticketCount(backup)} tickets/${openCount(backup)} open)`
    );
    atomicWrite(DB_PATH, JSON.stringify(backup, null, 2));
    try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch { /* ignore */ }
    return backup;
  }

  if (primary) return primary;

  console.warn('⚠️  No usable ticket DB found — starting empty (will rebuild from Discord channels).');
  const empty = emptyDb();
  // Write primary but DO NOT clobber an existing .bak yet
  atomicWrite(DB_PATH, JSON.stringify(empty, null, 2));
  protectBackup = true;
  return empty;
}

function getDb() {
  if (!cache) cache = readFromDisk();
  return cache;
}

function persist(data) {
  ensureDataDir();
  const payload = JSON.stringify(data, null, 2);
  atomicWrite(DB_PATH, payload);

  // Don't overwrite a richer .bak with a thinner in-memory snapshot
  // (e.g. empty boot before Discord reconcile finishes).
  const currentBak = tryLoadFile(BAK_PATH, 'tickets.json.bak');
  const shouldWriteBak =
    !protectBackup
    && scoreSnapshot(data) >= scoreSnapshot(currentBak);

  if (shouldWriteBak || !currentBak) {
    try {
      fs.copyFileSync(DB_PATH, BAK_PATH);
    } catch (err) {
      console.error('Failed to write tickets backup:', err.message);
    }
  }

  cache = data;
}

/** After a successful Discord reconcile, bak mirroring is safe again */
function allowBackupUpdates() {
  protectBackup = false;
  // Refresh bak to match the reconciled primary
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, BAK_PATH);
  } catch { /* ignore */ }
}

/** Run a mutation against the in-memory DB and flush to disk */
function mutate(fn) {
  const data = getDb();
  const result = fn(data);
  persist(data);
  return result;
}

/** Ensure only one ticket owns a given channelId */
function clearChannelIdOwners(db, channelId, exceptKey = null) {
  if (!channelId) return;
  for (const [key, ticket] of Object.entries(db.tickets)) {
    if (exceptKey && key === exceptKey) continue;
    if (ticket.channelId === channelId) ticket.channelId = null;
  }
}

function clearFallbackChannelOwners(db, fallbackChannelId, exceptKey = null) {
  if (!fallbackChannelId) return;
  for (const [key, ticket] of Object.entries(db.tickets)) {
    if (exceptKey && key === exceptKey) continue;
    if (ticket.fallbackChannelId === fallbackChannelId) ticket.fallbackChannelId = null;
  }
}

// Create a new ticket, returns the ticket object
function createTicket(userId, username, subject = null) {
  return mutate(db => {
    // Hard guard against duplicate open tickets for the same user
    const uid = String(userId);
    const existingOpen = Object.values(db.tickets).find(
      t => String(t.userId) === uid && t.status === 'open'
    );
    if (existingOpen) {
      return { ...existingOpen, _duplicate: true };
    }

    db.counter += 1;
    const ticketId = db.counter;
    const key = String(ticketId);
    const now = new Date().toISOString();

    db.tickets[key] = {
      id: ticketId,
      userId: uid,
      username,
      channelId: null,
      fallbackChannelId: null,
      status: 'open',
      department: null,
      subject: subject ? String(subject).slice(0, 200) : null,
      claimedBy: null,
      claimedByTag: null,
      claimedAt: null,
      createdAt: now,
      closedAt: null,
      lastActivityAt: now,
    };

    return { ...db.tickets[key] };
  });
}

// Attach a staff channel ID to a ticket
function setTicketChannel(ticketId, channelId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    clearChannelIdOwners(db, channelId, key);
    db.tickets[key].channelId = channelId;
    return { ...db.tickets[key] };
  });
}

function setFallbackChannel(ticketId, fallbackChannelId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    clearFallbackChannelOwners(db, fallbackChannelId, key);
    db.tickets[key].fallbackChannelId = fallbackChannelId || null;
    return { ...db.tickets[key] };
  });
}

function setTicketSubject(ticketId, subject) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].subject = subject ? String(subject).slice(0, 200) : null;
    return { ...db.tickets[key] };
  });
}

function claimTicket(ticketId, staffId, staffTag) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    if (db.tickets[key].status !== 'open') {
      return { ...db.tickets[key], _error: 'closed' };
    }
    db.tickets[key].claimedBy = String(staffId);
    db.tickets[key].claimedByTag = staffTag || 'staff';
    db.tickets[key].claimedAt = new Date().toISOString();
    db.tickets[key].lastActivityAt = new Date().toISOString();
    return { ...db.tickets[key] };
  });
}

function unclaimTicket(ticketId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].claimedBy = null;
    db.tickets[key].claimedByTag = null;
    db.tickets[key].claimedAt = null;
    return { ...db.tickets[key] };
  });
}

function touchTicketActivity(ticketId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].lastActivityAt = new Date().toISOString();
    return { ...db.tickets[key] };
  });
}

// Find ticket by the Discord channel it maps to
function getTicketByChannel(channelId) {
  if (!channelId) return null;
  const db = getDb();
  const hit = Object.values(db.tickets).find(
    t => t.channelId === channelId || t.fallbackChannelId === channelId
  ) || null;
  return hit ? { ...hit } : null;
}

// Find the open ticket for a user (each user can have one open ticket at a time)
function getOpenTicketByUser(userId) {
  const db = getDb();
  const uid = String(userId);
  const hit = Object.values(db.tickets).find(t => String(t.userId) === uid && t.status === 'open') || null;
  return hit ? { ...hit } : null;
}

// Find ticket by ID (JSON keys are strings; accept number or string)
function getTicket(ticketId) {
  if (ticketId == null) return null;
  const db = getDb();
  const hit = db.tickets[ticketId] || db.tickets[String(ticketId)] || null;
  return hit ? { ...hit } : null;
}

// Close a ticket
function closeTicket(ticketId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].status = 'closed';
    db.tickets[key].closedAt = new Date().toISOString();
    db.tickets[key].lastActivityAt = db.tickets[key].closedAt;
    return { ...db.tickets[key] };
  });
}

/**
 * Reopen a ticket. Blocks if the user already has a different open ticket.
 * @returns {object|null} ticket, or ticket with `_blocked` + `_otherOpenId`
 */
function reopenTicket(ticketId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    const ticket = db.tickets[key];
    const otherOpen = Object.values(db.tickets).find(
      t => String(t.userId) === String(ticket.userId)
        && t.status === 'open'
        && String(t.id) !== key
    );
    if (otherOpen) {
      return { ...ticket, _blocked: true, _otherOpenId: otherOpen.id };
    }
    ticket.status = 'open';
    ticket.closedAt = null;
    ticket.lastActivityAt = new Date().toISOString();
    return { ...ticket };
  });
}

/** Permanently remove a ticket row (used to roll back failed channel creates) */
function deleteTicket(ticketId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return false;
    delete db.tickets[key];
    return true;
  });
}

// Get all tickets (optionally filter by status)
function getAllTickets(status = null) {
  const db = getDb();
  const all = Object.values(db.tickets).map(t => ({ ...t }));
  return status ? all.filter(t => t.status === status) : all;
}

/** Open tickets with no activity for at least `days` days */
function getStaleOpenTickets(days) {
  const ms = Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ms;
  return getAllTickets('open').filter(t => {
    const last = Date.parse(t.lastActivityAt || t.createdAt || 0);
    return Number.isFinite(last) && last <= cutoff;
  });
}

/** Aggregate stats for /stats */
function getStats() {
  const all = getAllTickets();
  const open = all.filter(t => t.status === 'open');
  const closed = all.filter(t => t.status === 'closed');
  const claimed = open.filter(t => t.claimedBy);
  const unclaimed = open.filter(t => !t.claimedBy);

  const closeDurations = closed
    .map(t => {
      const start = Date.parse(t.createdAt || 0);
      const end = Date.parse(t.closedAt || 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      return end - start;
    })
    .filter(n => n != null);

  const avgCloseMs = closeDurations.length
    ? Math.round(closeDurations.reduce((a, b) => a + b, 0) / closeDurations.length)
    : null;

  return {
    total: all.length,
    open: open.length,
    closed: closed.length,
    claimed: claimed.length,
    unclaimed: unclaimed.length,
    avgCloseMs,
    closedWithDuration: closeDurations.length,
  };
}

// Set the department a ticket has been transferred to
function setTicketDepartment(ticketId, departmentId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].department = departmentId;
    db.tickets[key].lastActivityAt = new Date().toISOString();
    return { ...db.tickets[key] };
  });
}

/**
 * Insert or update a ticket record (used when recovering from Discord channels).
 * Never lowers the counter. channelId is unique.
 */
function upsertTicket(ticket) {
  if (!ticket || ticket.id == null) return null;

  return mutate(db => {
    const key = String(ticket.id);
    const prev = db.tickets[key] || {};
    const idNum = Number(ticket.id);
    if (!Number.isFinite(idNum)) return null;

    const status = ticket.status === 'closed' ? 'closed' : 'open';
    const channelId = ticket.channelId !== undefined ? ticket.channelId : (prev.channelId ?? null);
    const fallbackChannelId = ticket.fallbackChannelId !== undefined
      ? ticket.fallbackChannelId
      : (prev.fallbackChannelId ?? null);
    const createdAt = prev.createdAt || ticket.createdAt || new Date().toISOString();

    clearChannelIdOwners(db, channelId, key);
    clearFallbackChannelOwners(db, fallbackChannelId, key);

    db.tickets[key] = {
      id: idNum,
      userId: String(ticket.userId ?? prev.userId ?? ''),
      username: ticket.username ?? prev.username ?? 'unknown',
      channelId,
      fallbackChannelId,
      status,
      department: ticket.department ?? prev.department ?? null,
      subject: ticket.subject !== undefined ? ticket.subject : (prev.subject ?? null),
      claimedBy: ticket.claimedBy !== undefined
        ? (ticket.claimedBy != null ? String(ticket.claimedBy) : null)
        : (prev.claimedBy ?? null),
      claimedByTag: ticket.claimedByTag !== undefined ? ticket.claimedByTag : (prev.claimedByTag ?? null),
      claimedAt: ticket.claimedAt !== undefined ? ticket.claimedAt : (prev.claimedAt ?? null),
      createdAt,
      closedAt: status === 'closed'
        ? (ticket.closedAt || prev.closedAt || new Date().toISOString())
        : null,
      lastActivityAt: ticket.lastActivityAt || prev.lastActivityAt || createdAt,
    };

    if (idNum > db.counter) db.counter = idNum;
    return { ...db.tickets[key] };
  });
}

/** Raise counter to at least `n` without creating a ticket */
function ensureCounterAtLeast(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return;
  mutate(db => {
    if (num > db.counter) db.counter = num;
  });
}

/** Force reload from disk (used by tests) */
function _resetForTests() {
  cache = null;
  protectBackup = false;
}

function getDataDir() {
  return DATA_DIR;
}

function getDbPath() {
  return DB_PATH;
}

module.exports = {
  createTicket,
  setTicketChannel,
  setFallbackChannel,
  setTicketSubject,
  setTicketDepartment,
  claimTicket,
  unclaimTicket,
  touchTicketActivity,
  getTicketByChannel,
  getOpenTicketByUser,
  getTicket,
  closeTicket,
  reopenTicket,
  deleteTicket,
  getAllTickets,
  getStaleOpenTickets,
  getStats,
  upsertTicket,
  ensureCounterAtLeast,
  allowBackupUpdates,
  getDataDir,
  getDbPath,
  _resetForTests,
};
