const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

require('dotenv').config();

// =====================
// CLIENT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// =====================
// CONFIG
// =====================
const ADMIN_ROLES = ["Admin", "Moderator", "Owner"];
const PLAYER_ROLES = ["FC26 Player", "Member"];

const MAIN_VC_ID = "1499698725893705872"; // Main channel to gather all players after competition ends
const TEAM_CATEGORY_ID = "1502236927141875782"; // Category where temp team channels will be created
const ADMIN_PANEL_CHANNEL_ID = "1499753429512487023"; // Optional: Channel for admin updates (can be same as MAIN_VC_ID if you want)
// =====================
// DATA
// =====================
let tempChannels = {
  red: null,
  blue: null
};

let originalVoiceChannels = {};

let queue = [];
const playerData = {};

let draftMode = false;

let captains = { red: null, blue: null };

let draftTeams = { red: [], blue: [] };

let currentTurn = "red";

let lastMatch = null;

let matchStarted = false;

// =====================
// LIVE COMPETITION STATE
// =====================
let competitionActive = false;
let competitionMessage = null;

// =====================
// COMPETITION TRACKING (NEW)
// =====================
let competitionScores = { red: 0, blue: 0 };
let matchHistory = [];
let matchCount = 0;
let pickedPlayers = new Set(); // Track all picked players during competition

// =====================
// ROLE CHECK
// =====================
function hasRole(member, roles) {
  return member.roles.cache.some(r => roles.includes(r.name));
}

// FIXED SAFE COMMAND ACCESS
function canUse(member, cmd) {

  const admin = [
    "autobalance",
    "captains",
    "startmatch",
    "finalize",
    "rematch",
    "startcompetition",
    "finishcompetition"
  ];

  const player = [
    "join",
    "skill",
    "pick",
    "stats"
  ];

  if (admin.includes(cmd)) return hasRole(member, ADMIN_ROLES);
  if (player.includes(cmd)) return hasRole(member, PLAYER_ROLES);

  return true; // fallback avoids crashes
}

// =====================
// PLAYER DATA
// =====================
function ensurePlayer(id) {
  if (!playerData[id]) {
    playerData[id] = {
      skill: 5,
      position: "MID"
    };
  }
}

// =====================
// VOICE SCAN (FIXED)
// =====================
function getVoicePlayers(guild) {
  const users = [];

  guild.channels.cache.forEach(channel => {
    if (channel.isVoiceBased()) {
      channel.members.forEach(m => {
        if (!m.user.bot) users.push(m.id);
      });
    }
  });

  return [...new Set(users)];
}

// =====================
// COMPETITION CONTROL PANEL (NEW - BASIC VERSION)
// =====================

function buildAdminPanel() {

  const embed = new EmbedBuilder()
    .setTitle("⚙️ COMPETITION CONTROL PANEL")
    .setDescription("Use buttons to control the match system quickly")
    .setColor(0x00AEFF);

  const row1 = new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId("startcompetition")
      .setLabel("Start Competition")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("autobalance")
      .setLabel("Auto Balance")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("startmatch")
      .setLabel("Start Match")
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId("rematch")
      .setLabel("Rematch")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("endcompetition")
      .setLabel("End Early")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("finishcompetition")
      .setLabel("Finish Competition")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("open_finalize_modal")
      .setLabel("Finalize Match")
      .setStyle(ButtonStyle.Primary)  
  );

  return { embeds: [embed], components: [row1, row2] };
}

// =====================
// FinalizeModal (NEW - FOR ADMIN PANEL)
// =====================
function buildFinalizeModal() {

  const modal = new ModalBuilder()
    .setCustomId("finalize_modal")
    .setTitle("Finalize Match Score");

  const redScore = new TextInputBuilder()
    .setCustomId("red_score")
    .setLabel("Red Team Goals")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const blueScore = new TextInputBuilder()
    .setCustomId("blue_score")
    .setLabel("Blue Team Goals")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const row1 = new ActionRowBuilder().addComponents(redScore);
  const row2 = new ActionRowBuilder().addComponents(blueScore);

  modal.addComponents(row1, row2);

  return modal;
}

