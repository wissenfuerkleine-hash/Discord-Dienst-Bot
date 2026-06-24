const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN ist nicht gesetzt!");
  process.exit(1);
}

const ROLE_ID = "1515119690219786250";
const ADMIN_CHANNEL_ID = "1519014718369697902";
const PING_USER_ID = "1478376025585881119";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

const STATS_FILE = path.join(__dirname, "stats.json");

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function recordCheck(userId, tag) {
  const stats = loadStats();
  if (!stats[userId]) {
    stats[userId] = { tag, checks: 0, active: 0, inactive: 0, dienstSeit: new Date().toISOString() };
  }
  stats[userId].tag = tag;
  stats[userId].checks++;
  saveStats(stats);
}

function recordActive(userId) {
  const stats = loadStats();
  if (stats[userId]) {
    stats[userId].active++;
    saveStats(stats);
  }
}

function recordInactive(userId) {
  const stats = loadStats();
  if (stats[userId]) {
    stats[userId].inactive++;
    saveStats(stats);
  }
}

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Aktivitätsprüfungen pausieren")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("fortsetzen")
    .setDescription("Aktivitätsprüfungen fortsetzen")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("statistik")
    .setDescription("Zeigt Aktivitätsstatistiken aller Dienst-Nutzer")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

const pendingChecks = new Map();
let paused = false;
let checkInterval = null;

async function checkActivity() {
  if (paused) {
    console.log("[Bot] Prüfung übersprungen (pausiert)");
    return;
  }
  console.log("[Bot] Starte Aktivitätsprüfung...");
  for (const guild of client.guilds.cache.values()) {
    let members;
    try {
      await guild.members.fetch();
      members = [...guild.members.cache.values()].filter((m) =>
        m.roles.cache.has(ROLE_ID)
      );
    } catch (err) {
      console.error(`Fehler beim Laden der Mitglieder in ${guild.name}:`, err);
      continue;
    }
    console.log(`[Bot] ${members.length} Mitglied(er) mit der Rolle in: ${guild.name}`);
    for (const member of members) {
      await sendActivityCheck(member, guild.id);
    }
  }
}

async function sendActivityCheck(member, guildId) {
  const userId = member.id;
  const customId = `aktiv_${userId}_${Date.now()}`;

  recordCheck(userId, member.user.tag);

  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel("Ich bin aktiv!")
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");

  const row = new ActionRowBuilder().addComponents(button);

  const embed = new EmbedBuilder()
    .setTitle("🔔 Aktivitätsprüfung")
    .setDescription(
      "Hallo! Du hast eine aktive Rolle auf dem Server.\n\n" +
      "Bitte bestätige innerhalb von **5 Minuten**, dass du aktiv bist."
    )
    .setColor(0x5865f2)
    .setFooter({ text: "Discord Dienst Bot" })
    .setTimestamp();

  try {
    const dmChannel = await member.createDM();
    await dmChannel.send({ embeds: [embed], components: [row] });
    console.log(`[Bot] DM gesendet an: ${member.user.tag}`);
  } catch (err) {
    console.warn(`[Bot] Konnte keine DM an ${member.user.tag} senden:`, err);
    recordInactive(userId);
    await reportInactive(member, guildId, "DM konnte nicht zugestellt werden");
    return;
  }

  if (pendingChecks.has(userId)) clearTimeout(pendingChecks.get(userId));

  const timeout = setTimeout(async () => {
    pendingChecks.delete(userId);
    console.log(`[Bot] Timeout für ${member.user.tag} — melde als inaktiv`);
    recordInactive(userId);
    await reportInactive(member, guildId, "Keine Antwort nach 5 Minuten");
  }, RESPONSE_TIMEOUT_MS);

  pendingChecks.set(userId, timeout);
}

