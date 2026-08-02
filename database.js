const fs = require('fs');
const path = require('path');

/**
 * Ticket persistence.
 *
 * - DATA_DIR env can point at a persistent volume (recommended in production)
 * - In-memory cache avoids lost updates from overlapping read/modify/write
 * - Atomic writes + rolling .bak so a crash cannot wipe the ticket book
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const DB_PATH = path.join(DATA_DIR, 'tickets.json');
const BAK_PATH = path.join(DATA_DIR, 'tickets.json.bak');

let cache = null;

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

function parseDb(raw, label) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error(`${label}: invalid db shape`);
  if (!data.tickets || typeof data.tickets !== 'object') data.tickets = {};
  if (typeof data.counter !== 'number' || !Number.isFinite(data.counter)) data.counter = 0;

  // Normalize stored tickets so restarts never break userId/status matching
  const normalized = {};
  for (const [key, ticket] of Object.entries(data.tickets)) {
    if (!ticket || typeof ticket !== 'object') continue;
    const idNum = Number(ticket.id ?? key);
    if (!Number.isFinite(idNum)) continue;
    normalized[String(idNum)] = {
      id: idNum,
      userId: ticket.userId != null ? String(ticket.userId) : '',
      username: ticket.username || 'unknown',
      channelId: ticket.channelId || null,
      status: ticket.status === 'closed' ? 'closed' : 'open',
      department: ticket.department || null,
      createdAt: ticket.createdAt || new Date().toISOString(),
      closedAt: ticket.status === 'closed' ? (ticket.closedAt || null) : null,
    };
    if (idNum > data.counter) data.counter = idNum;
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

function readFromDisk() {
  ensureDataDir();

  const primary = tryLoadFile(DB_PATH, 'tickets.json');
  const backup = tryLoadFile(BAK_PATH, 'tickets.json.bak');

  // Prefer a non-empty snapshot. If primary was wiped to {} but .bak still
  // has tickets, restore from backup — this is the common panel-restart case.
  if (ticketCount(primary) > 0) return primary;

  if (ticketCount(backup) > 0) {
    console.warn(`⚠️  Restored ${ticketCount(backup)} ticket(s) from tickets.json.bak`);
    atomicWrite(DB_PATH, JSON.stringify(backup, null, 2));
    try { fs.copyFileSync(DB_PATH, BAK_PATH); } catch { /* ignore */ }
    return backup;
  }

  if (primary) return primary;

  console.warn('⚠️  No usable ticket DB found — starting empty (will rebuild from Discord channels).');
  const empty = emptyDb();
  atomicWrite(DB_PATH, JSON.stringify(empty, null, 2));
  return empty;
}

function getDb() {
  if (!cache) cache = readFromDisk();
  return cache;
}

function persist(data) {
  ensureDataDir();
  const payload = JSON.stringify(data, null, 2);

  // Write primary, then mirror the same good snapshot to .bak
  // (bak is always the latest known-good file, not one write behind)
  atomicWrite(DB_PATH, payload);
  try {
    fs.copyFileSync(DB_PATH, BAK_PATH);
  } catch (err) {
    console.error('Failed to write tickets backup:', err.message);
  }
  cache = data;
}

/** Run a mutation against the in-memory DB and flush to disk */
function mutate(fn) {
  const data = getDb();
  // Deep-ish clone of top-level so failed mutations can be abandoned if needed
  const result = fn(data);
  persist(data);
  return result;
}

// Create a new ticket, returns the ticket object
function createTicket(userId, username) {
  return mutate(db => {
    db.counter += 1;
    const ticketId = db.counter;
    const key = String(ticketId);

    db.tickets[key] = {
      id: ticketId,
      userId: String(userId),
      username,
      channelId: null,
      status: 'open',
      department: null,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };

    return { ...db.tickets[key] };
  });
}

// Attach a staff channel ID to a ticket
function setTicketChannel(ticketId, channelId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].channelId = channelId;
    return { ...db.tickets[key] };
  });
}

// Find ticket by the Discord channel it maps to
function getTicketByChannel(channelId) {
  if (!channelId) return null;
  const db = getDb();
  const hit = Object.values(db.tickets).find(t => t.channelId === channelId) || null;
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
    return { ...db.tickets[key] };
  });
}

// Reopen a ticket
function reopenTicket(ticketId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].status = 'open';
    db.tickets[key].closedAt = null;
    return { ...db.tickets[key] };
  });
}

// Get all tickets (optionally filter by status)
function getAllTickets(status = null) {
  const db = getDb();
  const all = Object.values(db.tickets).map(t => ({ ...t }));
  return status ? all.filter(t => t.status === status) : all;
}

// Set the department a ticket has been transferred to
function setTicketDepartment(ticketId, departmentId) {
  return mutate(db => {
    const key = String(ticketId);
    if (!db.tickets[key]) return null;
    db.tickets[key].department = departmentId;
    return { ...db.tickets[key] };
  });
}

/**
 * Insert or update a ticket record (used when recovering from Discord channels).
 * Never lowers the counter. Never invents a closed status unless explicitly set.
 */
function upsertTicket(ticket) {
  if (!ticket || ticket.id == null) return null;

  return mutate(db => {
    const key = String(ticket.id);
    const prev = db.tickets[key] || {};
    const idNum = Number(ticket.id);
    if (!Number.isFinite(idNum)) return null;

    const status = ticket.status === 'closed' ? 'closed' : 'open';

    db.tickets[key] = {
      id: idNum,
      userId: String(ticket.userId ?? prev.userId ?? ''),
      username: ticket.username ?? prev.username ?? 'unknown',
      channelId: ticket.channelId ?? prev.channelId ?? null,
      status,
      department: ticket.department ?? prev.department ?? null,
      createdAt: prev.createdAt || ticket.createdAt || new Date().toISOString(),
      closedAt: status === 'closed'
        ? (ticket.closedAt || prev.closedAt || new Date().toISOString())
        : null,
    };

    if (idNum > db.counter) db.counter = idNum;
    return { ...db.tickets[key] };
  });
}

/** Force reload from disk (used by tests) */
function _resetForTests() {
  cache = null;
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
  setTicketDepartment,
  getTicketByChannel,
  getOpenTicketByUser,
  getTicket,
  closeTicket,
  reopenTicket,
  getAllTickets,
  upsertTicket,
  getDataDir,
  getDbPath,
  _resetForTests,
};
