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
} = require('discord.js');

const db      = require('./database');
const appDb   = require('./applications-db');
const qrDb    = require('./quick-replies-db');
const { deployCommands } = require('./deploy-commands');
const { parseTicketChannel: parseTicketChannelRaw } = require('./ticket-channel');
const DEPARTMENTS  = require('./departments.json');

// Channel where submitted applications are posted (management-only channel in main guild)
const APPLICATIONS_CHANNEL_ID = process.env.APPLICATIONS_CHANNEL_ID || '1527645538244100136';
// Role that can action (accept/decline) applications
const APPLICATIONS_ROLE_ID = process.env.APPLICATIONS_ROLE_ID || '1515309451727470794'; // defaults to management role

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
  const staffGuild = getStaffGuild();
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
 * DM a ticket/application user from staff and log in-channel.
 * Returns { dmSent }.
 */
async function sendStaffReplyToUser({ targetUserId, content, member, author, contextLabel, files = [] }) {
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
  return { dmSent, rankLabel, embedColor, staffDisplay, description };
}

/** Resolve the staff guild from env */
function getStaffGuild() {
  return client.guilds.cache.get(process.env.STAFF_GUILD_ID);
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
 *  - @everyone: denied
 *  - Bot itself: allowed
 *  - Management role: always allowed (sees everything)
 *  - departmentRoleId (if set): allowed exclusively
 *  - DEFAULT_STAFF_ROLE_ID (if set and no department): allowed
 */
function buildPermissionOverwrites(guild, departmentRoleId = null) {
  const MANAGEMENT_ROLE_ID = '1515309451727470794';
  const allowedPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const overwrites = [
    // Hide from everyone by default
    {
      id: guild.roles.everyone,
      deny: [PermissionFlagsBits.ViewChannel],
      type: OverwriteType.Role,
    },
    // Always allow the bot itself
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

  if (departmentRoleId && departmentRoleId !== MANAGEMENT_ROLE_ID) {
    // Locked to a specific department: only that role (+ management above) can see it
    overwrites.push({
      id: departmentRoleId,
      allow: allowedPerms,
      type: OverwriteType.Role,
    });
  } else if (!departmentRoleId && process.env.DEFAULT_STAFF_ROLE_ID) {
    // No department yet: visible to general staff
    overwrites.push({
      id: process.env.DEFAULT_STAFF_ROLE_ID,
      allow: allowedPerms,
      type: OverwriteType.Role,
    });
  }

  return overwrites;
}

/** Create a ticket channel in the staff guild */
async function createStaffChannel(ticket) {
  const guild = getStaffGuild();
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

/**
 * Run the full application as a DM conversation.
 * Returns the completed answers object, or null if cancelled/timed out.
 */
async function runApplicationInDM(user) {
  let dm;
  try { dm = await user.createDM(); } catch {
    return null; // DMs disabled
  }

  const TIMEOUT = 45 * 60 * 1000; // 45 minutes per question
  const total   = APP_QUESTIONS.length;

  await dm.send({ embeds: [
    new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📋  Next RP — Staff Application')
      .setDescription(
        '**Welcome! You\'re about to complete a staff application.**\n\n' +
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
    const q = APP_QUESTIONS[i];

    // Section header when section changes
    const prevSection = i > 0 ? APP_QUESTIONS[i - 1].section : null;
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
        .setColor(0x5865F2)
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
        description: 'Your application has been cancelled due to inactivity.\nClick **Apply for Staff** again whenever you\'re ready.',
      })]});
      return null;
    }

    const answer = collected.first().content.trim();

    if (answer.toLowerCase() === 'cancel') {
      await dm.send({ embeds: [makeEmbed({
        color: Colors.Red,
        title: '❌  Application Cancelled',
        description: 'Your application has been cancelled.\nYou can click **Apply for Staff** again at any time.',
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
    footer: 'Next RP Staff Team',
  })]});

  return answers;
}

// ---------------------------------------------------------------------------
// Applications helpers
// ---------------------------------------------------------------------------

/** Create a dedicated application channel in the staff guild */
async function createApplicationChannel(app) {
  const guild = getStaffGuild();
  if (!guild) throw new Error('Staff guild not found');

  const category = await getOrCreateCategory(guild, '📋 Staff Applications');

  const safeName = app.username.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 16) || 'applicant';
  const channelName = `app-${app.id}-${safeName}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Application APP-${app.id} | Applicant: ${app.username} (${app.userId}) | Status: pending`,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
      { id: client.user.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages], type: OverwriteType.Member },
      { id: APPLICATIONS_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory], type: OverwriteType.Role },
    ],
  });

  return channel;
}

