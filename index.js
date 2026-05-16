const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
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
    "startcompetition"
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

  const embed = new EmbedBuilder()
    .setTitle("🏆 LIVE COMPETITION")
    .addFields(
      { name: "📋 Available Players", value: available },
      { name: "🔴 Red Team", value: red, inline: true },
      { name: "🔵 Blue Team", value: blue, inline: true }
    )
    .setColor(0x00AEFF)
    .setTimestamp();

  await competitionMessage.edit({ embeds: [embed] });
}

// =====================
// COMMANDS (FIXED ALL VALIDATION ERRORS)
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
// READY (FIX WARNING)
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

  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);

  if (!canUse(member, interaction.commandName)) {
    return interaction.reply({ content: "No permission", flags: 64 });
  }

// =====================
// AUTOBALANCE (NEW)
// =====================
if (interaction.commandName === "autobalance") {

  const players = getAllVoicePlayers(guild);

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
  // 1 GK PER TEAM (IMPORTANT)
  // =====================
  if (gks.length > 0) teamRed.push(gks[0]);
  if (gks.length > 1) teamBlue.push(gks[1]);

  // if only 1 GK → random assign
  if (gks.length === 1) {
    (Math.random() > 0.5 ? teamRed : teamBlue).push(gks[0]);
  }

  // remove assigned gks from pool
  const used = new Set(teamRed.concat(teamBlue));
  const fieldPlayers = players.filter(p => !used.has(p));

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
  for (const id of teamRed) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member?.voice?.channel) {
      await member.voice.setChannel(RED_VC_ID);
    }
  }

  for (const id of teamBlue) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member?.voice?.channel) {
      await member.voice.setChannel(BLUE_VC_ID);
    }
  }

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

  const embed = new EmbedBuilder()
    .setTitle("🏆 COMPETITION STARTED")
    .setDescription(
      queue.map(id =>
        `• <@${id}> — **${playerData[id]?.position || "MID"}**`
      ).join("\n") || "No players"
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
  // PICK (REMOVES PLAYER FROM EMBED LIVE)
  // =====================
  if (interaction.commandName === "pick") {

    const player = interaction.options.getUser("player").id;

    if (!queue.includes(player)) {
      return interaction.reply("Not in queue");
    }

    if (member.id !== captains[currentTurn]) {
      return interaction.reply("Not your turn");
    }

    draftTeams[currentTurn].push(player);
    queue = queue.filter(p => p !== player);

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

  matchStarted = true;

  lastMatch = {
    red: [...draftTeams.red],
    blue: [...draftTeams.blue]
  };

  return interaction.reply("⚽ Match started successfully");
}

  // =====================
  // FINALIZE
  // =====================
  if (interaction.commandName === "finalize") {

    const red = interaction.options.getInteger("red");
    const blue = interaction.options.getInteger("blue");

    let winner = "DRAW";
    if (red > blue) winner = "RED";
    if (blue > red) winner = "BLUE";

    matchStarted = false;

    return interaction.reply(`FINAL ${red}-${blue} Winner: ${winner}`);
  }

  // =====================
  // REMATCH
  // =====================
  if (interaction.commandName === "rematch") {
    queue = [...lastMatch.red, ...lastMatch.blue];
    return interaction.reply("Rematch ready");
  }

  // =====================
  // STATS
  // =====================
  if (interaction.commandName === "stats") {
    ensurePlayer(member.id);
    return interaction.reply(`Skill: ${playerData[member.id].skill}`);
  }

});

// =====================
register();
client.login(process.env.TOKEN);
