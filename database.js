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

  db.tickets[ticketId] = {
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
  return db.tickets[ticketId];
}

// Attach a staff channel ID to a ticket
function setTicketChannel(ticketId, channelId) {
  const db = read();
  if (!db.tickets[ticketId]) return null;
  db.tickets[ticketId].channelId = channelId;
  write(db);
  return db.tickets[ticketId];
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

// Find ticket by ID
function getTicket(ticketId) {
  const db = read();
  return db.tickets[ticketId] || null;
}

// Close a ticket
function closeTicket(ticketId) {
  const db = read();
  if (!db.tickets[ticketId]) return null;
  db.tickets[ticketId].status = 'closed';
  db.tickets[ticketId].closedAt = new Date().toISOString();
  write(db);
  return db.tickets[ticketId];
}

// Reopen a ticket
function reopenTicket(ticketId) {
  const db = read();
  if (!db.tickets[ticketId]) return null;
  db.tickets[ticketId].status = 'open';
  db.tickets[ticketId].closedAt = null;
  write(db);
  return db.tickets[ticketId];
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
  if (!db.tickets[ticketId]) return null;
  db.tickets[ticketId].department = departmentId;
  write(db);
  return db.tickets[ticketId];
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