/** Build the "Apply for Staff" panel message payload */
function buildApplicationPanelPayload(open = true) {
  const embed = makeEmbed({
    color: open ? 0x5865F2 : 0x747F8D,
    title: open ? '📋 Staff Applications' : '📋 Staff Applications — Closed',
    description: open
      ? [
          '**Next RP is looking for dedicated staff members!**',
          '',
          'Click the button below to submit your application.',
          'Our management team will review it and get back to you.',
          '',
          '> Make sure your DMs are open so we can contact you.',
        ].join('\n')
      : [
          '**Applications are currently closed.**',
          '',
          'We are not accepting new staff applications at this time.',
          'Check back later or keep an eye on announcements.',
        ].join('\n'),
    footer: open ? 'Applications are open' : 'Applications are closed',
  });

  const button = new ButtonBuilder()
    .setCustomId('apply_staff_panel')
    .setLabel(open ? 'Apply for Staff' : 'Applications Closed')
    .setStyle(open ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setEmoji(open ? '📋' : '🔒')
    .setDisabled(!open);

  const row = new ActionRowBuilder().addComponents(button);
  return { embeds: [embed], components: [row] };
}

/**
 * Build the overview embed for an application (status header + short bio fields).
 * Long answers are posted separately — Discord caps ALL embeds in one message at 6000 chars,
 * so packing every answer into one message was silently failing for detailed applications.
 */
function buildApplicationOverviewEmbed(app, status = 'pending') {
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
    .setTitle(`APP-${app.id}  ·  Staff Application`)
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
    .setFooter({ text: 'Next RP  ·  Staff Applications' })
    .setTimestamp();
}

/** One embed per answer — stays well under Discord limits even for max-length replies */
function buildApplicationAnswerEmbeds(app) {
  return APP_ANSWER_FIELDS.map(field => {
    const answer = String(getAppAnswer(app, field)).slice(0, 4096) || '—';
    return new EmbedBuilder()
      .setColor(0x23272A)
      .setTitle(field.title.slice(0, 256))
      .setDescription(answer)
      .setFooter({ text: `APP-${app.id}` });
  });
}

/** @deprecated kept for any callers expecting the old multi-embed array */
function buildApplicationEmbeds(app, status = 'pending') {
  return [buildApplicationOverviewEmbed(app, status), ...buildApplicationAnswerEmbeds(app)];
}

/**
 * Post overview, each answer, then a dedicated action-button message.
 * Buttons are on their own short message so they still appear even if an answer post fails.
 */
async function postApplicationReviewMessages(appChannel, app) {
  const status = app.status || 'pending';

  await appChannel.send({
    content: [
      `<@&${APPLICATIONS_ROLE_ID}>  —  Staff application ready for review.`,
      ``,
      `**Applicant:** <@${app.userId}>`,
      `**Application ID:** \`APP-${app.id}\``,
      `**Status:** \`${status}\``,
      ``,
      `Use the buttons at the bottom of this channel to accept, decline, or place on hold.`,
    ].join('\n'),
  });

  await appChannel.send({ embeds: [buildApplicationOverviewEmbed(app, status)] });

  for (const embed of buildApplicationAnswerEmbeds(app)) {
    try {
      await appChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error(`Failed to post answer embed for APP-${app.id}:`, err.message);
      await appChannel.send({
        content: `⚠️ Could not display **${embed.data.title}** (Discord limit). Answer is still saved in the bot database.`,
      }).catch(() => {});
    }
  }

  const buttons = buildApplicationButtons(app.id, status);
  const msg = await appChannel.send({
    content: `**APP-${app.id}** — Accept, decline, or place this application on hold:`,
    components: [buttons],
  });
  appDb.setChannelMessage(app.id, appChannel.id, msg.id);
  return msg;
}

/** Build the action row buttons for an application */
function buildApplicationButtons(appId, status = 'pending') {
  if (status !== 'pending' && status !== 'hold') {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`app_noop_${appId}`)
        .setLabel('Application Reviewed')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔒')
        .setDisabled(true)
    );
  }

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`app_accept_${appId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`app_decline_${appId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
    new ButtonBuilder()
      .setCustomId(`app_hold_${appId}`)
      .setLabel('Place on Hold')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🕐'),
  );
}

// ---------------------------------------------------------------------------
// Ticket recovery — rebuild DB from Discord channels after a wipe/restart
// ---------------------------------------------------------------------------

function parseTicketChannel(channel) {
  return parseTicketChannelRaw(channel, DEPARTMENTS);
}

/** Look up a ticket by channel, recovering from Discord metadata if the DB was wiped */
function resolveTicketFromChannel(channel) {
  if (!channel?.id) return null;
  const existing = db.getTicketByChannel(channel.id);
  if (existing) return existing;

  const parsed = parseTicketChannel(channel);
  if (!parsed?.userId) return null;

  const restored = db.upsertTicket(parsed);
  console.log(`🧾 Recovered ticket #${restored.id} from #${channel.name}`);
  return restored;
}

/**
 * Scan the staff guild for ticket channels and restore any missing DB rows.
 * This is what keeps tickets alive across host restarts that wipe data/.
 */
async function reconcileTicketsFromStaffGuild() {
  const staffGuild = getStaffGuild();
  if (!staffGuild) {
    console.warn('⚠️  Staff guild not in cache — skipping ticket reconcile.');
    return { restored: 0, updated: 0, skipped: 0 };
  }

  // Ensure channel list is fresh
  try {
    await staffGuild.channels.fetch();
  } catch (err) {
    console.error('Failed to fetch staff channels for reconcile:', err.message);
  }

  let restored = 0;
  let updated = 0;
  let skipped = 0;

  for (const channel of staffGuild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    const parsed = parseTicketChannel(channel);
    if (!parsed) continue;

    // Need a user id to relay DMs; try to recover from the opener embed if topic lacked it
    if (!parsed.userId) {
      try {
        const pinnedOrRecent = await channel.messages.fetch({ limit: 10 });
        for (const msg of pinnedOrRecent.values()) {
          if (msg.author?.id !== client.user.id) continue;
          const desc = msg.embeds?.[0]?.description || '';
          const m = desc.match(/\((\d{5,25})\)/);
          if (m) {
            parsed.userId = m[1];
            break;
          }
        }
      } catch { /* best-effort */ }
    }

    if (!parsed.userId) {
      skipped += 1;
      console.warn(`⚠️  Could not recover userId for ticket channel #${channel.name}`);
      continue;
    }

    const existing = db.getTicket(parsed.id);
    if (!existing) {
      db.upsertTicket(parsed);
      restored += 1;
      continue;
    }

    // Repair channel mapping / status drift without clobbering newer DB state blindly
    const needsUpdate =
      existing.channelId !== parsed.channelId
      || existing.status !== parsed.status
      || String(existing.userId) !== String(parsed.userId)
      || (!existing.department && parsed.department);

    if (needsUpdate) {
      db.upsertTicket({
        ...existing,
        channelId: parsed.channelId,
        // Prefer Discord channel name/topic as source of truth after a wipe/restart
        status: parsed.status,
        userId: parsed.userId,
        username: parsed.username || existing.username,
        department: parsed.department || existing.department,
      });
      updated += 1;
    }
  }

  console.log(`🧾 Ticket reconcile: restored=${restored} updated=${updated} skipped=${skipped}`);
  return { restored, updated, skipped };
}

