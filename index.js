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
const { deployCommands } = require('./deploy-commands');
const DEPARTMENTS  = require('./departments.json');
const QUICK_REPLIES = require('./quick-replies.json');

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
  { id: 'ign',            section: '📋 General Information',         label: 'What is your in-game name?',                                                                         hint: 'e.g. John Smith' },
  { id: 'dobTimezone',    section: '📋 General Information',         label: 'What is your date of birth and timezone?',                                                           hint: 'e.g. 01/01/2000 | AEST (UTC+10)' },
  { id: 'availability',   section: '📋 General Information',         label: 'How many hours per week can you realistically dedicate to staff duties?',                            hint: 'Be honest — e.g. 15–20 hrs/week' },
  // ── Section 2: Experience & Self-Assessment ──────────────────────────────
  { id: 'prevExp',        section: '🧠 Experience & Self-Assessment', label: 'Do you have any previous staff experience? If yes, list the server name, your rank, and why you left.', hint: 'Write "None" if you have no prior experience.' },
  { id: 'whyServer',      section: '🧠 Experience & Self-Assessment', label: 'Why do you want to join the staff team of our server specifically?',                                 hint: 'Be specific — what draws you to this server and what can you contribute?' },
  { id: 'modVsAdmin',     section: '🧠 Experience & Self-Assessment', label: 'In your own words, what is the difference between a Moderator and an Administrator?',               hint: '' },
  { id: 'qualities',      section: '🧠 Experience & Self-Assessment', label: 'What qualities do you possess that make you a better fit than other applicants?',                   hint: '' },
  { id: 'stressHandling', section: '🧠 Experience & Self-Assessment', label: 'How do you handle high-stress situations or dealing with extremely toxic players?',                  hint: 'Give an example if you can.' },
  // ── Section 3: Scenario Questions ───────────────────────────────────────
  { id: 'scenarioA',      section: '⚠️ Scenario Questions',           label: 'Scenario A: You are in a sit with two players who are screaming over each other and trading OOC insults. Neither is letting the other speak. How do you de-escalate and resolve this?', hint: '' },
  { id: 'scenarioB',      section: '⚠️ Scenario Questions',           label: 'Scenario B: A close friend of yours on the server is caught clearly breaking a major rule (such as Combat Logging or VDM). No other staff are online. How do you handle this?',        hint: 'We are testing for bias — be honest.' },
  { id: 'scenarioC',      section: '⚠️ Scenario Questions',           label: 'Scenario C: You spectate a player suspected of using external cheats (e.g. aimbot or menu-injecting). What steps do you take to confirm your suspicions before taking action?',        hint: '' },
  { id: 'scenarioD',      section: '⚠️ Scenario Questions',           label: 'Scenario D: A player submits a clip showing a rule break, but the clip is only 15 seconds long and does not show the context leading up to the event. They demand an immediate ban. What is your response?', hint: '' },
  { id: 'scenarioE',      section: '⚠️ Scenario Questions',           label: 'Scenario E: An admin higher in rank than you makes a decision during an active scene that clearly violates the server\'s established rules. How do you handle this?',                  hint: 'Think carefully about chain of command.' },
  // ── Section 4: Rules & Knowledge ────────────────────────────────────────
  { id: 'rulesFailFear',  section: '📖 Rules & Knowledge',            label: 'Briefly define FailRP and FearRP, and give an in-game example of each.',                           hint: 'Format: FailRP: [definition + example] | FearRP: [definition + example]' },
  { id: 'rulesMetaPower', section: '📖 Rules & Knowledge',            label: 'Briefly define Meta-gaming and Power-gaming, and give an in-game example of each.',               hint: '' },
  { id: 'rulesRdmNlr',    section: '📖 Rules & Knowledge',            label: 'Briefly define RDM, VDM and the New Life Rule (NLR), and give an in-game example of each.',       hint: '' },
];

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
 * Build the application embeds (shown in the applications channel).
 * Returns an array of up to 4 embeds — one per section.
 */
