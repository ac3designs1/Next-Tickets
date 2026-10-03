require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  MessageFlags,
  Colors,
  AttachmentBuilder,
} = require('discord.js');

const db      = require('./database');
const appDb   = require('./applications-db');
const crewDb  = require('./applications-db').createApplicationsDb('crew-applications');
const banDb   = require('./ticket-bans-db');
const qrDb    = require('./quick-replies-db');
const { buildAndSaveTranscript } = require('./transcript');
const { deployCommands } = require('./deploy-commands');
const {
  parseTicketChannel: parseTicketChannelRaw,
  extractUserIdFromText,
  statusFromChannelName,
  isTicketChannelName,
} = require('./ticket-channel');
const DEPARTMENTS  = require('./departments.json');

// Serialize boot reconcile vs ticket opens; per-user open locks prevent duplicates
let ticketsReady = Promise.resolve();
let resolveTicketsReady = null;
const openTicketLocks = new Map();

// Channel where submitted applications are posted (management-only channel in main guild)
const APPLICATIONS_CHANNEL_ID = process.env.APPLICATIONS_CHANNEL_ID || '1527645538244100136';
// Role that can action (accept/decline) applications
const APPLICATIONS_ROLE_ID = process.env.APPLICATIONS_ROLE_ID || '1515309451727470794'; // defaults to management role
// Crew applications mirror staff applications, with their own panel, database, and review channels.
const CREW_APPLICATIONS_CHANNEL_ID = process.env.CREW_APPLICATIONS_CHANNEL_ID || APPLICATIONS_CHANNEL_ID;
const CREW_APPLICATIONS_ROLE_ID = process.env.CREW_APPLICATIONS_ROLE_ID || APPLICATIONS_ROLE_ID;

const MANAGEMENT_DEPT = DEPARTMENTS.find(d => d.id === 'management') || null;
const ADMIN_DEPT = DEPARTMENTS.find(d => d.id === 'admin') || null;
const MANAGEMENT_ROLE_ID = MANAGEMENT_DEPT?.roleId || '1515309451727470794';
const ADMIN_ROLE_ID = ADMIN_DEPT?.roleId || '1515309068200185866';
const STALE_TICKET_DAYS = Math.max(1, Number(process.env.STALE_TICKET_DAYS) || 7);

/** Admin Team, Management Team, or Discord Administrator may manage ticket bans */
function canManageTicketBans(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = member.roles?.cache;
  if (!roles) return false;
  return roles.has(MANAGEMENT_ROLE_ID) || roles.has(ADMIN_ROLE_ID);
}

/** Any department role, default staff role, or Administrator */
function isStaffMember(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = member.roles?.cache;
  if (!roles) return false;
  if (process.env.DEFAULT_STAFF_ROLE_ID && roles.has(process.env.DEFAULT_STAFF_ROLE_ID)) return true;
  return DEPARTMENTS.some(d => roles.has(d.roleId));
}

/** Admin/Management may edit the shared quick-reply book */
function canManageQuickReplies(member) {
  return canManageTicketBans(member);
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(ms / (1000 * 60))}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// In-memory draft store for multi-step application forms: userId → partial answers
const applicationDrafts = new Map();

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a styled embed to a channel or DM */
function makeEmbed(opts = {}) {
  return new EmbedBuilder()
    .setColor(opts.color ?? Colors.Blurple)
    .setTitle(opts.title ?? null)
    .setDescription(opts.description ?? null)
    .setFooter(opts.footer ? { text: opts.footer } : null)
    .setTimestamp();
}

/** Try to DM a user; silently swallow errors if they have DMs off */
async function tryDM(userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a ticket's staff channel, fetching if not cached */
async function resolveTicketChannel(ticket) {
  if (!ticket?.channelId) return null;
  const staffGuild = await getStaffGuildAsync();
  if (!staffGuild) return null;
  return (
    staffGuild.channels.cache.get(ticket.channelId)
    ?? await staffGuild.channels.fetch(ticket.channelId).catch(() => null)
  );
}

/** Highest department role for a guild member (for reply branding) */
function getStaffRank(member) {
  let highestDept = null;
  if (member) {
    for (let i = DEPARTMENTS.length - 1; i >= 0; i--) {
      if (member.roles.cache.has(DEPARTMENTS[i].roleId)) {
        highestDept = DEPARTMENTS[i];
        break;
      }
    }
  }
  return {
    rankLabel: highestDept ? `${highestDept.emoji} ${highestDept.name}` : 'Staff',
    embedColor: highestDept?.color ?? Colors.Green,
    highestDept,
  };
}

/** Build file attachments from a Discord message for relay */
function filesFromMessage(message) {
  return [...message.attachments.values()].map(a => ({
    attachment: a.url,
    name: a.name || 'attachment',
  }));
}

/** Modal form used by /qr add and the Add Quick Reply button */
function buildQrAddModal() {
  const modal = new ModalBuilder()
    .setCustomId('qr_add_modal')
    .setTitle('Add Quick Reply');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('qr_id')
        .setLabel('Short ID (for commands)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. uwu_cafe')
        .setRequired(true)
        .setMaxLength(32)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('qr_label')
        .setLabel('Display name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. UwU Cafe Owners')
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('qr_message')
        .setLabel('Message sent to the user')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('The full reply text…')
        .setRequired(true)
        .setMaxLength(2000)
    ),
  );

  return modal;
}

/** Button row that opens the add-quick-reply modal */
function buildQrAddButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('qr_add_btn')
      .setLabel('Add Quick Reply')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('⚡')
  );
}

/**
 * DM a ticket/application user from staff.
 * Falls back to the ticket's main-server relay channel when DMs are closed.
 * Returns { dmSent, viaFallback, rankLabel, embedColor, staffDisplay, description }.
 * Callers post the in-channel delivery log themselves.
 */
async function sendStaffReplyToUser({
  targetUserId,
  content,
  member,
  author,
  contextLabel,
  files = [],
  ticket = null,
}) {
  const { rankLabel, embedColor } = getStaffRank(member);
  const staffDisplay = member?.displayName ?? author.username;
  const description = String(content || '').slice(0, 4096) || '*(no text)*';

  const userEmbed = makeEmbed({
    color: embedColor,
    title: null,
    description,
    footer: `${rankLabel}  ·  ${contextLabel}`,
  });
  userEmbed.setAuthor({ name: staffDisplay, iconURL: author.displayAvatarURL() });

  const payload = { embeds: [userEmbed] };
  if (files.length) payload.files = files;

  const dmSent = await tryDM(targetUserId, payload);
  if (dmSent) {
    return { dmSent: true, viaFallback: false, rankLabel, embedColor, staffDisplay, description };
  }

  // DM failed — try main-server fallback channel for tickets
  if (ticket) {
    const fallback = await ensureFallbackChannel(ticket);
    if (fallback) {
      try {
        await fallback.send({
          content: `<@${targetUserId}>`,
          embeds: [userEmbed],
          files: files.length ? files : undefined,
          allowedMentions: { users: [String(targetUserId)] },
        });
        return { dmSent: false, viaFallback: true, rankLabel, embedColor, staffDisplay, description };
      } catch (err) {
        console.error(`Fallback delivery failed for ticket #${ticket.id}:`, err.message);
      }
    }
  }

  return { dmSent: false, viaFallback: false, rankLabel, embedColor, staffDisplay, description };
}

/** Staff-channel log for a message that was (or tried to be) sent to the user. */
function buildSentToUserLogEmbed({
  embedColor,
  staffDisplay,
  author,
  description,
  title = null,
  deliveryLabel,
  contextLabel,
}) {
  const embed = makeEmbed({
    color: embedColor,
    title,
    description,
    footer: [deliveryLabel, contextLabel].filter(Boolean).join(' · '),
  });
  embed.setAuthor({
    name: staffDisplay,
    iconURL: typeof author.displayAvatarURL === 'function'
      ? author.displayAvatarURL()
      : author.displayAvatarURL,
  });
  return embed;
}

function deliveryFooterLabel(dmSent, viaFallback) {
  if (dmSent) return 'Delivered ✅';
  if (viaFallback) return 'Relay ✅';
  return 'Failed ❌';
}

/** Create/fetch a private relay channel in the main guild when user DMs are closed */
async function ensureFallbackChannel(ticket) {
  if (!ticket) return null;
  if (ticket.fallbackChannelId) {
    const existing = await client.channels.fetch(ticket.fallbackChannelId).catch(() => null);
    if (existing) return existing;
  }

  const mainGuildId = process.env.MAIN_GUILD_ID;
  if (!mainGuildId) return null;
  const mainGuild = client.guilds.cache.get(mainGuildId)
    || await client.guilds.fetch(mainGuildId).catch(() => null);
  if (!mainGuild) return null;

  try {
    const category = await getOrCreateCategory(mainGuild, '📩 Ticket Relay');
    const safeName = `ticket-${String(ticket.id).padStart(4, '0')}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 90);

    const channel = await mainGuild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Relay for ticket #${ticket.id} | User: ${ticket.username} (${ticket.userId})`,
      permissionOverwrites: [
        {
          id: mainGuild.roles.everyone,
          deny: [PermissionFlagsBits.ViewChannel],
          type: OverwriteType.Role,
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
          type: OverwriteType.Member,
        },
        {
          id: ticket.userId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
          type: OverwriteType.Member,
        },
        // Only add management overwrite when that role exists in the main guild
        ...(mainGuild.roles.cache.has(MANAGEMENT_ROLE_ID) ? [{
          id: MANAGEMENT_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          type: OverwriteType.Role,
        }] : []),
        ...(mainGuild.roles.cache.has(APPLICATIONS_ROLE_ID) && APPLICATIONS_ROLE_ID !== MANAGEMENT_ROLE_ID ? [{
          id: APPLICATIONS_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
          type: OverwriteType.Role,
        }] : []),
      ],
    });

    db.setFallbackChannel(ticket.id, channel.id);
    ticket.fallbackChannelId = channel.id;

    await channel.send({
      content: `<@${ticket.userId}>`,
      embeds: [makeEmbed({
        color: Colors.Orange,
        title: '📩 Ticket Relay Channel',
        description: [
          'Staff could not reach you via DM, so this private channel is your ticket inbox.',
          '',
          'Messages you send here go to staff. Staff replies will also appear here.',
          `**Ticket:** #${ticket.id}`,
          ticket.subject ? `**Subject:** ${ticket.subject}` : null,
        ].filter(Boolean).join('\n'),
      })],
      allowedMentions: { users: [String(ticket.userId)] },
    });

    return channel;
  } catch (err) {
    console.error(`Failed to create fallback channel for ticket #${ticket.id}:`, err.message);
    return null;
  }
}

