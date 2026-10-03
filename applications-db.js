const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

function createApplicationsDb(fileBase = 'applications') {
  const DB_PATH = path.join(DATA_DIR, `${fileBase}.json`);
  const BAK_PATH = path.join(DATA_DIR, `${fileBase}.json.bak`);

  let cache = null;

  function emptyDb() {
    return { applications: {}, counter: 0, open: true };
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

  function normalize(data) {
    if (!data || typeof data !== 'object') throw new Error('invalid db shape');
    if (!data.applications || typeof data.applications !== 'object') data.applications = {};
    if (typeof data.counter !== 'number') data.counter = 0;
    if (typeof data.open !== 'boolean') data.open = true;
    return data;
  }

  function tryParse(file, label) {
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw || !raw.trim()) throw new Error('empty file');
      return normalize(JSON.parse(raw));
    } catch (err) {
      const corrupt = `${file}.corrupt.${Date.now()}`;
      try { fs.copyFileSync(file, corrupt); } catch { /* ignore */ }
      console.error(`${label} unreadable (${err.message}). Kept copy at ${corrupt}`);
      return null;
    }
  }

  function appCount(data) {
    return data?.applications ? Object.keys(data.applications).length : 0;
  }

  function score(data) {
    if (!data) return -1;
    return (appCount(data) * 1000) + (data.counter || 0);
  }

  function readFromDisk() {
    ensureDataDir();
    const primary = tryParse(DB_PATH, `${fileBase}.json`);
    const backup = tryParse(BAK_PATH, `${fileBase}.json.bak`);

    if (backup && score(backup) > score(primary || emptyDb())) {
      console.warn(`⚠️  Restored ${fileBase} from .bak (richer than primary)`);
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
      console.error(`Failed to write ${fileBase} backup:`, err.message);
    }
    cache = data;
  }

  function mutate(fn) {
    const data = getDb();
    const result = fn(data);
    persist(data);
    return result;
  }

  /** Check if applications are currently open */
  function isOpen() {
    return getDb().open === true;
  }

  /** Open or close the application system */
  function setOpen(open) {
    return mutate(db => {
      db.open = !!open;
    });
  }

  /**
   * Create a new application from a fully completed multi-step form.
   */
  function createApplication(userId, username, answers) {
    return mutate(db => {
      db.counter += 1;
      const id = String(db.counter).padStart(4, '0');

      db.applications[id] = {
        id,
        userId,
        username,
        ...answers,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        messageId: null,
        submittedAt: new Date().toISOString(),
      };

      return { ...db.applications[id] };
    });
  }

  /** Attach the Discord channel + message ID to an application */
  function setChannelMessage(appId, channelId, messageId) {
    return mutate(db => {
      if (!db.applications[appId]) return null;
      db.applications[appId].channelId = channelId;
      db.applications[appId].messageId = messageId;
      return { ...db.applications[appId] };
    });
  }

  /** Attach the Discord message ID to an application */
  function setMessageId(appId, messageId) {
    return mutate(db => {
      if (!db.applications[appId]) return null;
      db.applications[appId].messageId = messageId;
      return { ...db.applications[appId] };
    });
  }

  /** Update the status of an application */
  function updateStatus(appId, status, reviewerTag) {
    return mutate(db => {
      if (!db.applications[appId]) return null;
      db.applications[appId].status = status;
      db.applications[appId].reviewedBy = reviewerTag;
      db.applications[appId].reviewedAt = new Date().toISOString();
      return { ...db.applications[appId] };
    });
  }

  /** Reset an application back to pending (clears reviewer metadata) */
  function reopenApplication(appId) {
    return mutate(db => {
      if (!db.applications[appId]) return null;
      db.applications[appId].status = 'pending';
      db.applications[appId].reviewedBy = null;
      db.applications[appId].reviewedAt = null;
      return { ...db.applications[appId] };
    });
  }

  /** Get an application by ID */
  function getApplication(appId) {
    const hit = getDb().applications[appId];
    return hit ? { ...hit } : null;
  }

  /** Get all applications, optionally filtered by status */
  function getAllApplications(status = null) {
    const all = Object.values(getDb().applications).map(a => ({ ...a }));
    return status ? all.filter(a => a.status === status) : all;
  }

  /** Check if a user already has an active (pending or on-hold) application */
  function hasPendingApplication(userId) {
    return Object.values(getDb().applications).some(
      a => a.userId === userId && (a.status === 'pending' || a.status === 'hold')
    );
  }

  /** Find an application by its Discord channel ID */
  function getApplicationByChannel(channelId) {
    const hit = Object.values(getDb().applications).find(a => a.channelId === channelId);
    return hit ? { ...hit } : null;
  }

  function _resetForTests() {
    cache = null;
  }

  return {
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
    _resetForTests,
  };
}

const staffApplications = createApplicationsDb('applications');

module.exports = {
  ...staffApplications,
  createApplicationsDb,
};