function buildApplicationEmbeds(app, status = 'pending') {
  const statusMeta = {
    pending:  { color: 0xFEE75C, badge: '⏳ Pending Review' },
    accepted: { color: 0x57F287, badge: '✅ Accepted'        },
    declined: { color: 0xED4245, badge: '❌ Declined'        },
    hold:     { color: 0xEB459E, badge: '🕐 On Hold'         },
  };
  const { color, badge } = statusMeta[status] ?? statusMeta.pending;
  const ts = Math.floor(new Date(app.submittedAt).getTime() / 1000);
  const trim = (s, n = 1024) => (s ?? '—').slice(0, n);

  // ── Embed 1: Header + General Info ──────────────────────────────────────
  const e1 = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📋  Staff Application — APP-${app.id}`)
    .setDescription(
      `**Status: ${badge}**\n` +
      `👤 <@${app.userId}>  ·  \`${app.username}\`  ·  Submitted <t:${ts}:R>` +
      (app.reviewedBy ? `\n🔍 Reviewed by **${app.reviewedBy}**` : '')
    )
    .addFields(
      { name: '🎮 In-Game Name',        value: trim(app.ign, 256),          inline: true },
      { name: '📅 DOB & Timezone',      value: trim(app.dobTimezone, 256),  inline: true },
      { name: '⏰ Weekly Availability', value: trim(app.availability, 256), inline: true },
    )
    .setFooter({ text: `APP-${app.id}  ·  Section 1 of 4 — General Information` })
    .setTimestamp();

  // ── Embed 2: Experience & Self-Assessment ────────────────────────────────
  const e2 = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🧠  Section 2 — Experience & Self-Assessment')
    .addFields(
      { name: 'Previous Staff Experience',                value: trim(app.prevExp)        },
      { name: 'Why Do You Want to Join Our Staff Team?',  value: trim(app.whyServer)      },
      { name: 'Moderator vs Administrator',               value: trim(app.modVsAdmin)     },
      { name: 'What Makes You a Better Fit?',             value: trim(app.qualities)      },
      { name: 'Handling Toxic / High-Stress Situations',  value: trim(app.stressHandling) },
    )
    .setFooter({ text: `APP-${app.id}  ·  Section 2 of 4` });

  // ── Embed 3: Scenario Questions ──────────────────────────────────────────
  const e3 = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('⚠️  Section 3 — Scenario Questions')
    .addFields(
      { name: 'Scenario A — OOC sit, players screaming over each other',             value: trim(app.scenarioA) },
      { name: 'Scenario B — Close friend caught breaking a major rule',              value: trim(app.scenarioB) },
      { name: 'Scenario C — Player suspected of using external cheats',              value: trim(app.scenarioC) },
      { name: 'Scenario D — 15-sec clip with no context, demands instant ban',       value: trim(app.scenarioD) },
      { name: 'Scenario E — Senior admin makes a call that breaks server rules',     value: trim(app.scenarioE) },
    )
    .setFooter({ text: `APP-${app.id}  ·  Section 3 of 4` });

  // ── Embed 4: Rules & Knowledge ───────────────────────────────────────────
  const e4 = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('📖  Section 4 — Rules & Knowledge')
    .addFields(
      { name: 'FailRP & FearRP',               value: trim(app.rulesFailFear)  },
      { name: 'Meta-gaming & Power-gaming',     value: trim(app.rulesMetaPower) },
      { name: 'RDM, VDM & New Life Rule (NLR)', value: trim(app.rulesRdmNlr)   },
    )
    .setFooter({ text: `APP-${app.id}  ·  Section 4 of 4 — Rules & Knowledge` });

  return [e1, e2, e3, e4];
}