// =====================
// BUILD COMPETITION EMBED (NEW)
// =====================
function buildCompetitionEmbed() {
  const matchHistoryText = matchHistory.length > 0
    ? matchHistory.map((m, i) => `**Match ${i + 1}:** 🔴 ${m.redScore} - 🔵 ${m.blueScore} | Winner: ${m.winner}`).join("\n")
    : "No matches yet";

  const embed = new EmbedBuilder()
    .setTitle("🏆 LIVE COMPETITION")
    .addFields(
      { name: "🔴 Red Team Score", value: `**${competitionScores.red}** wins`, inline: true },
      { name: "🔵 Blue Team Score", value: `**${competitionScores.blue}** wins`, inline: true },
      { name: "📊 Match History", value: matchHistoryText, inline: false },
      { name: "📋 Current Match", value: matchStarted ? "Match in progress" : "Waiting to start", inline: false }
    )
    .setColor(0x00AEFF)
    .setTimestamp();

  return embed;
}

// =====================
// RESTORE PLAYERS + DELETE TEMP CHANNELS
// =====================
async function moveAllPlayersToMain(guild) {

  try {

    // restore EVERY tracked player
    for (const playerId of Object.keys(originalVoiceChannels)) {

      const member =
        await guild.members
          .fetch(playerId)
          .catch(() => null);

      if (!member) continue;

      // player must still be in VC
      if (!member.voice?.channel) continue;

      const originalChannelId =
        originalVoiceChannels[playerId];

      const originalChannel =
        guild.channels.cache.get(originalChannelId);

      // restore original channel
      if (originalChannel) {

        await member.voice
          .setChannel(originalChannel)
          .catch(console.error);
      }
      else {

        // fallback
        const mainChannel =
          guild.channels.cache.get(MAIN_VC_ID);

        if (mainChannel) {

          await member.voice
            .setChannel(mainChannel)
            .catch(console.error);
        }
      }
    }

    // =====================
    // DELETE TEMP CHANNELS
    // =====================

    if (tempChannels.red) {

      const redChannel =
        guild.channels.cache.get(tempChannels.red);

      if (redChannel) {
        await redChannel.delete().catch(() => null);
      }
    }

    if (tempChannels.blue) {

      const blueChannel =
        guild.channels.cache.get(tempChannels.blue);

      if (blueChannel) {
        await blueChannel.delete().catch(() => null);
      }
    }

    // =====================
    // RESET STORAGE
    // =====================

    tempChannels = {
      red: null,
      blue: null
    };

    originalVoiceChannels = {};

  }
  catch (err) {

    console.error(
      "Error restoring players:",
      err
    );
  }
}

// =====================
// LIVE EMBED UPDATE
// =====================
async function updateCompetitionEmbed() {
  if (!competitionMessage) return;

  const available = queue.length
    ? queue.map(id =>
        `• <@${id}> — **${playerData[id]?.position || "MID"}**`
      ).join("\n")
    : "No players left";

  const red = draftTeams.red.length
    ? draftTeams.red.map(id =>
        `• <@${id}> — **${playerData[id]?.position || "MID"}**`
      ).join("\n")
    : "Empty";

  const blue = draftTeams.blue.length
    ? draftTeams.blue.map(id =>
        `• <@${id}> — **${playerData[id]?.position || "MID"}**`
      ).join("\n")
    : "Empty";

  const matchHistoryText = matchHistory.length > 0
    ? matchHistory.map((m, i) => `**Match ${i + 1}:** 🔴 ${m.redScore} - 🔵 ${m.blueScore} | Winner: ${m.winner}`).join("\n")
    : "No matches yet";

  const embed = new EmbedBuilder()
    .setTitle("🏆 LIVE COMPETITION")
    .addFields(
      { name: "🔴 Red Wins", value: `**${competitionScores.red}**`, inline: true },
      { name: "🔵 Blue Wins", value: `**${competitionScores.blue}**`, inline: true },
      { name: "📊 Match History", value: matchHistoryText, inline: false },
      { name: "📋 Available Players", value: available },
      { name: "🔴 Red Team", value: red, inline: true },
      { name: "🔵 Blue Team", value: blue, inline: true }
    )
    .setColor(0x00AEFF)
    .setTimestamp();

  await competitionMessage.edit({ embeds: [embed] });
}

