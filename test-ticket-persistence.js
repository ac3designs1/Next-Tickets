/**
 * Smoke tests for ticket DB + channel recovery helpers.
 * Run: node test-ticket-persistence.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tickets.json');
const BAK = path.join(DATA_DIR, 'tickets.json.__testbak');

// Isolate test DB
if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, BAK);
if (fs.existsSync(DATA_DIR)) {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.startsWith('tickets.json.') && f.endsWith('.tmp')) {
      fs.unlinkSync(path.join(DATA_DIR, f));
    }
  }
}

// Fresh require after isolating
delete require.cache[require.resolve('./database')];
const db = require('./database');

function cleanup() {
  try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
  if (fs.existsSync(BAK)) fs.renameSync(BAK, DB_PATH);
}

try {
  // create + lookup
  const t = db.createTicket('111', 'alice');
  assert.strictEqual(t.status, 'open');
  db.setTicketChannel(t.id, 'chan-1');
  db.setTicketDepartment(t.id, 'community_assistant');

  assert.ok(db.getOpenTicketByUser('111'));
  assert.ok(db.getTicketByChannel('chan-1'));
  assert.ok(db.getTicket(t.id));
  assert.ok(db.getTicket(String(t.id)));

  // close / reopen
  db.closeTicket(t.id);
  assert.strictEqual(db.getTicket(t.id).status, 'closed');
  assert.strictEqual(db.getOpenTicketByUser('111'), null);
  db.reopenTicket(t.id);
  assert.strictEqual(db.getTicket(t.id).status, 'open');

  // upsert recovery after wipe simulation
  fs.writeFileSync(DB_PATH, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  delete require.cache[require.resolve('./database')];
  const db2 = require('./database');
  assert.strictEqual(db2.getTicket(t.id), null);

  const restored = db2.upsertTicket({
    id: t.id,
    userId: '111',
    username: 'alice',
    channelId: 'chan-1',
    status: 'open',
    department: 'community_assistant',
  });
  assert.strictEqual(restored.id, t.id);
  assert.ok(db2.getOpenTicketByUser(111)); // number coercion
  assert.ok(db2.getTicketByChannel('chan-1'));

  // counter must not go backwards / must allow new tickets above restored id
  const next = db2.createTicket('222', 'bob');
  assert.ok(next.id > t.id, `expected next id > ${t.id}, got ${next.id}`);

  // corrupt file recovery
  fs.writeFileSync(DB_PATH, '{not-json');
  delete require.cache[require.resolve('./database')];
  const db3 = require('./database');
  const afterCorrupt = db3.getAllTickets();
  assert.deepStrictEqual(afterCorrupt, []);

  // atomic write leaves no .tmp behind after success
  db3.createTicket('333', 'carol');
  const tmps = fs.readdirSync(DATA_DIR).filter(f => f.includes('.tmp'));
  assert.deepStrictEqual(tmps, []);

  // channel parser recovery
  const { parseTicketChannel, departmentIdFromTopicName } = require('./ticket-channel');
  const DEPARTMENTS = require('./departments.json');
  assert.strictEqual(
    departmentIdFromTopicName(DEPARTMENTS, 'Community Assistant Team'),
    'community_assistant'
  );

  const parsedOpen = parseTicketChannel({
    id: 'c1',
    name: 'ticket-0007-kyle',
    topic: 'Ticket #7 | User: Kyle Brown (123456789012345678) | Status: open | Dept: Community Assistant Team',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }, DEPARTMENTS);
  assert.strictEqual(parsedOpen.id, 7);
  assert.strictEqual(parsedOpen.userId, '123456789012345678');
  assert.strictEqual(parsedOpen.status, 'open');
  assert.strictEqual(parsedOpen.department, 'community_assistant');

  const parsedClosed = parseTicketChannel({
    id: 'c2',
    name: 'closed-0008-kyle',
    topic: 'Ticket #8 | User: Kyle (999999999999999999) | Status: closed | Dept: Gang Team',
  }, DEPARTMENTS);
  assert.strictEqual(parsedClosed.status, 'closed');
  assert.strictEqual(parsedClosed.department, 'gang');

  assert.strictEqual(parseTicketChannel({ id: 'x', name: 'general' }, DEPARTMENTS), null);

  console.log('✅ All ticket persistence smoke tests passed');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('❌ Test failed:', err);
  cleanup();
  process.exit(1);
}
