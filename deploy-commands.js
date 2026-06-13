require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const QUICK_REPLIES = require('./quick-replies.json');

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

  // Dynamically generate one command per quick reply
  ...QUICK_REPLIES.map(qr =>
    new SlashCommandBuilder()
      .setName(qr.id.toLowerCase().replace(/_/g, ''))
      .setDescription(`Quick reply: ${qr.label}`)
  ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log('Deploying slash commands...');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.MAIN_GUILD_ID),
      { body: commands }
    );
    console.log(`Commands deployed to MAIN guild (${process.env.MAIN_GUILD_ID})`);

    if (process.env.STAFF_GUILD_ID && process.env.STAFF_GUILD_ID !== process.env.MAIN_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.STAFF_GUILD_ID),
        { body: commands }
      );
      console.log(`Commands deployed to STAFF guild (${process.env.STAFF_GUILD_ID})`);
    }

    console.log('Done!');
  } catch (err) {
    console.error(err);
  }
})();
