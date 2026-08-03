const fs = require('fs');
const path = require('path');

/**
 * Build a plain-text transcript from Discord channel messages (oldest first).
 */
function formatTranscript({ ticket, messages, closedBy }) {
  const lines = [
    `Ticket #${ticket.id} transcript`,
    `User: ${ticket.username || 'unknown'} (${ticket.userId})`,
    `Subject: ${ticket.subject || '(none)'}`,
    `Department: ${ticket.department || 'unassigned'}`,
    `Created: ${ticket.createdAt || 'unknown'}`,
    `Closed: ${ticket.closedAt || new Date().toISOString()}`,
    `Closed by: ${closedBy || 'unknown'}`,
    `Claimed by: ${ticket.claimedByTag || ticket.claimedBy || '(none)'}`,
    ''.padEnd(48, '─'),
    '',
  ];

  for (const msg of messages) {
    const ts = msg.createdAt ? msg.createdAt.toISOString() : '';
    const author = msg.author?.tag || msg.author?.username || 'unknown';
    // Strip staff outbound `%` prefix if an old raw reply is still in history
    let content = (msg.content || '').trim();
    if (content.startsWith('%')) content = content.slice(1).trim();
    const embedBits = (msg.embeds || [])
      .map(e => {
        const parts = [e.title, e.description, e.footer?.text].filter(Boolean);
        if (!parts.length) return null;
        const footer = e.footer?.text || '';
        const title = e.title || '';
        const label = /Delivered|Relay|Failed|Sent by/i.test(footer) || /Quick Reply/i.test(title)
          ? 'sent'
          : /Staff note|not sent to user/i.test(footer)
            ? 'note'
            : 'embed';
        return `[${label}] ${parts.join(' | ')}`;
      })
      .filter(Boolean);
    const attachments = [...(msg.attachments?.values?.() || msg.attachments || [])]
      .map(a => a.url || a.name)
      .filter(Boolean);

    const body = [
      content,
      ...embedBits,
      ...attachments.map(u => `[attachment] ${u}`),
    ].filter(Boolean).join('\n');

    if (!body) continue;
    lines.push(`[${ts}] ${author}`);
    lines.push(body);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Fetch up to `limit` messages from a channel (newest pages → chronological).
 */
async function fetchChannelMessages(channel, limit = 200) {
  const collected = [];
  let before;
  while (collected.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, limit - collected.length),
      ...(before ? { before } : {}),
    });
    if (!batch.size) break;
    const arr = [...batch.values()];
    collected.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  return collected.reverse();
}

/**
 * Save transcript under DATA_DIR/transcripts and return { text, filePath, fileName }.
 */
async function buildAndSaveTranscript({ ticket, channel, closedBy, dataDir }) {
  const messages = await fetchChannelMessages(channel, 300);
  const text = formatTranscript({ ticket, messages, closedBy });
  const dir = path.join(dataDir, 'transcripts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = `ticket-${String(ticket.id).padStart(4, '0')}-${Date.now()}.txt`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, text, 'utf8');
  return { text, filePath, fileName, messageCount: messages.length };
}

module.exports = {
  formatTranscript,
  fetchChannelMessages,
  buildAndSaveTranscript,
};
