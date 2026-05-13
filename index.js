const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

client.once("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
});

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
client.once("ready", () => {
  console.log(`Bot online as ${client.user.tag}`);
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

    lastMatch = {
      red: draftTeams.red,
      blue: draftTeams.blue
    };

    await interaction.reply(
      `MATCH STARTED\n🔴 RED vs 🔵 BLUE`
    );

    await moveTeams(guild, draftTeams.red, draftTeams.blue);

    draftMode = false;
  }

  // =====================
  // AUTO BALANCE
  // =====================
  if (interaction.commandName === "autobalance") {

    const all = [...queue];

    const red = all.filter((_, i) => i % 2 === 0);
    const blue = all.filter((_, i) => i % 2 === 1);

    lastMatch = { red, blue };

    return interaction.reply("Teams balanced");
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