// ---------------------------------------------------------------------------
// Ticket creation logic
// ---------------------------------------------------------------------------
async function openTicket(user, subject) {
  // Block duplicate open tickets
  const existing = db.getOpenTicketByUser(user.id);
  if (existing) {
    return {
      ok: false,
      message: `You already have an open ticket (#${existing.id}). Please continue in DMs with me or wait for it to be resolved.`,
    };
  }

  const ticket = db.createTicket(user.id, user.username);
  db.setTicketDepartment(ticket.id, 'community_assistant');

  let staffChannel;
  try {
    staffChannel = await createStaffChannel(ticket);
  } catch (err) {
    console.error('Failed to create staff channel:', err);
    return { ok: false, message: 'Could not create a ticket channel. Please contact staff directly.' };
  }

  db.setTicketChannel(ticket.id, staffChannel.id);

  // Auto-send the hello message to the user
  const member = staffChannel.guild.members.me;
  const autoEmbed = makeEmbed({
    color: Colors.Blurple,
    description: 'Hey! Thanks for reaching out. A staff member will be with you shortly — please describe your issue in as much detail as possible.',
    footer: 'Next RP Support',
  });
  autoEmbed.setAuthor({ name: 'Next RP Support', iconURL: client.user.displayAvatarURL() });
  await tryDM(user.id, { embeds: [autoEmbed] });

  // Post the ticket header in the staff channel
  const staffEmbed = makeEmbed({
    color: Colors.Yellow,
    title: `🎫 Ticket #${ticket.id} — ${subject}`,
    description: [
      `**User:** ${user.tag} (\`${user.id}\`)`,
      `**Subject:** ${subject}`,
      `**Status:** 🟢 Open`,
      '',
      '> Messages the user sends via DM will appear here.',
      '> To reply to the user, start your message with `%`, e.g. `%Hello! How can I help you?`',
      '> Any message WITHOUT `%` is an internal staff note — the user will NOT see it.',
    ].join('\n'),
    footer: 'Ticket Bot',
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`close_ticket_${ticket.id}`)
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
  );

  await staffChannel.send({ embeds: [staffEmbed], components: [row] });

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

  return { ok: true, ticket, dmSent };
}

