const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
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

// ── Stats helpers ──────────────────────────────────────────────────────────

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[Bot] Fehler beim Laden der Stats:", err);
  }
  return {};
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error("[Bot] Fehler beim Speichern der Stats:", err);
  }
}

function ensureUser(stats, userId, tag) {
  if (!stats[userId]) {
    stats[userId] = {
      tag,
      checks: 0,
      active: 0,
      inactive: 0,
      dienstSeit: new Date().toISOString(),
    };
  } else {
    stats[userId].tag = tag;
  }
}

function recordCheck(userId, tag) {
  const stats = loadStats();
  ensureUser(stats, userId, tag);
  stats[userId].checks++;
  saveStats(stats);
}

function recordActive(userId, tag) {
  const stats = loadStats();
  ensureUser(stats, userId, tag || stats[userId]?.tag || "Unbekannt");
  stats[userId].active++;
  saveStats(stats);
}

function recordInactive(userId, tag) {
  const stats = loadStats();
  ensureUser(stats, userId, tag || stats[userId]?.tag || "Unbekannt");
  stats[userId].inactive++;
  saveStats(stats);
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "—";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// ── Slash commands ─────────────────────────────────────────────────────────

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

// ── Client ─────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

const pendingChecks = new Map();
let paused = false;

// ── Activity check ─────────────────────────────────────────────────────────

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
        m.roles.cache.has(ROLE_ID) && !m.user.bot
      );
    } catch (err) {
      console.error(`[Bot] Fehler beim Laden der Mitglieder in ${guild.name}:`, err);
      continue;
    }
    console.log(`[Bot] ${members.length} Mitglied(er) mit Rolle in: ${guild.name}`);
    for (const member of members) {
      await sendActivityCheck(member, guild.id);
    }
  }
}

async function sendActivityCheck(member, guildId) {
  const userId = member.id;
  const tag = member.user.tag;
  const customId = `aktiv_${userId}_${Date.now()}`;

  recordCheck(userId, tag);

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
    console.log(`[Bot] DM gesendet an: ${tag}`);
  } catch (err) {
    console.warn(`[Bot] Konnte keine DM an ${tag} senden — melde als inaktiv`);
    recordInactive(userId, tag);
    await reportInactive(member, guildId, "DM konnte nicht zugestellt werden");
    return;
  }

  if (pendingChecks.has(userId)) clearTimeout(pendingChecks.get(userId));

  const timeout = setTimeout(async () => {
    pendingChecks.delete(userId);
    console.log(`[Bot] Timeout für ${tag} — melde als inaktiv`);
    recordInactive(userId, tag);
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

// ── Ready ──────────────────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`[Bot] Eingeloggt als: ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: COMMANDS }
      );
      console.log(`[Bot] Slash-Commands registriert in: ${guild.name}`);
    } catch (err) {
      console.error(`[Bot] Fehler beim Registrieren der Commands in ${guild.name}:`, err);
    }
  }

  checkActivity();
  setInterval(checkActivity, CHECK_INTERVAL_MS);
});

// ── Interactions ───────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    }
  } catch (err) {
    console.error("[Bot] Unbehandelter Fehler in interactionCreate:", err);
  }
});

