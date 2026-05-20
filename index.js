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

const fs = require('fs');
const path = require('path');

require('dotenv').config();

// =====================
// CONFIG PERSISTENCE
// =====================
const CONFIG_FILE = path.join(__dirname, 'serverConfigs.json');

function loadConfigs() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error("Failed to load configs:", err);
      return {};
    }
  }
  return {};
}

function saveConfigs(configs) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
  } catch (err) {
    console.error("Failed to save configs:", err);
  }
}

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
// SERVER CONFIGURATIONS
// =====================
const serverConfigs = loadConfigs();

function getServerConfig(guildId) {
  if (!serverConfigs[guildId]) {
    serverConfigs[guildId] = {
      ADMIN_ROLES: ["Admin", "Moderator", "Owner"],
      PLAYER_ROLES: ["FC26 Player", "Member"],
      MAIN_VC_ID: null,
      TEAM_CATEGORY_ID: null,
      ADMIN_PANEL_CHANNEL_ID: null,
      COMPETITION_CHANNEL_ID: null
    };
    saveConfigs(serverConfigs);
  }
  return serverConfigs[guildId];
}

// =====================
// PER-SERVER DATA
// =====================
const serverData = {};

function getServerData(guildId) {
  if (!serverData[guildId]) {
    serverData[guildId] = {
      tempChannels: { red: null, blue: null },
      originalVoiceChannels: {},
      queue: [],
      playerData: {},
      draftMode: false,
      captains: { red: null, blue: null },
      draftTeams: { red: [], blue: [] },
      currentTurn: "red",
      lastMatch: null,
      matchStarted: false,
      competitionActive: false,
      competitionMessage: null,
      competitionScores: { red: 0, blue: 0 },
      matchHistory: [],
      matchCount: 0,
      pickedPlayers: new Set(),
      captainPanelMessage: null,
      userPanelMessage: null
    };
  }
  return serverData[guildId];
}

// =====================
// ROLE CHECK
// =====================
function hasRole(member, roles) {
  return member.roles.cache.some(r => roles.includes(r.name));
}

// =====================
// COMMAND ACCESS CONTROL
// =====================
function canUse(member, cmd, guildId) {
  const config = getServerConfig(guildId);
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

  if (admin.includes(cmd)) return hasRole(member, config.ADMIN_ROLES);
  if (player.includes(cmd)) return hasRole(member, config.PLAYER_ROLES);

  return true;
}

// =====================
// PLAYER DATA
// =====================
function ensurePlayer(guildId, id) {
  const data = getServerData(guildId);
  if (!data.playerData[id]) {
    data.playerData[id] = {
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

// =====================
// BUILD ADMIN PANEL
// =====================
function buildAdminPanel() {
  const embed = new EmbedBuilder()
    .setTitle("⚙️ COMPETITION CONTROL")
    .setDescription("Manage your competition with precision")
    .setColor(0x2C2F33)
    .setThumbnail("https://cdn-icons-png.flaticon.com/512/1995/1995473-settings_gear_admin_configuration_tool-512.png");

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_startcompetition")
      .setLabel("Start")
      .setStyle(ButtonStyle.Success)
      .setEmoji("▶️"),

    new ButtonBuilder()
      .setCustomId("btn_autobalance")
      .setLabel("Auto Balance")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⚖️"),

    new ButtonBuilder()
      .setCustomId("btn_startmatch")
      .setLabel("Start Match")
      .setStyle(ButtonStyle.Success)
      .setEmoji("⚽")
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_rematch")
      .setLabel("Rematch")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔄"),

    new ButtonBuilder()
      .setCustomId("btn_endcompetition")
      .setLabel("End Early")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⏹️"),

    new ButtonBuilder()
      .setCustomId("btn_finishcompetition")
      .setLabel("Finish")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🏁"),

    new ButtonBuilder()
      .setCustomId("open_finalize_modal")
      .setLabel("Score")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("📊")
  );

  return { embeds: [embed], components: [row1, row2] };
}

// =====================
// BUILD PLAYER PANEL
// =====================
function buildPlayerPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🎮 PLAYER HUB")
    .setDescription("Manage your game profile and stats")
    .setColor(0x1ABC9C);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_join_position")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Success)
      .setEmoji("📋"),

    new ButtonBuilder()
      .setCustomId("btn_set_skill")
      .setLabel("Set Skill")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⚡"),

    new ButtonBuilder()
      .setCustomId("btn_view_stats")
      .setLabel("My Stats")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📈")
  );

  return { embeds: [embed], components: [row1] };
}