async function reportInactive(member, guildId, reason) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const channel = guild.channels.cache.get(ADMIN_CHANNEL_ID);
  if (!channel) {
    console.error(`[Bot] Admin-Kanal ${ADMIN_CHANNEL_ID} nicht gefunden.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Inaktiver Nutzer gemeldet")
    .addFields(
      { name: "Wer", value: `<@${member.id}>`, inline: true },
      { name: "Warum", value: reason, inline: true },
      { name: "Wann", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
    )
    .setColor(0xed4245)
    .setTimestamp();

  try {
    await channel.send({ content: `<@${PING_USER_ID}>`, embeds: [embed] });
    console.log(`[Bot] ${member.user.tag} als inaktiv gemeldet.`);
  } catch (err) {
    console.error("[Bot] Fehler beim Senden in den Admin-Kanal:", err);
  }
}

client.once("clientReady", async () => {
  console.log(`[Bot] Eingeloggt als: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: COMMANDS });
      console.log(`[Bot] Slash-Commands registriert in: ${guild.name}`);
    } catch (err) {
      console.error(`[Bot] Fehler beim Registrieren der Commands in ${guild.name}:`, err);
    }
  }

  checkActivity();
  checkInterval = setInterval(checkActivity, CHECK_INTERVAL_MS);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("aktiv_")) return;

    const userId = interaction.customId.split("_")[1];

    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "Dieser Button ist nicht für dich.", ephemeral: true });
      return;
    }

    const timestamp = parseInt(interaction.customId.split("_")[2]);
    const elapsed = Date.now() - timestamp;

    if (elapsed > RESPONSE_TIMEOUT_MS) {
      await interaction.reply({ content: "Diese Prüfung ist bereits abgelaufen.", ephemeral: true });
      return;
    }

    if (pendingChecks.has(userId)) {
      clearTimeout(pendingChecks.get(userId));
      pendingChecks.delete(userId);
    }

    recordActive(userId);
    console.log(`[Bot] ${interaction.user.tag} hat bestätigt: aktiv ✅`);
    await interaction.update({ content: "✅ Danke! Du wurdest als **aktiv** markiert.", embeds: [], components: [] });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "pause") {
    if (paused) {
      await interaction.reply({ content: "⏸️ Die Prüfungen sind bereits pausiert.", ephemeral: true });
      return;
    }
    paused = true;
    console.log("[Bot] Prüfungen pausiert von:", interaction.user.tag);
    await interaction.reply({ content: "⏸️ Aktivitätsprüfungen wurden **pausiert**.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "fortsetzen") {
    if (!paused) {
      await interaction.reply({ content: "▶️ Die Prüfungen laufen bereits.", ephemeral: true });
      return;
    }
    paused = false;
    console.log("[Bot] Prüfungen fortgesetzt von:", interaction.user.tag);
    await interaction.reply({ content: "▶️ Aktivitätsprüfungen wurden **fortgesetzt**.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "statistik") {
    await interaction.deferReply({ ephemeral: true });

    const stats = loadStats();
    const entries = Object.entries(stats);

    if (entries.length === 0) {
      await interaction.editReply("📊 Noch keine Statistiken vorhanden.");
      return;
    }

    entries.sort((a, b) => (b[1].active / Math.max(b[1].checks, 1)) - (a[1].active / Math.max(a[1].checks, 1)));

    const lines = entries.map(([userId, data]) => {
      const ms = data.dienstSeit ? Date.now() - new Date(data.dienstSeit).getTime() : 0;
      const totalMinutes = Math.floor(ms / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const dienstzeit = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      return `<@${userId}> **${data.tag}**\nPrüfungen: ${data.active}/${data.checks} | Dienstzeit: ${dienstzeit}`;
    });

    const firstChunk = lines.slice(0, 10).join("\n\n");

    const embed = new EmbedBuilder()
      .setTitle("📊 Dienst-Statistiken")
      .setDescription(firstChunk || "Keine Einträge.")
      .addFields({ name: "Status", value: paused ? "⏸️ Prüfungen pausiert" : "▶️ Prüfungen aktiv", inline: true })
      .setColor(0x5865f2)
      .setFooter({ text: `${entries.length} Nutzer gesamt` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }
});

client.on("error", (err) => console.error("[Bot] Client-Fehler:", err));

client.login(TOKEN);