/** Shared close flow: rename → transcript → DB close → notify → move */
async function finalizeTicketClose({
  channel,
  ticket,
  closedByTag,
  via = 'command',
  userMessage = null,
  notifyUser = true,
}) {
  const renamed = await applyTicketChannelStatus(channel, 'closed');
  if (!renamed) {
    return {
      ok: false,
      message: '❌ Could not rename the channel to `closed-…` (Discord rate limit?). Ticket left **open** — try again in a minute.',
    };
  }

  let transcriptFile = null;
  try {
    const built = await buildAndSaveTranscript({
      ticket,
      channel,
      closedBy: closedByTag,
      dataDir: db.getDataDir(),
    });
    transcriptFile = new AttachmentBuilder(Buffer.from(built.text, 'utf8'), { name: built.fileName });
  } catch (err) {
    console.error(`Transcript failed for ticket #${ticket.id}:`, err.message);
  }

  db.closeTicket(ticket.id);
  const closedTicket = { ...ticket, status: 'closed', claimedBy: ticket.claimedBy };
  await refreshTicketHeaderMessage(channel, closedTicket).catch(() => {});

  if (notifyUser) {
    const userEmbed = makeEmbed({
      color: via === 'stale' ? Colors.Orange : Colors.Red,
      title: via === 'stale' ? '🔒 Ticket Auto-Closed' : '🔒 Ticket Closed',
      description: userMessage || (
        via === 'stale'
          ? `Your ticket was closed after **${STALE_TICKET_DAYS} days** without activity.\n\nOpen a new ticket if you still need help.`
          : 'Your ticket has been closed by staff.\n\nIf you need further help, open a new ticket.'
      ),
    });
    const dmSent = await tryDM(ticket.userId, { embeds: [userEmbed] });
    if (!dmSent && ticket.fallbackChannelId) {
      const fallback = await client.channels.fetch(ticket.fallbackChannelId).catch(() => null);
      if (fallback) {
        await fallback.send({ content: `<@${ticket.userId}>`, embeds: [userEmbed] }).catch(() => {});
      }
    }
  }

  const closeEmbed = makeEmbed({
    color: Colors.Red,
    title: '🔒 Ticket Closed',
    description: `Closed by ${closedByTag}${via === 'button' ? ' (via button)' : via === 'stale' ? ' (auto — inactive)' : ''}`,
    footer: `Ticket #${ticket.id}`,
  });

  await channel.send({
    embeds: [closeEmbed],
    files: transcriptFile ? [transcriptFile] : undefined,
  });

  try {
    const closedCat = await getOrCreateCategory(channel.guild, '🔒 Closed Tickets');
    await channel.setParent(closedCat.id, { lockPermissions: false });
  } catch (err) {
    console.error('Close move failed:', err.message);
  }

  // Lock fallback relay if present
  if (ticket.fallbackChannelId) {
    try {
      const fallback = await client.channels.fetch(ticket.fallbackChannelId).catch(() => null);
      if (fallback) {
        await fallback.send({ embeds: [closeEmbed] }).catch(() => {});
        await fallback.setName(`closed-${String(ticket.id).padStart(4, '0')}`.slice(0, 100)).catch(() => {});
        await fallback.permissionOverwrites.edit(ticket.userId, {
          SendMessages: false,
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Fallback close cleanup failed:', err.message);
    }
  }

  return { ok: true, message: transcriptFile ? '✅ Ticket closed (transcript attached).' : '✅ Ticket closed.' };
}

/** Resolve staff guild member for cross-guild permission checks */
async function resolveStaffMember(userId) {
  const staffGuild = await getStaffGuildAsync();
  if (!staffGuild) return null;
  return staffGuild.members.fetch(userId).catch(() => null);
}

async function memberCanManageTicketBans(interaction) {
  if (canManageTicketBans(interaction.member)) return true;
  const staffMember = await resolveStaffMember(interaction.user.id);
  return canManageTicketBans(staffMember);
}

async function memberIsStaff(interaction) {
  if (isStaffMember(interaction.member)) return true;
  const staffMember = await resolveStaffMember(interaction.user.id);
  return isStaffMember(staffMember);
}

/** Resolve the staff guild from env (cache first) */
function getStaffGuild() {
  return client.guilds.cache.get(process.env.STAFF_GUILD_ID) || null;
}

/** Resolve staff guild, fetching if needed (startup / recovery paths) */
async function getStaffGuildAsync() {
  const id = process.env.STAFF_GUILD_ID;
  if (!id) return null;
  return (
    client.guilds.cache.get(id)
    || await client.guilds.fetch(id).catch(() => null)
  );
}

/** Create or fetch a named category in a guild */
async function getOrCreateCategory(guild, name) {
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (!category) {
    category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  }
  return category;
}

/** Get or create the Unassigned category for new tickets */
async function getUnassignedCategory(guild) {
  return getOrCreateCategory(guild, '📋 Unassigned Tickets');
}

/** Get or create a department-specific category */
async function getDeptCategory(guild, dept) {
  return getOrCreateCategory(guild, `${dept.emoji} ${dept.name}`);
}

/** Build permission overwrites for a ticket channel.
 *  Hierarchy: Management > Admin > other departments.
 *  - @everyone: denied
 *  - Bot: allowed
 *  - Management: always allowed
 *  - Admin: allowed on all tickets except Management-only ones
 *  - Assigned department role: allowed (if not already covered)
 *  - DEFAULT_STAFF_ROLE_ID: allowed only when unassigned
 */
function buildPermissionOverwrites(guild, departmentRoleId = null) {
  const allowedPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const overwrites = [
    {
      id: guild.roles.everyone,
      deny: [PermissionFlagsBits.ViewChannel],
      type: OverwriteType.Role,
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
      type: OverwriteType.Member,
    },
    // Management always sees every ticket
    {
      id: MANAGEMENT_ROLE_ID,
      allow: allowedPerms,
      type: OverwriteType.Role,
    },
  ];

  const isManagementTicket = departmentRoleId && departmentRoleId === MANAGEMENT_ROLE_ID;
  const isAdminTicket = departmentRoleId && departmentRoleId === ADMIN_ROLE_ID;

  // Admin sees everything below Management — not Management-only tickets
  if (ADMIN_ROLE_ID && ADMIN_ROLE_ID !== MANAGEMENT_ROLE_ID && !isManagementTicket) {
    overwrites.push({
      id: ADMIN_ROLE_ID,
      allow: allowedPerms,
      type: OverwriteType.Role,
    });
  }

  if (departmentRoleId && !isManagementTicket && !isAdminTicket) {
    // Lower department: that role + Admin + Management
    overwrites.push({
      id: departmentRoleId,
      allow: allowedPerms,
      type: OverwriteType.Role,
    });
  } else if (!departmentRoleId && process.env.DEFAULT_STAFF_ROLE_ID) {
    // Unassigned: general staff + Admin + Management
    overwrites.push({
      id: process.env.DEFAULT_STAFF_ROLE_ID,
      allow: allowedPerms,
      type: OverwriteType.Role,
    });
  }

  return overwrites;
}

/** Action row for open tickets: Claim/Unclaim + Close */
function buildTicketActionRow(ticket, { claimed = false, disabled = false } = {}) {
  const isClaimed = claimed || Boolean(ticket?.claimedBy);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(isClaimed ? `unclaim_ticket_${ticket.id}` : `claim_ticket_${ticket.id}`)
      .setLabel(isClaimed ? 'Unclaim' : 'Claim')
      .setStyle(isClaimed ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(isClaimed ? '🔓' : '🙋')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`close_ticket_${ticket.id}`)
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
      .setDisabled(disabled)
  );
}

/** Try to refresh the ticket header message buttons/claim status */
async function refreshTicketHeaderMessage(channel, ticket) {
  if (!channel || !ticket) return;
  try {
    const recent = await channel.messages.fetch({ limit: 30 });
    const header = recent.find(m =>
      m.author.id === client.user.id
      && m.embeds?.[0]?.title?.includes(`Ticket #${ticket.id}`)
      && m.components?.length > 0
    );
    if (!header) return;

    const embed = EmbedBuilder.from(header.embeds[0]);
    const claimLine = ticket.claimedBy
      ? `**Claimed:** <@${ticket.claimedBy}> (${ticket.claimedByTag || 'staff'})`
      : '**Claimed:** Unclaimed';
    const oldDesc = embed.data.description || '';
    const newDesc = oldDesc.replace(/\*\*Claimed:\*\*[^\n]*/i, claimLine);
    if (newDesc !== oldDesc) embed.setDescription(newDesc);

    const closed = ticket.status === 'closed';
    await header.edit({
      embeds: [embed],
      components: [buildTicketActionRow(ticket, { claimed: Boolean(ticket.claimedBy), disabled: closed })],
    });
  } catch (err) {
    console.error(`Header refresh failed for ticket #${ticket.id}:`, err.message);
  }
}

/**
 * Rename a ticket channel to match open/closed status.
 * Channel name is the durable source of truth across restarts.
 * @returns {Promise<boolean>} whether the channel name now matches the desired status
 */
async function applyTicketChannelStatus(channel, status) {
  if (!channel?.name || !isTicketChannelName(channel.name)) return false;
  const wantClosed = status === 'closed';
  const current = statusFromChannelName(channel.name);
  if (current === (wantClosed ? 'closed' : 'open')) return true;

  const nextName = wantClosed
    ? channel.name.replace(/^ticket-/i, 'closed-')
    : channel.name.replace(/^closed-/i, 'ticket-');

  if (nextName === channel.name || !isTicketChannelName(nextName)) return false;

  try {
    await channel.setName(nextName);
  } catch (err) {
    console.error(`Ticket channel rename failed (${channel.name} → ${nextName}):`, err.message);
    return false;
  }

  try {
    const topic = channel.topic || '';
    const nextTopic = wantClosed
      ? topic.replace(/Status:\s*open/i, 'Status: closed')
      : topic.replace(/Status:\s*closed/i, 'Status: open');
    if (nextTopic && nextTopic !== topic) await channel.setTopic(nextTopic);
  } catch { /* topic optional */ }

  return true;
}

/** Create a ticket channel in the staff guild */
async function createStaffChannel(ticket) {
  const guild = await getStaffGuildAsync();
  if (!guild) throw new Error('Staff guild not found — check STAFF_GUILD_ID in .env');

  // New tickets land in Community Assistant by default
  const defaultDept = DEPARTMENTS.find(d => d.id === 'community_assistant');
  const category = await getDeptCategory(guild, defaultDept);

  const channelName = `ticket-${String(ticket.id).padStart(4, '0')}-${ticket.username
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 16)}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Ticket #${ticket.id} | User: ${ticket.username} (${ticket.userId}) | Status: open | Dept: Community Assistant Team`,
    permissionOverwrites: buildPermissionOverwrites(guild, defaultDept.roleId),
  });

  return channel;
}

// ---------------------------------------------------------------------------
// Applications — question definitions (DM-based, 1 per message)
// ---------------------------------------------------------------------------
const APP_QUESTIONS = [
  // ── Section 1: General Info ──────────────────────────────────────────────
  { id: 'ign',          section: '📋 General Information',          label: 'What is your in-game name?',                                                                                         hint: 'e.g. John Smith' },
  { id: 'dob',          section: '📋 General Information',          label: 'What is your date of birth?',                                                                                        hint: 'e.g. 01/01/2000' },
  { id: 'country',      section: '📋 General Information',          label: 'What country do you live in?',                                                                                       hint: 'e.g. Australia' },
  { id: 'availability', section: '📋 General Information',          label: 'How many hours per week can you realistically dedicate to staff duties?',                                             hint: 'Be honest — e.g. 15–20 hrs/week' },
  // ── Section 2: Experience & Self-Assessment ──────────────────────────────
  { id: 'prevExp',      section: '🧠 Experience & Self-Assessment', label: 'What are your expectations of a staffing position?',                                                                  hint: '' },
  { id: 'whyServer',    section: '🧠 Experience & Self-Assessment', label: 'Why do you want to volunteer your time to becoming a member of the staff team?',                                       hint: '' },
  { id: 'modVsAdmin',   section: '🧠 Experience & Self-Assessment', label: 'Do you have previous moderating, staffing or community management experience? If so, please detail.',                  hint: '' },
  { id: 'qualities',    section: '🧠 Experience & Self-Assessment', label: 'How do you currently contribute to fostering a positive and fun role-play experience for members of our community?',   hint: '' },
  { id: 'rpExperience', section: '🧠 Experience & Self-Assessment', label: 'Please provide an overview of your role-play experience across FiveM.',                                               hint: '' },
  // ── Section 3: Scenario Questions ───────────────────────────────────────
  { id: 'scenarioA',      section: '⚠️ Scenario Questions',         label: 'Scenario A: You are in a sit with two players who are screaming over each other and trading OOC insults. Neither is letting the other speak. How do you de-escalate and resolve this?', hint: '' },
  { id: 'scenarioB',      section: '⚠️ Scenario Questions',         label: 'Scenario B: A close friend of yours on the server is caught clearly breaking a major rule (such as Combat Logging or VDM). No other staff are online. How do you handle this?',        hint: 'We are testing for bias — be honest.' },
  { id: 'scenarioC',      section: '⚠️ Scenario Questions',         label: 'Scenario C: You spectate a player suspected of using external cheats (e.g. aimbot or menu-injecting). What steps do you take to confirm your suspicions before taking action?',        hint: '' },
  { id: 'scenarioD',      section: '⚠️ Scenario Questions',         label: 'Scenario D: A player submits a clip showing a rule break, but the clip is only 15 seconds long and does not show the context leading up to the event. They demand an immediate ban. What is your response?', hint: '' },
  { id: 'scenarioE',      section: '⚠️ Scenario Questions',         label: 'Scenario E: An admin higher in rank than you makes a decision during an active scene that clearly violates the server\'s established rules. How do you handle this?',                  hint: 'Think carefully about chain of command.' },
  // ── Section 4: Rules & Knowledge ────────────────────────────────────────
  { id: 'rulesFailFear',  section: '📖 Rules & Knowledge',          label: 'Briefly define FailRP and FearRP, and give an in-game example of each.',                                              hint: 'Format: FailRP: [definition + example] | FearRP: [definition + example]' },
  { id: 'rulesMetaPower', section: '📖 Rules & Knowledge',          label: 'Briefly define Meta-gaming and Power-gaming, and give an in-game example of each.',                                  hint: '' },
  { id: 'rulesRdmNlr',    section: '📖 Rules & Knowledge',          label: 'Briefly define RDM, VDM and the New Life Rule (NLR), and give an in-game example of each.',                          hint: '' },
];

/** Long-form answer fields shown as their own embeds (avoids Discord's 6000-char multi-embed limit) */
const APP_ANSWER_FIELDS = [
  { id: 'prevExp',        title: 'Expectations of a staffing position' },
  { id: 'whyServer',      title: 'Why volunteer for the staff team?' },
  { id: 'modVsAdmin',     title: 'Previous moderating / staffing experience' },
  { id: 'qualities',      title: 'How you contribute to positive RP' },
  { id: 'rpExperience',   title: 'FiveM role-play experience overview', fallbackIds: ['stressHandling'] },
  { id: 'scenarioA',      title: 'Scenario A — OOC sit, players screaming' },
  { id: 'scenarioB',      title: 'Scenario B — Close friend breaking a major rule' },
  { id: 'scenarioC',      title: 'Scenario C — Suspected cheater' },
  { id: 'scenarioD',      title: 'Scenario D — Short clip, demands instant ban' },
  { id: 'scenarioE',      title: 'Scenario E — Senior admin breaks server rules' },
  { id: 'rulesFailFear',  title: 'FailRP & FearRP' },
  { id: 'rulesMetaPower', title: 'Meta-gaming & Power-gaming' },
  { id: 'rulesRdmNlr',    title: 'RDM, VDM & New Life Rule (NLR)' },
];

function getAppAnswer(app, field) {
  if (app[field.id] != null && String(app[field.id]).trim() !== '') return app[field.id];
  for (const alt of field.fallbackIds ?? []) {
    if (app[alt] != null && String(app[alt]).trim() !== '') return app[alt];
  }
  return '—';
}

/** Same interview as staff, worded for a crew position. */
const CREW_QUESTIONS = APP_QUESTIONS.map(q => {
  if (q.id === 'availability') {
    return { ...q, label: 'How many hours per week can you realistically dedicate to crew duties?' };
  }
  if (q.id === 'prevExp') {
    return { ...q, label: 'What are your expectations of a crew position?' };
  }
  if (q.id === 'whyServer') {
    return { ...q, label: 'Why do you want to volunteer your time to becoming a member of the crew?' };
  }
  if (q.id === 'modVsAdmin') {
    return { ...q, label: 'Do you have previous moderating, crew, or community management experience? If so, please detail.' };
  }
  if (q.id === 'scenarioB') {
    return { ...q, label: q.label.replace('No other staff are online', 'No other crew members are online') };
  }
  return q;
});

const CREW_ANSWER_FIELDS = APP_ANSWER_FIELDS.map(field => {
  if (field.id === 'prevExp') return { ...field, title: 'Expectations of a crew position' };
  if (field.id === 'whyServer') return { ...field, title: 'Why volunteer for the crew?' };
  if (field.id === 'modVsAdmin') return { ...field, title: 'Previous moderating / crew experience' };
  return field;
});