// =====================
// BUILD CAPTAIN DRAFT PANEL
// =====================
function buildCaptainDraftPanel(guildId) {
  const data = getServerData(guildId);

  const currentTurnEmoji = data.currentTurn === "red" ? "🔴" : "🔵";
  const currentCaptainId = data.captains[data.currentTurn];
  const bgColor = data.currentTurn === "red" ? 0xFF6B6B : 0x4ECDC4;

  const embed = new EmbedBuilder()
    .setTitle("🎯 DRAFT PHASE")
    .setDescription(`${currentTurnEmoji} **${data.currentTurn.toUpperCase()} TEAM PICKING**`)
    .setColor(bgColor)
    .addFields(
      {
        name: "🔴 Red Squad",
        value: data.draftTeams.red.length > 0
          ? data.draftTeams.red.map((id, i) => `${i + 1}. <@${id}>`).join("\n")
          : "Waiting for picks...",
        inline: true
      },
      {
        name: "🔵 Blue Squad",
        value: data.draftTeams.blue.length > 0
          ? data.draftTeams.blue.map((id, i) => `${i + 1}. <@${id}>`).join("\n")
          : "Waiting for picks...",
        inline: true
      },
      {
        name: "📋 Pool",
        value: data.queue.length > 0
          ? data.queue.slice(0, 10).map(id => `• <@${id}> [${data.playerData[id]?.position || "MID"}]`).join("\n") + (data.queue.length > 10 ? `\n... and ${data.queue.length - 10} more` : "")
          : "✅ All picked!",
        inline: false
      }
    )
    .setFooter({ text: `Current Captain: ${currentCaptainId ? "Captain #" + currentCaptainId.slice(0, 4) : "TBD"}` })
    .setTimestamp();

  const rows = [];
  const availablePlayers = data.queue.slice(0, 25);

  for (let i = 0; i < availablePlayers.length; i += 5) {
    const rowPlayers = availablePlayers.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      ...rowPlayers.map(playerId => {
        const playerData = data.playerData[playerId];
        return new ButtonBuilder()
          .setCustomId(`pick_player_${playerId}`)
          .setLabel(`${playerData?.position || "MID"}`)
          .setStyle(ButtonStyle.Primary);
      })
    );
    rows.push(row);
  }

  if (data.queue.length === 0) {
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("btn_start_match_draft")
        .setLabel("Start Match")
        .setStyle(ButtonStyle.Success)
        .setEmoji("⚽"),

      new ButtonBuilder()
        .setCustomId("btn_clear_draft")
        .setLabel("Clear")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🗑️")
    );
    rows.push(controlRow);
  }

  return { embeds: [embed], components: rows };
}