// ---------------------------------------------------------------------------
// Event: ready
// ---------------------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   Main guild  : ${process.env.MAIN_GUILD_ID}`);
  console.log(`   Staff guild : ${process.env.STAFF_GUILD_ID}`);

  // Rebuild ticket records if data/ was wiped on restart
  try {
    await reconcileTicketsFromStaffGuild();
  } catch (err) {
    console.error('Ticket reconcile failed:', err.message);
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

  // Auto-post the staff applications panel
  const appPanelChannelId = process.env.APPLICATIONS_PANEL_CHANNEL_ID;
  if (appPanelChannelId) {
    try {
      const appPanelChannel = await client.channels.fetch(appPanelChannelId);
      if (appPanelChannel) {
        const recent = await appPanelChannel.messages.fetch({ limit: 20 });
        const existing = recent.find(m => m.author.id === client.user.id && m.components?.length > 0
          && m.components[0]?.components?.some(c => c.customId === 'apply_staff_panel'));
        if (existing) {
          console.log(`ℹ️  Applications panel already exists in #${appPanelChannel.name} — skipping.`);
        } else {
          const isOpen = appDb.isOpen();
          await appPanelChannel.send(buildApplicationPanelPayload(isOpen));
          console.log(`✅ Applications panel posted in #${appPanelChannel.name}`);
        }
      }
    } catch (err) {
      console.error('Failed to post applications panel:', err.message);
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
        '`/qr add` — Add a new quick reply (form)',
        '`/qr remove` — Remove a quick reply',
        '`/qr list` — List all quick replies',
        '`/transfer` — Move the ticket to a specific department',
        '`/close` — Close the ticket and notify the user',
        '`/reopen` — Reopen a closed ticket',
        '`/tickets` — List all currently open tickets',
        '',
        '**Main Server Only:**',
        '`/ticket <subject>` — Open a ticket (users)',
        '`/setup` — Post the ticket panel button in a channel (staff)',
        '',
        '**Replying to users:**',
        '> Type `%` before your message to send it to the user via DM',
        '> e.g. `%Hello! How can I help you today?`',
        '> Any message **without** `%` is an internal staff note — the user **will not** see it.',
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
        'Only that department (and Management) will be able to see the channel.',
        '',
        ...deptLines,
      ].join('\n'),
      footer: 'Management always has access to all tickets.',
    });

    await guideChannel.send({ embeds: [commandsEmbed] });
    await guideChannel.send({ embeds: [qrEmbed] });
    await guideChannel.send({ embeds: [deptEmbed] });
    console.log('✅ Staff guide updated in #📋-staff-guide');
  } catch (err) {
    console.error('Failed to post staff guide:', err.message);
  }
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

      const msg = result.dmSent
        ? `✅ Ticket opened! Check your DMs for confirmation.`
        : `✅ Ticket opened! I couldn't DM you — please enable DMs from server members.`;

      return interaction.editReply({ content: msg });
    }

    // /close — close the current ticket (staff guild only)
    if (commandName === 'close') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = resolveTicketFromChannel(interaction.channel);

      if (!ticket) return interaction.editReply({ content: '❌ This is not a ticket channel.' });
      if (ticket.status === 'closed') return interaction.editReply({ content: '❌ This ticket is already closed.' });

      db.closeTicket(ticket.id);

      // Notify user
      const userEmbed = makeEmbed({
        color: Colors.Red,
        title: '🔒 Ticket Closed',
        description: `Your ticket has been closed by staff.\n\nIf you need further help, open a new ticket.`,
      });
      await tryDM(ticket.userId, { embeds: [userEmbed] });

      // Update staff channel
      const closeEmbed = makeEmbed({
        color: Colors.Red,
        title: '🔒 Ticket Closed',
        description: `Closed by ${interaction.user.tag}`,
        footer: `Ticket #${ticket.id}`,
      });

      await interaction.channel.send({ embeds: [closeEmbed] });
      try {
        await interaction.channel.setName(interaction.channel.name.replace(/^ticket-/, 'closed-'));
      } catch (err) {
        console.error('Close rename failed (rate limit?):', err.message);
      }
      try {
        await interaction.channel.setTopic((interaction.channel.topic || '').replace('Status: open', 'Status: closed'));
      } catch { /* topic optional */ }
      try {
        const closedCat = await getOrCreateCategory(interaction.guild, '🔒 Closed Tickets');
        await interaction.channel.setParent(closedCat.id, { lockPermissions: false });
      } catch (err) {
        console.error('Close move failed:', err.message);
      }

      return interaction.editReply({ content: '✅ Ticket closed.' });
    }

    // /reopen — reopen a closed ticket
    if (commandName === 'reopen') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = resolveTicketFromChannel(interaction.channel);

      if (!ticket) return interaction.editReply({ content: '❌ This is not a ticket channel.' });
      if (ticket.status === 'open') return interaction.editReply({ content: '❌ This ticket is already open.' });

      db.reopenTicket(ticket.id);

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
        await interaction.channel.setName(interaction.channel.name.replace(/^closed-/, 'ticket-'));
      } catch (err) {
        console.error('Reopen rename failed (rate limit?):', err.message);
      }
      try {
        await interaction.channel.setTopic((interaction.channel.topic || '').replace('Status: closed', 'Status: open'));
      } catch { /* topic optional */ }
      try {
        const reopenedTicket = db.getTicket(ticket.id);
        const reopenDept = reopenedTicket?.department ? DEPARTMENTS.find(d => d.id === reopenedTicket.department) : null;
        const reopenCat = reopenDept
          ? await getDeptCategory(interaction.guild, reopenDept)
          : await getUnassignedCategory(interaction.guild);
        await interaction.channel.setParent(reopenCat.id, { lockPermissions: false });
      } catch (err) {
        console.error('Reopen move failed:', err.message);
      }

      return interaction.editReply({ content: '✅ Ticket reopened.' });
    }

    // /tickets — list open tickets
    if (commandName === 'tickets') {
      const open = db.getAllTickets('open');
      if (open.length === 0) {
        return interaction.reply({ content: '✅ No open tickets right now.', flags: MessageFlags.Ephemeral });
      }

      const lines = open.map(t => {
        const deptLabel = t.department
          ? (DEPARTMENTS.find(d => d.id === t.department)?.name ?? t.department)
          : 'Unassigned';
        return `**#${t.id}** — ${t.username} (\`${t.userId}\`) — \`${deptLabel}\` — opened <t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>`;
      });

      const embed = makeEmbed({
        color: Colors.Blurple,
        title: `📋 Open Tickets (${open.length})`,
        description: lines.join('\n'),
      });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /qr — send / add / remove / list quick replies
    if (commandName === 'qr') {
      const sub = interaction.options.getSubcommand();

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

        const ticket = resolveTicketFromChannel(interaction.channel);
        if (!ticket) {
          return interaction.reply({ content: '❌ Use this inside a ticket channel.', flags: MessageFlags.Ephemeral });
        }
        if (ticket.status === 'closed') {
          return interaction.reply({ content: '❌ This ticket is closed. Use `/reopen` first.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const member = interaction.member ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        const { dmSent, embedColor, staffDisplay, description } = await sendStaffReplyToUser({
          targetUserId: ticket.userId,
          content: qr.message,
          member,
          author: interaction.user,
          contextLabel: `Ticket #${ticket.id}  ·  Next RP`,
        });

        const logEmbed = makeEmbed({
          color: embedColor,
          title: `⚡ Quick Reply — ${qr.label}`,
          description,
          footer: `Sent by ${staffDisplay} · ${dmSent ? 'Delivered ✅' : 'Failed ❌'}`,
        });
        await interaction.channel.send({ embeds: [logEmbed] });

        return interaction.editReply({
          content: dmSent ? `✅ Sent **${qr.label}** to the user.` : '❌ Could not DM the user — they may have DMs disabled.',
        });
      }
    }

    // Legacy individual quick reply commands (e.g. /hello) if still registered
    const legacyQr = qrDb.getAll().find(
      qr => qr.id.toLowerCase().replace(/_/g, '') === commandName
    );
    if (legacyQr) {
      const ticket = resolveTicketFromChannel(interaction.channel);
      if (!ticket) return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
      if (ticket.status === 'closed') return interaction.reply({ content: '❌ This ticket is closed.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const member = interaction.member ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
      const { dmSent, embedColor, staffDisplay, description } = await sendStaffReplyToUser({
        targetUserId: ticket.userId,
        content: legacyQr.message,
        member,
        author: interaction.user,
        contextLabel: `Ticket #${ticket.id}  ·  Next RP`,
      });

      await interaction.channel.send({
        embeds: [makeEmbed({
          color: embedColor,
          title: `⚡ Quick Reply — ${legacyQr.label}`,
          description,
          footer: `Sent by ${staffDisplay} · ${dmSent ? 'Delivered ✅' : 'Failed ❌'}`,
        })],
      });

      return interaction.editReply({ content: dmSent ? '✅ Sent!' : '❌ Could not DM the user.' });
    }


    // /applications — manage staff applications
    if (commandName === 'applications') {
      const sub = interaction.options.getSubcommand();

      // Only the applications role (management) can use this command
      const isManagement = interaction.member?.roles?.cache?.has(APPLICATIONS_ROLE_ID)
        || interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);

      if (!isManagement) {
        return interaction.reply({ content: '❌ You do not have permission to manage applications.', flags: MessageFlags.Ephemeral });
      }

      if (sub === 'open') {
        appDb.setOpen(true);
        // Update any panel message if APPLICATIONS_PANEL_CHANNEL_ID is set
        const panelChId = process.env.APPLICATIONS_PANEL_CHANNEL_ID;
        if (panelChId) {
          try {
            const ch = await client.channels.fetch(panelChId);
            const msgs = await ch.messages.fetch({ limit: 20 });
            const panel = msgs.find(m => m.author.id === client.user.id && m.components?.length > 0
              && m.components[0]?.components?.some(c => c.customId === 'apply_staff_panel'));
            if (panel) await panel.edit(buildApplicationPanelPayload(true));
          } catch { /* panel channel may not exist */ }
        }
        return interaction.reply({ content: '✅ Staff applications are now **open**. The panel has been updated.', flags: MessageFlags.Ephemeral });
      }

      if (sub === 'close') {
        appDb.setOpen(false);
        const panelChId = process.env.APPLICATIONS_PANEL_CHANNEL_ID;
        if (panelChId) {
          try {
            const ch = await client.channels.fetch(panelChId);
            const msgs = await ch.messages.fetch({ limit: 20 });
            const panel = msgs.find(m => m.author.id === client.user.id && m.components?.length > 0
              && m.components[0]?.components?.some(c => c.customId === 'apply_staff_panel'));
            if (panel) await panel.edit(buildApplicationPanelPayload(false));
          } catch { /* panel channel may not exist */ }
        }
        return interaction.reply({ content: '✅ Staff applications are now **closed**. The panel has been updated.', flags: MessageFlags.Ephemeral });
      }

      if (sub === 'setup') {
        await interaction.channel.send(buildApplicationPanelPayload(appDb.isOpen()));
        return interaction.reply({ content: '✅ Applications panel posted!', flags: MessageFlags.Ephemeral });
      }

      if (sub === 'list') {
        const statusFilter = interaction.options.getString('status') ?? null;
        const apps = appDb.getAllApplications(statusFilter);

        if (!apps.length) {
          return interaction.reply({ content: `No applications found${statusFilter ? ` with status **${statusFilter}**` : ''}.`, flags: MessageFlags.Ephemeral });
        }

        const lines = apps.slice(-20).map(a => {
          const ch = a.channelId ? ` · <#${a.channelId}>` : ' · ⚠️ no channel';
          return `**APP-${a.id}** · ${a.username} · ${a.ign ?? '—'} · \`${a.status}\`${ch} · <t:${Math.floor(new Date(a.submittedAt).getTime() / 1000)}:R>`;
        });

        const embed = makeEmbed({
          color: 0x5865F2,
          title: `📋 Applications${statusFilter ? ` — ${statusFilter}` : ''}`,
          description: lines.join('\n'),
          footer: `${apps.length} total${statusFilter ? ` · filtered by ${statusFilter}` : ''} · Use /applications review id:<id> to restore buttons`,
        });

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (sub === 'review') {
        const rawId = interaction.options.getString('id', true).replace(/^APP-/i, '').trim();
        const app = appDb.getApplication(rawId);
        if (!app) {
          return interaction.reply({ content: `❌ Application \`APP-${rawId}\` not found.`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await postApplicationReviewMessages(interaction.channel, app);
          return interaction.editReply({
            content: `✅ Re-posted **APP-${app.id}** (\`${app.status}\`) with answers and action buttons in this channel.`,
          });
        } catch (err) {
          console.error('Failed to re-post application:', err.message);
          return interaction.editReply({ content: `❌ Failed to re-post: ${err.message}` });
        }
      }

      if (sub === 'reopen') {
        const rawId = interaction.options.getString('id', true).replace(/^APP-/i, '').trim();
        const app = appDb.getApplication(rawId);
        if (!app) {
          return interaction.reply({ content: `❌ Application \`APP-${rawId}\` not found.`, flags: MessageFlags.Ephemeral });
        }

        const previous = app.status;
        appDb.reopenApplication(rawId);

        return interaction.reply({
          content: `✅ **APP-${rawId}** reopened (was \`${previous}\`). You can Accept / Decline / Hold it again.\nTip: run \`/applications review id:${rawId}\` in the app channel to refresh the buttons.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // /transfer — move ticket to a department
    if (commandName === 'transfer') {
      const ticket = resolveTicketFromChannel(interaction.channel);
      if (!ticket) {
        return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
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
        content: `**Transfer Ticket #${ticket.id}**\nCurrently: \`${currentDept}\`\nSelect a department to transfer this ticket to. Only that department's role will be able to see the channel.`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // ── Button interactions ──────────────────────────────────────────────────
  if (interaction.isButton()) {
    // ── Apply for Staff panel button — starts DM question flow ──────────
    if (interaction.customId === 'apply_staff_panel') {
      if (!appDb.isOpen()) {
        return interaction.reply({ content: '❌ Applications are currently closed. Check back later!', flags: MessageFlags.Ephemeral });
      }
      if (applicationDrafts.has(interaction.user.id)) {
        return interaction.reply({ content: '❌ You already have an application in progress — check your DMs to continue.', flags: MessageFlags.Ephemeral });
      }
      if (appDb.hasPendingApplication(interaction.user.id)) {
        const existing = appDb.getAllApplications().find(
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
            footer: existing ? `APP-${existing.id}` : null,
          })],
          flags: MessageFlags.Ephemeral,
        });
      }

      // Test DMs are open before starting
      let dmTest;
      try { dmTest = await interaction.user.createDM(); } catch {
        return interaction.reply({ content: '❌ I couldn\'t DM you. Please enable DMs from server members and try again.', flags: MessageFlags.Ephemeral });
      }

      // Acknowledge immediately so Discord doesn't show a timeout
      await interaction.reply({ content: '📨  Check your DMs! Your application has started.', flags: MessageFlags.Ephemeral });

      // Mark as in-progress
      applicationDrafts.set(interaction.user.id, { inProgress: true });

      // Run the DM flow (non-blocking)
      runApplicationInDM(interaction.user).then(async answers => {
        applicationDrafts.delete(interaction.user.id);
        if (!answers) return; // cancelled or timed out

        const app = appDb.createApplication(interaction.user.id, interaction.user.tag, answers);

        try {
          // Create a dedicated channel for this application
          const appChannel = await createApplicationChannel(app);

          // Overview + each answer + action buttons (buttons are always posted last)
          await postApplicationReviewMessages(appChannel, app);

          // DM the applicant — confirm receipt
          await tryDM(app.userId, {
            embeds: [makeEmbed({
              color: 0x5865F2,
              title: '📋  Application Received',
              description: [
                `### Thanks for applying, ${app.username.split('#')[0]}!`,
                ``,
                `Your staff application for **Next RP** has been received and is currently under review.`,
                `You will receive a DM here once a decision has been made.`,
                ``,
                `> Keep your DMs open so we can reach you.`,
              ].join('\n'),
              footer: `APP-${app.id}  ·  Next RP`,
            })],
          });

          // Also ping the log channel if configured
          if (APPLICATIONS_CHANNEL_ID) {
            try {
              const staffGuild = getStaffGuild();
              const logChannel = staffGuild
                ? (staffGuild.channels.cache.get(APPLICATIONS_CHANNEL_ID) ?? await staffGuild.channels.fetch(APPLICATIONS_CHANNEL_ID))
                : await client.channels.fetch(APPLICATIONS_CHANNEL_ID);
              await logChannel.send({
                embeds: [makeEmbed({
                  color: 0x5865F2,
                  title: '📋 New Staff Application',
                  description: `**${app.username}** has submitted a staff application.\n\n> View it in <#${appChannel.id}>`,
                  footer: `APP-${app.id}`,
                })],
              });
            } catch { /* log channel optional */ }
          }
        } catch (err) {
          console.error('Failed to create application channel:', err.message);
          // Application is already saved — try to notify management via log channel
          try {
            if (APPLICATIONS_CHANNEL_ID) {
              const staffGuild = getStaffGuild();
              const logChannel = staffGuild
                ? (staffGuild.channels.cache.get(APPLICATIONS_CHANNEL_ID) ?? await staffGuild.channels.fetch(APPLICATIONS_CHANNEL_ID))
                : await client.channels.fetch(APPLICATIONS_CHANNEL_ID);
              await logChannel.send({
                content: `⚠️ **APP-${app.id}** from **${app.username}** was saved but the review channel failed to post.\nError: \`${err.message}\`\nUse \`/applications list\` to see it — restart/redeploy may be needed to recover the channel.`,
              });
            }
          } catch { /* best effort */ }
        }
      }).catch(err => {
        applicationDrafts.delete(interaction.user.id);
        console.error('Application DM flow error:', err.message);
      });

      return;
    }

    // ── Application Accept / Decline / Hold buttons ─────────────────────
    if (interaction.customId.startsWith('app_accept_') ||
        interaction.customId.startsWith('app_decline_') ||
        interaction.customId.startsWith('app_hold_')) {

      // Only the applications management role can action these
      const isManagement = interaction.member?.roles?.cache?.has(APPLICATIONS_ROLE_ID)
        || interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);

      if (!isManagement) {
        return interaction.reply({ content: '❌ Only management can action applications.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      let action, appId;
      // Parse from the end so IDs like 0005 stay exact (avoid fragile replace collisions)
      if (interaction.customId.startsWith('app_accept_')) {
        action = 'accepted';
        appId = interaction.customId.slice('app_accept_'.length);
      } else if (interaction.customId.startsWith('app_decline_')) {
        action = 'declined';
        appId = interaction.customId.slice('app_decline_'.length);
      } else {
        action = 'hold';
        appId = interaction.customId.slice('app_hold_'.length);
      }
      appId = String(appId || '').replace(/^APP-/i, '').trim();

      const app = appDb.getApplication(appId);
      if (!app) {
        return interaction.followUp({
          content: `❌ Application \`APP-${appId || '?'}\` not found in the database.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // Treat missing/unknown status as still open. Allow management to change a prior
      // decision too — older builds updated the DB but left Accept/Decline looking pending.
      const currentStatus = String(app.status || 'pending').toLowerCase();
      if (currentStatus === action) {
        try {
          await interaction.message.edit({
            content: `**APP-${appId}** — already **${action}**${app.reviewedBy ? ` by ${app.reviewedBy}` : ''}`,
            embeds: [buildApplicationOverviewEmbed(app, action)],
            components: [buildApplicationButtons(appId, action)],
          });
        } catch { /* message may be gone */ }
        return interaction.followUp({
          content: `ℹ️ **APP-${appId}** is already marked as **${action}**${app.reviewedBy ? ` by **${app.reviewedBy}**` : ''}. The message has been refreshed.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const previousStatus = currentStatus;
      appDb.updateStatus(appId, action, interaction.user.tag);
      const updated = appDb.getApplication(appId);
      // DM the applicant
      const dmContent = {
        accepted: {
          color: 0x57F287,
          title: 'Application Accepted',
          body: [
            `### Congratulations, ${updated.username.split('#')[0]}! 🎉`,
            ``,
            `Your staff application for **Next RP** has been accepted.`,
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
            `Unfortunately your staff application for **Next RP** was not successful at this time.`,
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
            `Management is still reviewing your staff application for **Next RP**.`,
            `They may reach out with further questions — keep an eye on your DMs.`,
          ].join('\n'),
        },
      };

      const { color: dmColor, title: dmTitle, body: dmBody } = dmContent[action] ?? dmContent.declined;
      const dmEmbed = makeEmbed({
        color: dmColor,
        title: `📋  ${dmTitle}`,
        description: dmBody,
        footer: `APP-${appId}  ·  Next RP`,
      });

      await tryDM(updated.userId, { embeds: [dmEmbed] });

      const actionLabel = action === 'accepted' ? '✅ Accepted' : action === 'declined' ? '❌ Declined' : '🕐 On Hold';

      // Always refresh the button message so Discord matches the database
      try {
        await interaction.message.edit({
          content: `**APP-${appId}** — **${actionLabel}** by ${interaction.user.tag}`,
          embeds: [buildApplicationOverviewEmbed(updated, action)],
          components: [buildApplicationButtons(appId, action)],
        });
      } catch (err) {
        console.error('Failed to update application action message:', err.message);
      }

      // Reflect status on the channel topic so it stays visible while pending/hold
      try {
        if (interaction.channel?.isTextBased?.() && interaction.channel.manageable) {
          const topic = `Application APP-${appId} | Applicant: ${updated.username} (${updated.userId}) | Status: ${action}`;
          await interaction.channel.setTopic(topic.slice(0, 1024));
        }
      } catch { /* topic optional */ }

      const changedNote = (previousStatus !== 'pending' && previousStatus !== action)
        ? `\n_(was previously \`${previousStatus}\`${app.reviewedBy ? ` by ${app.reviewedBy}` : ''})_`
        : '';

      return interaction.followUp({
        embeds: [makeEmbed({
          color: dmColor,
          description: `**APP-${appId}** has been marked as **${actionLabel}**.\nApplicant has been notified via DM.${changedNote}`,
          footer: `Reviewed by ${interaction.user.tag}`,
        })],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Add quick reply button → open modal
    if (interaction.customId === 'qr_add_btn') {
      return interaction.showModal(buildQrAddModal());
    }

    // Open ticket from panel button
    if (interaction.customId === 'open_ticket_panel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const modal_subject = `Support request from ${interaction.user.username}`;
      const result = await openTicket(interaction.user, modal_subject);

      if (!result.ok) {
        return interaction.editReply({ content: `❌ ${result.message}` });
      }

      const msg = result.dmSent
        ? `✅ Ticket opened! Check your DMs.`
        : `✅ Ticket opened! I couldn't DM you — please enable DMs from server members.`;

      return interaction.editReply({ content: msg });
    }

    // Close ticket from staff channel button
    if (interaction.customId.startsWith('close_ticket_')) {
      const ticketId = parseInt(interaction.customId.replace('close_ticket_', ''), 10);
      const ticket = db.getTicket(ticketId) || resolveTicketFromChannel(interaction.channel);

      if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', flags: MessageFlags.Ephemeral });
      if (ticket.status === 'closed') return interaction.reply({ content: '❌ Already closed.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      db.closeTicket(ticket.id);

      const userEmbed = makeEmbed({
        color: Colors.Red,
        title: '🔒 Ticket Closed',
        description: `Your ticket has been closed.\n\nIf you need further help, open a new ticket.`,
      });
      await tryDM(ticket.userId, { embeds: [userEmbed] });

      const closeEmbed = makeEmbed({
        color: Colors.Red,
        title: '🔒 Ticket Closed',
        description: `Closed by ${interaction.user.tag} (via button)`,
        footer: `Ticket #${ticket.id}`,
      });

      const channel = interaction.guild.channels.cache.get(ticket.channelId)
        ?? await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
      if (channel) {
        await channel.send({ embeds: [closeEmbed] });
        try {
          await channel.setName(channel.name.replace(/^ticket-/, 'closed-'));
        } catch (err) {
          console.error('Close button rename failed:', err.message);
        }
        try {
          await channel.setTopic((channel.topic || '').replace('Status: open', 'Status: closed'));
        } catch { /* topic optional */ }
        try {
          const closedCat = await getOrCreateCategory(interaction.guild, '🔒 Closed Tickets');
          await channel.setParent(closedCat.id, { lockPermissions: false });
        } catch (err) {
          console.error('Close button move failed:', err.message);
        }
      }

      return interaction.editReply({ content: '✅ Ticket closed.' });
    }
  }
  // ── Select menu — department transfer ──────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('transfer_dept_')) {
    const ticketId = parseInt(interaction.customId.replace('transfer_dept_', ''), 10);
    const ticket = db.getTicket(ticketId) || resolveTicketFromChannel(interaction.channel);

    if (!ticket) return interaction.update({ content: '❌ Ticket not found.', components: [] });

    const deptId = interaction.values[0];
    const dept = DEPARTMENTS.find(d => d.id === deptId);

    if (!dept) return interaction.update({ content: '❌ Invalid department.', components: [] });

    await interaction.deferUpdate();

    const staffGuild = getStaffGuild();
    const channel = staffGuild?.channels.cache.get(ticket.channelId);

    if (!channel) {
      return interaction.editReply({ content: '❌ Ticket channel not found.', components: [] });
    }

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

    // Save department to DB
    db.setTicketDepartment(ticketId, deptId);

    // Post log in the channel
    const transferEmbed = makeEmbed({
      color: dept.color ?? Colors.Orange,
      title: `${dept.emoji} Ticket Transferred — ${dept.name}`,
      description: [
        `This ticket has been transferred to **${dept.name}**.`,
        '',
        `Only members with the <@&${dept.roleId}> role can now see this channel.`,
        `Transferred by ${interaction.user.tag}`,
      ].join('\n'),
      footer: `Ticket #${ticket.id}`,
    });

    await channel.send({ embeds: [transferEmbed] });

    return interaction.editReply({ content: `✅ Ticket transferred to **${dept.emoji} ${dept.name}**.`, components: [] });
  }
  } catch (err) {
    console.error('Interaction error:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Event: messageCreate — handles both DMs and staff channel messages
// ---------------------------------------------------------------------------
client.on('messageCreate', async message => {
  try {
  if (message.author.bot) return;

  // ── DM from user → forward to staff ticket channel ──────────────────────
  if (!message.guild) {
    // Ignore DMs from users who are mid-application — their messages are
    // handled by the awaitMessages collector inside runApplicationInDM()
    if (applicationDrafts.has(message.author.id)) return;

    const ticket = db.getOpenTicketByUser(message.author.id);

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
    const files = typeof filesFromMessage === 'function' ? filesFromMessage(message) : [];
    try {
      await channel.send({ embeds: [fwdEmbed], files: files.length ? files : undefined });
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
              '**Add a reply**',
              '`qr add` — opens a button, then a form',
              '',
              '**Use a reply** (in a ticket channel)',
              '`qr send hello`',
              '`qr send uwu_cafe`',
              '',
              '**Manage**',
              '`qr list`',
              '`qr remove hello`',
              '',
              '_Slash `/qr` appears after the bot is restarted with the latest update._',
            ].join('\n'),
          })],
          components: [buildQrAddButtonRow()],
        });
      }

      if (action === 'add') {
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
            components: [buildQrAddButtonRow()],
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
        if (!restJoined) return message.reply('Usage: `qr remove <id>` — e.g. `qr remove hello`');
        const result = qrDb.remove(restJoined);
        if (!result.ok) return message.reply(`❌ ${result.error}`);
        return message.reply(`✅ Removed **${result.reply.label}** (\`${result.reply.id}\`).`);
      }

      if (action === 'send') {
        if (!restJoined) return message.reply('Usage: `qr send <id>` — e.g. `qr send hello`');
        const qr = qrDb.getById(restJoined);
        if (!qr) return message.reply(`❌ No quick reply \`${restJoined}\`. Try \`qr list\`.`);

        const ticket = resolveTicketFromChannel(message.channel);
        if (!ticket) return message.reply('❌ Use `qr send` inside a ticket channel.');
        if (ticket.status === 'closed') return message.reply('❌ Ticket is closed. Use `/reopen` first.');

        const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        const { dmSent, embedColor, staffDisplay, description } = await sendStaffReplyToUser({
          targetUserId: ticket.userId,
          content: qr.message,
          member,
          author: message.author,
          contextLabel: `Ticket #${ticket.id}  ·  Next RP`,
        });

        await message.channel.send({
          embeds: [makeEmbed({
            color: embedColor,
            title: `⚡ Quick Reply — ${qr.label}`,
            description,
            footer: `Sent by ${staffDisplay} · ${dmSent ? 'Delivered ✅' : 'Failed ❌'}`,
          })],
        });
        return message.reply(dmSent ? `✅ Sent **${qr.label}**.` : '❌ Could not DM the user.');
      }

      return message.reply('Unknown qr command. Try `qr help`.');
    }

    if (!message.content.startsWith('%')) return; // internal note, do nothing

    const ticket = resolveTicketFromChannel(message.channel);
    const application = !ticket ? appDb.getApplicationByChannel(message.channelId) : null;

    if (!ticket && !application) return; // not a managed channel

    if (ticket?.status === 'closed') {
      return message.reply('⚠️ This ticket is closed. Use `/reopen` before replying.');
    }

    const replyContent = message.content.slice(1).trim();
    const files = typeof filesFromMessage === 'function' ? filesFromMessage(message) : [];
    if (!replyContent && !files.length) {
      return message.reply('⚠️ Message is empty after the `%` prefix.');
    }

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    const targetUserId = ticket ? ticket.userId : application.userId;
    const contextLabel = application ? `APP-${application.id}  ·  Next RP` : `Ticket #${ticket?.id}  ·  Next RP`;

    const { dmSent } = await sendStaffReplyToUser({
      targetUserId,
      content: replyContent || '*(attachment)*',
      member,
      author: message.author,
      contextLabel,
      files,
    });

    await message.react(dmSent ? '✅' : '❌').catch(() => {});
    if (!dmSent) {
      await message.reply('⚠️ Could not DM the user — they may have DMs disabled.').catch(() => {});
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