const APPLICATION_PROFILES = {
  staff: {
    key: 'staff',
    db: appDb,
    questions: APP_QUESTIONS,
    answerFields: APP_ANSWER_FIELDS,
    idPrefix: 'APP',
    channelPrefix: 'app',
    categoryName: '📋 Staff Applications',
    panelButtonId: 'apply_staff_panel',
    actionPrefix: 'app',
    commandName: 'applications',
    panelChannelEnv: 'APPLICATIONS_PANEL_CHANNEL_ID',
    logChannelId: () => APPLICATIONS_CHANNEL_ID,
    roleId: () => APPLICATIONS_ROLE_ID,
    color: 0x5865F2,
    dmTitle: '📋  Next RP — Staff Application',
    welcomeLead: '**Welcome! You\'re about to complete a staff application.**',
    applyAgainLabel: 'Apply for Staff',
    completeFooter: 'Next RP Staff Team',
    panelTitleOpen: '📋 Staff Applications',
    panelTitleClosed: '📋 Staff Applications — Closed',
    panelOpenBody: [
      '**Next RP is looking for dedicated staff members!**',
      '',
      'Click the button below to submit your application.',
      'Our management team will review it and get back to you.',
      '',
      '> Make sure your DMs are open so we can contact you.',
    ].join('\n'),
    panelClosedBody: [
      '**Applications are currently closed.**',
      '',
      'We are not accepting new staff applications at this time.',
      'Check back later or keep an eye on announcements.',
    ].join('\n'),
    panelButtonLabel: 'Apply for Staff',
    overviewKind: 'Staff Application',
    overviewFooter: 'Next RP  ·  Staff Applications',
    reviewIntro: roleId => `<@&${roleId}>  —  Staff application ready for review.`,
    receivedLine: 'Your staff application for **Next RP** has been received and is currently under review.',
    logTitle: '📋 New Staff Application',
    logLine: 'has submitted a staff application.',
    acceptedLine: 'Your staff application for **Next RP** has been accepted.',
    declinedLine: 'Unfortunately your staff application for **Next RP** was not successful at this time.',
    holdLine: 'Management is still reviewing your staff application for **Next RP**.',
    openReply: '✅ Staff applications are now **open**. The panel has been updated.',
    closeReply: '✅ Staff applications are now **closed**. The panel has been updated.',
    listTitle: '📋 Applications',
  },
  crew: {
    key: 'crew',
    db: crewDb,
    questions: CREW_QUESTIONS,
    answerFields: CREW_ANSWER_FIELDS,
    idPrefix: 'CREW',
    channelPrefix: 'crew',
    categoryName: '👥 Crew Applications',
    panelButtonId: 'apply_crew_panel',
    actionPrefix: 'crew',
    commandName: 'crew-applications',
    panelChannelEnv: 'CREW_APPLICATIONS_PANEL_CHANNEL_ID',
    logChannelId: () => CREW_APPLICATIONS_CHANNEL_ID,
    roleId: () => CREW_APPLICATIONS_ROLE_ID,
    color: 0x57F287,
    dmTitle: '👥  Next RP — Crew Application',
    welcomeLead: '**Welcome! You\'re about to complete a crew application.**',
    applyAgainLabel: 'Apply for Crew',
    completeFooter: 'Next RP Crew',
    panelTitleOpen: '👥 Crew Applications',
    panelTitleClosed: '👥 Crew Applications — Closed',
    panelOpenBody: [
      '**Next RP is looking for dedicated crew members!**',
      '',
      'Click the button below to submit your application.',
      'Our management team will review it and get back to you.',
      '',
      '> Make sure your DMs are open so we can contact you.',
    ].join('\n'),
    panelClosedBody: [
      '**Applications are currently closed.**',
      '',
      'We are not accepting new crew applications at this time.',
      'Check back later or keep an eye on announcements.',
    ].join('\n'),
    panelButtonLabel: 'Apply for Crew',
    overviewKind: 'Crew Application',
    overviewFooter: 'Next RP  ·  Crew Applications',
    reviewIntro: roleId => `<@&${roleId}>  —  Crew application ready for review.`,
    receivedLine: 'Your crew application for **Next RP** has been received and is currently under review.',
    logTitle: '👥 New Crew Application',
    logLine: 'has submitted a crew application.',
    acceptedLine: 'Your crew application for **Next RP** has been accepted.',
    declinedLine: 'Unfortunately your crew application for **Next RP** was not successful at this time.',
    holdLine: 'Management is still reviewing your crew application for **Next RP**.',
    openReply: '✅ Crew applications are now **open**. The panel has been updated.',
    closeReply: '✅ Crew applications are now **closed**. The panel has been updated.',
    listTitle: '👥 Crew Applications',
  },
};

const STAFF_APP = APPLICATION_PROFILES.staff;
const CREW_APP = APPLICATION_PROFILES.crew;

function applicationTag(profile, id) {
  return `${profile.idPrefix}-${id}`;
}

/**
 * Run the full application as a DM conversation.
 * Returns the completed answers object, or null if cancelled/timed out.
 */
async function runApplicationInDM(profile, user) {
  let dm;
  try { dm = await user.createDM(); } catch {
    return null; // DMs disabled
  }

  const questions = profile.questions;
  const TIMEOUT = 45 * 60 * 1000; // 45 minutes per question
  const total   = questions.length;

  await dm.send({ embeds: [
    new EmbedBuilder()
      .setColor(profile.color)
      .setTitle(profile.dmTitle)
      .setDescription(
        `${profile.welcomeLead}\n\n` +
        `There are **${total} questions** across 4 sections.\n` +
        'Simply send your answer as a message after each question appears.\n\n' +
        '> Type `cancel` at any time to cancel your application.\n' +
        '> You have **45 minutes** to answer each question.'
      )
      .setFooter({ text: 'Your answers will be reviewed by management.' })
      .setTimestamp(),
  ]});

  const answers = {};

  for (let i = 0; i < total; i++) {
    const q = questions[i];

    // Section header when section changes
    const prevSection = i > 0 ? questions[i - 1].section : null;
    if (q.section !== prevSection) {
      await dm.send({ embeds: [
        new EmbedBuilder()
          .setColor(0x23272A)
          .setDescription(`**${q.section}**`),
      ]});
    }

    // Send the question
    await dm.send({ embeds: [
      new EmbedBuilder()
        .setColor(profile.color)
        .setTitle(`Question ${i + 1} of ${total}`)
        .setDescription(`**${q.label}**${q.hint ? `\n\n*${q.hint}*` : ''}`)
        .setFooter({ text: `${q.section}  ·  ${total - i - 1} question${total - i - 1 !== 1 ? 's' : ''} remaining after this` }),
    ]});

    // Wait for the user's reply
    let collected;
    try {
      collected = await dm.awaitMessages({
        filter: m => m.author.id === user.id,
        max: 1,
        time: TIMEOUT,
        errors: ['time'],
      });
    } catch {
      await dm.send({ embeds: [makeEmbed({
        color: Colors.Red,
        title: '⏰  Application Timed Out',
        description: `Your application has been cancelled due to inactivity.\nClick **${profile.applyAgainLabel}** again whenever you're ready.`,
      })]});
      return null;
    }

    const answer = collected.first().content.trim();

    if (answer.toLowerCase() === 'cancel') {
      await dm.send({ embeds: [makeEmbed({
        color: Colors.Red,
        title: '❌  Application Cancelled',
        description: `Your application has been cancelled.\nYou can click **${profile.applyAgainLabel}** again at any time.`,
      })]});
      return null;
    }

    answers[q.id] = answer;

    // Acknowledge (not on last question)
    if (i < total - 1) {
      await dm.send(`✅  Got it — moving to question **${i + 2}** of **${total}**…`);
    }
  }

  // All done
  await dm.send({ embeds: [makeEmbed({
    color: Colors.Green,
    title: '🎉  Application Complete!',
    description: 'All questions answered. Your application has been submitted and will be reviewed by management.\n\n> Make sure your DMs stay open so we can contact you with a decision.',
    footer: profile.completeFooter,
  })]});

  return answers;
}

// ---------------------------------------------------------------------------
// Applications helpers
// ---------------------------------------------------------------------------

/** Create a dedicated application channel in the staff guild */
async function createApplicationChannel(profile, app) {
  const guild = getStaffGuild();
  if (!guild) throw new Error('Staff guild not found');

  const category = await getOrCreateCategory(guild, profile.categoryName);
  const roleId = profile.roleId();

  const safeName = app.username.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 16) || 'applicant';
  const channelName = `${profile.channelPrefix}-${app.id}-${safeName}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Application ${applicationTag(profile, app.id)} | Applicant: ${app.username} (${app.userId}) | Status: pending`,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
      { id: client.user.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages], type: OverwriteType.Member },
      { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory], type: OverwriteType.Role },
    ],
  });

  return channel;
}

/** Build the apply-panel message payload for a staff or crew profile */
function buildApplicationPanelPayload(profile, open = true) {
  const embed = makeEmbed({
    color: open ? profile.color : 0x747F8D,
    title: open ? profile.panelTitleOpen : profile.panelTitleClosed,
    description: open ? profile.panelOpenBody : profile.panelClosedBody,
    footer: open ? 'Applications are open' : 'Applications are closed',
  });

  const button = new ButtonBuilder()
    .setCustomId(profile.panelButtonId)
    .setLabel(open ? profile.panelButtonLabel : 'Applications Closed')
    .setStyle(open ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setEmoji(open ? (profile.key === 'crew' ? '👥' : '📋') : '🔒')
    .setDisabled(!open);

  const row = new ActionRowBuilder().addComponents(button);
  return { embeds: [embed], components: [row] };
}

/**
 * Build the overview embed for an application (status header + short bio fields).
 * Long answers are posted separately — Discord caps ALL embeds in one message at 6000 chars,
 * so packing every answer into one message was silently failing for detailed applications.
 */
function buildApplicationOverviewEmbed(profile, app, status = 'pending') {
  const statusMeta = {
    pending:  { color: 0xFEE75C, label: '⏳  Pending Review'  },
    accepted: { color: 0x57F287, label: '✅  Accepted'         },
    declined: { color: 0xED4245, label: '❌  Declined'         },
    hold:     { color: 0xEB459E, label: '🕐  On Hold'          },
  };
  const { color, label } = statusMeta[status] ?? statusMeta.pending;
  const ts = Math.floor(new Date(app.submittedAt).getTime() / 1000);
  const trim = (s, n = 256) => String(s ?? '—').slice(0, n);
  const dob = app.dob ?? app.dobTimezone;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${applicationTag(profile, app.id)}  ·  ${profile.overviewKind}`)
    .setDescription(
      [
        `### ${label}`,
        ``,
        `**Applicant**   <@${app.userId}>  ·  \`${app.username}\``,
        `**In-Game Name**   ${trim(app.ign, 64)}`,
        `**Date of Birth**   ${trim(dob, 64)}`,
        `**Country**   ${trim(app.country, 64)}`,
        `**Weekly Availability**   ${trim(app.availability, 64)}`,
        ``,
        `Submitted <t:${ts}:F>  ·  <t:${ts}:R>`,
        app.reviewedBy ? `Reviewed by **${app.reviewedBy}**` : null,
      ].filter(Boolean).join('\n')
    )
    .setFooter({ text: profile.overviewFooter })
    .setTimestamp();
}

/** One embed per answer — stays well under Discord limits even for max-length replies */
function buildApplicationAnswerEmbeds(profile, app) {
  return profile.answerFields.map(field => {
    const answer = String(getAppAnswer(app, field)).slice(0, 4096) || '—';
    return new EmbedBuilder()
      .setColor(0x23272A)
      .setTitle(field.title.slice(0, 256))
      .setDescription(answer)
      .setFooter({ text: applicationTag(profile, app.id) });
  });
}

/** @deprecated kept for any callers expecting the old multi-embed array */
function buildApplicationEmbeds(profile, app, status = 'pending') {
  return [buildApplicationOverviewEmbed(profile, app, status), ...buildApplicationAnswerEmbeds(profile, app)];
}

/**
 * Post overview, each answer, then a dedicated action-button message.
 * Buttons are on their own short message so they still appear even if an answer post fails.
 */
async function postApplicationReviewMessages(profile, appChannel, app) {
  const status = app.status || 'pending';
  const tag = applicationTag(profile, app.id);

  await appChannel.send({
    content: [
      profile.reviewIntro(profile.roleId()),
      ``,
      `**Applicant:** <@${app.userId}>`,
      `**Application ID:** \`${tag}\``,
      `**Status:** \`${status}\``,
      ``,
      `Use the buttons at the bottom of this channel to accept, decline, or place on hold.`,
    ].join('\n'),
  });

  await appChannel.send({ embeds: [buildApplicationOverviewEmbed(profile, app, status)] });

  for (const embed of buildApplicationAnswerEmbeds(profile, app)) {
    try {
      await appChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error(`Failed to post answer embed for ${tag}:`, err.message);
      await appChannel.send({
        content: `⚠️ Could not display **${embed.data.title}** (Discord limit). Answer is still saved in the bot database.`,
      }).catch(() => {});
    }
  }

  const buttons = buildApplicationButtons(profile, app.id, status);
  const msg = await appChannel.send({
    content: `**${tag}** — Accept, decline, or place this application on hold:`,
    components: [buttons],
  });
  profile.db.setChannelMessage(app.id, appChannel.id, msg.id);
  return msg;
}

