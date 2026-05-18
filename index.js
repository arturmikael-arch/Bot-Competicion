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

const MAIN_VC_ID = "1499698725893705872";
const TEAM_CATEGORY_ID = "1502236927141875782";
const ADMIN_PANEL_CHANNEL_ID = "1499753429512487023";

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
// COMPETITION STATE
// =====================
let competitionActive = false;
let competitionMessage = null;
let competitionScores = { red: 0, blue: 0 };
let matchHistory = [];
let matchCount = 0;
let pickedPlayers = new Set();

// =====================
// ROLE CHECK
// =====================
function hasRole(member, roles) {
  return member.roles.cache.some(r => roles.includes(r.name));
}

// =====================
// COMMAND ACCESS CONTROL
// =====================
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

  return true;
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
// VOICE SCAN
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

function getAllVoicePlayers(guild) {
  return getVoicePlayers(guild);
}

// =====================
// BUILD ADMIN PANEL
// =====================
function buildAdminPanel() {
  const embed = new EmbedBuilder()
    .setTitle("⚙️ COMPETITION CONTROL PANEL")
    .setDescription("Use buttons to control the match system quickly")
    .setColor(0x00AEFF);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_startcompetition")
      .setLabel("Start Competition")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("btn_autobalance")
      .setLabel("Auto Balance")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("btn_startmatch")
      .setLabel("Start Match")
      .setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_rematch")
      .setLabel("Rematch")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("btn_endcompetition")
      .setLabel("End Early")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("btn_finishcompetition")
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
// BUILD FINALIZE MODAL
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
// BUILD COMPETITION EMBED
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
    for (const playerId of Object.keys(originalVoiceChannels)) {
      const member = await guild.members
        .fetch(playerId)
        .catch(() => null);

      if (!member) continue;

      if (!member.voice?.channel) continue;

      const originalChannelId = originalVoiceChannels[playerId];
      const originalChannel = guild.channels.cache.get(originalChannelId);

      if (originalChannel) {
        await member.voice
          .setChannel(originalChannel)
          .catch(console.error);
      } else {
        const mainChannel = guild.channels.cache.get(MAIN_VC_ID);

        if (mainChannel) {
          await member.voice
            .setChannel(mainChannel)
            .catch(console.error);
        }
      }
    }

    // DELETE TEMP CHANNELS
    if (tempChannels.red) {
      const redChannel = guild.channels.cache.get(tempChannels.red);
      if (redChannel) {
        await redChannel.delete().catch(() => null);
      }
    }

    if (tempChannels.blue) {
      const blueChannel = guild.channels.cache.get(tempChannels.blue);
      if (blueChannel) {
        await blueChannel.delete().catch(() => null);
      }
    }

    // RESET STORAGE
    tempChannels = { red: null, blue: null };
    originalVoiceChannels = {};

  } catch (err) {
    console.error("Error restoring players:", err);
  }
}

