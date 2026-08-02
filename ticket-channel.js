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

/** Discord snowflakes are 17–20 digit decimals */
function isSnowflake(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

/**
 * Status comes from the channel NAME prefix only.
 * `ticket-<digits>` => open, `closed-<digits>` => closed
 */
function statusFromChannelName(channelName) {
  if (!channelName) return null;
  if (/^closed-\d+/i.test(channelName)) return 'closed';
  if (/^ticket-\d+/i.test(channelName)) return 'open';
  return null;
}

/** True if the name is a parseable open/closed ticket channel */
function isTicketChannelName(channelName) {
  return /^(ticket|closed)-\d{1,10}(?:-|$)/i.test(channelName || '');
}

/**
 * Parse a staff ticket channel into a ticket record.
 * Channel names: ticket-0001-user / closed-0001-user
 * Topics: Ticket #1 | User: name (123456789012345678) | Status: open | Dept: Community Assistant Team
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
  // Strict: only accept User: name (snowflake)
  const userMatch = topic.match(/User:\s*(.+?)\s*\((\d{17,20})\)/i);
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

/**
 * Pull a Discord snowflake user id from known bot text shapes only.
 * Avoids false positives from random numbers in staff notes.
 */
function extractUserIdFromText(text) {
  if (!text) return null;
  const s = String(text);

  const patterns = [
    /User:\s*.+?\((\d{17,20})\)/i,
    /\*\*User:\*\*[^\n]*\((\d{17,20})\)/i,
    /Applicant:\s*.+?\((\d{17,20})\)/i,
    /<@!?(\d{17,20})>/,
    /`(\d{17,20})`/,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1] && isSnowflake(m[1])) return m[1];
  }
  return null;
}

module.exports = {
  departmentIdFromTopicName,
  statusFromChannelName,
  isTicketChannelName,
  parseTicketChannel,
  extractUserIdFromText,
  isSnowflake,
};