/** Build the action row buttons for an application (pending = Accept/Decline/Hold; else locked) */
function buildApplicationButtons(appId, status = 'pending') {
  if (status !== 'pending' && status !== 'hold') {
    // Application resolved — show a single disabled "Reviewed" button
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`app_noop_${appId}`)
        .setLabel('Reviewed')
        .setStyle(ButtonStyle.Secondary)
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
      .setLabel('On Hold')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🕐'),
  );
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
        '`/qr` — Send a quick reply to the user (dropdown menu)',
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
    const qrLines = QUICK_REPLIES.map(qr => `**${qr.label}**\n> ${qr.message}`);
    const qrEmbed = makeEmbed({
      color: Colors.Green,
      title: '⚡ Quick Replies  —  `/qr`',
      description: qrLines.join('\n\n'),
      footer: 'Edit quick-replies.json to add or change these.',
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
      const ticket = db.getTicketByChannel(interaction.channelId);

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
      await interaction.channel.setName(interaction.channel.name.replace('ticket-', 'closed-'));
      await interaction.channel.setTopic(interaction.channel.topic?.replace('Status: open', 'Status: closed'));
      const closedCat = await getOrCreateCategory(interaction.guild, '🔒 Closed Tickets');
      await interaction.channel.setParent(closedCat.id, { lockPermissions: false });

      return interaction.editReply({ content: '✅ Ticket closed.' });
    }

    // /reopen — reopen a closed ticket
    if (commandName === 'reopen') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ticket = db.getTicketByChannel(interaction.channelId);

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
      await interaction.channel.setName(interaction.channel.name.replace('closed-', 'ticket-'));
      await interaction.channel.setTopic(interaction.channel.topic?.replace('Status: closed', 'Status: open'));
      // Move back to Unassigned or the department category
      const reopenedTicket = db.getTicket(ticket.id);
      const reopenDept = reopenedTicket?.department ? DEPARTMENTS.find(d => d.id === reopenedTicket.department) : null;
      const reopenCat = reopenDept
        ? await getDeptCategory(interaction.guild, reopenDept)
        : await getUnassignedCategory(interaction.guild);
      await interaction.channel.setParent(reopenCat.id, { lockPermissions: false });

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

    // Individual quick reply commands (e.g. /hello, /resolved, /moreinfo)
    const quickReplyCmd = QUICK_REPLIES.find(
      qr => qr.id.toLowerCase().replace(/_/g, '') === commandName
    );
    if (quickReplyCmd) {
      const ticket = db.getTicketByChannel(interaction.channelId);
      if (!ticket) return interaction.reply({ content: '❌ This is not a ticket channel.', flags: MessageFlags.Ephemeral });
      if (ticket.status === 'closed') return interaction.reply({ content: '❌ This ticket is closed.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const member = interaction.member ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
      let highestDept = null;
      if (member) {
        for (let i = DEPARTMENTS.length - 1; i >= 0; i--) {
          if (member.roles.cache.has(DEPARTMENTS[i].roleId)) { highestDept = DEPARTMENTS[i]; break; }
        }
      }
      const rankLabel = highestDept ? `${highestDept.emoji} ${highestDept.name}` : 'Staff';
      const embedColor = highestDept?.color ?? Colors.Green;
      const staffDisplayName = member?.displayName ?? interaction.user.username;

      const userEmbed = makeEmbed({ color: embedColor, description: quickReplyCmd.message, footer: rankLabel });
      userEmbed.setAuthor({ name: staffDisplayName, iconURL: interaction.user.displayAvatarURL() });

      const dmSent = await tryDM(ticket.userId, { embeds: [userEmbed] });

      const logEmbed = makeEmbed({
        color: embedColor,
        title: `⚡ Quick Reply — ${quickReplyCmd.label}`,
        description: quickReplyCmd.message,
        footer: `Sent by ${staffDisplayName} · ${dmSent ? 'Delivered ✅' : 'Failed ❌'}`,
      });
      await interaction.channel.send({ embeds: [logEmbed] });

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

        const lines = apps.slice(-20).map(a =>
          `**APP-${a.id}** · ${a.username} · ${a.ign ?? '—'} · \`${a.status}\` · <t:${Math.floor(new Date(a.submittedAt).getTime() / 1000)}:R>`
        );

        const embed = makeEmbed({
          color: 0x5865F2,
          title: `📋 Applications${statusFilter ? ` — ${statusFilter}` : ''}`,
          description: lines.join('\n'),
          footer: `${apps.length} total${statusFilter ? ` · filtered by ${statusFilter}` : ''}`,
        });

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }

    // /transfer — move ticket to a department
    if (commandName === 'transfer') {
      const ticket = db.getTicketByChannel(interaction.channelId);
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
      if (appDb.hasPendingApplication(interaction.user.id)) {
        return interaction.reply({ content: '❌ You already have a pending application. Please wait for a decision before re-applying.', flags: MessageFlags.Ephemeral });
      }
      if (applicationDrafts.has(interaction.user.id)) {
        return interaction.reply({ content: '❌ You already have an application in progress! Check your DMs.', flags: MessageFlags.Ephemeral });
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
          const appChannel = await client.channels.fetch(APPLICATIONS_CHANNEL_ID);
          const embeds  = buildApplicationEmbeds(app, 'pending');
          const buttons = buildApplicationButtons(app.id, 'pending');
          const msg = await appChannel.send({ embeds, components: [buttons] });
          appDb.setMessageId(app.id, msg.id);
        } catch (err) {
          console.error('Failed to post application to channel:', err.message);
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
      if (interaction.customId.startsWith('app_accept_'))  { action = 'accepted'; appId = interaction.customId.replace('app_accept_',  ''); }
      if (interaction.customId.startsWith('app_decline_')) { action = 'declined'; appId = interaction.customId.replace('app_decline_', ''); }
      if (interaction.customId.startsWith('app_hold_'))    { action = 'hold';     appId = interaction.customId.replace('app_hold_',    ''); }

      const app = appDb.getApplication(appId);
      if (!app) return interaction.followUp({ content: '❌ Application not found.', flags: MessageFlags.Ephemeral });
      if (app.status !== 'pending' && app.status !== 'hold') {
        return interaction.followUp({ content: '❌ This application has already been reviewed.', flags: MessageFlags.Ephemeral });
      }

      appDb.updateStatus(appId, action, interaction.user.tag);
      const updated = appDb.getApplication(appId);

      // Update the embeds in the applications channel
      const updatedEmbeds   = buildApplicationEmbeds(updated, action);
      const updatedButtons  = buildApplicationButtons(appId, action);
      await interaction.message.edit({ embeds: updatedEmbeds, components: [updatedButtons] });

      // DM the applicant
      const dmMessages = {
        accepted: [
          '🎉 **Congratulations!** Your staff application for Next RP has been **accepted**.',
          '',
          'A member of management will be in touch shortly with next steps.',
          'Welcome to the team!',
        ].join('\n'),
        declined: [
          '❌ Thank you for your interest in joining the Next RP staff team.',
          '',
          'Unfortunately your application was **not successful** at this time.',
          'You\'re welcome to apply again in the future.',
        ].join('\n'),
        hold: [
          '🕐 Your staff application for Next RP has been placed **on hold**.',
          '',
          'Management may reach out to you with further questions.',
        ].join('\n'),
      };

      const dmEmbed = makeEmbed({
        color: action === 'accepted' ? Colors.Green : action === 'declined' ? Colors.Red : Colors.Fuchsia,
        title: `📋 Staff Application — ${action === 'accepted' ? 'Accepted ✅' : action === 'declined' ? 'Declined ❌' : 'On Hold 🕐'}`,
        description: dmMessages[action],
        footer: `APP-${appId} · Next RP`,
      });

      await tryDM(updated.userId, { embeds: [dmEmbed] });

      return interaction.followUp({
        content: `✅ Application **APP-${appId}** marked as **${action}**. Applicant has been notified via DM.`,
        flags: MessageFlags.Ephemeral,
      });
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
      const ticket = db.getTicket(ticketId);

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

      const channel = interaction.guild.channels.cache.get(ticket.channelId);
      if (channel) {
        await channel.send({ embeds: [closeEmbed] });
        await channel.setName(channel.name.replace('ticket-', 'closed-'));
        await channel.setTopic(channel.topic?.replace('Status: open', 'Status: closed'));
        const closedCat = await getOrCreateCategory(interaction.guild, '🔒 Closed Tickets');
        await channel.setParent(closedCat.id, { lockPermissions: false });
      }

      return interaction.editReply({ content: '✅ Ticket closed.' });
    }
  }
  // ── Select menu — department transfer ──────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('transfer_dept_')) {
    const ticketId = parseInt(interaction.customId.replace('transfer_dept_', ''), 10);
    const ticket = db.getTicket(ticketId);

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

    const staffGuild = getStaffGuild();
    if (!staffGuild) return;

    const channel = staffGuild.channels.cache.get(ticket.channelId);
    if (!channel) return;

    // Build the forwarded message embed
    const fwdEmbed = makeEmbed({
      color: Colors.Blue,
      title: null,
      description: message.content || '*(no text — see attachment below)*',
      footer: `📨 ${message.author.tag} · Ticket #${ticket.id}`,
    });

    fwdEmbed.setAuthor({
      name: `${message.author.tag} (User)`,
      iconURL: message.author.displayAvatarURL(),
    });

    // Forward attachments too
    const files = message.attachments.map(a => a.url);
    await channel.send({ embeds: [fwdEmbed], files });

    // Confirm receipt to user
    await message.react('✅');
    return;
  }

  // ── Staff message in ticket channel with % prefix → reply to user ───────
  if (message.guild && message.guild.id === process.env.STAFF_GUILD_ID) {
    if (!message.content.startsWith('%')) return; // internal note, do nothing

    const ticket = db.getTicketByChannel(message.channelId);
    if (!ticket) return; // not a ticket channel

    if (ticket.status === 'closed') {
      return message.reply('⚠️ This ticket is closed. Use `/reopen` before replying.');
    }

    const replyContent = message.content.slice(1).trim();
    if (!replyContent) return message.reply('⚠️ Message is empty after the `%` prefix.');

    // Find the staff member's highest department role
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    let highestDept = null;
    if (member) {
      // DEPARTMENTS is ordered lowest → highest, so iterate in reverse to find the top rank
      for (let i = DEPARTMENTS.length - 1; i >= 0; i--) {
        if (member.roles.cache.has(DEPARTMENTS[i].roleId)) {
          highestDept = DEPARTMENTS[i];
          break;
        }
      }
    }

    const rankLabel = highestDept ? `${highestDept.emoji} ${highestDept.name}` : 'Staff';
    const embedColor = highestDept?.color ?? Colors.Green;
    const staffDisplayName = member?.displayName ?? message.author.username;

    const userEmbed = makeEmbed({
      color: embedColor,
      title: null,
      description: replyContent,
      footer: `${rankLabel}`,
    });

    userEmbed.setAuthor({
      name: staffDisplayName,
      iconURL: message.author.displayAvatarURL(),
    });

    // Forward attachments
    const files = message.attachments.map(a => a.url);
    const dmSent = await tryDM(ticket.userId, { embeds: [userEmbed], files });

    // React to confirm delivery
    await message.react(dmSent ? '✅' : '❌');

    if (!dmSent) {
      await message.reply('⚠️ Could not DM the user — they may have DMs disabled.');
    }

    return;
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
deployCommands().then(() => client.login(process.env.BOT_TOKEN));
