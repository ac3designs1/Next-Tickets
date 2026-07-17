const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'applications.json');

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ applications: {}, counter: 0, open: true }, null, 2));
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

/** Check if applications are currently open */
function isOpen() {
  return read().open === true;
}

/** Open or close the application system */
function setOpen(open) {
  const db = read();
  db.open = !!open;
  write(db);
}

/**
 * Create a new application from a fully completed multi-step form.
 * answers shape:
 *   Section 1: ign, steamHex, dobTimezone, availability
 *   Section 2: prevExp, whyServer, modVsAdmin, qualities, stressHandling
 *   Section 3: scenarioA, scenarioB, scenarioC, scenarioD, scenarioE
 *   Section 4: rulesFailFear, rulesMetaPower, rulesRdmNlr, additionalInfo
 */
function createApplication(userId, username, answers) {
  const db = read();
  db.counter += 1;
  const id = String(db.counter).padStart(4, '0');

  db.applications[id] = {
    id,
    userId,
    username,
    ...answers,
    status:      'pending',  // pending | accepted | declined | hold
    reviewedBy:  null,
    reviewedAt:  null,
    messageId:   null,       // set after posting embed
    submittedAt: new Date().toISOString(),
  };

  write(db);
  return db.applications[id];
}

/** Attach the Discord channel + message ID to an application */
function setChannelMessage(appId, channelId, messageId) {
  const db = read();
  if (!db.applications[appId]) return null;
  db.applications[appId].channelId = channelId;
  db.applications[appId].messageId = messageId;
  write(db);
  return db.applications[appId];
}

/** Attach the Discord message ID to an application */
function setMessageId(appId, messageId) {
  const db = read();
  if (!db.applications[appId]) return null;
  db.applications[appId].messageId = messageId;
  write(db);
  return db.applications[appId];
}

/** Update the status of an application */
function updateStatus(appId, status, reviewerTag) {
  const db = read();
  if (!db.applications[appId]) return null;
  db.applications[appId].status     = status;
  db.applications[appId].reviewedBy  = reviewerTag;
  db.applications[appId].reviewedAt  = new Date().toISOString();
  write(db);
  return db.applications[appId];
}

/** Get an application by ID */
function getApplication(appId) {
  return read().applications[appId] ?? null;
}

/** Get all applications, optionally filtered by status */
function getAllApplications(status = null) {
  const all = Object.values(read().applications);
  return status ? all.filter(a => a.status === status) : all;
}

/** Check if a user already has a pending application */
function hasPendingApplication(userId) {
  return Object.values(read().applications).some(
    a => a.userId === userId && a.status === 'pending'
  );
}

/** Find an application by its Discord channel ID */
function getApplicationByChannel(channelId) {
  return Object.values(read().applications).find(a => a.channelId === channelId) ?? null;
}

module.exports = {
  isOpen,
  setOpen,
  createApplication,
  setMessageId,
  setChannelMessage,
  updateStatus,
  getApplication,
  getAllApplications,
  hasPendingApplication,
  getApplicationByChannel,
};