// =====================
// BUILD USER PANEL (PERSISTENT)
// =====================
function buildUserPanel(guildId) {
  const data = getServerData(guildId);

  const available = data.queue.length
    ? data.queue.slice(0, 5).map((id, i) => `${i + 1}. <@${id}> [${data.playerData[id]?.position || "MID"}]`).join("\n") + (data.queue.length > 5 ? `\n... +${data.queue.length - 5} more` : "")
    : "No queue";

  const red = data.draftTeams.red.length
    ? data.draftTeams.red.map((id, i) => `${i + 1}. <@${id}>`).join("\n")
    : "—";

  const blue = data.draftTeams.blue.length
    ? data.draftTeams.blue.map((id, i) => `${i + 1}. <@${id}>`).join("\n")
    : "—";

  const embed = new EmbedBuilder()
    .setTitle("📊 LIVE STATUS")
    .setDescription("Real-time competition tracking")
    .setColor(0x3498DB)
    .addFields(
      { 
        name: "📋 Queue", 
        value: available, 
        inline: false 
      },
      { 
        name: "🔴 Red (5v5)", 
        value: red, 
        inline: true 
      },
      { 
        name: "🔵 Blue (5v5)", 
        value: blue, 
        inline: true 
      },
      { 
        name: "🎤 Turn", 
        value: data.draftMode 
          ? `${data.currentTurn === "red" ? "🔴" : "🔵"} ${data.currentTurn.toUpperCase()}` 
          : "⚽ In Progress", 
        inline: false 
      }
    )
    .setFooter({ text: `Queue: ${data.queue.length} | Red: ${data.draftTeams.red.length} | Blue: ${data.draftTeams.blue.length}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_join_position")
      .setLabel("Join")
      .setStyle(ButtonStyle.Success)
      .setEmoji("➕"),

    new ButtonBuilder()
      .setCustomId("btn_set_skill")
      .setLabel("Skill")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⚡"),

    new ButtonBuilder()
      .setCustomId("btn_view_stats")
      .setLabel("Stats")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📊")
  );

  return { embeds: [embed], components: [row] };
}

// =====================
// BUILD JOIN MODAL
// =====================
function buildJoinModal() {
  const modal = new ModalBuilder()
    .setCustomId("join_modal")
    .setTitle("📋 Join Queue");

  const positionInput = new TextInputBuilder()
    .setCustomId("position_input")
    .setLabel("Position (GK / DEF / MID / ATT)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("e.g., MID");

  const row = new ActionRowBuilder().addComponents(positionInput);
  modal.addComponents(row);

  return modal;
}

// =====================
// BUILD SKILL MODAL
// =====================
function buildSkillModal() {
  const modal = new ModalBuilder()
    .setCustomId("skill_modal")
    .setTitle("⚡ Set Skill Level");

  const skillInput = new TextInputBuilder()
    .setCustomId("skill_input")
    .setLabel("Skill Level (1-10)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("e.g., 7");

  const row = new ActionRowBuilder().addComponents(skillInput);
  modal.addComponents(row);

  return modal;
}

// =====================
// BUILD FINALIZE MODAL
// =====================
function buildFinalizeModal() {
  const modal = new ModalBuilder()
    .setCustomId("finalize_modal")
    .setTitle("⚽ Match Score");

  const redScore = new TextInputBuilder()
    .setCustomId("red_score")
    .setLabel("🔴 Red Team Goals")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const blueScore = new TextInputBuilder()
    .setCustomId("blue_score")
    .setLabel("🔵 Blue Team Goals")
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
function buildCompetitionEmbed(guildId) {
  const data = getServerData(guildId);
  const matchHistoryText = data.matchHistory.length > 0
    ? data.matchHistory.map((m, i) => `\`Match ${i + 1}\` 🔴 ${m.redScore} - 🔵 ${m.blueScore} | **${m.winner}**`).join("\n")
    : "No matches played yet";

  const embed = new EmbedBuilder()
    .setTitle("🏆 COMPETITION SCOREBOARD")
    .setDescription("Live competition tracking and match history")
    .setColor(0xFFD700)
    .addFields(
      { 
        name: "🔴 Red Wins", 
        value: `\`\`\`${data.competitionScores.red}\`\`\``, 
        inline: true 
      },
      { 
        name: "🔵 Blue Wins", 
        value: `\`\`\`${data.competitionScores.blue}\`\`\``, 
        inline: true 
      },
      { 
        name: "⚖️ Balance",
        value: data.competitionScores.red === data.competitionScores.blue ? "TIED" : (data.competitionScores.red > data.competitionScores.blue ? "RED LEADING" : "BLUE LEADING"),
        inline: true
      },
      { 
        name: "📋 Match History", 
        value: matchHistoryText, 
        inline: false 
      },
      { 
        name: "📊 Status", 
        value: data.matchStarted ? "⚽ **LIVE MATCH**" : "⏸️ **WAITING**", 
        inline: false 
      }
    )
    .setFooter({ text: `Total Matches: ${data.matchCount}` })
    .setTimestamp();

  return embed;
}

// =====================
// RESTORE PLAYERS + DELETE TEMP CHANNELS + DELETE PANELS
// =====================
async function moveAllPlayersToMain(guild, guildId) {
  const config = getServerConfig(guildId);
  const data = getServerData(guildId);

  if (!config.MAIN_VC_ID) {
    console.error("MAIN_VC_ID not configured for this server");
    return;
  }

  try {
    for (const playerId of Object.keys(data.originalVoiceChannels)) {
      const member = await guild.members
        .fetch(playerId)
        .catch(() => null);

      if (!member) continue;

      if (!member.voice?.channel) continue;

      const originalChannelId = data.originalVoiceChannels[playerId];
      const originalChannel = guild.channels.cache.get(originalChannelId);

      if (originalChannel) {
        await member.voice
          .setChannel(originalChannel)
          .catch(console.error);
      } else {
        const mainChannel = guild.channels.cache.get(config.MAIN_VC_ID);

        if (mainChannel) {
          await member.voice
            .setChannel(mainChannel)
            .catch(console.error);
        }
      }
    }

    // DELETE TEMP CHANNELS
    if (data.tempChannels.red) {
      const redChannel = guild.channels.cache.get(data.tempChannels.red);
      if (redChannel) {
        await redChannel.delete().catch(() => null);
      }
    }

    if (data.tempChannels.blue) {
      const blueChannel = guild.channels.cache.get(data.tempChannels.blue);
      if (blueChannel) {
        await blueChannel.delete().catch(() => null);
      }
    }

    // DELETE PANEL MESSAGES
    if (data.userPanelMessage) {
      await data.userPanelMessage.delete().catch(() => null);
    }

    if (data.captainPanelMessage) {
      await data.captainPanelMessage.delete().catch(() => null);
    }

    // RESET STORAGE
    data.tempChannels = { red: null, blue: null };
    data.originalVoiceChannels = {};
    data.userPanelMessage = null;
    data.captainPanelMessage = null;

  } catch (err) {
    console.error("Error restoring players:", err);
  }
}

// =====================
// UPDATE COMPETITION EMBED
// =====================
async function updateCompetitionEmbed(guildId) {
  const data = getServerData(guildId);
  
  if (!data.competitionMessage) return;

  const embed = buildCompetitionEmbed(guildId);

  await data.competitionMessage.edit({ embeds: [embed] });

  // Update user panel
  if (data.userPanelMessage) {
    try {
      const userPanelData = buildUserPanel(guildId);
      await data.userPanelMessage.edit(userPanelData);
    } catch (err) {
      console.error("Error updating user panel:", err);
    }
  }
}

// =====================
// UPDATE CAPTAIN DRAFT PANEL
// =====================
async function updateCaptainDraftPanel(guild, guildId) {
  const data = getServerData(guildId);

  if (!data.captainPanelMessage) return;

  const panelData = buildCaptainDraftPanel(guildId);

  try {
    await data.captainPanelMessage.edit(panelData);
  } catch (err) {
    console.error("Error updating captain draft panel:", err);
  }
}

// =====================
// CREATE TEAM CHANNELS
// =====================
async function createTeamChannels(guild, guildId) {
  const config = getServerConfig(guildId);
  const data = getServerData(guildId);

  if (!config.TEAM_CATEGORY_ID) {
    console.error("TEAM_CATEGORY_ID not configured for this server");
    return;
  }

  if (data.tempChannels.red) {
    const oldRed = guild.channels.cache.get(data.tempChannels.red);
    if (oldRed) {
      await oldRed.delete().catch(() => null);
    }
  }

  if (data.tempChannels.blue) {
    const oldBlue = guild.channels.cache.get(data.tempChannels.blue);
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
    parent: config.TEAM_CATEGORY_ID,
    permissionOverwrites: permissions
  });

  const blueChannel = await guild.channels.create({
    name: "🔵 Blue Team",
    type: ChannelType.GuildVoice,
    parent: config.TEAM_CATEGORY_ID,
    permissionOverwrites: permissions
  });

  data.tempChannels.red = redChannel.id;
  data.tempChannels.blue = blueChannel.id;
}

