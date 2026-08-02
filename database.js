const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tickets.json');

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    atomicWrite(DB_PATH, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  }
}

/** Write atomically so a crash mid-write cannot wipe the ticket DB */
function atomicWrite(filePath, contents) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function read() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('invalid db shape');
    if (!data.tickets || typeof data.tickets !== 'object') data.tickets = {};
    if (typeof data.counter !== 'number' || !Number.isFinite(data.counter)) data.counter = 0;
    return data;
  } catch (err) {
    // Corrupt/empty file — try backup, otherwise start fresh but keep a copy
    const bak = `${DB_PATH}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(DB_PATH, bak); } catch { /* ignore */ }
    console.error(`tickets.json unreadable (${err.message}); starting empty. Backup: ${bak}`);
    const empty = { tickets: {}, counter: 0 };
    atomicWrite(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
}

function write(data) {
  ensureDataDir();
  atomicWrite(DB_PATH, JSON.stringify(data, null, 2));
}

// Create a new ticket, returns the ticket object
function createTicket(userId, username) {
  const db = read();
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

  write(db);
  return db.tickets[key];
}

// Attach a staff channel ID to a ticket
function setTicketChannel(ticketId, channelId) {
  const db = read();
  const key = String(ticketId);
  if (!db.tickets[key]) return null;
  db.tickets[key].channelId = channelId;
  write(db);
  return db.tickets[key];
}

// Find ticket by the Discord channel it maps to
function getTicketByChannel(channelId) {
  const db = read();
  return Object.values(db.tickets).find(t => t.channelId === channelId) || null;
}

// Find the open ticket for a user (each user can have one open ticket at a time)
function getOpenTicketByUser(userId) {
  const db = read();
  const uid = String(userId);
  return Object.values(db.tickets).find(t => String(t.userId) === uid && t.status === 'open') || null;
}

// Find ticket by ID (JSON keys are strings; accept number or string)
function getTicket(ticketId) {
  const db = read();
  if (ticketId == null) return null;
  return db.tickets[ticketId] || db.tickets[String(ticketId)] || null;
}

// Close a ticket
function closeTicket(ticketId) {
  const db = read();
  const key = String(ticketId);
  if (!db.tickets[key]) return null;
  db.tickets[key].status = 'closed';
  db.tickets[key].closedAt = new Date().toISOString();
  write(db);
  return db.tickets[key];
}

// Reopen a ticket
function reopenTicket(ticketId) {
  const db = read();
  const key = String(ticketId);
  if (!db.tickets[key]) return null;
  db.tickets[key].status = 'open';
  db.tickets[key].closedAt = null;
  write(db);
  return db.tickets[key];
}

// Get all tickets (optionally filter by status)
function getAllTickets(status = null) {
  const db = read();
  const all = Object.values(db.tickets);
  return status ? all.filter(t => t.status === status) : all;
}

// Set the department a ticket has been transferred to
function setTicketDepartment(ticketId, departmentId) {
  const db = read();
  const key = String(ticketId);
  if (!db.tickets[key]) return null;
  db.tickets[key].department = departmentId;
  write(db);
  return db.tickets[key];
}

/**
 * Insert or update a ticket record (used when recovering from Discord channels).
 * Never lowers the counter.
 */
function upsertTicket(ticket) {
  if (!ticket || ticket.id == null) return null;
  const db = read();
  const key = String(ticket.id);
  const prev = db.tickets[key] || {};
  const idNum = Number(ticket.id);

  db.tickets[key] = {
    id: idNum,
    userId: String(ticket.userId ?? prev.userId ?? ''),
    username: ticket.username ?? prev.username ?? 'unknown',
    channelId: ticket.channelId ?? prev.channelId ?? null,
    status: ticket.status === 'closed' ? 'closed' : 'open',
    department: ticket.department ?? prev.department ?? null,
    createdAt: prev.createdAt || ticket.createdAt || new Date().toISOString(),
    closedAt: (ticket.status === 'closed')
      ? (ticket.closedAt || prev.closedAt || new Date().toISOString())
      : null,
  };

  if (Number.isFinite(idNum) && idNum > db.counter) {
    db.counter = idNum;
  }

  write(db);
  return db.tickets[key];
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
};
