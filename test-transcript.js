/**
 * Smoke tests for transcript formatting.
 * Run: node test-transcript.js
 */
const assert = require('assert');
const { formatTranscript } = require('./transcript');

const ticket = {
  id: 7,
  userId: '111',
  username: 'alice',
  subject: 'Help please',
  department: 'community_assistant',
  createdAt: '2026-01-01T00:00:00.000Z',
  closedAt: '2026-01-02T00:00:00.000Z',
  claimedByTag: 'staff#1',
};

const messages = [
  {
    createdAt: new Date('2026-01-01T01:00:00.000Z'),
    author: { tag: 'alice#0001' },
    content: 'Hello staff',
    embeds: [],
    attachments: [],
  },
  {
    createdAt: new Date('2026-01-01T01:05:00.000Z'),
    author: { tag: 'Bot#0000' },
    content: '',
    embeds: [{ title: 'Staff reply', description: 'Hi!', footer: { text: 'Staff · Delivered ✅' } }],
    attachments: [],
  },
  {
    createdAt: new Date('2026-01-01T01:06:00.000Z'),
    author: { tag: 'mod#1' },
    content: '%Old style raw reply',
    embeds: [],
    attachments: [],
  },
];

const text = formatTranscript({ ticket, messages, closedBy: 'mod#1' });
assert.ok(text.includes('Ticket #7 transcript'));
assert.ok(text.includes('Help please'));
assert.ok(text.includes('Hello staff'));
assert.ok(text.includes('[sent] Staff reply | Hi! | Staff · Delivered ✅'));
assert.ok(text.includes('Old style raw reply'));
assert.ok(!text.includes('%Old style'));
assert.ok(text.includes('Closed by: mod#1'));

console.log('✅ transcript tests passed');
