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
 * Parse a staff ticket channel into a ticket record.
 * Channel names: ticket-0001-user / closed-0001-user
 * Topics: Ticket #1 | User: name (123) | Status: open | Dept: Community Assistant Team
 *
 * @param {{ id: string, name: string, topic?: string|null, createdAt?: Date }} channel
 * @param {Array<{id: string, name: string}>} departments
 */
function parseTicketChannel(channel, departments = []) {
  if (!channel?.name) return null;
  const nameMatch = channel.name.match(/^(ticket|closed)-(\d{1,10})-/i);
  if (!nameMatch) return null;

  const id = parseInt(nameMatch[2], 10);
  if (!Number.isFinite(id) || id < 1) return null;

  const topic = channel.topic || '';
  const userMatch = topic.match(/User:\s*(.+?)\s*\((\d{5,25})\)/i);
  const statusMatch = topic.match(/Status:\s*(open|closed)/i);
  const deptMatch = topic.match(/Dept:\s*(.+)$/i);

  const statusFromName = nameMatch[1].toLowerCase() === 'closed' ? 'closed' : 'open';
  const status = (statusMatch?.[1] || statusFromName).toLowerCase() === 'closed' ? 'closed' : 'open';

  return {
    id,
    userId: userMatch?.[2] || null,
    username: userMatch?.[1]?.trim() || channel.name.replace(/^(ticket|closed)-\d+-/, ''),
    channelId: channel.id,
    status,
    department: departmentIdFromTopicName(departments, deptMatch?.[1]),
    createdAt: channel.createdAt?.toISOString?.() || new Date().toISOString(),
    closedAt: status === 'closed' ? new Date().toISOString() : null,
  };
}

module.exports = {
  departmentIdFromTopicName,
  parseTicketChannel,
};
