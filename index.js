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

let captains = {
  red: null,
  blue: null
};

let draftTeams = {
  red: [],
  blue: []
};

let currentTurn = "red";

let lastMatch = null;

let matchStarted = false;

// =====================
// ROLE CHECK
// =====================
function hasRole(member, roles) {
  return member.roles.cache.some(r => roles.includes(r.name));
}

function canUse(member, cmd) {

  const admin = ["autobalance", "captains", "startmatch", "finalize", "rematch"];
  const player = ["join", "skill", "pick", "stats"];

  if (admin.includes(cmd)) return hasRole(member, ADMIN_ROLES);
  if (player.includes(cmd)) return hasRole(member, PLAYER_ROLES);

  return false;
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
// VOICE MOVE
// =====================
async function moveToVC(guild, userId, channelId) {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    if (!member.voice?.channel) return;

    await member.voice.setChannel(channelId);
  } catch (e) {
    console.log(e.message);
  }
}

async function moveTeams(guild, red, blue) {
  for (const id of red) {
    await moveToVC(guild, id, RED_VC_ID);
  }

  for (const id of blue) {
    await moveToVC(guild, id, BLUE_VC_ID);
  }
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
    .setDescription('Start drafted match'),

  new SlashCommandBuilder()
    .setName('autobalance')
    .setDescription('Auto balance teams'),

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
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
}

// =====================
// READY
// =====================
client.once("clientReady", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

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
  // JOIN
  // =====================
  if (interaction.commandName === "join") {

    const pos = interaction.options.getString("position").toUpperCase();

    if (!["GK", "DEF", "MID", "ATT"].includes(pos)) {
      return interaction.reply({ content: "Invalid position", flags: 64 });
    }

    if (queue.includes(member.id)) {
      return interaction.reply({ content: "Already in queue", flags: 64 });
    }

    ensurePlayer(member.id);
    playerData[member.id].position = pos;

    queue.push(member.id);

    return interaction.reply(`Joined as ${pos}`);
  }

  // =====================
  // SKILL
  // =====================
  if (interaction.commandName === "skill") {

    const level = interaction.options.getInteger("level");

    if (level < 1 || level > 10) {
      return interaction.reply({ content: "1-10 only", flags: 64 });
    }

    ensurePlayer(member.id);
    playerData[member.id].skill = level;

    return interaction.reply(`Skill set ${level}`);
  }

  // =====================
  // AUTOBALANCE
  // =====================
  if (interaction.commandName === "autobalance") {

  if (draftMode || captains.red !== null || captains.blue !== null) {
    return interaction.reply({
      content: "❌ Captains already selected. Auto balance only works in free queue.",
      flags: 64
    });
  }

  if (queue.length < 2) {
    return interaction.reply({
      content: "❌ Not enough players in queue",
      flags: 64
    });
  }

  let gk = [];
  let fieldPlayers = [];

  // =========================
  // SPLIT GK vs FIELD PLAYERS
  // =========================
  for (const id of queue) {
    ensurePlayer(id);

    if (playerData[id].position === "GK") {
      gk.push(id);
    } else {
      fieldPlayers.push(id);
    }
  }

  // shuffle helper
  const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

  gk = shuffle(gk);
  fieldPlayers = shuffle(fieldPlayers);

  const teamA = [];
  const teamB = [];

  // =========================
  // 1️⃣ FORCE GK DISTRIBUTION FIRST
  // =========================
  if (gk.length > 0) {
    teamA.push(gk[0]);
  }

  if (gk.length > 1) {
    teamB.push(gk[1]);
  }

  // If only 1 GK exists → assign him randomly
  if (gk.length === 1) {
    if (Math.random() > 0.5) teamA.push(gk[0]);
    else teamB.push(gk[0]);
  }

  // =========================
  // 2️⃣ DISTRIBUTE FIELD PLAYERS
  // =========================
  for (const id of fieldPlayers) {
    if (teamA.length <= teamB.length) {
      teamA.push(id);
    } else {
      teamB.push(id);
    }
  }

  // =========================
  // 3️⃣ FINAL BALANCE FIX
  // =========================
  while (Math.abs(teamA.length - teamB.length) > 1) {
    if (teamA.length > teamB.length) {
      teamB.push(teamA.pop());
    } else {
      teamA.push(teamB.pop());
    }
  }

  // reset queue
  queue = [];

  return interaction.reply({
    content:
      `🤖 **AUTO BALANCED TEAMS (GK PRIORITY)**\n\n` +
      `🔴 **Team A:**\n${teamA.map(id => `<@${id}>`).join("\n") || "None"}\n\n` +
      `🔵 **Team B:**\n${teamB.map(id => `<@${id}>`).join("\n") || "None"}`
  });
}

  // =====================
  // CAPTAINS
  // =====================
  if (interaction.commandName === "captains") {

    captains.red = interaction.options.getUser("red").id;
    captains.blue = interaction.options.getUser("blue").id;

    draftMode = true;

    draftTeams.red = [captains.red];
    draftTeams.blue = [captains.blue];

    queue = queue.filter(p =>
      p !== captains.red && p !== captains.blue
    );

    currentTurn = "red";

    return interaction.reply(
      `Captains set:\n🔴 <@${captains.red}>\n🔵 <@${captains.blue}>`
    );
  }

  // =====================
  // PICK
  // =====================
  if (interaction.commandName === "pick") {

    if (!draftMode) return interaction.reply("No draft active");

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

    return interaction.reply(`Picked <@${player}>`);
  }

// =====================
// START MATCH
// =====================
if (interaction.commandName === "startmatch") {

  if (matchStarted) {
    return interaction.reply({
      content: "A match is already started",
      flags: 64
    });
  }

  if (
    draftTeams.red.length === 0 ||
    draftTeams.blue.length === 0
  ) {
    return interaction.reply({
      content: "Teams are not ready",
      flags: 64
    });
  }

  matchStarted = true;

  lastMatch = {
    red: [...draftTeams.red],
    blue: [...draftTeams.blue]
  };

  const redTeam = draftTeams.red
    .map(id => `• <@${id}>`)
    .join("\n");

  const blueTeam = draftTeams.blue
    .map(id => `• <@${id}>`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("⚽ MATCH STARTED")
    .setDescription("🔴 RED vs 🔵 BLUE")
    .addFields(
      {
        name: "🔴 RED TEAM",
        value: redTeam || "No players",
        inline: true
      },
      {
        name: "🔵 BLUE TEAM",
        value: blueTeam || "No players",
        inline: true
      }
    )
    .setColor(0x00AEFF)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed]
  });

  await moveTeams(guild, draftTeams.red, draftTeams.blue);

  draftMode = false;
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

  return interaction.reply(
    `FINAL\n🔴 ${red} - ${blue} 🔵\nWinner: ${winner}`
  );
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

    return interaction.reply(
      `Skill: ${playerData[member.id].skill}\nPosition: ${playerData[member.id].position}`
    );
  }
});

// =====================

register();
client.login(process.env.TOKEN);

// Add this part below ↓
const express = require('express');
const server = express();

server.get('/', (req, res) => res.send('Bot is running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