async function handleButton(interaction) {
  if (!interaction.customId.startsWith("aktiv_")) return;

  const parts = interaction.customId.split("_");
  const userId = parts[1];
  const timestamp = parseInt(parts[2]);

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "❌ Dieser Button ist nicht für dich.", flags: MessageFlags.Ephemeral });
    return;
  }

  const elapsed = Date.now() - timestamp;
  if (elapsed > RESPONSE_TIMEOUT_MS) {
    await interaction.reply({ content: "⌛ Diese Prüfung ist bereits abgelaufen.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (pendingChecks.has(userId)) {
    clearTimeout(pendingChecks.get(userId));
    pendingChecks.delete(userId);
  }

  recordActive(userId, interaction.user.tag);
  console.log(`[Bot] ${interaction.user.tag} hat bestätigt: aktiv ✅`);
  await interaction.update({
    content: "✅ Danke! Du wurdest als **aktiv** markiert.",
    embeds: [],
    components: [],
  });
}

async function handleCommand(interaction) {
  if (interaction.commandName === "pause") {
    if (paused) {
      await interaction.reply({ content: "⏸️ Die Prüfungen sind bereits pausiert.", flags: MessageFlags.Ephemeral });
      return;
    }
    paused = true;
    console.log(`[Bot] Prüfungen pausiert von: ${interaction.user.tag}`);
    await interaction.reply({ content: "⏸️ Aktivitätsprüfungen wurden **pausiert**.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "fortsetzen") {
    if (!paused) {
      await interaction.reply({ content: "▶️ Die Prüfungen laufen bereits.", flags: MessageFlags.Ephemeral });
      return;
    }
    paused = false;
    console.log(`[Bot] Prüfungen fortgesetzt von: ${interaction.user.tag}`);
    await interaction.reply({ content: "▶️ Aktivitätsprüfungen wurden **fortgesetzt**.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "statistik") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply("❌ Dieser Command funktioniert nur auf einem Server.");
      return;
    }

    // Use the already-cached members to avoid rate limits from guild.members.fetch()
    // Only fetch if the cache appears empty (bot just started and no check ran yet)
    let allMembers = [...guild.members.cache.values()].filter(
      (m) => m.roles.cache.has(ROLE_ID) && !m.user.bot
    );

    if (guild.members.cache.size <= 1) {
      try {
        await guild.members.fetch();
        allMembers = [...guild.members.cache.values()].filter(
          (m) => m.roles.cache.has(ROLE_ID) && !m.user.bot
        );
      } catch (err) {
        console.error("[Bot] Fehler beim Laden der Mitglieder für Statistik:", err);
        await interaction.editReply("❌ Mitglieder konnten nicht geladen werden. Bitte in 10 Sekunden erneut versuchen.");
        return;
      }
    }

    const stats = loadStats();

    const rows = allMembers.map((member) => {
      const data = stats[member.id];
      const tag = member.user.tag;
      if (!data) {
        return { userId: member.id, tag, line: `<@${member.id}> **${tag}**\nPrüfungen: 0/0 | Dienstzeit: —` };
      }
      const ms = data.dienstSeit ? Date.now() - new Date(data.dienstSeit).getTime() : 0;
      const dienstzeit = formatDuration(ms);
      const line = `<@${member.id}> **${tag}**\nPrüfungen: ${data.active}/${data.checks} | Dienstzeit: ${dienstzeit}`;
      return { userId: member.id, tag, line, rate: data.checks > 0 ? data.active / data.checks : 0 };
    });

    rows.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

    const statusText = paused ? "⏸️ Prüfungen pausiert" : "▶️ Prüfungen aktiv";

    const chunks = [];
    let current = [];
    let currentLen = 0;
    for (const row of rows) {
      if (currentLen + row.line.length + 2 > 3800) {
        chunks.push(current);
        current = [row];
        currentLen = row.line.length;
      } else {
        current.push(row);
        currentLen += row.line.length + 2;
      }
    }
    if (current.length > 0) chunks.push(current);

    if (chunks.length === 0) {
      await interaction.editReply("📊 Keine Nutzer mit der Dienst-Rolle gefunden.");
      return;
    }

    const firstEmbed = new EmbedBuilder()
      .setTitle("📊 Dienst-Statistiken")
      .setDescription(chunks[0].map((r) => r.line).join("\n\n"))
      .addFields({ name: "Status", value: statusText, inline: true })
      .setColor(0x5865f2)
      .setFooter({ text: `${allMembers.length} Nutzer gesamt${chunks.length > 1 ? ` (Seite 1/${chunks.length})` : ""}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [firstEmbed] });

    for (let i = 1; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setTitle(`📊 Dienst-Statistiken (Seite ${i + 1}/${chunks.length})`)
        .setDescription(chunks[i].map((r) => r.line).join("\n\n"))
        .setColor(0x5865f2);
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  }
}

client.on("error", (err) => console.error("[Bot] Client-Fehler:", err));

process.on("unhandledRejection", (err) => console.error("[Bot] Unhandled rejection:", err));

client.login(TOKEN);