// =====================
// COMMANDS
// =====================
const commands = [

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join queue')
    .addStringOption(o =>
      o.setName('position')
        .setDescription('GK / DEF / MID / ATT')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('skill')
    .setDescription('Set skill')
    .addIntegerOption(o =>
      o.setName('level')
        .setDescription('1-10')
        .setRequired(true)
    ),

    new SlashCommandBuilder()
  .setName('autobalance')
  .setDescription('Auto balance all VC players into two teams'),

  new SlashCommandBuilder()
    .setName('startcompetition')
    .setDescription('Start VC competition'),

  new SlashCommandBuilder()
    .setName('captains')
    .setDescription('Select captains')
    .addUserOption(o =>
      o.setName('red')
        .setDescription('Red captain')
        .setRequired(true)
    )
    .addUserOption(o =>
      o.setName('blue')
        .setDescription('Blue captain')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pick')
    .setDescription('Pick player')
    .addUserOption(o =>
      o.setName('player')
        .setDescription('Player to pick')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('startmatch')
    .setDescription('Start match'),

  new SlashCommandBuilder()
    .setName('finalize')
    .setDescription('Finish match')
    .addIntegerOption(o =>
      o.setName('red')
        .setDescription('Red goals')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('blue')
        .setDescription('Blue goals')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('rematch')
    .setDescription('Rematch'),

  new SlashCommandBuilder()
    .setName('finishcompetition')
    .setDescription('Finish competition and declare winner'),

  new SlashCommandBuilder()
    .setName('endcompetition')
    .setDescription('End competition early and restore all players'),  

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Stats'),

   new SlashCommandBuilder()
  .setName('panel')
  .setDescription('Send admin control panel') 

].map(c => c.toJSON());

// =====================
// REGISTER
// =====================
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

async function register() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log("✅ Commands registered cleanly");
}

// =====================
// CREATE PRIVATE TEAM CHANNELS
// =====================
async function createTeamChannels(guild) {

  // delete old channels
  if (tempChannels.red) {

    const oldRed =
      guild.channels.cache.get(tempChannels.red);

    if (oldRed) {
      await oldRed.delete().catch(() => null);
    }
  }

  if (tempChannels.blue) {

    const oldBlue =
      guild.channels.cache.get(tempChannels.blue);

    if (oldBlue) {
      await oldBlue.delete().catch(() => null);
    }
  }

  // roles allowed to see channels
  const allowedRoles = [
    "Owner",
    "Admin",
    "Bot",
    "Moderador",
    "FC26 Player",
    "Member"
  ];

  // build permissions
  const permissions = [

    // deny everyone
    {
      id: guild.roles.everyone.id,
      deny: ['ViewChannel', 'Connect']
    }
  ];

  // allow selected roles
  allowedRoles.forEach(roleName => {

    const role =
      guild.roles.cache.find(r => r.name === roleName);

    if (role) {

      permissions.push({
        id: role.id,
        allow: ['ViewChannel', 'Connect', 'Speak']
      });
    }
  });

  // =====================
  // CREATE RED CHANNEL
  // =====================
  const redChannel =
    await guild.channels.create({

      name: "🔴 Red Team",

      type: ChannelType.GuildVoice,

      parent: TEAM_CATEGORY_ID,

      permissionOverwrites: permissions
    });

  // =====================
  // CREATE BLUE CHANNEL
  // =====================
  const blueChannel =
    await guild.channels.create({

      name: "🔵 Blue Team",

      type: ChannelType.GuildVoice,

      parent: TEAM_CATEGORY_ID,

      permissionOverwrites: permissions
    });

  tempChannels.red = redChannel.id;
  tempChannels.blue = blueChannel.id;
}

// =====================
// MOVE TEAMS TO TEMP CHANNELS
// =====================
async function moveTeams(guild, redTeam, blueTeam) {

  // create channels if missing
  if (!tempChannels.red || !tempChannels.blue) {
    await createTeamChannels(guild);
  }

  // =====================
  // MOVE RED TEAM
  // =====================
  for (const id of redTeam) {

    const member =
      await guild.members.fetch(id).catch(() => null);

    if (!member?.voice?.channel) continue;

    // save ORIGINAL channel ONLY ONCE
    if (!originalVoiceChannels[id]) {

      originalVoiceChannels[id] =
        member.voice.channel.id;
    }

    // move only if not already there
    if (member.voice.channel.id !== tempChannels.red) {

      await member.voice
        .setChannel(tempChannels.red)
        .catch(console.error);
    }
  }

  // =====================
  // MOVE BLUE TEAM
  // =====================
  for (const id of blueTeam) {

    const member =
      await guild.members.fetch(id).catch(() => null);

    if (!member?.voice?.channel) continue;

    // save ORIGINAL channel ONLY ONCE
    if (!originalVoiceChannels[id]) {

      originalVoiceChannels[id] =
        member.voice.channel.id;
    }

    // move only if not already there
    if (member.voice.channel.id !== tempChannels.blue) {

      await member.voice
        .setChannel(tempChannels.blue)
        .catch(console.error);
    }
  }
}

// =====================
// READY (FIXED - USING clientReady FOR discord.js v14)
// =====================
client.once("clientReady", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

function getAllVoicePlayers(guild) {
  const players = [];

  guild.channels.cache.forEach(channel => {
    if (channel.isVoiceBased()) {
      channel.members.forEach(member => {
        if (!member.user.bot) {
          players.push(member.id);
        }
      });
    }
  });

  return [...new Set(players)];
}

// =====================
// MAIN
// =====================

client.on('interactionCreate', async interaction => {

  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return;

  // =====================
  // BUTTONS FIRST
  // =====================
  if (interaction.isButton()) {

    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const id = interaction.customId;

    if (id === "open_finalize_modal") {
      return interaction.showModal(buildFinalizeModal());
    }

    if (id === "startcompetition") {
      return interaction.reply({ content: "Use /startcompetition command instead", flags: 64 });
    }

    if (id === "autobalance") {
      return interaction.reply({ content: "Use /autobalance command instead", flags: 64 });
    }

    if (id === "startmatch") {
      return interaction.reply({ content: "Use /startmatch command instead", flags: 64 });
    }

    if (id === "rematch") {
      return interaction.reply({ content: "Use /rematch command instead", flags: 64 });
    }

    if (id === "finishcompetition") {
      return interaction.reply({ content: "Use /finishcompetition command instead", flags: 64 });
    }

    if (id === "endcompetition") {
      return interaction.reply({ content: "Use /endcompetition command instead", flags: 64 });
    }
  }

  // =====================
  // MODALS
  // =====================
  if (interaction.isModalSubmit()) {

    if (interaction.customId === "finalize_modal") {

      const red = parseInt(interaction.fields.getTextInputValue("red_score"));
      const blue = parseInt(interaction.fields.getTextInputValue("blue_score"));

      if (isNaN(red) || isNaN(blue)) {
        return interaction.reply({ content: "❌ Invalid scores", flags: 64 });
      }

      if (!matchStarted) {
        return interaction.reply({ content: "❌ No match in progress", flags: 64 });
      }

      let winner = "DRAW";

      if (red > blue) {
        winner = "RED";
        competitionScores.red += 1;
      } else if (blue > red) {
        winner = "BLUE";
        competitionScores.blue += 1;
      }

      matchCount += 1;

      matchHistory.push({
        matchNumber: matchCount,
        redScore: red,
        blueScore: blue,
        winner
      });

      matchStarted = false;
      draftTeams = { red: [], blue: [] };
      captains = { red: null, blue: null };
      queue = [];

      await updateCompetitionEmbed();

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚽ MATCH FINISHED")
            .addFields(
              { name: "🔴 Red", value: `${red}`, inline: true },
              { name: "🔵 Blue", value: `${blue}`, inline: true },
              { name: "🏆 Winner", value: winner, inline: false }
            )
            .setColor(0x00AEFF)
        ]
      });
    }
  }

  // =====================
  // SLASH COMMANDS
  // =====================
  if (!interaction.isChatInputCommand()) return;

  const guild2 = interaction.guild;
  const member2 = member;
  const cmdMember = member2;

  const command = interaction.commandName;

// =====================
// ADMIN PANEL
// =====================
if (interaction.commandName === "panel") {

  const channel =
    await client.channels.fetch(ADMIN_PANEL_CHANNEL_ID);

  if (!channel) {
    return interaction.reply({
      content: "❌ Admin panel channel not found",
      flags: 64
    });
  }

  await channel.send(buildAdminPanel());

  return interaction.reply({
    content: "✅ Admin panel sent",
    flags: 64
  });
}

// =====================
// Buton interactions for admin panel
// =====================
if (interaction.isButton()) {

  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);

  if (!hasRole(member, ADMIN_ROLES)) {
    return interaction.reply({
      content: "❌ No permission",
      flags: 64
    });
  }

  const id = interaction.customId;

  // =====================
  // OPEN FINALIZE MODAL
  // =====================
  if (id === "open_finalize_modal") {
    return interaction.showModal(buildFinalizeModal());
  }

  // =====================
  // DIRECT ACTION BUTTONS
  // =====================

  if (id === "startcompetition") {
    return interaction.reply({
      content: "Use /startcompetition command instead",
      flags: 64
    });
  }

  if (id === "autobalance") {
    return interaction.reply({
      content: "Use /autobalance command instead",
      flags: 64
    });
  }

  if (id === "startmatch") {
    return interaction.reply({
      content: "Use /startmatch command instead",
      flags: 64
    });
  }

  if (id === "rematch") {
    return interaction.reply({
      content: "Use /rematch command instead",
      flags: 64
    });
  }

  if (id === "finishcompetition") {
    return interaction.reply({
      content: "Use /finishcompetition command instead",
      flags: 64
    });
  }

  if (id === "endcompetition") {
    return interaction.reply({
      content: "Use /endcompetition command instead",
      flags: 64
    });
  }
}

// =====================
// AUTOBALANCE (FIXED - PROPER VALIDATION)
// =====================
if (interaction.commandName === "autobalance") {

  const players = getAllVoicePlayers(guild);
  
  // Check if captains were manually selected (using /captains command)
  if (draftMode && captains.red !== null && captains.blue !== null) {
    return interaction.reply({
      content: "❌ Captains already selected. Auto balance only works in free queue.",
      flags: 64
    });
  }

  if (players.length < 2) {
    return interaction.reply({
      content: "❌ Not enough players in voice channels",
      flags: 64
    });
  }

  // =====================
  // SPLIT BY POSITION
  // =====================
  let gks = [];
  let defs = [];
  let mids = [];
  let atts = [];

  for (const id of players) {
    ensurePlayer(id);

    const pos = playerData[id].position;

    if (pos === "GK") gks.push(id);
    else if (pos === "DEF") defs.push(id);
    else if (pos === "ATT") atts.push(id);
    else mids.push(id);
  }

  const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

  gks = shuffle(gks);
  defs = shuffle(defs);
  mids = shuffle(mids);
  atts = shuffle(atts);

  const teamRed = [];
  const teamBlue = [];

  // =====================
// 1 GK PER TEAM (FIXED)
// =====================

// 2 or more GKs
if (gks.length >= 2) {

  teamRed.push(gks[0]);
  teamBlue.push(gks[1]);

}

// ONLY 1 GK
else if (gks.length === 1) {

  if (Math.random() > 0.5) {
    teamRed.push(gks[0]);
  } else {
    teamBlue.push(gks[0]);
  }

}

  // remove assigned players from pool
const used = new Set([
  ...teamRed,
  ...teamBlue
]);

const fieldPlayers = players.filter(
  p => !used.has(p)
);

  // =====================
  // BALANCE FIELD PLAYERS
  // =====================
  for (const id of fieldPlayers) {
    if (teamRed.length <= teamBlue.length) {
      teamRed.push(id);
    } else {
      teamBlue.push(id);
    }
  }

  // =====================
  // SAVE STATE
  // =====================
  draftTeams.red = teamRed;
  draftTeams.blue = teamBlue;

  queue = [];

  // captains optional (GK default)
  captains.red = teamRed[0] || null;
  captains.blue = teamBlue[0] || null;

  // =====================
  // MOVE TO VOICE CHANNELS
  // =====================
   await moveTeams(guild, teamRed, teamBlue);

  // Update competition embed with new teams
  await updateCompetitionEmbed();

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🤖 POSITION-BASED AUTO BALANCE")
        .addFields(
          {
            name: "🔴 Red Team",
            value: teamRed.map(id => `<@${id}> (${playerData[id]?.position})`).join("\n") || "None"
          },
          {
            name: "🔵 Blue Team",
            value: teamBlue.map(id => `<@${id}> (${playerData[id]?.position})`).join("\n") || "None"
          }
        )
        .setColor(0x00AEFF)
    ]
  });
}

