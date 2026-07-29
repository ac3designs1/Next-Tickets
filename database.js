const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tickets.json');

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  }
}

function read() {
  ensureDataDir();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function write(data) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Create a new ticket, returns the ticket object
function createTicket(userId, username) {
  const db = read();
  db.counter += 1;
  const ticketId = db.counter;
  const key = String(ticketId);

  db.tickets[key] = {
    id: ticketId,
    userId,
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
  return Object.values(db.tickets).find(t => t.userId === userId && t.status === 'open') || null;
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
};