/** Build the action row buttons for an application */
function buildApplicationButtons(profile, appId, status = 'pending') {
  const prefix = profile.actionPrefix;
  if (status !== 'pending' && status !== 'hold') {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${prefix}_noop_${appId}`)
        .setLabel('Application Reviewed')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔒')
        .setDisabled(true)
    );
  }

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}_accept_${appId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`${prefix}_decline_${appId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
    new ButtonBuilder()
      .setCustomId(`${prefix}_hold_${appId}`)
      .setLabel('Place on Hold')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🕐'),
  );
}

function memberCanManageApplications(interaction, profile) {
  return interaction.member?.roles?.cache?.has(profile.roleId())
    || interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
}

async function refreshApplicationPanel(profile, open) {
  const panelChId = process.env[profile.panelChannelEnv];
  if (!panelChId) return;
  try {
    const ch = await client.channels.fetch(panelChId);
    const msgs = await ch.messages.fetch({ limit: 20 });
    const panel = msgs.find(m => m.author.id === client.user.id && m.components?.length > 0
      && m.components[0]?.components?.some(c => c.customId === profile.panelButtonId));
    if (panel) await panel.edit(buildApplicationPanelPayload(profile, open));
  } catch { /* panel channel may not exist */ }
}

function applicationProfileFromCustomId(customId) {
  for (const profile of [STAFF_APP, CREW_APP]) {
    if (customId === profile.panelButtonId) return profile;
    if (
      customId.startsWith(`${profile.actionPrefix}_accept_`)
      || customId.startsWith(`${profile.actionPrefix}_decline_`)
      || customId.startsWith(`${profile.actionPrefix}_hold_`)
    ) return profile;
  }
  return null;
}

function parseApplicationAction(profile, customId) {
  const prefixes = [
    [`${profile.actionPrefix}_accept_`, 'accepted'],
    [`${profile.actionPrefix}_decline_`, 'declined'],
    [`${profile.actionPrefix}_hold_`, 'hold'],
  ];
  for (const [prefix, action] of prefixes) {
    if (!customId.startsWith(prefix)) continue;
    const appId = String(customId.slice(prefix.length) || '').replace(new RegExp(`^${profile.idPrefix}-`, 'i'), '').trim();
    return { action, appId };
  }
  return null;
}

async function handleApplicationsCommand(interaction, profile) {
  const sub = interaction.options.getSubcommand();
  const store = profile.db;

  if (!memberCanManageApplications(interaction, profile)) {
    return interaction.reply({ content: '❌ You do not have permission to manage applications.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'open') {
    store.setOpen(true);
    await refreshApplicationPanel(profile, true);
    return interaction.reply({ content: profile.openReply, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'close') {
    store.setOpen(false);
    await refreshApplicationPanel(profile, false);
    return interaction.reply({ content: profile.closeReply, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'setup') {
    await interaction.channel.send(buildApplicationPanelPayload(profile, store.isOpen()));
    return interaction.reply({ content: '✅ Applications panel posted!', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'list') {
    const statusFilter = interaction.options.getString('status') ?? null;
    const apps = store.getAllApplications(statusFilter);

    if (!apps.length) {
      return interaction.reply({ content: `No applications found${statusFilter ? ` with status **${statusFilter}**` : ''}.`, flags: MessageFlags.Ephemeral });
    }

    const lines = apps.slice(-20).map(a => {
      const ch = a.channelId ? ` · <#${a.channelId}>` : ' · ⚠️ no channel';
      return `**${applicationTag(profile, a.id)}** · ${a.username} · ${a.ign ?? '—'} · \`${a.status}\`${ch} · <t:${Math.floor(new Date(a.submittedAt).getTime() / 1000)}:R>`;
    });

    const embed = makeEmbed({
      color: profile.color,
      title: `${profile.listTitle}${statusFilter ? ` — ${statusFilter}` : ''}`,
      description: lines.join('\n'),
      footer: `${apps.length} total${statusFilter ? ` · filtered by ${statusFilter}` : ''} · Use /${profile.commandName} review id:<id> to restore buttons`,
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const idPattern = new RegExp(`^${profile.idPrefix}-`, 'i');

  if (sub === 'review') {
    const rawId = interaction.options.getString('id', true).replace(idPattern, '').trim();
    const app = store.getApplication(rawId);
    if (!app) {
      return interaction.reply({ content: `❌ Application \`${applicationTag(profile, rawId)}\` not found.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await postApplicationReviewMessages(profile, interaction.channel, app);
      return interaction.editReply({
        content: `✅ Re-posted **${applicationTag(profile, app.id)}** (\`${app.status}\`) with answers and action buttons in this channel.`,
      });
    } catch (err) {
      console.error('Failed to re-post application:', err.message);
      return interaction.editReply({ content: `❌ Failed to re-post: ${err.message}` });
    }
  }

  if (sub === 'reopen') {
    const rawId = interaction.options.getString('id', true).replace(idPattern, '').trim();
    const app = store.getApplication(rawId);
    if (!app) {
      return interaction.reply({ content: `❌ Application \`${applicationTag(profile, rawId)}\` not found.`, flags: MessageFlags.Ephemeral });
    }

    const previous = app.status;
    store.reopenApplication(rawId);

    return interaction.reply({
      content: `✅ **${applicationTag(profile, rawId)}** reopened (was \`${previous}\`). You can Accept / Decline / Hold it again.\nTip: run \`/${profile.commandName} review id:${rawId}\` in the app channel to refresh the buttons.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function startApplicationFromPanel(interaction, profile) {
  const store = profile.db;
  if (!store.isOpen()) {
    return interaction.reply({ content: '❌ Applications are currently closed. Check back later!', flags: MessageFlags.Ephemeral });
  }
  if (applicationDrafts.has(interaction.user.id)) {
    return interaction.reply({ content: '❌ You already have an application in progress — check your DMs to continue.', flags: MessageFlags.Ephemeral });
  }
  if (store.hasPendingApplication(interaction.user.id)) {
    const existing = store.getAllApplications().find(
      a => a.userId === interaction.user.id && (a.status === 'pending' || a.status === 'hold')
    );
    const statusLine = existing?.status === 'hold'
      ? 'Your application is currently **on hold** — management may reach out with questions.'
      : 'Your application is currently **under review** — you will be notified once a decision is made.';
    return interaction.reply({
      embeds: [makeEmbed({
        color: 0xFEE75C,
        title: 'You Already Have an Open Application',
        description: `${statusLine}\n\nYou cannot submit a new application until your current one has been resolved.`,
        footer: existing ? applicationTag(profile, existing.id) : null,
      })],
      flags: MessageFlags.Ephemeral,
    });
  }

  try { await interaction.user.createDM(); } catch {
    return interaction.reply({ content: '❌ I couldn\'t DM you. Please enable DMs from server members and try again.', flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({ content: '📨  Check your DMs! Your application has started.', flags: MessageFlags.Ephemeral });
  applicationDrafts.set(interaction.user.id, { inProgress: true, kind: profile.key });

  runApplicationInDM(profile, interaction.user).then(async answers => {
    applicationDrafts.delete(interaction.user.id);
    if (!answers) return;

    const app = store.createApplication(interaction.user.id, interaction.user.tag, answers);

    try {
      const appChannel = await createApplicationChannel(profile, app);
      await postApplicationReviewMessages(profile, appChannel, app);

      await tryDM(app.userId, {
        embeds: [makeEmbed({
          color: profile.color,
          title: '📋  Application Received',
          description: [
            `### Thanks for applying, ${app.username.split('#')[0]}!`,
            ``,
            profile.receivedLine,
            `You will receive a DM here once a decision has been made.`,
            ``,
            `> Keep your DMs open so we can reach you.`,
          ].join('\n'),
          footer: `${applicationTag(profile, app.id)}  ·  Next RP`,
        })],
      });

      const logChannelId = profile.logChannelId();
      if (logChannelId) {
        try {
          const staffGuild = getStaffGuild();
          const logChannel = staffGuild
            ? (staffGuild.channels.cache.get(logChannelId) ?? await staffGuild.channels.fetch(logChannelId))
            : await client.channels.fetch(logChannelId);
          await logChannel.send({
            embeds: [makeEmbed({
              color: profile.color,
              title: profile.logTitle,
              description: `**${app.username}** ${profile.logLine}\n\n> View it in <#${appChannel.id}>`,
              footer: applicationTag(profile, app.id),
            })],
          });
        } catch { /* log channel optional */ }
      }
    } catch (err) {
      console.error('Failed to create application channel:', err.message);
      try {
        const logChannelId = profile.logChannelId();
        if (logChannelId) {
          const staffGuild = getStaffGuild();
          const logChannel = staffGuild
            ? (staffGuild.channels.cache.get(logChannelId) ?? await staffGuild.channels.fetch(logChannelId))
            : await client.channels.fetch(logChannelId);
          await logChannel.send({
            content: `⚠️ **${applicationTag(profile, app.id)}** from **${app.username}** was saved but the review channel failed to post.\nError: \`${err.message}\`\nUse \`/${profile.commandName} list\` to see it — restart/redeploy may be needed to recover the channel.`,
          });
        }
      } catch { /* best effort */ }
    }
  }).catch(err => {
    applicationDrafts.delete(interaction.user.id);
    console.error('Application DM flow error:', err.message);
  });
}

async function handleApplicationDecision(interaction, profile) {
  if (!memberCanManageApplications(interaction, profile)) {
    return interaction.reply({ content: '❌ Only management can action applications.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const parsed = parseApplicationAction(profile, interaction.customId);
  const action = parsed?.action;
  const appId = parsed?.appId || '';
  const store = profile.db;
  const tag = applicationTag(profile, appId || '?');

  const app = store.getApplication(appId);
  if (!app) {
    return interaction.followUp({
      content: `❌ Application \`${tag}\` not found in the database.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const currentStatus = String(app.status || 'pending').toLowerCase();
  if (currentStatus === action) {
    try {
      await interaction.message.edit({
        content: `**${tag}** — already **${action}**${app.reviewedBy ? ` by ${app.reviewedBy}` : ''}`,
        embeds: [buildApplicationOverviewEmbed(profile, app, action)],
        components: [buildApplicationButtons(profile, appId, action)],
      });
    } catch { /* message may be gone */ }
    return interaction.followUp({
      content: `ℹ️ **${tag}** is already marked as **${action}**${app.reviewedBy ? ` by **${app.reviewedBy}**` : ''}. The message has been refreshed.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const previousStatus = currentStatus;
  store.updateStatus(appId, action, interaction.user.tag);
  const updated = store.getApplication(appId);

  const dmContent = {
    accepted: {
      color: 0x57F287,
      title: 'Application Accepted',
      body: [
        `### Congratulations, ${updated.username.split('#')[0]}! 🎉`,
        ``,
        profile.acceptedLine,
        `A member of management will be in touch shortly with your next steps.`,
        ``,
        `Welcome to the team!`,
      ].join('\n'),
    },
    declined: {
      color: 0xED4245,
      title: 'Application Unsuccessful',
      body: [
        `### Thank you for applying`,
        ``,
        profile.declinedLine,
        `You are welcome to apply again in the future.`,
        ``,
        `We appreciate the time and effort you put into your application.`,
      ].join('\n'),
    },
    hold: {
      color: 0xEB459E,
      title: 'Application On Hold',
      body: [
        `### Your application has been placed on hold`,
        ``,
        profile.holdLine,
        `They may reach out with further questions — keep an eye on your DMs.`,
      ].join('\n'),
    },
  };

  const { color: dmColor, title: dmTitle, body: dmBody } = dmContent[action] ?? dmContent.declined;
  await tryDM(updated.userId, {
    embeds: [makeEmbed({
      color: dmColor,
      title: `📋  ${dmTitle}`,
      description: dmBody,
      footer: `${applicationTag(profile, appId)}  ·  Next RP`,
    })],
  });

  const actionLabel = action === 'accepted' ? '✅ Accepted' : action === 'declined' ? '❌ Declined' : '🕐 On Hold';

  try {
    await interaction.message.edit({
      content: `**${applicationTag(profile, appId)}** — **${actionLabel}** by ${interaction.user.tag}`,
      embeds: [buildApplicationOverviewEmbed(profile, updated, action)],
      components: [buildApplicationButtons(profile, appId, action)],
    });
  } catch (err) {
    console.error('Failed to update application action message:', err.message);
  }

  try {
    if (interaction.channel?.isTextBased?.() && interaction.channel.manageable) {
      const topic = `Application ${applicationTag(profile, appId)} | Applicant: ${updated.username} (${updated.userId}) | Status: ${action}`;
      await interaction.channel.setTopic(topic.slice(0, 1024));
    }
  } catch { /* topic optional */ }

  const changedNote = (previousStatus !== 'pending' && previousStatus !== action)
    ? `\n_(was previously \`${previousStatus}\`${app.reviewedBy ? ` by ${app.reviewedBy}` : ''})_`
    : '';

  return interaction.followUp({
    embeds: [makeEmbed({
      color: dmColor,
      description: `**${applicationTag(profile, appId)}** has been marked as **${actionLabel}**.\nApplicant has been notified via DM.${changedNote}`,
      footer: `Reviewed by ${interaction.user.tag}`,
    })],
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------------
// Ticket recovery — Discord channels are the durable source of truth
// ---------------------------------------------------------------------------

function parseTicketChannel(channel) {
  return parseTicketChannelRaw(channel, DEPARTMENTS);
}

/** Pull userId from channel topic or recent bot embeds (strict snowflake shapes only) */
async function recoverUserIdFromChannel(channel, parsed) {
  if (parsed?.userId) return parsed.userId;

  const fromTopic = extractUserIdFromText(channel.topic || '');
  if (fromTopic) return fromTopic;

  try {
    const recent = await channel.messages.fetch({ limit: 25 });
    for (const msg of recent.values()) {
      if (msg.author?.id !== client.user?.id) continue;
      for (const embed of msg.embeds || []) {
        const blob = [embed.title, embed.description, embed.footer?.text]
          .filter(Boolean)
          .join('\n');
        const id = extractUserIdFromText(blob);
        if (id) return id;
      }
      const fromContent = extractUserIdFromText(msg.content || '');
      if (fromContent) return fromContent;
    }
  } catch { /* best-effort */ }

  return null;
}

/**
 * Look up a ticket by channel, recovering / repairing from Discord metadata.
 * Channel NAME prefix is the status source of truth (`ticket-` open, `closed-` closed).
 */
async function resolveTicketFromChannel(channel) {
  if (!channel?.id) return null;

  const parsed = parseTicketChannel(channel);
  const existing = db.getTicketByChannel(channel.id) || (parsed ? db.getTicket(parsed.id) : null);

  if (!parsed && !existing) return null;
  if (!parsed) return existing;

  const liveStatus = statusFromChannelName(channel.name) || parsed.status || existing?.status || 'open';
  const userId = (await recoverUserIdFromChannel(channel, parsed)) || existing?.userId || null;

  // Always sync status/channelId from Discord name — even without userId —
  // so restarts cannot leave tickets weirdly closed while the channel is ticket-*
  if (!userId && !existing) {
    db.ensureCounterAtLeast(parsed.id);
    return null;
  }

  const restored = db.upsertTicket({
    id: parsed.id,
    userId: userId || existing.userId,
    username: parsed.username || existing?.username || 'unknown',
    channelId: channel.id,
    status: liveStatus,
    department: parsed.department || existing?.department || null,
    createdAt: existing?.createdAt || parsed.createdAt,
  });

  if (!existing) {
    console.log(`🧾 Recovered ticket #${restored.id} (${restored.status}) from #${channel.name}`);
  } else if (existing.status !== restored.status || existing.channelId !== restored.channelId) {
    console.log(`🧾 Repaired ticket #${restored.id}: ${existing.status}→${restored.status}`);
  }

  return restored;
}

/**
 * Scan the staff guild for ticket channels and rebuild/repair the DB.
 * Open `ticket-*` channels are NEVER left closed after a wipe/restart.
 */
async function reconcileTicketsFromStaffGuild() {
  const staffGuild = await getStaffGuildAsync();
  if (!staffGuild) {
    console.warn('⚠️  Staff guild unavailable — skipping ticket reconcile.');
    return { restored: 0, updated: 0, skipped: 0, closedOrphans: 0, open: 0 };
  }

  try {
    await staffGuild.channels.fetch();
  } catch (err) {
    console.error('Failed to fetch staff channels for reconcile:', err.message);
  }

  let restored = 0;
  let updated = 0;
  let skipped = 0;
  const seenChannelIds = new Set();
  let maxParsedId = 0;

  for (const channel of staffGuild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
    const parsed = parseTicketChannel(channel);
    if (!parsed) continue;

    seenChannelIds.add(channel.id);
    if (parsed.id > maxParsedId) maxParsedId = parsed.id;

    // Force status from channel name (never trust drifted topic text)
    parsed.status = statusFromChannelName(channel.name) || parsed.status || 'open';
    parsed.closedAt = parsed.status === 'closed' ? (parsed.closedAt || new Date().toISOString()) : null;

    const existing = db.getTicket(parsed.id) || db.getTicketByChannel(channel.id);
    const userId = (await recoverUserIdFromChannel(channel, parsed)) || existing?.userId || null;

    if (!userId) {
      // Still repair status/channel mapping on existing rows
      if (existing) {
        if (existing.status !== parsed.status || existing.channelId !== parsed.channelId) {
          db.upsertTicket({
            ...existing,
            channelId: parsed.channelId,
            status: parsed.status,
          });
          updated += 1;
        }
      } else {
        skipped += 1;
        db.ensureCounterAtLeast(parsed.id);
        console.warn(`⚠️  Could not recover userId for #${channel.name} — status not fully restored`);
      }
      continue;
    }

    parsed.userId = userId;

    if (!existing) {
      db.upsertTicket(parsed);
      restored += 1;
      continue;
    }

    const needsUpdate =
      existing.channelId !== parsed.channelId
      || existing.status !== parsed.status
      || String(existing.userId) !== String(parsed.userId)
      || (!existing.department && parsed.department)
      || (existing.username === 'unknown' && parsed.username);

    if (needsUpdate) {
      db.upsertTicket({
        ...existing,
        channelId: parsed.channelId,
        status: parsed.status,
        userId: parsed.userId,
        username: parsed.username || existing.username,
        department: parsed.department || existing.department,
      });
      updated += 1;
    }
  }

  db.ensureCounterAtLeast(maxParsedId);

  // Close DB rows whose Discord channel is gone, and orphan opens with no channel
  let closedOrphans = 0;
  for (const ticket of db.getAllTickets('open')) {
    if (!ticket.channelId) {
      db.closeTicket(ticket.id);
      closedOrphans += 1;
      console.warn(`🧾 Closed orphan open ticket #${ticket.id} (no channelId)`);
      continue;
    }
    if (!seenChannelIds.has(ticket.channelId)) {
      // Double-check with a fetch in case cache was incomplete
      const stillThere = await staffGuild.channels.fetch(ticket.channelId).catch(() => null);
      if (!stillThere) {
        db.closeTicket(ticket.id);
        closedOrphans += 1;
        console.warn(`🧾 Closed ticket #${ticket.id} — channel missing after restart`);
      }
    }
  }

  db.allowBackupUpdates();

  const open = db.getAllTickets('open').length;
  console.log(
    `🧾 Ticket reconcile: restored=${restored} updated=${updated} `
    + `skipped=${skipped} closedOrphans=${closedOrphans} open=${open}`
  );
  console.log(`💾 Ticket DB: ${db.getDbPath()}`);
  return { restored, updated, skipped, closedOrphans, open };
}

/**
 * Find an open ticket for a user, validating the live Discord channel.
 * Used on DMs so users can keep talking even if data/ was wiped mid-flight.
 */
async function findOpenTicketForUser(userId) {
  const uid = String(userId);
  const cached = db.getOpenTicketByUser(uid);

  if (cached) {
    // Validate against Discord — never trust a stale "open" row
    if (cached.channelId) {
      const channel = await resolveTicketChannel(cached);
      if (channel && statusFromChannelName(channel.name) === 'open') {
        // Keep DB in sync if anything drifted
        if (cached.status !== 'open') db.reopenTicket(cached.id);
        return db.getTicket(cached.id);
      }
      if (channel && statusFromChannelName(channel.name) === 'closed') {
        db.closeTicket(cached.id);
      } else if (!channel) {
        // Channel gone — clear and fall through to live scan
        db.closeTicket(cached.id);
      }
    } else {
      // Open row with no channel — treat as orphan, fall through
      db.closeTicket(cached.id);
    }
  }

  const staffGuild = await getStaffGuildAsync();
  if (!staffGuild) return null;

  try {
    await staffGuild.channels.fetch();
  } catch { /* use cache */ }

  for (const channel of staffGuild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue;
    if (statusFromChannelName(channel.name) !== 'open') continue;

    const parsed = parseTicketChannel(channel);
    if (!parsed) continue;

    const recoveredUserId = await recoverUserIdFromChannel(channel, parsed);
    if (!recoveredUserId || String(recoveredUserId) !== uid) continue;

    const ticket = db.upsertTicket({
      ...parsed,
      userId: recoveredUserId,
      status: 'open',
      closedAt: null,
    });
    console.log(`🧾 Live-recovered open ticket #${ticket.id} for user ${uid}`);
    return ticket;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ticket creation logic
// ---------------------------------------------------------------------------
async function openTicket(user, subject) {
  const uid = String(user.id);

  // Wait for boot reconcile so we don't collide with Discord recovery IDs
  await ticketsReady;

  const existingBan = banDb.getBan(uid);
  if (existingBan) {
    const reason = existingBan.reason ? ` Reason: ${existingBan.reason}` : '';
    return {
      ok: false,
      message: `You are banned from opening tickets.${reason}`,
    };
  }

  // Per-user lock against double-clicks creating two tickets
  if (openTicketLocks.has(uid)) {
    return {
      ok: false,
      message: 'You already have a ticket being opened — check your DMs in a moment.',
    };
  }
  openTicketLocks.set(uid, true);

  try {
  // Block duplicate open tickets (check DB + live Discord in case data/ was wiped)
  const existing = await findOpenTicketForUser(user.id);
  if (existing) {
    return {
      ok: false,
      message: `You already have an open ticket (#${existing.id}). Please continue in DMs with me or wait for it to be resolved.`,
    };
  }

  const ticket = db.createTicket(user.id, user.username, subject);
  if (ticket._duplicate) {
    return {
      ok: false,
      message: `You already have an open ticket (#${ticket.id}). Please continue in DMs with me or wait for it to be resolved.`,
    };
  }
  db.setTicketDepartment(ticket.id, 'community_assistant');

  let staffChannel;
  try {
    staffChannel = await createStaffChannel(ticket);
  } catch (err) {
    console.error('Failed to create staff channel:', err);
    // Roll back the orphan open row so the user isn't permanently blocked
    db.deleteTicket(ticket.id);
    return { ok: false, message: 'Could not create a ticket channel. Please contact staff directly.' };
  }

  db.setTicketChannel(ticket.id, staffChannel.id);

  // Auto-send the hello message to the user
  const autoEmbed = makeEmbed({
    color: Colors.Blurple,
    description: 'Hey! Thanks for reaching out. A staff member will be with you shortly — please describe your issue in as much detail as possible.',
    footer: 'Next RP Support',
  });
  autoEmbed.setAuthor({ name: 'Next RP Support', iconURL: client.user.displayAvatarURL() });
  await tryDM(user.id, { embeds: [autoEmbed] });

  // Post the ticket header in the staff channel
  const caDept = DEPARTMENTS.find(d => d.id === 'community_assistant');
  const staffEmbed = makeEmbed({
    color: Colors.Yellow,
    title: `🎫 Ticket #${ticket.id} — ${subject}`,
    description: [
      `**User:** ${user.tag} (${user.id})`,
      `**Subject:** ${subject}`,
      `**Status:** 🟢 Open`,
      `**Claimed:** Unclaimed`,
      '',
      '> Messages the user sends via DM will appear here.',
      '> To reply to the user, start your message with `%`, e.g. `%Hello! How can I help you?`',
      '> Messages without `%` stay as normal staff chat — the user will NOT see them.',
      '> Use `/claim` to take ownership of this ticket.',
    ].join('\n'),
    footer: 'Ticket Bot',
  });

  const row = buildTicketActionRow(ticket, { claimed: false });

  const pingRole = caDept?.roleId || process.env.DEFAULT_STAFF_ROLE_ID;
  await staffChannel.send({
    content: pingRole ? `<@&${pingRole}> New ticket` : undefined,
    embeds: [staffEmbed],
    components: [row],
    allowedMentions: pingRole ? { roles: [pingRole] } : undefined,
  });

  // DM the user a confirmation
  const userEmbed = makeEmbed({
    color: Colors.Green,
    title: '🎫 Ticket Opened',
    description: [
      `Your ticket has been opened.`,
      '',
      `**Subject:** ${subject}`,
      '',
      'You can send follow-up messages by simply DMing me here.',
      'A staff member will get back to you soon!',
    ].join('\n'),
    footer: 'Reply to this DM to add more details.',
  });

  const dmSent = await tryDM(user.id, { embeds: [userEmbed] });
  if (!dmSent) {
    const fresh = db.getTicket(ticket.id);
    const fallback = await ensureFallbackChannel(fresh || ticket);
    if (fallback) {
      return {
        ok: true,
        ticket,
        dmSent: false,
        viaFallback: true,
        fallbackChannelId: fallback.id,
      };
    }
  }

  return { ok: true, ticket, dmSent, viaFallback: false };
  } finally {
    openTicketLocks.delete(uid);
  }
}

// ---------------------------------------------------------------------------
// Event: ready
// ---------------------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   Main guild  : ${process.env.MAIN_GUILD_ID}`);
  console.log(`   Staff guild : ${process.env.STAFF_GUILD_ID}`);

  // Gate ticket opens until Discord reconcile finishes (incl. one retry)
  ticketsReady = new Promise(resolve => { resolveTicketsReady = resolve; });

  try {
    let result = await reconcileTicketsFromStaffGuild();
    // Guild/channel cache can lag right after login — retry once
    if (result.restored === 0 && result.updated === 0 && result.open === 0) {
      await new Promise(r => setTimeout(r, 5000));
      result = await reconcileTicketsFromStaffGuild();
    }
    console.log(`✅ Tickets ready — ${result.open} open after reconcile`);
  } catch (err) {
    console.error('Ticket reconcile failed:', err.message);
  } finally {
    if (resolveTicketsReady) resolveTicketsReady();
    ticketsReady = Promise.resolve();
  }

  // Auto-post the ticket panel in the main server
  const panelChannelId = process.env.PANEL_CHANNEL_ID;
  if (panelChannelId) {
    try {
      const channel = await client.channels.fetch(panelChannelId);
      if (channel) {
        const recent = await channel.messages.fetch({ limit: 20 });
        const existing = recent.find(m => m.author.id === client.user.id && m.components?.length > 0);
        if (existing) {
          console.log(`ℹ️  Ticket panel already exists in #${channel.name} — skipping re-post.`);
        } else {
          const embed = makeEmbed({
            color: Colors.Blurple,
            title: '🎫 Support Tickets',
            description: [
              'Need help? Click the button below to open a ticket.',
              '',
              'A staff member will reply to you via **Direct Message**.',
              'Please make sure your DMs are open!',
            ].join('\n'),
            footer: 'One ticket per user at a time.',
          });
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('open_ticket_panel')
              .setLabel('Open a Ticket')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🎫')
          );
          await channel.send({ embeds: [embed], components: [row] });
          console.log(`✅ Ticket panel posted in #${channel.name}`);
        }
      }
    } catch (err) {
      console.error('Failed to post ticket panel:', err.message);
    }
  }

  // Auto-post staff and crew application panels
  for (const profile of [STAFF_APP, CREW_APP]) {
    const appPanelChannelId = process.env[profile.panelChannelEnv];
    if (!appPanelChannelId) continue;
    try {
      const appPanelChannel = await client.channels.fetch(appPanelChannelId);
      if (!appPanelChannel) continue;
      const recent = await appPanelChannel.messages.fetch({ limit: 20 });
      const existing = recent.find(m => m.author.id === client.user.id && m.components?.length > 0
        && m.components[0]?.components?.some(c => c.customId === profile.panelButtonId));
      if (existing) {
        console.log(`ℹ️  ${profile.overviewKind} panel already exists in #${appPanelChannel.name} — skipping.`);
      } else {
        await appPanelChannel.send(buildApplicationPanelPayload(profile, profile.db.isOpen()));
        console.log(`✅ ${profile.overviewKind} panel posted in #${appPanelChannel.name}`);
      }
    } catch (err) {
      console.error(`Failed to post ${profile.key} applications panel:`, err.message);
    }
  }

  // Auto-create/update the staff guide channel in the staff server
  try {
    const staffGuild = getStaffGuild();
    if (!staffGuild) throw new Error('Staff guild not found');

    let guideChannel = staffGuild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name === '📋-staff-guide'
    );
    if (!guideChannel) {
      guideChannel = await staffGuild.channels.create({
        name: '📋-staff-guide',
        type: ChannelType.GuildText,
        topic: 'Staff commands and quick reply reference guide.',
        permissionOverwrites: [
          { id: staffGuild.roles.everyone, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ViewChannel] },
        ],
      });
      console.log('✅ Created #📋-staff-guide channel');
    }

    // Delete old bot messages and repost fresh
    const old = await guideChannel.messages.fetch({ limit: 20 });
    const botMsgs = old.filter(m => m.author.id === client.user.id);
    for (const msg of botMsgs.values()) await msg.delete().catch(() => {});

    // ── Embed 1: Commands ──
    const commandsEmbed = makeEmbed({
      color: Colors.Blurple,
      title: '⌨️ Staff Commands',
      description: [
        'All commands are used inside ticket channels in this server unless stated otherwise.',
        '',
        '`/qr send` — Send a saved quick reply to the user',
        '`/qr add` — Add a new quick reply (Admin/Management)',
        '`/qr remove` — Remove a quick reply (Admin/Management)',
        '`/qr list` — List all quick replies',
        '`/claim` — Claim this ticket (Admin/Management can take over)',
        '`/unclaim` — Release your claim (or Admin/Management force-release)',
        '`/transfer` — Move the ticket to a specific department (clears claim)',
        '`/close` — Close the ticket (saves a transcript)',
        '`/reopen` — Reopen a closed ticket',
        '`/tickets` — List all currently open tickets',
        '`/stats` — Ticket volume / claim stats',
        '`/ticketban ban` — Ban a user from opening tickets (Admin/Management)',
        '`/ticketban unban` — Allow a banned user to open tickets again (Admin/Management)',
        '`/ticketban list` — List ticket bans (Admin/Management)',
        '`/applications` — Open, close, or review staff applications (management)',
        '`/crew-applications` — Open, close, or review crew applications (management)',
        '',
        '**Main Server Only:**',
        '`/ticket <subject>` — Open a ticket (users)',
        '`/setup` — Post the ticket panel button in a channel (staff)',
        '',
        '**Replying to users:**',
        '> Type `%` before your message to send it to the user via DM',
        '> e.g. `%Hello! How can I help you today?`',
        '> Messages **without** `%` stay as normal staff chat — the user **will not** see them.',
        '> If DMs fail, replies go to a private **Ticket Relay** channel on the main server.',
        '',
        `**Auto-close:** inactive open tickets close after **${STALE_TICKET_DAYS} days**.`,
      ].join('\n'),
    });

    // ── Embed 2: Quick Replies ──
    const qrLines = qrDb.getAll().map(qr => `\`${qr.id}\` — **${qr.label}**\n> ${qr.message}`);
    const qrEmbed = makeEmbed({
      color: Colors.Green,
      title: '⚡ Quick Replies  —  `/qr`',
      description: qrLines.length
        ? qrLines.join('\n\n').slice(0, 4096)
        : 'No quick replies yet. Use `/qr add` to create one.',
      footer: 'Add more anytime with /qr add — no bot restart needed.',
    });

    // ── Embed 3: Departments ──
    const deptLines = [...DEPARTMENTS].reverse().map((d, i) =>
      `${i === 0 ? '👑 ' : ''}**${d.emoji} ${d.name}** — <@&${d.roleId}>`
    );
    const deptEmbed = makeEmbed({
      color: Colors.Yellow,
      title: '🏢 Departments  —  `/transfer`',
      description: [
        'Use `/transfer` inside a ticket to move it to a department.',
        '**Hierarchy:** Management > Admin > other departments.',
        'Management always sees every ticket. Admin sees all tickets **except** ones transferred to Management.',
        'Transferring clears any active claim so the new team can claim it.',
        '',
        ...deptLines,
      ].join('\n'),
      footer: 'Management is above Admin — Admin cannot see Management tickets.',
    });

    await guideChannel.send({ embeds: [commandsEmbed] });
    await guideChannel.send({ embeds: [qrEmbed] });
    await guideChannel.send({ embeds: [deptEmbed] });
    console.log('✅ Staff guide updated in #📋-staff-guide');
  } catch (err) {
    console.error('Failed to post staff guide:', err.message);
  }

  // Auto-close stale open tickets
  const runStalePass = async () => {
    try {
      const stale = db.getStaleOpenTickets(STALE_TICKET_DAYS);
      if (!stale.length) return;
      console.log(`⏳ Auto-closing ${stale.length} stale ticket(s) (>${STALE_TICKET_DAYS}d inactive)`);
      for (const ticket of stale) {
        const channel = await resolveTicketChannel(ticket);
        if (!channel) {
          db.closeTicket(ticket.id);
          continue;
        }
        await finalizeTicketClose({
          channel,
          ticket,
          closedByTag: 'Ticket Bot (auto-close)',
          via: 'stale',
        });
      }
    } catch (err) {
      console.error('Stale ticket pass failed:', err.message);
    }
  };
  await runStalePass();
  setInterval(runStalePass, 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Event: interactionCreate — slash commands & buttons
// ---------------------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  try {
  // ── Autocomplete (quick reply pickers) ──────────────────────────────────
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'qr') {
      const focused = interaction.options.getFocused(true);
      const q = String(focused.value || '').toLowerCase();
      const choices = qrDb.getAll()
        .filter(r => !q || r.id.includes(q) || r.label.toLowerCase().includes(q))
        .slice(0, 25)
        .map(r => ({
          name: `${r.label} (${r.id})`.slice(0, 100),
          value: r.id,
        }));
      return interaction.respond(choices);
    }
    return;
  }

  // ── Modal submit — add quick reply ──────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'qr_add_modal') {
    if (!(await memberCanManageTicketBans(interaction))) {
      return interaction.reply({
        content: '❌ Only Admin Team and Management Team can add quick replies.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const id = interaction.fields.getTextInputValue('qr_id');
    const label = interaction.fields.getTextInputValue('qr_label');
    const message = interaction.fields.getTextInputValue('qr_message');
    const result = qrDb.add(id, label, message);

    if (!result.ok) {
      return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
      content: `✅ Quick reply **${result.reply.label}** saved as \`${result.reply.id}\`.\nUse \`/qr send reply:${result.reply.id}\` in a ticket to send it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── Modal submit — panel ticket subject ─────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'ticket_subject_modal') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const subject = interaction.fields.getTextInputValue('ticket_subject').trim();
    const result = await openTicket(interaction.user, subject || `Support request from ${interaction.user.username}`);

    if (!result.ok) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }

    let msg = '✅ Ticket opened! Check your DMs.';
    if (result.viaFallback) {
      msg = `✅ Ticket opened! I couldn't DM you — use <#${result.fallbackChannelId}> to talk to staff.`;
    } else if (!result.dmSent) {
      msg = '✅ Ticket opened! I couldn\'t DM you — please enable DMs from server members.';
    }
    return interaction.editReply({ content: msg });
  }

  // ── Slash commands ──────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // /setup — post the ticket panel
    if (commandName === 'setup') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({ content: 'You need **Manage Channels** permission to use this.', flags: MessageFlags.Ephemeral });
      }

      const embed = makeEmbed({
        color: Colors.Blurple,
        title: '🎫 Support Tickets',
        description: [
          'Need help? Click the button below to open a ticket.',
          '',
          'A staff member will reply to you via **Direct Message**.',
          'Please make sure your DMs are open!',
        ].join('\n'),
        footer: 'One ticket per user at a time.',
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket_panel')
          .setLabel('Open a Ticket')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎫')
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: 'Ticket panel posted!', flags: MessageFlags.Ephemeral });
    }

    // /ticket — create a ticket directly via slash command
    if (commandName === 'ticket') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const subject = interaction.options.getString('subject');
      const result = await openTicket(interaction.user, subject);

      if (!result.ok) {
        return interaction.editReply({ content: `❌ ${result.message}` });
      }

      let msg = '✅ Ticket opened! Check your DMs for confirmation.';
      if (result.viaFallback) {
        msg = `✅ Ticket opened! I couldn't DM you — use <#${result.fallbackChannelId}> to talk to staff.`;
      } else if (!result.dmSent) {
        msg = '✅ Ticket opened! I couldn\'t DM you — please enable DMs from server members.';
      }

      return interaction.editReply({ content: msg });
    }

    // Staff-only commands below
    const staffCommands = new Set(['close', 'reopen', 'tickets', 'claim', 'unclaim', 'stats', 'transfer', 'qr']);
    if (staffCommands.has(commandName)) {
      const staffOk = await memberIsStaff(interaction);
      if (!staffOk) {
        return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
      }
    }

    // /close — close the current ticket (staff guild only)
    if (commandName === 'close') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await resolveTicketFromChannel(interaction.channel);

      if (!ticket) return interaction.editReply({ content: '❌ This is not a ticket channel.' });
      if (ticket.status === 'closed') return interaction.editReply({ content: '❌ This ticket is already closed.' });

      const result = await finalizeTicketClose({
        channel: interaction.channel,
        ticket,
        closedByTag: interaction.user.tag,
        via: 'command',
      });
      return interaction.editReply({ content: result.message });
    }

    // /reopen — reopen a closed ticket
    if (commandName === 'reopen') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = await resolveTicketFromChannel(interaction.channel);

      if (!ticket) return interaction.editReply({ content: '❌ This is not a ticket channel.' });
      if (ticket.status === 'open') return interaction.editReply({ content: '❌ This ticket is already open.' });

      const otherOpen = db.getOpenTicketByUser(ticket.userId);
      if (otherOpen && Number(otherOpen.id) !== Number(ticket.id)) {
        return interaction.editReply({
          content: `❌ This user already has open ticket **#${otherOpen.id}**. Close that one before reopening this ticket.`,
        });
      }

      const renamed = await applyTicketChannelStatus(interaction.channel, 'open');
      if (!renamed) {
        return interaction.editReply({
          content: '❌ Could not rename the channel to `ticket-…` (Discord rate limit?). Ticket left **closed** — try `/reopen` again in a minute.',
        });
      }

      const reopened = db.reopenTicket(ticket.id);
      if (reopened?._blocked) {
        await applyTicketChannelStatus(interaction.channel, 'closed').catch(() => {});
        return interaction.editReply({
          content: `❌ This user already has open ticket **#${reopened._otherOpenId}**. Close that one before reopening this ticket.`,
        });
      }

      const userEmbed = makeEmbed({
        color: Colors.Green,
        title: '🔓 Ticket Reopened',
        description: `Your ticket has been reopened by staff.\n\nFeel free to continue the conversation by DMing me.`,
      });
      await tryDM(ticket.userId, { embeds: [userEmbed] });

      const reopenEmbed = makeEmbed({
        color: Colors.Green,
        title: '🔓 Ticket Reopened',
        description: `Reopened by ${interaction.user.tag}`,
        footer: `Ticket #${ticket.id}`,
      });

      await interaction.channel.send({ embeds: [reopenEmbed] });
      try {
        const reopenedTicket = db.getTicket(ticket.id);
        const reopenDept = reopenedTicket?.department ? DEPARTMENTS.find(d => d.id === reopenedTicket.department) : null;
        const reopenCat = reopenDept
          ? await getDeptCategory(interaction.guild, reopenDept)
          : await getUnassignedCategory(interaction.guild);
        await interaction.channel.setParent(reopenCat.id, { lockPermissions: false });
        const overwrites = buildPermissionOverwrites(
          interaction.guild,
          reopenDept?.roleId || null
        );
        await interaction.channel.permissionOverwrites.set(overwrites, `Reopened by ${interaction.user.tag}`);
        await refreshTicketHeaderMessage(interaction.channel, reopenedTicket);
      } catch (err) {
        console.error('Reopen move failed:', err.message);
      }

      return interaction.editReply({ content: '✅ Ticket reopened.' });
    }

    // /claim — claim the current ticket
    if (commandName === 'claim') {
      const ticket = await resolveTicketFromChannel(interaction.channel);
      if (!ticket) {
        return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
      }
      if (ticket.status === 'closed') {
        return interaction.reply({ content: '❌ This ticket is closed.', flags: MessageFlags.Ephemeral });
      }

      const elevated = await memberCanManageTicketBans(interaction);
      const alreadyMine = ticket.claimedBy === String(interaction.user.id);
      if (alreadyMine) {
        return interaction.reply({ content: '✅ You already have this ticket claimed.', flags: MessageFlags.Ephemeral });
      }

      if (ticket.claimedBy && !elevated) {
        return interaction.reply({
          content: `⚠️ Already claimed by **${ticket.claimedByTag || ticket.claimedBy}**. Ask them to \`/unclaim\`, or have Admin/Management take over.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const updated = db.claimTicket(
        ticket.id,
        interaction.user.id,
        interaction.user.tag,
        { force: Boolean(ticket.claimedBy && elevated) }
      );
      if (updated?._error === 'claimed') {
        return interaction.reply({
          content: `⚠️ Already claimed by **${updated._previousClaimerTag || updated.claimedByTag}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const takeoverNote = updated._takeover
        ? `\nTakeover from **${updated._previousClaimerTag || updated._previousClaimer}**.`
        : '';
      await interaction.channel.send({
        embeds: [makeEmbed({
          color: Colors.Green,
          title: updated._takeover ? '🙋 Ticket Claim Takeover' : '🙋 Ticket Claimed',
          description: `Claimed by ${interaction.user}${takeoverNote}`,
          footer: `Ticket #${ticket.id}`,
        })],
      });
      await refreshTicketHeaderMessage(interaction.channel, updated);
      return interaction.reply({
        content: `✅ You claimed ticket **#${updated.id}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // /unclaim — release claim
    if (commandName === 'unclaim') {
      const ticket = await resolveTicketFromChannel(interaction.channel);
      if (!ticket) {
        return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
      }
      if (!ticket.claimedBy) {
        return interaction.reply({ content: '⚠️ This ticket is not claimed.', flags: MessageFlags.Ephemeral });
      }

      const isOwner = ticket.claimedBy === String(interaction.user.id);
      const elevated = canManageTicketBans(interaction.member) || await memberCanManageTicketBans(interaction);
      if (!isOwner && !elevated) {
        return interaction.reply({
          content: '❌ Only the claimer (or Admin/Management) can unclaim this ticket.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const updated = db.unclaimTicket(ticket.id);
      await interaction.channel.send({
        embeds: [makeEmbed({
          color: Colors.Orange,
          title: '🙋 Ticket Unclaimed',
          description: `Released by ${interaction.user}`,
          footer: `Ticket #${ticket.id}`,
        })],
      });
      await refreshTicketHeaderMessage(interaction.channel, updated);
      return interaction.reply({ content: '✅ Ticket unclaimed.', flags: MessageFlags.Ephemeral });
    }

    // /stats — ticket metrics
    if (commandName === 'stats') {
      const s = db.getStats();
      const bans = banDb.listBans().length;
      const embed = makeEmbed({
        color: Colors.Blurple,
        title: '📊 Ticket Stats',
        description: [
          `**Open:** ${s.open} (${s.claimed} claimed · ${s.unclaimed} unclaimed)`,
          `**Closed:** ${s.closed}`,
          `**Total:** ${s.total}`,
          `**Avg time to close:** ${formatDuration(s.avgCloseMs)} (${s.closedWithDuration} samples)`,
          `**Ticket bans:** ${bans}`,
          `**Stale auto-close:** ${STALE_TICKET_DAYS} day${STALE_TICKET_DAYS === 1 ? '' : 's'}`,
        ].join('\n'),
      });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /tickets — list open tickets
    if (commandName === 'tickets') {
      const open = db.getAllTickets('open').sort((a, b) => Number(a.id) - Number(b.id));
      if (open.length === 0) {
        return interaction.reply({ content: '✅ No open tickets right now.', flags: MessageFlags.Ephemeral });
      }

      const lines = open.map(t => {
        const deptLabel = t.department
          ? (DEPARTMENTS.find(d => d.id === t.department)?.name ?? t.department)
          : 'Unassigned';
        const channelBit = t.channelId ? `<#${t.channelId}>` : '`no channel`';
        const subject = t.subject ? t.subject.slice(0, 60) : '(no subject)';
        const claim = t.claimedBy
          ? `claimed by <@${t.claimedBy}>`
          : '**unclaimed**';
        const opened = `<t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>`;
        return `**#${t.id}** ${channelBit} — ${t.username}\n> ${subject} · \`${deptLabel}\` · ${claim} · ${opened}`;
      });

      // Discord embed description limit 4096
      const chunks = [];
      let buf = '';
      for (const line of lines) {
        if ((buf + '\n' + line).length > 3900) {
          chunks.push(buf);
          buf = line;
        } else {
          buf = buf ? `${buf}\n${line}` : line;
        }
      }
      if (buf) chunks.push(buf);

      await interaction.reply({
        embeds: [makeEmbed({
          color: Colors.Blurple,
          title: `📋 Open Tickets (${open.length})`,
          description: chunks[0],
        })],
        flags: MessageFlags.Ephemeral,
      });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({
          embeds: [makeEmbed({
            color: Colors.Blurple,
            title: `📋 Open Tickets (cont.)`,
            description: chunks[i],
          })],
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // /qr — send / add / remove / list quick replies
    if (commandName === 'qr') {
      const sub = interaction.options.getSubcommand();

      if ((sub === 'add' || sub === 'remove') && !(await memberCanManageTicketBans(interaction))) {
        return interaction.reply({
          content: '❌ Only Admin Team and Management Team can add or remove quick replies.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'list') {
        const all = qrDb.getAll();
        if (!all.length) {
          return interaction.reply({
            content: 'No quick replies yet. Use `/qr add` to create one.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const lines = all.map(r => `**${r.label}** (\`${r.id}\`)\n> ${r.message}`);
        return interaction.reply({
          embeds: [makeEmbed({
            color: Colors.Green,
            title: `⚡ Quick Replies (${all.length})`,
            description: lines.join('\n\n').slice(0, 4096),
            footer: 'Send with /qr send · Add with /qr add',
          })],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'add') {
        return interaction.showModal(buildQrAddModal());
      }

      if (sub === 'remove') {
        const replyId = interaction.options.getString('reply', true);
        const result = qrDb.remove(replyId);
        if (!result.ok) {
          return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({
          content: `✅ Removed quick reply **${result.reply.label}** (\`${result.reply.id}\`).`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'send') {
        const replyId = interaction.options.getString('reply', true);
        const qr = qrDb.getById(replyId);
        if (!qr) {
          return interaction.reply({ content: `❌ Quick reply \`${replyId}\` not found.`, flags: MessageFlags.Ephemeral });
        }

        const ticket = await resolveTicketFromChannel(interaction.channel);
        if (!ticket) {
          return interaction.reply({ content: '❌ Use this inside a ticket channel.', flags: MessageFlags.Ephemeral });
        }
        if (ticket.status === 'closed') {
          return interaction.reply({ content: '❌ This ticket is closed. Use `/reopen` first.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const member = interaction.member ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        const { dmSent, viaFallback, embedColor, staffDisplay, description } = await sendStaffReplyToUser({
          targetUserId: ticket.userId,
          content: qr.message,
          member,
          author: interaction.user,
          contextLabel: `Ticket #${ticket.id}  ·  Next RP`,
          ticket,
        });
        db.touchTicketActivity(ticket.id);

        await interaction.channel.send({
          embeds: [buildSentToUserLogEmbed({
            embedColor,
            staffDisplay,
            author: interaction.user,
            title: `⚡ Quick Reply — ${qr.label}`,
            description,
            deliveryLabel: deliveryFooterLabel(dmSent, viaFallback),
            contextLabel: `Sent by ${staffDisplay}`,
          })],
        });

        return interaction.editReply({
          content: dmSent
            ? `✅ Sent **${qr.label}** to the user.`
            : viaFallback
              ? `✅ Sent **${qr.label}** via ticket relay (DMs closed).`
              : '❌ Could not DM the user — they may have DMs disabled.',
        });
      }
    }

    // Legacy individual quick reply commands (e.g. /hello) if still registered
    const legacyQr = qrDb.getAll().find(
      qr => qr.id.toLowerCase().replace(/_/g, '') === commandName
    );
    if (legacyQr) {
      if (!(await memberIsStaff(interaction))) {
        return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
      }
      const ticket = await resolveTicketFromChannel(interaction.channel);
      if (!ticket) return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
      if (ticket.status === 'closed') return interaction.reply({ content: '❌ This ticket is closed.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const member = interaction.member ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
      const { dmSent, viaFallback, embedColor, staffDisplay, description } = await sendStaffReplyToUser({
        targetUserId: ticket.userId,
        content: legacyQr.message,
        member,
        author: interaction.user,
        contextLabel: `Ticket #${ticket.id}  ·  Next RP`,
        ticket,
      });
      db.touchTicketActivity(ticket.id);

      await interaction.channel.send({
        embeds: [buildSentToUserLogEmbed({
          embedColor,
          staffDisplay,
          author: interaction.user,
          title: `⚡ Quick Reply — ${legacyQr.label}`,
          description,
          deliveryLabel: deliveryFooterLabel(dmSent, viaFallback),
          contextLabel: `Sent by ${staffDisplay}`,
        })],
      });

      return interaction.editReply({
        content: dmSent ? '✅ Sent!' : viaFallback ? '✅ Sent via relay.' : '❌ Could not DM the user.',
      });
    }


    // /ticketban — ban / unban users from opening tickets (Admin + Management only)
    if (commandName === 'ticketban') {
      const sub = interaction.options.getSubcommand();

      if (!(await memberCanManageTicketBans(interaction))) {
        return interaction.reply({
          content: '❌ Only Admin Team and Management Team can manage ticket bans.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'ban') {
        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const result = banDb.banUser(
          target.id,
          target.tag || target.username,
          reason,
          interaction.user.tag || interaction.user.username
        );

        if (!result.ok) {
          return interaction.reply({ content: `⚠️ ${result.message}`, flags: MessageFlags.Ephemeral });
        }

        return interaction.reply({
          content: [
            `🚫 ${result.message}`,
            `**User:** ${target} (\`${target.id}\`)`,
            `**Reason:** ${result.ban.reason}`,
            `**By:** ${result.ban.bannedBy}`,
          ].join('\n'),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'unban') {
        const target = interaction.options.getUser('user');
        const rawId = interaction.options.getString('userid');
        const uid = target?.id || (rawId && rawId.trim()) || null;

        if (!uid) {
          return interaction.reply({
            content: '❌ Provide a `user` or `userid` to unban.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const result = banDb.unbanUser(uid);
        if (!result.ok) {
          return interaction.reply({ content: `⚠️ ${result.message}`, flags: MessageFlags.Ephemeral });
        }

        const mention = target ? `${target} (\`${uid}\`)` : `\`${uid}\``;
        return interaction.reply({
          content: `✅ ${result.message}\n**User:** ${mention}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'list') {
        const bans = banDb.listBans();
        if (!bans.length) {
          return interaction.reply({ content: 'No users are currently banned from opening tickets.', flags: MessageFlags.Ephemeral });
        }

        const lines = bans.slice(0, 25).map(b => {
          const when = b.bannedAt
            ? `<t:${Math.floor(new Date(b.bannedAt).getTime() / 1000)}:R>`
            : '—';
          return `• <@${b.userId}> (\`${b.userId}\`) — ${b.reason || 'No reason'} · by ${b.bannedBy || 'unknown'} · ${when}`;
        });

        const embed = makeEmbed({
          color: Colors.Red,
          title: '🚫 Ticket bans',
          description: lines.join('\n'),
          footer: bans.length > 25
            ? `Showing 25 of ${bans.length} bans`
            : `${bans.length} ban${bans.length === 1 ? '' : 's'}`,
        });

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }

    // /applications and /crew-applications
    if (commandName === 'applications' || commandName === 'crew-applications') {
      const profile = commandName === 'crew-applications' ? CREW_APP : STAFF_APP;
      return handleApplicationsCommand(interaction, profile);
    }

    // /transfer — move ticket to a department
    if (commandName === 'transfer') {
      const ticket = await resolveTicketFromChannel(interaction.channel);
      if (!ticket) {
        return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
      }
      if (ticket.status === 'closed') {
        return interaction.reply({ content: '❌ This ticket is closed. Reopen it before transferring.', flags: MessageFlags.Ephemeral });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`transfer_dept_${ticket.id}`)
        .setPlaceholder('Select a department…')
        .addOptions(
          DEPARTMENTS.map(dept =>
            new StringSelectMenuOptionBuilder()
              .setValue(dept.id)
              .setLabel(dept.name)
              .setEmoji(dept.emoji)
              .setDescription(`Transfer to ${dept.name}`)
          )
        );

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const currentDept = ticket.department
        ? (DEPARTMENTS.find(d => d.id === ticket.department)?.name ?? ticket.department)
        : 'Unassigned';

      return interaction.reply({
        content: [
          `**Transfer Ticket #${ticket.id}**`,
          `Currently: \`${currentDept}\``,
          'Select a department.',
          '**Management** always keeps access. **Admin** keeps access unless you transfer to Management.',
          'Any active claim will be cleared so the new team can claim it.',
        ].join('\n'),
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // ── Button interactions ──────────────────────────────────────────────────
  if (interaction.isButton()) {
    // Staff and crew application panel plus review buttons
    const appProfile = applicationProfileFromCustomId(interaction.customId);
    if (appProfile && interaction.customId === appProfile.panelButtonId) {
      return startApplicationFromPanel(interaction, appProfile);
    }
    if (appProfile) {
      return handleApplicationDecision(interaction, appProfile);
    }

    // Add quick reply button → open modal
    if (interaction.customId === 'qr_add_btn') {
      if (!(await memberCanManageTicketBans(interaction))) {
        return interaction.reply({
          content: '❌ Only Admin Team and Management Team can add quick replies.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.showModal(buildQrAddModal());
    }

    // Open ticket from panel button → ask for subject
    if (interaction.customId === 'open_ticket_panel') {
      const modal = new ModalBuilder()
        .setCustomId('ticket_subject_modal')
        .setTitle('Open a Ticket');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ticket_subject')
            .setLabel('What do you need help with?')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Briefly describe your issue…')
            .setRequired(true)
            .setMaxLength(200)
        )
      );
      return interaction.showModal(modal);
    }

    // Claim ticket from button
    if (interaction.customId.startsWith('claim_ticket_')) {
      if (!(await memberIsStaff(interaction))) {
        return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
      }
      const ticket = await resolveTicketFromChannel(interaction.channel)
        || db.getTicket(parseInt(interaction.customId.replace('claim_ticket_', ''), 10));
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', flags: MessageFlags.Ephemeral });
      if (ticket.status === 'closed') return interaction.reply({ content: '❌ Ticket is closed.', flags: MessageFlags.Ephemeral });

      const elevated = await memberCanManageTicketBans(interaction);
      if (ticket.claimedBy === String(interaction.user.id)) {
        return interaction.reply({ content: '✅ You already claimed this ticket.', flags: MessageFlags.Ephemeral });
      }
      if (ticket.claimedBy && !elevated) {
        return interaction.reply({
          content: `⚠️ Already claimed by **${ticket.claimedByTag || ticket.claimedBy}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const updated = db.claimTicket(
        ticket.id,
        interaction.user.id,
        interaction.user.tag,
        { force: Boolean(ticket.claimedBy && elevated) }
      );
      if (updated?._error === 'claimed') {
        return interaction.reply({
          content: `⚠️ Already claimed by **${updated._previousClaimerTag || updated.claimedByTag}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const takeoverNote = updated._takeover
        ? `\nTakeover from **${updated._previousClaimerTag || updated._previousClaimer}**.`
        : '';
      await interaction.channel.send({
        embeds: [makeEmbed({
          color: Colors.Green,
          title: updated._takeover ? '🙋 Ticket Claim Takeover' : '🙋 Ticket Claimed',
          description: `Claimed by ${interaction.user}${takeoverNote}`,
          footer: `Ticket #${ticket.id}`,
        })],
      });
      await refreshTicketHeaderMessage(interaction.channel, updated);
      return interaction.reply({ content: `✅ You claimed ticket **#${ticket.id}**.`, flags: MessageFlags.Ephemeral });
    }

    // Unclaim ticket from button
    if (interaction.customId.startsWith('unclaim_ticket_')) {
      if (!(await memberIsStaff(interaction))) {
        return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
      }
      const ticket = await resolveTicketFromChannel(interaction.channel)
        || db.getTicket(parseInt(interaction.customId.replace('unclaim_ticket_', ''), 10));
      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', flags: MessageFlags.Ephemeral });
      if (!ticket.claimedBy) {
        return interaction.reply({ content: '⚠️ This ticket is not claimed.', flags: MessageFlags.Ephemeral });
      }
      const isOwner = ticket.claimedBy === String(interaction.user.id);
      const elevated = await memberCanManageTicketBans(interaction);
      if (!isOwner && !elevated) {
        return interaction.reply({
          content: '❌ Only the claimer (or Admin/Management) can unclaim.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const updated = db.unclaimTicket(ticket.id);
      await interaction.channel.send({
        embeds: [makeEmbed({
          color: Colors.Orange,
          title: '🙋 Ticket Unclaimed',
          description: `Released by ${interaction.user}`,
          footer: `Ticket #${ticket.id}`,
        })],
      });
      await refreshTicketHeaderMessage(interaction.channel, updated);
      return interaction.reply({ content: '✅ Ticket unclaimed.', flags: MessageFlags.Ephemeral });
    }

    // Close ticket from staff channel button
    if (interaction.customId.startsWith('close_ticket_')) {
      if (!(await memberIsStaff(interaction))) {
        return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
      }
      // Always repair from the live channel first — never trust a stale DB row alone
      const ticket = await resolveTicketFromChannel(interaction.channel)
        || db.getTicket(parseInt(interaction.customId.replace('close_ticket_', ''), 10));

      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', flags: MessageFlags.Ephemeral });
      if (ticket.status === 'closed') return interaction.reply({ content: '❌ Already closed.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channel = interaction.channel
        || interaction.guild.channels.cache.get(ticket.channelId)
        || await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);

      if (!channel) {
        return interaction.editReply({ content: '❌ Ticket channel not found.' });
      }

      const result = await finalizeTicketClose({
        channel,
        ticket,
        closedByTag: interaction.user.tag,
        via: 'button',
      });
      return interaction.editReply({ content: result.message });
    }
  }
  // ── Select menu — department transfer ──────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('transfer_dept_')) {
    if (!(await memberIsStaff(interaction))) {
      return interaction.reply({ content: '❌ Staff only.', flags: MessageFlags.Ephemeral });
    }
    const ticket = await resolveTicketFromChannel(interaction.channel)
      || db.getTicket(parseInt(interaction.customId.replace('transfer_dept_', ''), 10));

    if (!ticket) return interaction.update({ content: '❌ Ticket not found.', components: [] });
    if (ticket.status === 'closed') {
      return interaction.update({ content: '❌ This ticket is closed. Reopen it before transferring.', components: [] });
    }

    const deptId = interaction.values[0];
    const dept = DEPARTMENTS.find(d => d.id === deptId);

    if (!dept) return interaction.update({ content: '❌ Invalid department.', components: [] });

    await interaction.deferUpdate();

    const channel = interaction.channel
      || await resolveTicketChannel(ticket);

    if (!channel) {
      return interaction.editReply({ content: '❌ Ticket channel not found.', components: [] });
    }

    const staffGuild = await getStaffGuildAsync() || interaction.guild;

    // Rebuild permission overwrites locked to this department role
    const newOverwrites = buildPermissionOverwrites(staffGuild, dept.roleId);
    await channel.permissionOverwrites.set(newOverwrites, `Transferred to ${dept.name} by ${interaction.user.tag}`);

    // Move channel into the department's category
    const deptCategory = await getDeptCategory(staffGuild, dept);
    await channel.setParent(deptCategory.id, { lockPermissions: false });

    // Update topic to reflect new department
    const currentTopic = channel.topic ?? '';
    const newTopic = currentTopic.replace(/Dept: .+$/, `Dept: ${dept.name}`);
    await channel.setTopic(newTopic || `${currentTopic} | Dept: ${dept.name}`);

    // Save department to DB and clear claim so destination team can pick it up
    db.setTicketDepartment(ticket.id, deptId);
    const hadClaim = Boolean(ticket.claimedBy);
    if (hadClaim) db.unclaimTicket(ticket.id);
    const fresh = db.getTicket(ticket.id);

    const visibilityNote = dept.id === 'management'
      ? 'Only **Management** can see this channel now (Admin does not have access).'
      : dept.id === 'admin'
        ? '**Admin** and **Management** can see this channel.'
        : `<@&${dept.roleId}> plus **Admin** and **Management** can see this channel.`;

    // Post log in the channel (ping destination department)
    const transferEmbed = makeEmbed({
      color: dept.color ?? Colors.Orange,
      title: `${dept.emoji} Ticket Transferred — ${dept.name}`,
      description: [
        `This ticket has been transferred to **${dept.name}**.`,
        '',
        visibilityNote,
        hadClaim ? 'Previous claim was cleared — please `/claim` if you are taking it.' : null,
        `Transferred by ${interaction.user.tag}`,
      ].filter(Boolean).join('\n'),
      footer: `Ticket #${ticket.id}`,
    });

    await channel.send({
      content: `<@&${dept.roleId}>`,
      embeds: [transferEmbed],
      allowedMentions: { roles: [dept.roleId] },
    });
    await refreshTicketHeaderMessage(channel, fresh);

    return interaction.editReply({ content: `✅ Ticket transferred to **${dept.emoji} ${dept.name}**.`, components: [] });
  }
  } catch (err) {
    console.error('Interaction error:', err?.message ?? err);
    try {
      const msg = '❌ Something went wrong. Please try again.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else if (interaction.isRepliable?.()) {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Event: messageCreate — handles both DMs and staff channel messages
// ---------------------------------------------------------------------------
client.on('messageCreate', async message => {
  try {
  if (message.author.bot) return;

  // ── Main-server ticket relay (DM fallback) ──────────────────────────────
  if (
    message.guild
    && message.guild.id === process.env.MAIN_GUILD_ID
    && !message.content.startsWith('%')
  ) {
    const ticket = db.getTicketByChannel(message.channelId);
    if (ticket && ticket.fallbackChannelId === message.channelId && ticket.status === 'open') {
      if (String(message.author.id) !== String(ticket.userId)) return;

      const channel = await resolveTicketChannel(ticket);
      if (!channel) {
        return message.reply('⚠️ Staff channel missing — please ping staff in the main server.').catch(() => {});
      }

      const fwdEmbed = makeEmbed({
        color: Colors.Blue,
        description: (message.content || '*(no text — see attachment below)*').slice(0, 4096),
        footer: `📩 Relay · ${message.author.tag} · Ticket #${ticket.id}`,
      });
      fwdEmbed.setAuthor({
        name: `${message.author.tag} (User · Relay)`,
        iconURL: message.author.displayAvatarURL(),
      });
      const files = filesFromMessage(message);
      try {
        let pingContent;
        let allowedMentions;
        if (ticket.claimedBy) {
          pingContent = `<@${ticket.claimedBy}>`;
          allowedMentions = { users: [String(ticket.claimedBy)] };
        } else {
          const dept = ticket.department
            ? DEPARTMENTS.find(d => d.id === ticket.department)
            : null;
          const roleId = dept?.roleId || process.env.DEFAULT_STAFF_ROLE_ID;
          if (roleId) {
            pingContent = `<@&${roleId}>`;
            allowedMentions = { roles: [roleId] };
          }
        }
        await channel.send({
          content: pingContent,
          embeds: [fwdEmbed],
          files: files.length ? files : undefined,
          allowedMentions,
        });
        db.touchTicketActivity(ticket.id);
        await message.react('✅');
      } catch (err) {
        console.error(`Relay forward failed for ticket #${ticket.id}:`, err.message);
        await message.react('❌').catch(() => {});
      }
      return;
    }
  }

  // ── DM from user → forward to staff ticket channel ──────────────────────
  if (!message.guild) {
    // Ignore DMs from users who are mid-application — their messages are
    // handled by the awaitMessages collector inside runApplicationInDM()
    if (applicationDrafts.has(message.author.id)) return;

    // Prefer DB, but live-scan Discord if data/ was wiped so restarts don't kill chats
    const ticket = await findOpenTicketForUser(message.author.id);

    if (!ticket) {
      return message.reply({
        embeds: [makeEmbed({
          color: Colors.Red,
          title: 'No Open Ticket',
          description: 'You don\'t have an open ticket. Head to the main server and click **Open a Ticket** to get started.',
        })],
      });
    }

    const channel = await resolveTicketChannel(ticket);
    if (!channel) {
      console.error(`Ticket #${ticket.id} channel missing (${ticket.channelId})`);
      return message.reply({
        embeds: [makeEmbed({
          color: Colors.Red,
          title: 'Ticket Channel Missing',
          description: `Your ticket **#${ticket.id}** is open, but staff can\'t receive messages right now.\nPlease ping staff in the main server or open a new ticket after this one is closed.`,
        })],
      }).catch(() => {});
    }

    // Build the forwarded message embed
    const fwdEmbed = makeEmbed({
      color: Colors.Blue,
      title: null,
      description: (message.content || '*(no text — see attachment below)*').slice(0, 4096),
      footer: `📨 ${message.author.tag} · Ticket #${ticket.id}`,
    });

    fwdEmbed.setAuthor({
      name: `${message.author.tag} (User)`,
      iconURL: message.author.displayAvatarURL(),
    });

    // Forward attachments too
    const files = filesFromMessage(message);
    try {
      let pingContent;
      let allowedMentions;
      if (ticket.claimedBy) {
        pingContent = `<@${ticket.claimedBy}>`;
        allowedMentions = { users: [String(ticket.claimedBy)] };
      } else {
        const dept = ticket.department
          ? DEPARTMENTS.find(d => d.id === ticket.department)
          : DEPARTMENTS.find(d => d.id === 'community_assistant');
        const roleId = dept?.roleId || process.env.DEFAULT_STAFF_ROLE_ID;
        if (roleId) {
          pingContent = `<@&${roleId}>`;
          allowedMentions = { roles: [roleId] };
        }
      }

      await channel.send({
        content: pingContent,
        embeds: [fwdEmbed],
        files: files.length ? files : undefined,
        allowedMentions,
      });
      db.touchTicketActivity(ticket.id);
      await message.react('✅');
    } catch (err) {
      console.error(`Failed to forward DM for ticket #${ticket.id}:`, err.message);
      await message.react('❌').catch(() => {});
      await message.reply({
        embeds: [makeEmbed({
          color: Colors.Red,
          title: 'Could Not Deliver',
          description: 'Your message could not be delivered to staff. Please try again in a moment.',
        })],
      }).catch(() => {});
    }
    return;
  }

  // ── Staff guild helpers: plain-text qr commands + % replies ─────────────
  if (message.guild && message.guild.id === process.env.STAFF_GUILD_ID) {
    const raw = message.content.trim();
    const text = raw.toLowerCase();
    const qrMatch = text.match(/^[\/!]?qr(?:\s+(.*))?$/);

    if (qrMatch) {
      if (!isStaffMember(message.member)) {
        return message.reply('❌ Staff only.');
      }
      const args = (qrMatch[1] || '').trim();
      const [action, ...rest] = args.split(/\s+/).filter(Boolean);
      const restJoined = rest.join(' ').trim();

      // qr / qr help
      if (!action || action === 'help') {
        return message.reply({
          embeds: [makeEmbed({
            color: Colors.Green,
            title: '⚡ Quick Replies',
            description: [
              '**Add a reply** (Admin/Management)',
              '`qr add` — opens a button, then a form',
              '',
              '**Use a reply** (in a ticket channel)',
              '`qr send hello`',
              '`qr send uwu_cafe`',
              '',
              '**Manage**',
              '`qr list`',
              '`qr remove hello` (Admin/Management)',
              '',
              '_Slash `/qr` appears after the bot is restarted with the latest update._',
            ].join('\n'),
          })],
          components: canManageQuickReplies(message.member) ? [buildQrAddButtonRow()] : [],
        });
      }

      if (action === 'add') {
        if (!canManageQuickReplies(message.member)) {
          return message.reply('❌ Only Admin/Management can add quick replies.');
        }
        return message.reply({
          content: 'Click **Add Quick Reply** to open the form:',
          components: [buildQrAddButtonRow()],
        });
      }

      if (action === 'list') {
        const all = qrDb.getAll();
        if (!all.length) {
          return message.reply({
            content: 'No quick replies yet. Type `qr add` to create one.',
            components: canManageQuickReplies(message.member) ? [buildQrAddButtonRow()] : [],
          });
        }
        const lines = all.map(r => `**${r.label}** (\`${r.id}\`)\n> ${r.message}`);
        return message.reply({
          embeds: [makeEmbed({
            color: Colors.Green,
            title: `⚡ Quick Replies (${all.length})`,
            description: lines.join('\n\n').slice(0, 4096),
          })],
        });
      }

      if (action === 'remove') {
        if (!canManageQuickReplies(message.member)) {
          return message.reply('❌ Only Admin/Management can remove quick replies.');
        }
        if (!restJoined) return message.reply('Usage: `qr remove <id>` — e.g. `qr remove hello`');
        const result = qrDb.remove(restJoined);
        if (!result.ok) return message.reply(`❌ ${result.error}`);
        return message.reply(`✅ Removed **${result.reply.label}** (\`${result.reply.id}\`).`);
      }

      if (action === 'send') {
        if (!restJoined) return message.reply('Usage: `qr send <id>` — e.g. `qr send hello`');
        const qr = qrDb.getById(restJoined);
        if (!qr) return message.reply(`❌ No quick reply \`${restJoined}\`. Try \`qr list\`.`);

        const ticket = await resolveTicketFromChannel(message.channel);
        if (!ticket) return message.reply('❌ Use `qr send` inside a ticket channel.');
        if (ticket.status === 'closed') return message.reply('❌ Ticket is closed. Use `/reopen` first.');

        const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        const { dmSent, viaFallback, embedColor, staffDisplay, description } = await sendStaffReplyToUser({
          targetUserId: ticket.userId,
          content: qr.message,
          member,
          author: message.author,
          contextLabel: `Ticket #${ticket.id}  ·  Next RP`,
          ticket,
        });
        db.touchTicketActivity(ticket.id);

        // One log embed only — drop the raw `qr send` command message
        await message.channel.send({
          embeds: [buildSentToUserLogEmbed({
            embedColor,
            staffDisplay,
            author: message.author,
            title: `⚡ Quick Reply — ${qr.label}`,
            description,
            deliveryLabel: deliveryFooterLabel(dmSent, viaFallback),
            contextLabel: `Sent by ${staffDisplay}`,
          })],
        });
        await message.delete().catch(() => null);
        return;
      }

      return message.reply('Unknown qr command. Try `qr help`.');
    }

    if (!message.content.startsWith('%')) {
      // Internal staff chat in a ticket channel — leave as a normal message
      const ticket = await resolveTicketFromChannel(message.channel);
      if (!ticket || ticket.status === 'closed') return;
      if (!message.content.trim() && !message.attachments.size) return;

      db.touchTicketActivity(ticket.id);
      return;
    }

    const ticket = await resolveTicketFromChannel(message.channel);
    const application = !ticket ? appDb.getApplicationByChannel(message.channelId) : null;

    if (!ticket && !application) return; // not a managed channel

    if (ticket?.status === 'closed') {
      return message.reply('⚠️ This ticket is closed. Use `/reopen` before replying.');
    }

    if (application) {
      const appStatus = String(application.status || 'pending').toLowerCase();
      if (appStatus === 'accepted' || appStatus === 'declined') {
        return message.reply(
          `⚠️ This application is already **${appStatus}**. Reset it before messaging the applicant.`
        );
      }
    }

    const replyContent = message.content.slice(1).trim();
    const files = filesFromMessage(message);
    if (!replyContent && !files.length) {
      return message.reply('⚠️ Message is empty after the `%` prefix.');
    }

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const targetUserId = ticket ? ticket.userId : application.userId;
    const contextLabel = application ? `APP-${application.id}  ·  Next RP` : `Ticket #${ticket?.id}  ·  Next RP`;

    const { dmSent, viaFallback } = await sendStaffReplyToUser({
      targetUserId,
      content: replyContent || '*(attachment)*',
      member,
      author: message.author,
      contextLabel,
      files,
      ticket: ticket || null,
    });
    if (ticket) db.touchTicketActivity(ticket.id);

    // Keep the staff member's own `%` message so the channel shows who said what
    await message.react(dmSent || viaFallback ? '✅' : '❌').catch(() => {});
    if (!dmSent && !viaFallback) {
      const failHint = application
        ? '⚠️ Could not DM the applicant — they may have DMs disabled.'
        : '⚠️ Could not DM the user — they may have DMs disabled.';
      await message.reply(failHint).catch(() => {});
    }

    return;
  }
  } catch (err) {
    console.error('messageCreate error:', err?.message ?? err);
  }
});

// ---------------------------------------------------------------------------
// Global error handler — prevents crashes from unhandled API errors
// ---------------------------------------------------------------------------
client.on('error', err => console.error('Client error:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err?.message ?? err));

// ---------------------------------------------------------------------------
// Auto-deploy slash commands, then login
// ---------------------------------------------------------------------------
deployCommands().then(ok => {
  if (!ok) console.error('[Boot] Slash command deploy failed — plain-text `qr add` / `qr send` still work after login.');
  return client.login(process.env.BOT_TOKEN);
}).catch(err => {
  console.error('[Boot] Failed to start:', err?.message ?? err);
  process.exit(1);
});