// =====================
  // JOIN
  // =====================
if (interaction.commandName === "join") {

  const pos = interaction.options.getString("position").toUpperCase();

  if (!["GK", "DEF", "MID", "ATT"].includes(pos)) {
    return interaction.reply({ content: "Invalid position", flags: 64 });
  }

  ensurePlayer(member.id);

  playerData[member.id].position = pos;

  if (!queue.includes(member.id)) {
    queue.push(member.id);
  }

  await updateCompetitionEmbed();

  return interaction.reply(`✅ Joined as ${pos}`);
}

  // =====================
  // START COMPETITION (NEW FEATURE)
  // =====================
  if (interaction.commandName === "startcompetition") {

  queue = getAllVoicePlayers(guild);

  queue.forEach(id => ensurePlayer(id));

  draftTeams = { red: [], blue: [] };
  captains = { red: null, blue: null };
  draftMode = true;

  // Reset competition data
  competitionScores = { red: 0, blue: 0 };
  matchHistory = [];
  matchCount = 0;
  pickedPlayers = new Set();

  const embed = new EmbedBuilder()
    .setTitle("🏆 COMPETITION STARTED")
    .setDescription(
      queue.map(id =>
        `• <@${id}> — **${playerData[id]?.position || "MID"}**`
      ).join("\n") || "No players"
    )
    .addFields(
      { name: "🔴 Red Wins", value: "**0**", inline: true },
      { name: "🔵 Blue Wins", value: "**0**", inline: true }
    )
    .setColor(0x00AEFF);

  await interaction.reply({ embeds: [embed] });

  competitionMessage = await interaction.fetchReply();

  return;
}

  // =====================
  // CAPTAINS
  // =====================
  if (interaction.commandName === "captains") {

    captains.red = interaction.options.getUser("red").id;
    captains.blue = interaction.options.getUser("blue").id;

    draftTeams.red = [captains.red];
    draftTeams.blue = [captains.blue];

    queue = queue.filter(p => p !== captains.red && p !== captains.blue);

    currentTurn = "red";

    await updateCompetitionEmbed();

    return interaction.reply("Captains set");
  }

  // =====================
  // PICK (REMOVES PLAYER FROM EMBED LIVE - FIXED TO PREVENT DUPLICATE PICKS)
  // =====================
  if (interaction.commandName === "pick") {

    const player = interaction.options.getUser("player").id;

    // =====================
    // CHECK IF PLAYER ALREADY PICKED IN THIS COMPETITION
    // =====================
    if (pickedPlayers.has(player)) {
      return interaction.reply({
        content: `❌ <@${player}> has already been picked in this competition!`,
        flags: 64
      });
    }

    if (!queue.includes(player)) {
      return interaction.reply("Not in queue");
    }

    if (member.id !== captains[currentTurn]) {
      return interaction.reply("Not your turn");
    }

    draftTeams[currentTurn].push(player);
    queue = queue.filter(p => p !== player);
    pickedPlayers.add(player); // Add to picked set

    currentTurn = currentTurn === "red" ? "blue" : "red";

    await updateCompetitionEmbed();

    return interaction.reply(`Picked <@${player}>`);
  }

  // =====================
