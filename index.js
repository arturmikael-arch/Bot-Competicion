const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType
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

const RED_VC_ID = "1504096957407170611";
const BLUE_VC_ID = "1504097182620581958";
const MAIN_VC_ID = "1499698725893705872"; // Main channel to gather all players after competition ends

// =====================
// DATA
// =====================
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
// MOVE ALL PLAYERS TO MAIN CHANNEL
// =====================
async function moveAllPlayersToMain(guild) {

  try {

    const mainChannel =
      await guild.channels
        .fetch(MAIN_VC_ID)
        .catch(() => null);

    if (!mainChannel) return;

    // get voice channels
    const redChannel =
      await guild.channels
        .fetch(RED_VC_ID)
        .catch(() => null);

    const blueChannel =
      await guild.channels
        .fetch(BLUE_VC_ID)
        .catch(() => null);

    // unique player ids
    const allPlayers = new Set([
      ...draftTeams.red,
      ...draftTeams.blue
    ]);

    // include anyone still inside vc
    if (redChannel?.members) {
      redChannel.members.forEach(m =>
        allPlayers.add(m.id)
      );
    }

    if (blueChannel?.members) {
      blueChannel.members.forEach(m =>
        allPlayers.add(m.id)
      );
    }

    // move everybody
    for (const id of allPlayers) {

      const member =
        await guild.members
          .fetch(id)
          .catch(() => null);

      if (member?.voice?.channel) {

        await member.voice
          .setChannel(MAIN_VC_ID)
          .catch(() => null);
      }
    }

  }
  catch (err) {

    console.error(
      "Error moving players:",
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
    .setName('stats')
    .setDescription('Stats')

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
// MOVE TEAMS TO VOICE CHANNELS (FIXED - ADDED MISSING FUNCTION)
// =====================
async function moveTeams(guild, redTeam, blueTeam) {
  for (const id of redTeam) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member?.voice?.channel) {
      await member.voice.setChannel(RED_VC_ID);
    }
  }

  for (const id of blueTeam) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member?.voice?.channel) {
      await member.voice.setChannel(BLUE_VC_ID);
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
  // BUTTON INTERACTIONS (HANDLE FIRST - BEFORE COMMAND CHECK)
  // =====================
  if (interaction.isButton()) {

    if (!hasRole(member, ADMIN_ROLES)) {
      return interaction.reply({
        content: "❌ No permission",
        flags: 64
      });
    }

    const buttonId = interaction.customId;

    // Execute the corresponding command based on button ID
    if (buttonId === "startcompetition") {

      queue = getAllVoicePlayers(guild);
      queue.forEach(id => ensurePlayer(id));
      draftTeams = { red: [], blue: [] };
      captains = { red: null, blue: null };
      draftMode = true;

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

    if (buttonId === "autobalance") {

      const players = getAllVoicePlayers(guild);
      
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

      draftTeams.red = teamRed;
      draftTeams.blue = teamBlue;
      queue = [];
      captains.red = teamRed[0] || null;
      captains.blue = teamBlue[0] || null;

      for (const id of teamRed) {
        const m = await guild.members.fetch(id).catch(() => null);
        if (m?.voice?.channel) {
          await m.voice.setChannel(RED_VC_ID);
        }
      }

      for (const id of teamBlue) {
        const m = await guild.members.fetch(id).catch(() => null);
        if (m?.voice?.channel) {
          await m.voice.setChannel(BLUE_VC_ID);
        }
      }

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

    if (buttonId === "startmatch") {

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

    if (buttonId === "rematch") {

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

    if (buttonId === "finishcompetition") {

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

      return interaction.reply({ embeds: [embed] });
    }

    if (buttonId === "endcompetition") {

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

    return;
  }

  // =====================
  // SLASH COMMANDS (HANDLE AFTER BUTTONS)
  // =====================
  if (!interaction.isChatInputCommand()) return;

  if (!canUse(member, interaction.commandName)) {
    return interaction.reply({ content: "No permission", flags: 64 });
  }

  const command = interaction.commandName;

// =====================
// AUTOBALANCE
// =====================
if (command === "autobalance") {

  const players = getAllVoicePlayers(guild);
  
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

  draftTeams.red = teamRed;
  draftTeams.blue = teamBlue;
  queue = [];
  captains.red = teamRed[0] || null;
  captains.blue = teamBlue[0] || null;

  for (const id of teamRed) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (m?.voice?.channel) {
      await m.voice.setChannel(RED_VC_ID);
    }
  }

  for (const id of teamBlue) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (m?.voice?.channel) {
      await m.voice.setChannel(BLUE_VC_ID);
    }
  }

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

  queue = getAllVoicePlayers(guild);
  queue.forEach(id => ensurePlayer(id));

  draftTeams = { red: [], blue: [] };
  captains = { red: null, blue: null };
  draftMode = true;

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
if (command === "captains") {

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
    return interaction.reply("Not in queue");
  }

  if (member.id !== captains[currentTurn]) {
    return interaction.reply("Not your turn");
  }

  draftTeams[currentTurn].push(player);
  queue = queue.filter(p => p !== player);
  pickedPlayers.add(player);

  currentTurn = currentTurn === "red" ? "blue" : "red";

  await updateCompetitionEmbed();

  return interaction.reply(`Picked <@${player}>`);
}

// =====================
// START MATCH
// =====================
if (command === "startmatch") {

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

  return interaction.reply({ embeds: [embed] });
}

// =====================
// STATS
// =====================
if (command === "stats") {
  return interaction.reply(
    `Skill: ${playerData[member.id].skill}\nPosition: ${playerData[member.id].position}`
  );
}

});

// =====================
register();
client.login(process.env.TOKEN);
