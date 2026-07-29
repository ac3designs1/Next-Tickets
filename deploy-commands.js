require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
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
].map(cmd => cmd.toJSON());

/** Deploy commands to one or both guilds. Returns true on success. */
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    // Clear any stale global commands first (they persist until explicitly deleted)
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
    console.log('[Commands] 🧹 Cleared global commands');

    console.log('[Commands] Deploying slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.MAIN_GUILD_ID),
      { body: commands }
    );
    console.log(`[Commands] ✅ Deployed to MAIN guild (${process.env.MAIN_GUILD_ID})`);

    if (process.env.STAFF_GUILD_ID && process.env.STAFF_GUILD_ID !== process.env.MAIN_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.STAFF_GUILD_ID),
        { body: commands }
      );
      console.log(`[Commands] ✅ Deployed to STAFF guild (${process.env.STAFF_GUILD_ID})`);
    }
    return true;
  } catch (err) {
    console.error('[Commands] ❌ Failed to deploy:', err.message);
    return false;
  }
}

// Allow running directly: node deploy-commands.js
if (require.main === module) {
  deployCommands().then(() => process.exit(0));
}

module.exports = { deployCommands };
