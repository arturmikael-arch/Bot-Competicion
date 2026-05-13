const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

require("dotenv").config();

// =====================
// CLIENT (MUST BE FIRST)
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
const RED_VC_ID = "1504096957407170611";
const BLUE_VC_ID = "1504097182620581958";

const ADMIN_ROLES = ["Admin", "Moderator", "Owner"];
const PLAYER_ROLES = ["FC26 Player", "Member"];

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

// =====================
// READY EVENT
// =====================
client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

// =====================
// HELPERS
// =====================
function ensurePlayer(id) {
  if (!playerData[id]) {
    playerData[id] = { skill: 5, position: "MID" };
  }
}

async function moveToVC(guild, userId, channelId) {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    if (!member.voice?.channel) return;

    await member.voice.setChannel(channelId);
  } catch (e) {
    console.log("Move error:", e.message);
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
// COMMANDS REGISTER
// =====================
const commands = [

  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join queue")
    .addStringOption(o =>
      o.setName("position")
        .setDescription("GK / DEF / MID / ATT")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skill")
    .setDescription("Set skill (1-10)")
    .addIntegerOption(o =>
      o.setName("level")
        .setDescription("Skill level")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("captains")
    .setDescription("Select captains")
    .addUserOption(o =>
      o.setName("red")
        .setDescription("Red captain")
        .setRequired(true)
    )
    .addUserOption(o =>
      o.setName("blue")
        .setDescription("Blue captain")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("pick")
    .setDescription("Pick player")
    .addUserOption(o =>
      o.setName("player")
        .setDescription("Player")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("startmatch")
    .setDescription("Start match"),

  new SlashCommandBuilder()
    .setName("finalize")
    .setDescription("Finish match")
    .addIntegerOption(o =>
      o.setName("red")
        .setDescription("Red goals")
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName("blue")
        .setDescription("Blue goals")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("rematch")
    .setDescription("Rematch"),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Stats")

].map(c => c.toJSON());

// =====================
// REGISTER FUNCTION
// =====================
const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

async function register() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
}

// =====================
// INTERACTIONS
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const member = await guild.members.fetch(interaction.user.id);

  // =====================
  // JOIN
  // =====================
  if (interaction.commandName === "join") {

    const pos = interaction.options.getString("position").toUpperCase();

    if (!["GK", "DEF", "MID", "ATT"].includes(pos)) {
      return interaction.reply("Invalid position");
    }

    if (queue.includes(member.id)) {
      return interaction.reply("Already in queue");
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

    const lvl = interaction.options.getInteger("level");

    if (lvl < 1 || lvl > 10) {
      return interaction.reply("Skill 1-10 only");
    }

    ensurePlayer(member.id);
    playerData[member.id].skill = lvl;

    return interaction.reply(`Skill set ${lvl}`);
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

    await interaction.reply("🔥 MATCH STARTED");

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

    return interaction.reply(
      `🏁 FINAL\n🔴 ${red} - ${blue} 🔵\n🏆 ${winner}`
    );
  }

  // =====================
  // REMATCH
  // =====================
  if (interaction.commandName === "rematch") {

    queue = [...(lastMatch?.red || []), ...(lastMatch?.blue || [])];

    return interaction.reply("🔁 Rematch ready");
  }

  // =====================
  // STATS
  // =====================
  if (interaction.commandName === "stats") {

    ensurePlayer(member.id);

    const p = playerData[member.id];

    return interaction.reply(
      `📊 STATS\nPosition: ${p.position}\nSkill: ${p.skill}`
    );
  }
});

// =====================
register();
client.login(process.env.TOKEN);