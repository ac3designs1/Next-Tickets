require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  MessageFlags,
  Colors,
} = require('discord.js');

const db = require('./database');
const DEPARTMENTS = require('./departments.json');

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

  const category = await getUnassignedCategory(guild);
  const channelName = `ticket-${String(ticket.id).padStart(4, '0')}-${ticket.username
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 16)}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Ticket #${ticket.id} | User: ${ticket.username} (${ticket.userId}) | Status: open | Dept: Unassigned`,
    permissionOverwrites: buildPermissionOverwrites(guild),
  });

  return channel;
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

  let staffChannel;
  try {
    staffChannel = await createStaffChannel(ticket);
  } catch (err) {
    console.error('Failed to create staff channel:', err);
    return { ok: false, message: 'Could not create a ticket channel. Please contact staff directly.' };
  }

  db.setTicketChannel(ticket.id, staffChannel.id);

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
      `Your ticket **#${ticket.id}** has been opened.`,
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
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`   Main guild  : ${process.env.MAIN_GUILD_ID}`);
  console.log(`   Staff guild : ${process.env.STAFF_GUILD_ID}`);

  // Auto-post the ticket panel if PANEL_CHANNEL_ID is set
  const panelChannelId = process.env.PANEL_CHANNEL_ID;
  if (!panelChannelId) return;

  try {
    const channel = await client.channels.fetch(panelChannelId);
    if (!channel) return console.warn('⚠️  PANEL_CHANNEL_ID channel not found.');

    // Check if the bot already has a panel message in that channel
    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(
      m => m.author.id === client.user.id && m.components?.length > 0
    );

    if (existing) {
      console.log(`ℹ️  Ticket panel already exists in #${channel.name} — skipping re-post.`);
      return;
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

    await channel.send({ embeds: [embed], components: [row] });
    console.log(`✅ Ticket panel posted in #${channel.name}`);
  } catch (err) {
    console.error('Failed to post ticket panel:', err.message);
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
        ? `✅ Ticket **#${result.ticket.id}** opened! Check your DMs for confirmation.`
        : `✅ Ticket **#${result.ticket.id}** opened! I couldn't DM you — please enable DMs from server members.`;

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
        description: `Your ticket **#${ticket.id}** has been closed by staff.\n\nIf you need further help, open a new ticket.`,
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
        description: `Your ticket **#${ticket.id}** has been reopened by staff.\n\nFeel free to continue the conversation by DMing me.`,
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
    // Open ticket from panel button
    if (interaction.customId === 'open_ticket_panel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const modal_subject = `Support request from ${interaction.user.username}`;
      const result = await openTicket(interaction.user, modal_subject);

      if (!result.ok) {
        return interaction.editReply({ content: `❌ ${result.message}` });
      }

      const msg = result.dmSent
        ? `✅ Ticket **#${result.ticket.id}** opened! Check your DMs.`
        : `✅ Ticket **#${result.ticket.id}** opened! I couldn't DM you — please enable DMs from server members.`;

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
        description: `Your ticket **#${ticket.id}** has been closed.\n\nIf you need further help, open a new ticket.`,
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
// Login
// ---------------------------------------------------------------------------
client.login(process.env.BOT_TOKEN);