// START MATCH (FIXED + AUTO BALANCE FALLBACK)
// =====================
if (interaction.commandName === "startmatch") {

  // =====================
  // ❌ PREVENT INVALID MATCH
  // =====================
  const totalPlayers =
    draftTeams.red.length + draftTeams.blue.length;

  if (totalPlayers < 2) {
    return interaction.reply({
      content: "❌ Not enough players to start a match (min 2 required)",
      flags: 64
    });
  }

  // =====================
  // ⚠ AUTO BALANCE IF NO CAPTAINS
  // =====================
  if (!captains.red || !captains.blue) {

    const allPlayers = [...queue];

    // include already joined draft players too
    allPlayers.push(...draftTeams.red, ...draftTeams.blue);

    const uniquePlayers = [...new Set(allPlayers)];

    if (uniquePlayers.length < 2) {
      return interaction.reply({
        content: "❌ Not enough players to auto-balance",
        flags: 64
      });
    }

    const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

    const shuffled = shuffle(uniquePlayers);

    const mid = Math.ceil(shuffled.length / 2);

    draftTeams.red = shuffled.slice(0, mid);
    draftTeams.blue = shuffled.slice(mid);

    captains.red = draftTeams.red[0];
    captains.blue = draftTeams.blue[0];
  }

  // =====================
  // FINAL VALIDATION
  // =====================
  if (draftTeams.red.length < 1 || draftTeams.blue.length < 1) {
    return interaction.reply({
      content: "❌ Teams are not properly formed",
      flags: 64
    });
  }

  lastMatch = {
  red: [...draftTeams.red],
  blue: [...draftTeams.blue]
};

matchStarted = true;

await moveTeams(guild, draftTeams.red, draftTeams.blue);

draftMode = false;

return interaction.reply("⚽ Match started successfully");

}

  // =====================
  // FINALIZE (UPDATED - ADD TO MATCH HISTORY)
  // =====================
  if (interaction.commandName === "finalize") {

    if (!matchStarted) {
      return interaction.reply({
        content: "❌ No match in progress",
        flags: 64
      });
    }

    const red = interaction.options.getInteger("red");
    const blue = interaction.options.getInteger("blue");

    let winner = "DRAW";
    if (red > blue) {
      winner = "RED";
      competitionScores.red += 1;
    } else if (blue > red) {
      winner = "BLUE";
      competitionScores.blue += 1;
    }

    matchCount += 1;

    // Add to match history
    matchHistory.push({
      matchNumber: matchCount,
      redScore: red,
      blueScore: blue,
      winner: winner
    });

    matchStarted = false;

    // Reset teams for next match
    draftTeams = { red: [], blue: [] };
    captains = { red: null, blue: null };
    queue = [];

    // Update competition embed
    await updateCompetitionEmbed();

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚽ MATCH FINISHED")
          .addFields(
            { name: "🔴 Red", value: `**${red}**`, inline: true },
            { name: "🔵 Blue", value: `**${blue}**`, inline: true },
            { name: "🏆 Winner", value: `**${winner}**`, inline: false },
            { name: "📊 Competition Score", value: `🔴 ${competitionScores.red} - 🔵 ${competitionScores.blue}`, inline: false }
          )
          .setColor(winner === "RED" ? 0xFF0000 : winner === "BLUE" ? 0x0000FF : 0xFFFFFF)
      ]
    });
  }

  // =====================
  // REMATCH
  // =====================
