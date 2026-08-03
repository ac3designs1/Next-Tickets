require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const qrDb = require('./quick-replies-db');

function buildCommands() {
  const base = [
    new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Open a new support ticket')
      .addStringOption(opt =>
        opt.setName('subject')
          .setDescription('Brief description of your issue')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close the current ticket (staff only — run inside a ticket channel)'),

    new SlashCommandBuilder()
      .setName('reopen')
      .setDescription('Reopen a closed ticket (staff only — run inside a ticket channel)'),

    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Post the ticket panel in this channel (staff only)'),

    new SlashCommandBuilder()
      .setName('tickets')
      .setDescription('List all open tickets (staff only)'),

    new SlashCommandBuilder()
      .setName('claim')
      .setDescription('Claim the current ticket (staff only — run inside a ticket channel)'),

    new SlashCommandBuilder()
      .setName('unclaim')
      .setDescription('Release your claim on the current ticket (staff only)'),

    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Show ticket stats (staff only)'),

    new SlashCommandBuilder()
      .setName('transfer')
      .setDescription('Transfer this ticket to a specific department (staff only — run inside a ticket channel)'),

    new SlashCommandBuilder()
      .setName('qr')
      .setDescription('Quick replies — send, add, remove, or list canned responses')
      .addSubcommand(sub =>
        sub.setName('send')
          .setDescription('Send a quick reply to the user (use in a ticket channel)')
          .addStringOption(opt =>
            opt.setName('reply')
              .setDescription('Which quick reply to send')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('add')
          .setDescription('Add a new quick reply (opens a form)')
      )
      .addSubcommand(sub =>
        sub.setName('remove')
          .setDescription('Remove a quick reply')
          .addStringOption(opt =>
            opt.setName('reply')
              .setDescription('Which quick reply to remove')
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('list')
          .setDescription('List all saved quick replies')
      ),

    new SlashCommandBuilder()
      .setName('applications')
      .setDescription('Manage staff applications (management only)')
      .addSubcommand(sub => sub.setName('open').setDescription('Open staff applications'))
      .addSubcommand(sub => sub.setName('close').setDescription('Close staff applications — no new submissions accepted'))
      .addSubcommand(sub => sub.setName('setup').setDescription('Post the "Apply for Staff" panel in this channel'))
      .addSubcommand(sub =>
        sub.setName('list')
          .setDescription('List recent applications')
          .addStringOption(opt =>
            opt.setName('status')
              .setDescription('Filter by status')
              .addChoices(
                { name: 'Pending',  value: 'pending'  },
                { name: 'Accepted', value: 'accepted' },
                { name: 'Declined', value: 'declined' },
                { name: 'On Hold',  value: 'hold'     },
              )
          )
      )
      .addSubcommand(sub =>
        sub.setName('review')
          .setDescription('Re-post an application (with Accept/Decline buttons) in this channel')
          .addStringOption(opt =>
            opt.setName('id')
              .setDescription('Application ID, e.g. 0001')
              .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName('reopen')
          .setDescription('Reset an application back to pending so it can be accepted/declined again')
          .addStringOption(opt =>
            opt.setName('id')
              .setDescription('Application ID, e.g. 0005')
              .setRequired(true)
          )
      ),

    new SlashCommandBuilder()
      .setName('ticketban')
      .setDescription('Ban or unban users from opening tickets (Admin & Management only)')
      .addSubcommand(sub =>
        sub.setName('ban')
          .setDescription('Ban a user from opening tickets')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('User to ban from tickets')
              .setRequired(true)
          )
          .addStringOption(opt =>
            opt.setName('reason')
              .setDescription('Reason for the ban')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub.setName('unban')
          .setDescription('Allow a banned user to open tickets again')
          .addUserOption(opt =>
            opt.setName('user')
              .setDescription('User to unban')
              .setRequired(false)
          )
          .addStringOption(opt =>
            opt.setName('userid')
              .setDescription('Discord user ID (if they are not in the server)')
              .setRequired(false)
          )
      )
      .addSubcommand(sub =>
        sub.setName('list')
          .setDescription('List users banned from opening tickets')
      ),
  ];

  // Keep one-shot /hello style commands too (from saved replies)
  const usedNames = new Set(base.map(c => c.name));
  for (const qr of qrDb.getAll()) {
    const name = qr.id.toLowerCase().replace(/_/g, '').replace(/[^a-z0-9]/g, '').slice(0, 32);
    if (!name || usedNames.has(name)) continue;
    usedNames.add(name);
    base.push(
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(`Quick reply: ${qr.label}`.slice(0, 100))
    );
  }

  return base.map(cmd => cmd.toJSON());
}

/** Deploy commands to one or both guilds. Returns true on success. */
async function deployCommands() {
  const token = process.env.BOT_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const mainGuild = process.env.MAIN_GUILD_ID;
  const staffGuild = process.env.STAFF_GUILD_ID;

  if (!token || !clientId || !mainGuild) {
    console.error('[Commands] ❌ Missing BOT_TOKEN, CLIENT_ID, or MAIN_GUILD_ID — slash commands NOT deployed');
    return false;
  }

  const commands = buildCommands();
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    // Clear any stale global commands first (they persist until explicitly deleted)
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('[Commands] 🧹 Cleared global commands');

    console.log(`[Commands] Deploying ${commands.length} commands: ${commands.map(c => c.name).join(', ')}`);

    await rest.put(
      Routes.applicationGuildCommands(clientId, mainGuild),
      { body: commands }
    );
    console.log(`[Commands] ✅ Deployed to MAIN guild (${mainGuild})`);

    if (staffGuild && staffGuild !== mainGuild) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, staffGuild),
        { body: commands }
      );
      console.log(`[Commands] ✅ Deployed to STAFF guild (${staffGuild})`);
    } else if (!staffGuild) {
      console.warn('[Commands] ⚠️ STAFF_GUILD_ID not set — staff server will not get /qr');
    }
    return true;
  } catch (err) {
    console.error('[Commands] ❌ Failed to deploy:', err.message);
    if (err.rawError) console.error('[Commands] Details:', JSON.stringify(err.rawError));
    return false;
  }
}

// Allow running directly: node deploy-commands.js
if (require.main === module) {
  deployCommands().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { deployCommands };
