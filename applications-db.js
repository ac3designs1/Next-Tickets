const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'applications.json');

function atomicWrite(filePath, contents) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    atomicWrite(DB_PATH, JSON.stringify({ applications: {}, counter: 0, open: true }, null, 2));
  }
}

function read() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('invalid db shape');
    if (!data.applications || typeof data.applications !== 'object') data.applications = {};
    if (typeof data.counter !== 'number') data.counter = 0;
    if (typeof data.open !== 'boolean') data.open = true;
    return data;
  } catch (err) {
    const bak = `${DB_PATH}.corrupt.${Date.now()}`;
    try { fs.copyFileSync(DB_PATH, bak); } catch { /* ignore */ }
    console.error(`applications.json unreadable (${err.message}); starting empty. Backup: ${bak}`);
    const empty = { applications: {}, counter: 0, open: true };
    atomicWrite(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
}

function write(data) {
  ensureDataDir();
  atomicWrite(DB_PATH, JSON.stringify(data, null, 2));
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
 *   Section 1: ign, dob, country, availability
 *   Section 2: prevExp, whyServer, modVsAdmin, qualities, rpExperience
 *   Section 3: scenarioA, scenarioB, scenarioC, scenarioD, scenarioE
 *   Section 4: rulesFailFear, rulesMetaPower, rulesRdmNlr
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

/** Reset an application back to pending (clears reviewer metadata) */
function reopenApplication(appId) {
  const db = read();
  if (!db.applications[appId]) return null;
  db.applications[appId].status     = 'pending';
  db.applications[appId].reviewedBy = null;
  db.applications[appId].reviewedAt = null;
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

/** Check if a user already has an active (pending or on-hold) application */
function hasPendingApplication(userId) {
  return Object.values(read().applications).some(
    a => a.userId === userId && (a.status === 'pending' || a.status === 'hold')
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
  reopenApplication,
  getApplication,
  getAllApplications,
  hasPendingApplication,
  getApplicationByChannel,
};