// =====================
// MOVE TEAMS TO TEMP CHANNELS
// =====================
async function moveTeams(guild, guildId, redTeam, blueTeam) {
  const data = getServerData(guildId);

  if (!data.tempChannels.red || !data.tempChannels.blue) {
    await createTeamChannels(guild, guildId);
  }

  // MOVE RED TEAM
  for (const id of redTeam) {
    const member = await guild.members.fetch(id).catch(() => null);

    if (!member?.voice?.channel) continue;

    if (!data.originalVoiceChannels[id]) {
      data.originalVoiceChannels[id] = member.voice.channel.id;
    }

    if (member.voice.channel.id !== data.tempChannels.red) {
      await member.voice
        .setChannel(data.tempChannels.red)
        .catch(console.error);
    }
  }

  // MOVE BLUE TEAM
  for (const id of blueTeam) {
    const member = await guild.members.fetch(id).catch(() => null);

    if (!member?.voice?.channel) continue;

    if (!data.originalVoiceChannels[id]) {
      data.originalVoiceChannels[id] = member.voice.channel.id;
    }

    if (member.voice.channel.id !== data.tempChannels.blue) {
      await member.voice
        .setChannel(data.tempChannels.blue)
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
    .setName('setconfig')
    .setDescription('Configure bot settings (Admin only)')
    .addChannelOption(o =>
      o.setName('main_vc')
        .setDescription('Main voice channel')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o.setName('team_category')
        .setDescription('Team category for temp channels')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o.setName('admin_panel')
        .setDescription('Admin panel channel')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o.setName('competition_channel')
        .setDescription('Channel where competition embed will be posted')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send admin control panel'),

  new SlashCommandBuilder()
    .setName('playercommands')
    .setDescription('Send player commands panel'),

  new SlashCommandBuilder()
    .setName('captaindraft')
    .setDescription('Send captain draft panel')

].map(c => c.toJSON());

// =====================
// REGISTER COMMANDS (GLOBALLY)
// =====================
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

async function register() {
  try {
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log("✅ Commands registered globally");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// =====================
// READY EVENT
// =====================
client.once('clientReady', client => {
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
    const guildId = guild.id;
    const data = getServerData(guildId);

    // JOIN MODAL
    if (interaction.customId === "join_modal") {
      const pos = interaction.fields.getTextInputValue("position_input").toUpperCase();

      if (!["GK", "DEF", "MID", "ATT"].includes(pos)) {
        return interaction.reply({ content: "❌ Invalid position. Use: GK, DEF, MID, or ATT", flags: 64 });
      }

      ensurePlayer(guildId, member.id);
      data.playerData[member.id].position = pos;

      if (!data.queue.includes(member.id)) {
        data.queue.push(member.id);
      }

      await updateCompetitionEmbed(guildId);
      await updateCaptainDraftPanel(guild, guildId);

      return interaction.reply({ content: `✅ **${pos}** - Joined the queue!`, flags: 64 });
    }

    // SKILL MODAL
    if (interaction.customId === "skill_modal") {
      const skillValue = parseInt(interaction.fields.getTextInputValue("skill_input"));

      if (isNaN(skillValue) || skillValue < 1 || skillValue > 10) {
        return interaction.reply({ content: "❌ Skill level must be between 1 and 10", flags: 64 });
      }

      ensurePlayer(guildId, member.id);
      data.playerData[member.id].skill = skillValue;

      return interaction.reply({ content: `⚡ **${skillValue}/10** - Skill level updated!`, flags: 64 });
    }

    // FINALIZE MODAL
    if (interaction.customId === "finalize_modal") {
      const red = parseInt(interaction.fields.getTextInputValue("red_score"));
      const blue = parseInt(interaction.fields.getTextInputValue("blue_score"));

      if (isNaN(red) || isNaN(blue)) {
        return interaction.reply({ content: "❌ Invalid scores", flags: 64 });
      }

      if (!data.matchStarted) {
        return interaction.reply({ content: "❌ No match in progress", flags: 64 });
      }

      let winner = "DRAW";

      if (red > blue) {
        winner = "RED";
        data.competitionScores.red += 1;
      } else if (blue > red) {
        winner = "BLUE";
        data.competitionScores.blue += 1;
      }

      data.matchCount += 1;

      data.matchHistory.push({
        matchNumber: data.matchCount,
        redScore: red,
        blueScore: blue,
        winner
      });

      data.matchStarted = false;
      data.draftTeams = { red: [], blue: [] };
      data.captains = { red: null, blue: null };
      data.queue = [];

      await updateCompetitionEmbed(guildId);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚽ MATCH FINISHED")
            .setColor(winner === "RED" ? 0xFF6B6B : winner === "BLUE" ? 0x4ECDC4 : 0xFFD700)
            .addFields(
              { name: "🔴 Red", value: `\`\`\`${red}\`\`\``, inline: true },
              { name: "🔵 Blue", value: `\`\`\`${blue}\`\`\``, inline: true },
              { name: "🏆 Winner", value: `**${winner}**`, inline: false }
            )
        ],
        flags: 64
      });
    }
  }

  // =====================
  // BUTTON HANDLER
  // =====================
  if (interaction.isButton()) {
    const guildId = guild.id;
    const config = getServerConfig(guildId);
    const data = getServerData(guildId);
    const id = interaction.customId;

    // PLAYER BUTTONS
    if (id === "btn_join_position") {
      return interaction.showModal(buildJoinModal());
    }

    if (id === "btn_set_skill") {
      return interaction.showModal(buildSkillModal());
    }

    if (id === "btn_view_stats") {
      ensurePlayer(guildId, member.id);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📊 YOUR STATS")
            .setColor(0x1ABC9C)
            .addFields(
              { name: "⚡ Skill Level", value: `\`\`\`${data.playerData[member.id].skill}/10\`\`\``, inline: true },
              { name: "📍 Position", value: `\`\`\`${data.playerData[member.id].position}\`\`\``, inline: true }
            )
            .setFooter({ text: "Keep improving your skills!" })
            .setTimestamp()
        ],
        flags: 64
      });
    }

    // CAPTAIN PICK BUTTONS
    if (id.startsWith("pick_player_")) {
      const playerId = id.replace("pick_player_", "");

      if (data.pickedPlayers.has(playerId)) {
        return interaction.reply({
          content: `❌ <@${playerId}> has already been picked!`,
          flags: 64
        });
      }

      if (!data.queue.includes(playerId)) {
        return interaction.reply({
          content: "❌ Player not in queue",
          flags: 64
        });
      }

      if (member.id !== data.captains[data.currentTurn]) {
        return interaction.reply({
          content: `❌ Not your turn! It's <@${data.captains[data.currentTurn]}>'s turn`,
          flags: 64
        });
      }

      data.draftTeams[data.currentTurn].push(playerId);
      data.queue = data.queue.filter(p => p !== playerId);
      data.pickedPlayers.add(playerId);

      data.currentTurn = data.currentTurn === "red" ? "blue" : "red";

      await updateCaptainDraftPanel(guild, guildId);
      await updateCompetitionEmbed(guildId);

      return interaction.reply({
        content: `✅ <@${playerId}> picked for **${data.currentTurn === "red" ? "🔵 BLUE" : "🔴 RED"}** team!\nNext: <@${data.captains[data.currentTurn]}>`,
        flags: 64
      });
    }

    // ADMIN BUTTONS
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (id === "open_finalize_modal") {
      return interaction.showModal(buildFinalizeModal());
    }

    if (id === "btn_start_match_draft") {
      const totalPlayers = data.draftTeams.red.length + data.draftTeams.blue.length;

      if (totalPlayers < 2) {
        return interaction.reply({
          content: "❌ Not enough players to start a match (min 2 required)",
          flags: 64
        });
      }

      if (data.draftTeams.red.length < 1 || data.draftTeams.blue.length < 1) {
        return interaction.reply({
          content: "❌ Teams are not properly formed",
          flags: 64
        });
      }

      data.lastMatch = {
        red: [...data.draftTeams.red],
        blue: [...data.draftTeams.blue]
      };

      data.matchStarted = true;
      await moveTeams(guild, guildId, data.draftTeams.red, data.draftTeams.blue);
      data.draftMode = false;

      return interaction.reply({ content: "⚽ **Match started!** Teams moved to voice channels", flags: 64 });
    }

    if (id === "btn_clear_draft") {
      data.draftTeams = { red: [], blue: [] };
      data.captains = { red: null, blue: null };
      data.queue = [];
      data.currentTurn = "red";
      data.pickedPlayers = new Set();

      await updateCaptainDraftPanel(guild, guildId);
      return interaction.reply({ content: "🔄 **Draft cleared!**", flags: 64 });
    }

    const buttonCommands = {
      "btn_startcompetition": "startcompetition",
      "btn_autobalance": "autobalance",
      "btn_startmatch": "startmatch",
      "btn_rematch": "rematch",
      "btn_finishcompetition": "finishcompetition",
      "btn_endcompetition": "endcompetition"
    };

    const command = buttonCommands[id];
    
    if (command) {
      const fakeInteraction = {
        commandName: command,
        isChatInputCommand: () => true,
        isButton: () => false,
        reply: interaction.reply.bind(interaction),
        showModal: interaction.showModal.bind(interaction),
        options: {
          getUser: () => null,
          getString: () => null,
          getInteger: () => null,
          getChannel: () => null
        },
        user: interaction.user,
        guild: interaction.guild,
        fetchReply: interaction.fetchReply.bind(interaction)
      };

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
  const guildId = guild.id;
  const config = getServerConfig(guildId);
  const data = getServerData(guildId);

  // =====================
  // SETCONFIG COMMAND
  // =====================
  if (command === "setconfig") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const mainVc = interaction.options.getChannel("main_vc");
    const teamCategory = interaction.options.getChannel("team_category");
    const adminPanel = interaction.options.getChannel("admin_panel");
    const competitionChannel = interaction.options.getChannel("competition_channel");

    config.MAIN_VC_ID = mainVc.id;
    config.TEAM_CATEGORY_ID = teamCategory.id;
    config.ADMIN_PANEL_CHANNEL_ID = adminPanel.id;
    config.COMPETITION_CHANNEL_ID = competitionChannel.id;

    saveConfigs(serverConfigs);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Configuration Saved")
          .setColor(0x2ECC71)
          .addFields(
            { name: "🎤 Main VC", value: `<#${mainVc.id}>`, inline: false },
            { name: "📁 Team Category", value: `<#${teamCategory.id}>`, inline: false },
            { name: "⚙️ Admin Panel", value: `<#${adminPanel.id}>`, inline: false },
            { name: "🏆 Competition Channel", value: `<#${competitionChannel.id}>`, inline: false }
          )
      ],
      flags: 64
    });
  }

  // =====================
  // PANEL COMMAND
  // =====================
  if (command === "panel") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!config.ADMIN_PANEL_CHANNEL_ID) {
      return interaction.reply({
        content: "❌ Admin panel not configured. Use /setconfig first",
        flags: 64
      });
    }

    const channel = await client.channels.fetch(config.ADMIN_PANEL_CHANNEL_ID);

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
  // PLAYER COMMANDS PANEL
  // =====================
  if (command === "playercommands") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!config.ADMIN_PANEL_CHANNEL_ID) {
      return interaction.reply({
        content: "❌ Admin panel not configured. Use /setconfig first",
        flags: 64
      });
    }

    const channel = await client.channels.fetch(config.ADMIN_PANEL_CHANNEL_ID);

    if (!channel) {
      return interaction.reply({
        content: "❌ Admin panel channel not found",
        flags: 64
      });
    }

    await channel.send(buildPlayerPanel());

    return interaction.reply({
      content: "✅ Player commands panel sent",
      flags: 64
    });
  }

  // =====================
  // CAPTAIN DRAFT PANEL
  // =====================
  if (command === "captaindraft") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!data.draftMode || !data.captains.red || !data.captains.blue) {
      return interaction.reply({
        content: "❌ Captains not set. Use /captains first",
        flags: 64
      });
    }

    if (!config.ADMIN_PANEL_CHANNEL_ID) {
      return interaction.reply({
        content: "❌ Admin panel not configured. Use /setconfig first",
        flags: 64
      });
    }

    const channel = await client.channels.fetch(config.ADMIN_PANEL_CHANNEL_ID);

    if (!channel) {
      return interaction.reply({
        content: "❌ Admin panel channel not found",
        flags: 64
      });
    }

    const panelData = buildCaptainDraftPanel(guildId);
    const sentMessage = await channel.send(panelData);
    data.captainPanelMessage = sentMessage;

    return interaction.reply({
      content: "✅ Captain draft panel sent",
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

    ensurePlayer(guildId, member.id);
    data.playerData[member.id].position = pos;

    if (!data.queue.includes(member.id)) {
      data.queue.push(member.id);
    }

    await updateCompetitionEmbed(guildId);
    await updateCaptainDraftPanel(guild, guildId);

    return interaction.reply(`✅ Joined as **${pos}**`);
  }

  // =====================
  // SKILL
  // =====================
  if (command === "skill") {
    const level = interaction.options.getInteger("level");

    if (level < 1 || level > 10) {
      return interaction.reply({ content: "❌ Level must be between 1-10", flags: 64 });
    }

    ensurePlayer(guildId, member.id);
    data.playerData[member.id].skill = level;

    return interaction.reply(`✅ Skill set to **${level}/10**`);
  }

  // =====================
  // START COMPETITION
  // =====================
  if (command === "startcompetition") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!config.COMPETITION_CHANNEL_ID) {
      return interaction.reply({
        content: "❌ Competition channel not configured. Use /setconfig first",
        flags: 64
      });
    }

    data.queue = getVoicePlayers(guild);
    data.queue.forEach(id => ensurePlayer(guildId, id));

    data.draftTeams = { red: [], blue: [] };
    data.captains = { red: null, blue: null };
    data.draftMode = true;
    data.competitionActive = true;

    data.competitionScores = { red: 0, blue: 0 };
    data.matchHistory = [];
    data.matchCount = 0;
    data.pickedPlayers = new Set();

    const embed = new EmbedBuilder()
      .setTitle("🏆 COMPETITION STARTED")
      .setDescription(`**${data.queue.length}** players ready to compete`)
      .setColor(0xFFD700)
      .addFields(
        {
          name: "📋 Players in Queue",
          value: data.queue.length > 0
            ? data.queue.slice(0, 10).map((id, i) => `${i + 1}. <@${id}> [${data.playerData[id]?.position || "MID"}]`).join("\n") + (data.queue.length > 10 ? `\n... and ${data.queue.length - 10} more` : "")
            : "No players"
        },
        { name: "🔴 Red Wins", value: "`0`", inline: true },
        { name: "🔵 Blue Wins", value: "`0`", inline: true }
      )
      .setFooter({ text: "Good luck to all competitors!" })
      .setTimestamp();

    try {
      const competitionChannel = await client.channels.fetch(config.COMPETITION_CHANNEL_ID);
      const sentMessage = await competitionChannel.send({ embeds: [embed] });
      data.competitionMessage = sentMessage;

      // POST USER PANEL
      const userPanelData = buildUserPanel(guildId);
      const userPanelMessage = await competitionChannel.send(userPanelData);
      data.userPanelMessage = userPanelMessage;

      return interaction.reply({
        content: `✅ Competition started with **${data.queue.length}** players!`,
        flags: 64
      });
    } catch (err) {
      console.error("Error posting competition message:", err);
      return interaction.reply({
        content: "❌ Failed to post competition message",
        flags: 64
      });
    }
  }

  // =====================
  // CAPTAINS
  // =====================
  if (command === "captains") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    data.captains.red = interaction.options.getUser("red").id;
    data.captains.blue = interaction.options.getUser("blue").id;

    data.draftTeams.red = [data.captains.red];
    data.draftTeams.blue = [data.captains.blue];

    data.queue = data.queue.filter(p => p !== data.captains.red && p !== data.captains.blue);

    data.currentTurn = "red";

    await updateCompetitionEmbed(guildId);

    // POST CAPTAIN PANEL
    try {
      const panelData = buildCaptainDraftPanel(guildId);
      const panelMessage = await client.channels.fetch(config.COMPETITION_CHANNEL_ID)
        .then(ch => ch.send(panelData))
        .catch(console.error);
      
      if (panelMessage) {
        data.captainPanelMessage = panelMessage;
      }
    } catch (err) {
      console.error("Error posting captain panel:", err);
    }

    return interaction.reply(`✅ Captains set: 🔴 <@${data.captains.red}> vs 🔵 <@${data.captains.blue}>`);
  }

  // =====================
  // AUTOBALANCE
  // =====================
  if (command === "autobalance") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const players = getVoicePlayers(guild);

    if (data.draftTeams.red.length > 0 && data.draftTeams.blue.length > 0) {
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
      ensurePlayer(guildId, id);
      const pos = data.playerData[id].position;

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

    for (const id of fieldPlayers) {
      if (teamRed.length <= teamBlue.length) {
        teamRed.push(id);
      } else {
        teamBlue.push(id);
      }
    }

    data.draftTeams.red = teamRed;
    data.draftTeams.blue = teamBlue;
    data.queue = [];
    data.captains.red = teamRed[0] || null;
    data.captains.blue = teamBlue[0] || null;

    await moveTeams(guild, guildId, teamRed, teamBlue);
    await updateCompetitionEmbed(guildId);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚖️ AUTO BALANCE COMPLETE")
          .setColor(0x9B59B6)
          .addFields(
            {
              name: "🔴 Red Team",
              value: teamRed.map((id, i) => `${i + 1}. <@${id}> [${data.playerData[id]?.position}]`).join("\n") || "None"
            },
            {
              name: "🔵 Blue Team",
              value: teamBlue.map((id, i) => `${i + 1}. <@${id}> [${data.playerData[id]?.position}]`).join("\n") || "None"
            }
          )
          .setFooter({ text: "Teams are ready!" })
      ]
    });
  }

  // =====================
  // PICK
  // =====================
  if (command === "pick") {
    const player = interaction.options.getUser("player").id;

    if (data.pickedPlayers.has(player)) {
      return interaction.reply({
        content: `❌ <@${player}> has already been picked!`,
        flags: 64
      });
    }

    if (!data.queue.includes(player)) {
      return interaction.reply({
        content: "❌ Player not in queue",
        flags: 64
      });
    }

    if (member.id !== data.captains[data.currentTurn]) {
      return interaction.reply({
        content: "❌ Not your turn",
        flags: 64
      });
    }

    data.draftTeams[data.currentTurn].push(player);
    data.queue = data.queue.filter(p => p !== player);
    data.pickedPlayers.add(player);

    data.currentTurn = data.currentTurn === "red" ? "blue" : "red";

    await updateCompetitionEmbed(guildId);
    await updateCaptainDraftPanel(guild, guildId);

    return interaction.reply(`✅ <@${player}> picked`);
  }

  // =====================
  // START MATCH
  // =====================
  if (command === "startmatch") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const totalPlayers = data.draftTeams.red.length + data.draftTeams.blue.length;

    if (totalPlayers < 2) {
      return interaction.reply({
        content: "❌ Not enough players to start a match (min 2 required)",
        flags: 64
      });
    }

    if (!data.captains.red || !data.captains.blue) {
      const allPlayers = [...data.queue, ...data.draftTeams.red, ...data.draftTeams.blue];
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

      data.draftTeams.red = shuffled.slice(0, mid);
      data.draftTeams.blue = shuffled.slice(mid);

      data.captains.red = data.draftTeams.red[0];
      data.captains.blue = data.draftTeams.blue[0];
    }

    if (data.draftTeams.red.length < 1 || data.draftTeams.blue.length < 1) {
      return interaction.reply({
        content: "❌ Teams are not properly formed",
        flags: 64
      });
    }

    data.lastMatch = {
      red: [...data.draftTeams.red],
      blue: [...data.draftTeams.blue]
    };

    data.matchStarted = true;

    await moveTeams(guild, guildId, data.draftTeams.red, data.draftTeams.blue);

    data.draftMode = false;

    return interaction.reply("⚽ Match started successfully");
  }

  // =====================
  // FINALIZE
  // =====================
  if (command === "finalize") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!data.matchStarted) {
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
      data.competitionScores.red += 1;
    } else if (blue > red) {
      winner = "BLUE";
      data.competitionScores.blue += 1;
    }

    data.matchCount += 1;

    data.matchHistory.push({
      matchNumber: data.matchCount,
      redScore: red,
      blueScore: blue,
      winner: winner
    });

    data.matchStarted = false;

    data.draftTeams = { red: [], blue: [] };
    data.captains = { red: null, blue: null };
    data.queue = [];

    await updateCompetitionEmbed(guildId);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚽ MATCH FINISHED")
          .setColor(winner === "RED" ? 0xFF6B6B : winner === "BLUE" ? 0x4ECDC4 : 0xFFD700)
          .addFields(
            { name: "🔴 Red", value: `\`\`\`${red}\`\`\``, inline: true },
            { name: "🔵 Blue", value: `\`\`\`${blue}\`\`\``, inline: true },
            { name: "🏆 Winner", value: `**${winner}**`, inline: false },
            { name: "📊 Competition Score", value: `🔴 ${data.competitionScores.red} - 🔵 ${data.competitionScores.blue}`, inline: false }
          )
          .setFooter({ text: "Ready for the next match?" })
      ]
    });
  }

  // =====================
  // REMATCH
  // =====================
  if (command === "rematch") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!data.lastMatch) {
      return interaction.reply({
        content: "❌ No previous match found",
        flags: 64
      });
    }

    data.draftTeams.red = [...data.lastMatch.red];
    data.draftTeams.blue = [...data.lastMatch.blue];

    data.captains.red = data.draftTeams.red[0];
    data.captains.blue = data.draftTeams.blue[0];

    data.queue = [];

    await moveTeams(guild, guildId, data.draftTeams.red, data.draftTeams.blue);

    data.matchStarted = true;

    await updateCompetitionEmbed(guildId);

    return interaction.reply("🔁 **Rematch started** - Same teams!");
  }

  // =====================
  // FINISH COMPETITION
  // =====================
  if (command === "finishcompetition") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!data.competitionActive && data.matchCount === 0) {
      return interaction.reply({
        content: "❌ No competition in progress",
        flags: 64
      });
    }

    if (data.matchCount < 3) {
      return interaction.reply({
        content: `❌ Minimum 3 matches required to finish competition (${data.matchCount}/3)`,
        flags: 64
      });
    }

    let competitionWinner = "DRAW";
    let winnerColor = 0xFFD700;

    if (data.competitionScores.red > data.competitionScores.blue) {
      competitionWinner = "🔴 RED TEAM";
      winnerColor = 0xFF6B6B;
    } else if (data.competitionScores.blue > data.competitionScores.red) {
      competitionWinner = "🔵 BLUE TEAM";
      winnerColor = 0x4ECDC4;
    }

    const matchHistoryText = data.matchHistory.length > 0
      ? data.matchHistory.map((m, i) => `**Match ${i + 1}:** 🔴 ${m.redScore} - 🔵 ${m.blueScore} | **${m.winner}**`).join("\n")
      : "No matches";

    const embed = new EmbedBuilder()
      .setTitle("🏆 COMPETITION FINISHED")
      .setDescription("The competition has ended!")
      .setColor(winnerColor)
      .addFields(
        { name: "🏅 CHAMPION", value: `**${competitionWinner}**`, inline: false },
        { name: "📊 Final Score", value: `🔴 **${data.competitionScores.red}** - 🔵 **${data.competitionScores.blue}**`, inline: false },
        { name: "📋 Match Summary", value: matchHistoryText, inline: false }
      )
      .setFooter({ text: "Congratulations to the winners!" })
      .setTimestamp();

    await data.competitionMessage.edit({ embeds: [embed] });

    await moveAllPlayersToMain(guild, guildId);

    data.competitionActive = false;
    data.competitionScores = { red: 0, blue: 0 };
    data.matchHistory = [];
    data.matchCount = 0;
    data.draftTeams = { red: [], blue: [] };
    data.captains = { red: null, blue: null };
    data.queue = [];
    data.matchStarted = false;
    data.draftMode = false;
    data.pickedPlayers = new Set();

    return interaction.reply({
      embeds: [embed]
    });
  }

  // =====================
  // END COMPETITION EARLY
  // =====================
  if (command === "endcompetition") {
    if (!hasRole(member, config.ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    if (!data.competitionMessage) {
      return interaction.reply({
        content: "❌ No competition running",
        flags: 64
      });
    }

    let winner = "DRAW";
    let winnerColor = 0xFFD700;

    if (data.competitionScores.red > data.competitionScores.blue) {
      winner = "🔴 RED TEAM";
      winnerColor = 0xFF6B6B;
    } else if (data.competitionScores.blue > data.competitionScores.red) {
      winner = "🔵 BLUE TEAM";
      winnerColor = 0x4ECDC4;
    }

    const embed = new EmbedBuilder()
      .setTitle("🏁 COMPETITION ENDED EARLY")
      .setDescription("The competition was stopped by an admin")
      .setColor(winnerColor)
      .addFields(
        { name: "🏆 Winner", value: winner, inline: false },
        { name: "📊 Score", value: `🔴 ${data.competitionScores.red} - 🔵 ${data.competitionScores.blue}`, inline: false },
        { name: "🎮 Matches Played", value: `${data.matchCount}`, inline: false }
      )
      .setFooter({ text: "Thanks for playing!" })
      .setTimestamp();

    await data.competitionMessage.edit({ embeds: [embed] });

    await moveAllPlayersToMain(guild, guildId);

    data.competitionActive = false;
    data.competitionScores = { red: 0, blue: 0 };
    data.matchHistory = [];
    data.matchCount = 0;
    data.draftTeams = { red: [], blue: [] };
    data.captains = { red: null, blue: null };
    data.queue = [];
    data.matchStarted = false;
    data.draftMode = false;
    data.pickedPlayers = new Set();
    data.lastMatch = null;

    return interaction.reply({
      content: "🏁 **Competition ended** - All players restored"
    });
  }

  // =====================
  // STATS
  // =====================
  if (command === "stats") {
    ensurePlayer(guildId, member.id);
    return interaction.reply(
      `Skill: ${data.playerData[member.id].skill}\nPosition: ${data.playerData[member.id].position}`
    );
  }
}

// =====================
// START BOT
// =====================
register();
client.login(process.env.TOKEN);
