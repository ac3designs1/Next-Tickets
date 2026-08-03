/**
 * Smoke tests for ticket ban list.
 * Run: node test-ticket-bans.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-bans-test-'));
process.env.DATA_DIR = TEST_DIR;

const banDb = require('./ticket-bans-db');

const ALICE = '111111111111111111';
const BOB = '222222222222222222';

function cleanup() {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  assert.strictEqual(banDb.isBanned(ALICE), false);
  assert.strictEqual(banDb.getBan(ALICE), null);
  assert.strictEqual(banDb.listBans().length, 0);

  const banned = banDb.banUser(ALICE, 'alice', 'Abuse', 'mod#0001');
  assert.strictEqual(banned.ok, true);
  assert.strictEqual(banDb.isBanned(ALICE), true);
  assert.strictEqual(banDb.getBan(ALICE).reason, 'Abuse');
  assert.strictEqual(banDb.getBan(ALICE).bannedBy, 'mod#0001');

  const dup = banDb.banUser(ALICE, 'alice', 'again', 'mod#0001');
  assert.strictEqual(dup.ok, false);

  banDb.banUser(BOB, 'bob', 'Spam', 'admin#0002');
  const list = banDb.listBans();
  assert.strictEqual(list.length, 2);
  assert.ok(list.every(b => b.userId === ALICE || b.userId === BOB));

  // Persist across reload
  delete require.cache[require.resolve('./ticket-bans-db')];
  const banDb2 = require('./ticket-bans-db');
  assert.strictEqual(banDb2.isBanned(ALICE), true);

  const unbanned = banDb2.unbanUser(ALICE);
  assert.strictEqual(unbanned.ok, true);
  assert.strictEqual(banDb2.isBanned(ALICE), false);

  const missing = banDb2.unbanUser(ALICE);
  assert.strictEqual(missing.ok, false);

  // Default reason
  banDb2.banUser(ALICE, 'alice', null, 'staff');
  assert.strictEqual(banDb2.getBan(ALICE).reason, 'No reason provided');

  console.log('✅ ticket-bans tests passed');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('❌ ticket-bans tests failed:', err);
  cleanup();
  process.exit(1);
}
