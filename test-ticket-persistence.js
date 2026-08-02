/**
 * Smoke tests for ticket DB + channel recovery helpers.
 * Run: node test-ticket-persistence.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-bot-test-'));
process.env.DATA_DIR = TEST_DIR;

// Load after DATA_DIR is set
const db = require('./database');
const {
  parseTicketChannel,
  departmentIdFromTopicName,
  statusFromChannelName,
  extractUserIdFromText,
} = require('./ticket-channel');
const DEPARTMENTS = require('./departments.json');

function cleanup() {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  // ── create + lookup ─────────────────────────────────────────────────────
  const ALICE = '111111111111111111';
  const BOB = '222222222222222222';

  const t = db.createTicket(ALICE, 'alice');
  assert.strictEqual(t.status, 'open');
  db.setTicketChannel(t.id, 'chan-1');
  db.setTicketDepartment(t.id, 'community_assistant');

  assert.ok(db.getOpenTicketByUser(ALICE));
  assert.ok(db.getTicketByChannel('chan-1'));
  assert.ok(db.getTicket(t.id));
  assert.ok(db.getTicket(String(t.id)));

  // ── close / reopen ──────────────────────────────────────────────────────
  db.closeTicket(t.id);
  assert.strictEqual(db.getTicket(t.id).status, 'closed');
  assert.strictEqual(db.getOpenTicketByUser(ALICE), null);
  db.reopenTicket(t.id);
  assert.strictEqual(db.getTicket(t.id).status, 'open');

  // ── survives process-style reload via backup ────────────────────────────
  const primary = path.join(TEST_DIR, 'tickets.json');
  const bak = path.join(TEST_DIR, 'tickets.json.bak');
  assert.ok(fs.existsSync(primary));
  assert.ok(fs.existsSync(bak), 'expected rolling .bak after writes');

  // Simulate wipe of primary — bak must restore open tickets
  fs.writeFileSync(primary, '{not-json');
  db._resetForTests();
  const restoredAfterCorrupt = db.getOpenTicketByUser(ALICE);
  assert.ok(restoredAfterCorrupt, 'should restore open ticket from .bak after corrupt primary');
  assert.strictEqual(restoredAfterCorrupt.id, t.id);

  // ── empty primary with populated bak restores tickets ───────────────────
  fs.writeFileSync(primary, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  // bak still has the open ticket from earlier writes
  db._resetForTests();
  assert.ok(db.getOpenTicketByUser(ALICE), 'empty primary should fall back to non-empty .bak');

  // ── upsert recovery after total wipe of primary AND bak ───────────────
  fs.writeFileSync(primary, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  fs.writeFileSync(bak, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  db._resetForTests();
  assert.strictEqual(db.getTicket(t.id), null);

  const restored = db.upsertTicket({
    id: t.id,
    userId: ALICE,
    username: 'alice',
    channelId: 'chan-1',
    status: 'open',
    department: 'community_assistant',
  });
  assert.strictEqual(restored.id, t.id);
  assert.ok(db.getOpenTicketByUser(ALICE));
  assert.ok(db.getTicketByChannel('chan-1'));

  const next = db.createTicket(BOB, 'bob');
  assert.ok(next.id > t.id, `expected next id > ${t.id}, got ${next.id}`);

  // ── channel parser: NAME wins over topic status ─────────────────────────
  assert.strictEqual(statusFromChannelName('ticket-0007-kyle'), 'open');
  assert.strictEqual(statusFromChannelName('closed-0008-kyle'), 'closed');
  assert.strictEqual(
    departmentIdFromTopicName(DEPARTMENTS, 'Community Assistant Team'),
    'community_assistant'
  );

  const parsedOpen = parseTicketChannel({
    id: 'c1',
    name: 'ticket-0007-kyle',
    // Topic lies and says closed — name must win
    topic: 'Ticket #7 | User: Kyle Brown (123456789012345678) | Status: closed | Dept: Community Assistant Team',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }, DEPARTMENTS);
  assert.strictEqual(parsedOpen.id, 7);
  assert.strictEqual(parsedOpen.userId, '123456789012345678');
  assert.strictEqual(parsedOpen.status, 'open', 'ticket-* must stay open even if topic says closed');
  assert.strictEqual(parsedOpen.department, 'community_assistant');

  const parsedClosed = parseTicketChannel({
    id: 'c2',
    name: 'closed-0008-kyle',
    topic: 'Ticket #8 | User: Kyle (999999999999999999) | Status: open | Dept: Gang Team',
  }, DEPARTMENTS);
  assert.strictEqual(parsedClosed.status, 'closed', 'closed-* must stay closed even if topic says open');
  assert.strictEqual(parsedClosed.department, 'gang');

  // Channel name without trailing username still parses
  const bare = parseTicketChannel({
    id: 'c3',
    name: 'ticket-0012',
    topic: 'Ticket #12 | User: Sam (555555555555555555) | Status: open | Dept: Admin Team',
  }, DEPARTMENTS);
  assert.strictEqual(bare.id, 12);
  assert.strictEqual(bare.status, 'open');

  assert.strictEqual(parseTicketChannel({ id: 'x', name: 'general' }, DEPARTMENTS), null);
  assert.strictEqual(extractUserIdFromText('User: Kyle (123456789012345678)'), '123456789012345678');
  assert.strictEqual(extractUserIdFromText('<@123456789012345678>'), '123456789012345678');

  // ── simulate restart rebuild from Discord-shaped records ────────────────
  fs.writeFileSync(primary, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  try { fs.unlinkSync(bak); } catch { /* ignore */ }
  db._resetForTests();

  const channels = [
    {
      id: 'discord-1',
      name: 'ticket-0003-alice',
      topic: `Ticket #3 | User: alice (${ALICE}) | Status: closed | Dept: Community Assistant Team`,
    },
    {
      id: 'discord-2',
      name: 'closed-0004-bob',
      topic: `Ticket #4 | User: bob (${BOB}) | Status: open | Dept: Gang Team`,
    },
  ];

  for (const ch of channels) {
    const parsed = parseTicketChannel(ch, DEPARTMENTS);
    db.upsertTicket(parsed);
  }

  const openAlice = db.getOpenTicketByUser(ALICE);
  assert.ok(openAlice, 'alice ticket-* must be open after rebuild');
  assert.strictEqual(openAlice.id, 3);
  assert.strictEqual(db.getTicket(4).status, 'closed');
  assert.strictEqual(db.getOpenTicketByUser(BOB), null);

  // No leftover tmp files
  const tmps = fs.readdirSync(TEST_DIR).filter(f => f.includes('.tmp'));
  assert.deepStrictEqual(tmps, []);

  console.log('✅ All ticket persistence smoke tests passed');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('❌ Test failed:', err);
  cleanup();
  process.exit(1);
}
