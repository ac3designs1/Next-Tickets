/**
 * Pure helpers for parsing Discord ticket channels back into DB records.
 * Kept separate from index.js so recovery logic can be tested without Discord.
 */

/**
 * @param {Array<{id: string, name: string}>} departments
 * @param {string|null|undefined} deptName
 */
function departmentIdFromTopicName(departments, deptName) {
  if (!deptName) return null;
  const normalized = deptName.trim().toLowerCase();
  const hit = departments.find(d => d.name.toLowerCase() === normalized);
  if (hit) return hit.id;
  const byId = departments.find(d => d.id === normalized.replace(/\s+/g, '_'));
  return byId?.id ?? null;
}

/**
 * Status comes from the channel NAME prefix only.
 * `ticket-*` => open, `closed-*` => closed
 *
 * Topic "Status:" is intentionally ignored — it drifts when renames fail
 * under Discord rate limits and was causing open tickets to come back closed
 * after restarts.
 */
function statusFromChannelName(channelName) {
  if (!channelName) return null;
  if (/^closed-\d+/i.test(channelName)) return 'closed';
  if (/^ticket-\d+/i.test(channelName)) return 'open';
  return null;
}

/**
 * Parse a staff ticket channel into a ticket record.
 * Channel names: ticket-0001-user / closed-0001-user
 * Topics: Ticket #1 | User: name (123) | Status: open | Dept: Community Assistant Team
 *
 * @param {{ id: string, name: string, topic?: string|null, createdAt?: Date }} channel
 * @param {Array<{id: string, name: string}>} departments
 */
function parseTicketChannel(channel, departments = []) {
  if (!channel?.name) return null;
  const nameMatch = channel.name.match(/^(ticket|closed)-(\d{1,10})(?:-|$)/i);
  if (!nameMatch) return null;

  const id = parseInt(nameMatch[2], 10);
  if (!Number.isFinite(id) || id < 1) return null;

  const topic = channel.topic || '';
  const userMatch = topic.match(/User:\s*(.+?)\s*\((\d{5,25})\)/i);
  const deptMatch = topic.match(/Dept:\s*(.+)$/i);

  const status = statusFromChannelName(channel.name) || 'open';

  return {
    id,
    userId: userMatch?.[2] || null,
    username: userMatch?.[1]?.trim() || channel.name.replace(/^(ticket|closed)-\d+-?/i, '') || 'unknown',
    channelId: channel.id,
    status,
    department: departmentIdFromTopicName(departments, deptMatch?.[1]),
    createdAt: channel.createdAt?.toISOString?.() || new Date().toISOString(),
    closedAt: status === 'closed' ? new Date().toISOString() : null,
  };
}

/** Pull a Discord snowflake user id out of common bot embed/text shapes */
function extractUserIdFromText(text) {
  if (!text) return null;
  const patterns = [
    /User:\s*.+?\((\d{5,25})\)/i,
    /\((\d{5,25})\)/,
    /<@!?(\d{5,25})>/,
    /\b(\d{17,25})\b/,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

module.exports = {
  departmentIdFromTopicName,
  statusFromChannelName,
  parseTicketChannel,
  extractUserIdFromText,
};