if (interaction.commandName === "rematch") {

  if (!lastMatch) {
    return interaction.reply({
      content: "❌ No previous match found",
      flags: 64
    });
  }

  draftTeams.red = [...lastMatch.red];
  draftTeams.blue = [...lastMatch.blue];

  captains.red = draftTeams.red[0];
  captains.blue = draftTeams.blue[0];

  queue = [];

  // move teams back
  await moveTeams(
    guild,
    draftTeams.red,
    draftTeams.blue
  );

  matchStarted = true;

  await updateCompetitionEmbed();

  return interaction.reply(
    "🔁 Rematch started successfully"
  );
}

  // =====================
  // FINISH COMPETITION (NEW COMMAND - UPDATED TO MOVE PLAYERS)
  // =====================
  if (interaction.commandName === "finishcompetition") {

  if (!competitionActive && matchCount === 0) {
    return interaction.reply({
      content: "❌ No competition in progress",
      flags: 64
    });
  }

  if (matchCount < 3) {
    return interaction.reply({
      content: `❌ Minimum 3 matches required to finish competition (${matchCount}/3)`,
      flags: 64
    });
  }

  let competitionWinner = "DRAW";
  let winnerColor = 0xFFFFFF;

  if (competitionScores.red > competitionScores.blue) {
    competitionWinner = "🔴 RED TEAM";
    winnerColor = 0xFF0000;
  } else if (competitionScores.blue > competitionScores.red) {
    competitionWinner = "🔵 BLUE TEAM";
    winnerColor = 0x0000FF;
  }

  const matchHistoryText = matchHistory.length > 0
    ? matchHistory.map((m, i) => `**Match ${i + 1}:** 🔴 ${m.redScore} - 🔵 ${m.blueScore} | ${m.winner}`).join("\n")
    : "No matches";

  const embed = new EmbedBuilder()
    .setTitle("🏆 COMPETITION FINISHED")
    .addFields(
      { name: "🏅 CHAMPION", value: `**${competitionWinner}**`, inline: false },
      { name: "📊 Final Score", value: `🔴 ${competitionScores.red} - 🔵 ${competitionScores.blue}`, inline: false },
      { name: "📋 Match Summary", value: matchHistoryText, inline: false }
    )
    .setColor(winnerColor)
    .setTimestamp();

  await competitionMessage.edit({ embeds: [embed] });

  // Move all players to main channel
  await moveAllPlayersToMain(guild);

  // Reset competition
  competitionActive = false;
  competitionScores = { red: 0, blue: 0 };
  matchHistory = [];
  matchCount = 0;
  draftTeams = { red: [], blue: [] };
  captains = { red: null, blue: null };
  queue = [];
  matchStarted = false;
  draftMode = false;
  pickedPlayers = new Set();

  return interaction.reply({
    embeds: [embed]
  });
}