// =====================
// UPDATE COMPETITION EMBED
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
// CREATE TEAM CHANNELS
// =====================
async function createTeamChannels(guild) {
  if (tempChannels.red) {
    const oldRed = guild.channels.cache.get(tempChannels.red);
    if (oldRed) {
      await oldRed.delete().catch(() => null);
    }
  }

  if (tempChannels.blue) {
    const oldBlue = guild.channels.cache.get(tempChannels.blue);
    if (oldBlue) {
      await oldBlue.delete().catch(() => null);
    }
  }

  const allowedRoles = [
    "Owner",
    "Admin",
    "Bot",
    "Moderador",
    "FC26 Player",
    "Member"
  ];

  const permissions = [
    {
      id: guild.roles.everyone.id,
      deny: ['ViewChannel', 'Connect']
    }
  ];

  allowedRoles.forEach(roleName => {
    const role = guild.roles.cache.find(r => r.name === roleName);

    if (role) {
      permissions.push({
        id: role.id,
        allow: ['ViewChannel', 'Connect', 'Speak']
      });
    }
  });

  const redChannel = await guild.channels.create({
    name: "🔴 Red Team",
    type: ChannelType.GuildVoice,
    parent: TEAM_CATEGORY_ID,
    permissionOverwrites: permissions
  });

  const blueChannel = await guild.channels.create({
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
  if (!tempChannels.red || !tempChannels.blue) {
    await createTeamChannels(guild);
  }

  // MOVE RED TEAM
  for (const id of redTeam) {
    const member = await guild.members.fetch(id).catch(() => null);

    if (!member?.voice?.channel) continue;

    if (!originalVoiceChannels[id]) {
      originalVoiceChannels[id] = member.voice.channel.id;
    }

    if (member.voice.channel.id !== tempChannels.red) {
      await member.voice
        .setChannel(tempChannels.red)
        .catch(console.error);
    }
  }

  // MOVE BLUE TEAM
  for (const id of blueTeam) {
    const member = await guild.members.fetch(id).catch(() => null);

    if (!member?.voice?.channel) continue;

    if (!originalVoiceChannels[id]) {
      originalVoiceChannels[id] = member.voice.channel.id;
    }

    if (member.voice.channel.id !== tempChannels.blue) {
      await member.voice
        .setChannel(tempChannels.blue)
        .catch(console.error);
    }
  }
}

// =====================
// REGISTER SLASH COMMANDS
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
// REGISTER COMMANDS
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
// READY EVENT (FIXED - using 'clientReady' for v14)
// =====================
client.once("clientReady", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

// =====================
// INTERACTION HANDLER
// =====================
client.on('interactionCreate', async interaction => {
  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return;

  // =====================
  // MODAL SUBMIT
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
  // BUTTON HANDLER (EXECUTE COMMANDS)
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

    // Map button IDs to command names
    const buttonCommands = {
      "btn_startcompetition": "startcompetition",
      "btn_autobalance": "autobalance",
      "btn_startmatch": "startmatch",
      "btn_rematch": "rematch",
      "btn_finishcompetition": "finishcompetition",
      "btn_endcompetition": "endcompetition"
    };

    const command = buttonCommands[id];
    
    // If it's a valid button command, treat it as if it was a slash command
    if (command) {
      // Create a fake interaction object that mimics a slash command
      const fakeInteraction = {
        commandName: command,
        isChatInputCommand: () => true,
        isButton: () => false,
        reply: interaction.reply.bind(interaction),
        showModal: interaction.showModal.bind(interaction),
        options: {
          getUser: () => null,
          getString: () => null,
          getInteger: () => null
        },
        user: interaction.user,
        guild: interaction.guild,
        fetchReply: interaction.fetchReply.bind(interaction)
      };

      // Execute the command logic
      return handleCommand(fakeInteraction, guild, member);
    }
  }

  // =====================
  // SLASH COMMANDS
  // =====================
  if (!interaction.isChatInputCommand()) return;

  return handleCommand(interaction, guild, member);
});

// =====================
// COMMAND HANDLER FUNCTION
// =====================
async function handleCommand(interaction, guild, member) {
  const command = interaction.commandName;

  // =====================
  // PANEL COMMAND
  // =====================
  if (command === "panel") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const channel = await client.channels.fetch(ADMIN_PANEL_CHANNEL_ID);

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
  // JOIN
  // =====================
  if (command === "join") {
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
  // START COMPETITION
  // =====================
  if (command === "startcompetition") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    queue = getAllVoicePlayers(guild);
    queue.forEach(id => ensurePlayer(id));

    draftTeams = { red: [], blue: [] };
    captains = { red: null, blue: null };
    draftMode = true;
    competitionActive = true;

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
  }

  // =====================
  // CAPTAINS
  // =====================
  if (command === "captains") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    captains.red = interaction.options.getUser("red").id;
    captains.blue = interaction.options.getUser("blue").id;

    draftTeams.red = [captains.red];
    draftTeams.blue = [captains.blue];

    queue = queue.filter(p => p !== captains.red && p !== captains.blue);

    currentTurn = "red";

    await updateCompetitionEmbed();

    return interaction.reply("✅ Captains set");
  }

  // =====================
  // AUTOBALANCE
  // =====================
  if (command === "autobalance") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const players = getAllVoicePlayers(guild);

    if (draftTeams.red.length > 0 && draftTeams.blue.length > 0) {
      return interaction.reply({
        content: "❌ Teams already formed. Cannot auto-balance after draft has started.",
        flags: 64
      });
    }

    if (players.length < 2) {
      return interaction.reply({
        content: "❌ Not enough players in voice channels",
        flags: 64
      });
    }

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

    // 1 GK PER TEAM
    if (gks.length >= 2) {
      teamRed.push(gks[0]);
      teamBlue.push(gks[1]);
    } else if (gks.length === 1) {
      if (Math.random() > 0.5) {
        teamRed.push(gks[0]);
      } else {
        teamBlue.push(gks[0]);
      }
    }

    const used = new Set([...teamRed, ...teamBlue]);
    const fieldPlayers = players.filter(p => !used.has(p));

    // BALANCE FIELD PLAYERS
    for (const id of fieldPlayers) {
      if (teamRed.length <= teamBlue.length) {
        teamRed.push(id);
      } else {
        teamBlue.push(id);
      }
    }

    draftTeams.red = teamRed;
    draftTeams.blue = teamBlue;
    queue = [];
    captains.red = teamRed[0] || null;
    captains.blue = teamBlue[0] || null;

    await moveTeams(guild, teamRed, teamBlue);
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
  // PICK
  // =====================
  if (command === "pick") {
    const player = interaction.options.getUser("player").id;

    if (pickedPlayers.has(player)) {
      return interaction.reply({
        content: `❌ <@${player}> has already been picked in this competition!`,
        flags: 64
      });
    }

    if (!queue.includes(player)) {
      return interaction.reply({
        content: "❌ Player not in queue",
        flags: 64
      });
    }

    if (member.id !== captains[currentTurn]) {
      return interaction.reply({
        content: "❌ Not your turn",
        flags: 64
      });
    }

    draftTeams[currentTurn].push(player);
    queue = queue.filter(p => p !== player);
    pickedPlayers.add(player);

    currentTurn = currentTurn === "red" ? "blue" : "red";

    await updateCompetitionEmbed();

    return interaction.reply(`✅ Picked <@${player}>`);
  }

  // =====================
  // START MATCH
  // =====================
  if (command === "startmatch") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const totalPlayers = draftTeams.red.length + draftTeams.blue.length;

    if (totalPlayers < 2) {
      return interaction.reply({
        content: "❌ Not enough players to start a match (min 2 required)",
        flags: 64
      });
    }

    if (!captains.red || !captains.blue) {
      const allPlayers = [...queue, ...draftTeams.red, ...draftTeams.blue];
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
  // FINALIZE
  // =====================
  if (command === "finalize") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

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

    matchHistory.push({
      matchNumber: matchCount,
      redScore: red,
      blueScore: blue,
      winner: winner
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
  if (command === "rematch") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

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

    await moveTeams(guild, draftTeams.red, draftTeams.blue);

    matchStarted = true;

    await updateCompetitionEmbed();

    return interaction.reply("🔁 Rematch started successfully");
  }

  // =====================
  // FINISH COMPETITION
  // =====================
  if (command === "finishcompetition") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

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

    await moveAllPlayersToMain(guild);

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
  if (command === "endcompetition") {
    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!competitionMessage) {
      return interaction.reply({
        content: "❌ No competition running",
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

    await moveAllPlayersToMain(guild);

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
  // STATS
  // =====================
  if (command === "stats") {
    ensurePlayer(member.id);
    return interaction.reply(
      `Skill: ${playerData[member.id].skill}\nPosition: ${playerData[member.id].position}`
    );
  }
}

// =====================
// START BOT
// =====================
register();
client.login(process.env.TOKEN);
