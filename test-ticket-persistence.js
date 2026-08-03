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

const db = require('./database');
const {
  parseTicketChannel,
  departmentIdFromTopicName,
  statusFromChannelName,
  extractUserIdFromText,
  isTicketChannelName,
} = require('./ticket-channel');
const DEPARTMENTS = require('./departments.json');

const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const CAROL = '333333333333333333';

function cleanup() {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  // ── create + lookup ─────────────────────────────────────────────────────
  const t = db.createTicket(ALICE, 'alice');
  assert.strictEqual(t.status, 'open');
  db.setTicketChannel(t.id, 'chan-1');
  db.setTicketDepartment(t.id, 'community_assistant');

  assert.ok(db.getOpenTicketByUser(ALICE));
  assert.ok(db.getTicketByChannel('chan-1'));
  assert.ok(db.getTicket(t.id));
  assert.ok(db.getTicket(String(t.id)));

  // Duplicate open create returns existing
  const dup = db.createTicket(ALICE, 'alice');
  assert.strictEqual(dup.id, t.id);
  assert.strictEqual(dup._duplicate, true);

  // ── close / reopen ──────────────────────────────────────────────────────
  db.closeTicket(t.id);
  assert.strictEqual(db.getTicket(t.id).status, 'closed');
  assert.strictEqual(db.getOpenTicketByUser(ALICE), null);
  db.reopenTicket(t.id);
  assert.strictEqual(db.getTicket(t.id).status, 'open');

  // ── channelId uniqueness ────────────────────────────────────────────────
  const t2 = db.createTicket(BOB, 'bob');
  db.setTicketChannel(t2.id, 'chan-1'); // steal alice's channel
  assert.strictEqual(db.getTicket(t.id).channelId, null, 'previous owner must lose channelId');
  assert.strictEqual(db.getTicketByChannel('chan-1').id, t2.id);

  db.upsertTicket({
    id: t.id,
    userId: ALICE,
    username: 'alice',
    channelId: 'chan-1',
    status: 'open',
  });
  assert.strictEqual(db.getTicket(t2.id).channelId, null, 'upsert must clear other owners');
  assert.strictEqual(db.getTicketByChannel('chan-1').id, t.id);

  // ── deleteTicket rolls back orphans ─────────────────────────────────────
  const orphan = db.createTicket(CAROL, 'carol');
  assert.ok(db.deleteTicket(orphan.id));
  assert.strictEqual(db.getTicket(orphan.id), null);
  assert.strictEqual(db.getOpenTicketByUser(CAROL), null);

  // ── survives corrupt primary via bak ────────────────────────────────────
  const primary = path.join(TEST_DIR, 'tickets.json');
  const bak = path.join(TEST_DIR, 'tickets.json.bak');
  assert.ok(fs.existsSync(primary));
  assert.ok(fs.existsSync(bak), 'expected rolling .bak after writes');

  fs.writeFileSync(primary, '{not-json');
  db._resetForTests();
  const restoredAfterCorrupt = db.getOpenTicketByUser(ALICE);
  assert.ok(restoredAfterCorrupt, 'should restore open ticket from .bak after corrupt primary');
  assert.strictEqual(restoredAfterCorrupt.id, t.id);

  // ── empty primary with populated bak restores tickets ───────────────────
  fs.writeFileSync(primary, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  db._resetForTests();
  assert.ok(db.getOpenTicketByUser(ALICE), 'empty primary should fall back to non-empty .bak');

  // ── thinner non-empty primary loses to richer bak ───────────────────────
  const rich = {
    tickets: {
      '10': { id: 10, userId: ALICE, username: 'alice', channelId: 'c10', status: 'open', department: null, createdAt: new Date().toISOString(), closedAt: null },
      '11': { id: 11, userId: BOB, username: 'bob', channelId: 'c11', status: 'open', department: null, createdAt: new Date().toISOString(), closedAt: null },
    },
    counter: 11,
  };
  const thin = {
    tickets: {
      '10': { id: 10, userId: ALICE, username: 'alice', channelId: 'c10', status: 'closed', department: null, createdAt: new Date().toISOString(), closedAt: new Date().toISOString() },
    },
    counter: 10,
  };
  fs.writeFileSync(primary, JSON.stringify(thin, null, 2));
  fs.writeFileSync(bak, JSON.stringify(rich, null, 2));
  db._resetForTests();
  assert.strictEqual(db.getAllTickets().length, 2, 'richer bak must win over thinner primary');
  assert.ok(db.getOpenTicketByUser(BOB), 'bob open ticket from bak must survive');
  assert.strictEqual(db.getTicket(10).status, 'open');

  // ── upsert recovery after total wipe ────────────────────────────────────
  fs.writeFileSync(primary, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  fs.writeFileSync(bak, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  db._resetForTests();
  assert.strictEqual(db.getTicket(10), null);

  const restored = db.upsertTicket({
    id: 7,
    userId: ALICE,
    username: 'alice',
    channelId: 'chan-7',
    status: 'open',
    department: 'community_assistant',
  });
  assert.strictEqual(restored.id, 7);
  assert.ok(db.getOpenTicketByUser(ALICE));

  const next = db.createTicket(BOB, 'bob');
  assert.ok(next.id > 7, `expected next id > 7, got ${next.id}`);

  // ── channel parser: NAME wins over topic status ─────────────────────────
  assert.strictEqual(statusFromChannelName('ticket-0007-kyle'), 'open');
  assert.strictEqual(statusFromChannelName('closed-0008-kyle'), 'closed');
  assert.ok(isTicketChannelName('ticket-0007-kyle'));
  assert.ok(!isTicketChannelName('ticket-kyle'));
  assert.strictEqual(
    departmentIdFromTopicName(DEPARTMENTS, 'Community Assistant Team'),
    'community_assistant'
  );

  const parsedOpen = parseTicketChannel({
    id: 'c1',
    name: 'ticket-0007-kyle',
    topic: `Ticket #7 | User: Kyle Brown (${ALICE}) | Status: closed | Dept: Community Assistant Team`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }, DEPARTMENTS);
  assert.strictEqual(parsedOpen.id, 7);
  assert.strictEqual(parsedOpen.userId, ALICE);
  assert.strictEqual(parsedOpen.status, 'open', 'ticket-* must stay open even if topic says closed');
  assert.strictEqual(parsedOpen.department, 'community_assistant');

  const parsedClosed = parseTicketChannel({
    id: 'c2',
    name: 'closed-0008-kyle',
    topic: `Ticket #8 | User: Kyle (${BOB}) | Status: open | Dept: Gang Team`,
  }, DEPARTMENTS);
  assert.strictEqual(parsedClosed.status, 'closed');
  assert.strictEqual(parsedClosed.department, 'gang');

  const bare = parseTicketChannel({
    id: 'c3',
    name: 'ticket-0012',
    topic: `Ticket #12 | User: Sam (${CAROL}) | Status: open | Dept: Admin Team`,
  }, DEPARTMENTS);
  assert.strictEqual(bare.id, 12);
  assert.strictEqual(bare.status, 'open');

  assert.strictEqual(parseTicketChannel({ id: 'x', name: 'general' }, DEPARTMENTS), null);

  // Strict userId extraction — no false positives from short numbers
  assert.strictEqual(extractUserIdFromText(`User: Kyle (${ALICE})`), ALICE);
  assert.strictEqual(extractUserIdFromText(`**User:** Kyle (${ALICE})`), ALICE);
  assert.strictEqual(extractUserIdFromText(`<@${ALICE}>`), ALICE);
  assert.strictEqual(extractUserIdFromText(`\`${ALICE}\``), ALICE);
  assert.strictEqual(extractUserIdFromText('see note (12345)'), null);
  assert.strictEqual(extractUserIdFromText('random 123456789012345678 in text'), null);

  // ── simulate restart rebuild from Discord-shaped records ────────────────
  fs.writeFileSync(primary, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
  fs.writeFileSync(bak, JSON.stringify({ tickets: {}, counter: 0 }, null, 2));
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

  // ensureCounterAtLeast prevents ID collision after partial restore
  db.ensureCounterAtLeast(50);
  const after = db.createTicket(CAROL, 'carol');
  assert.ok(after.id > 50);

  // No leftover tmp files
  const tmps = fs.readdirSync(TEST_DIR).filter(f => f.includes('.tmp'));
  assert.deepStrictEqual(tmps, []);

  // ── claim / subject / activity / reopen guard ────────────────────────────
  const claimed = db.claimTicket(openAlice.id, '999', 'staff#1');
  assert.strictEqual(claimed.claimedBy, '999');
  const race = db.claimTicket(openAlice.id, '888', 'other#2');
  assert.strictEqual(race._error, 'claimed');
  assert.strictEqual(db.getTicket(openAlice.id).claimedBy, '999');
  const takeover = db.claimTicket(openAlice.id, '888', 'other#2', { force: true });
  assert.strictEqual(takeover.claimedBy, '888');
  assert.strictEqual(takeover._takeover, true);
  db.setTicketSubject(openAlice.id, 'Need help');
  assert.strictEqual(db.getTicket(openAlice.id).subject, 'Need help');
  db.touchTicketActivity(openAlice.id);
  assert.ok(db.getTicket(openAlice.id).lastActivityAt);

  // Close carol's open ticket from ensureCounterAtLeast section first
  db.closeTicket(after.id);
  const t3 = db.createTicket(CAROL, 'carol', 'other');
  db.closeTicket(t3.id);
  // Carol still has no other open — reopen OK
  const re1 = db.reopenTicket(t3.id);
  assert.strictEqual(re1.status, 'open');
  assert.ok(!re1._blocked);
  db.closeTicket(t3.id);

  // Block reopen when another open ticket exists for same user
  const openCarol = db.createTicket(CAROL, 'carol', 'second');
  assert.strictEqual(openCarol.status, 'open');
  const blocked = db.reopenTicket(t3.id);
  assert.strictEqual(blocked._blocked, true);
  assert.strictEqual(blocked._otherOpenId, openCarol.id);
  db.closeTicket(openCarol.id);

  const stats = db.getStats();
  assert.ok(stats.total >= 1);
  assert.ok('avgCloseMs' in stats);

  // Stale helper: brand-new tickets are not stale
  assert.strictEqual(db.getStaleOpenTickets(7).length, db.getAllTickets('open').filter(x => {
    const last = Date.parse(x.lastActivityAt || x.createdAt);
    return last <= Date.now() - 7 * 86400000;
  }).length);

  console.log('✅ All ticket persistence smoke tests passed');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('❌ Test failed:', err);
  cleanup();
  process.exit(1);
}