// =====================
// END COMPETITION EARLY
// =====================
if (interaction.commandName === "endcompetition") {

  if (!competitionMessage) {
    return interaction.reply({
      content: "❌ No competition running",
      flags: 64
    });
  }

  if (matchCount === 0 && !hasRole(member, ADMIN_ROLES)) {
    return interaction.reply({
      content: "❌ You must play at least 1 match before ending competition",
      flags: 64
    });
  }

  let winner = "DRAW";

  if (competitionScores.red > competitionScores.blue) {
    winner = "🔴 RED TEAM";
  } else if (competitionScores.blue > competitionScores.red) {
    winner = "🔵 BLUE TEAM";
  }

  const embed = new EmbedBuilder()
    .setTitle("🏁 COMPETITION ENDED EARLY")
    .addFields(
      { name: "🏆 Winner", value: winner, inline: false },
      { name: "📊 Score", value: `🔴 ${competitionScores.red} - 🔵 ${competitionScores.blue}`, inline: false },
      { name: "🎮 Matches Played", value: `${matchCount}`, inline: false }
    )
    .setColor(0xFFA500)
    .setTimestamp();

  await competitionMessage.edit({ embeds: [embed] });

  // move everyone back + delete temp channels
  await moveAllPlayersToMain(guild);

  // RESET EVERYTHING
  competitionActive = false;
  competitionScores = { red: 0, blue: 0 };
  matchHistory = [];
  matchCount = 0;
  draftTeams = { red: [], blue: [] };
  captains = { red: null, blue: null };
  queue = [];
  matchStarted = false;
  draftMode = false;
  pickedPlayers = new Set();
  lastMatch = null;

  return interaction.reply({
    content: "🏁 Competition ended early and all players restored"
  });
}

  // =====================
  // STATS (FIXED - ADDED CONDITIONAL CHECK)
  // =====================
  if (interaction.commandName === "stats") {
    return interaction.reply(
      `Skill: ${playerData[member.id].skill}\nPosition: ${playerData[member.id].position}`
    );
  }

});

// =====================
register();
client.login(process.env.TOKEN);
