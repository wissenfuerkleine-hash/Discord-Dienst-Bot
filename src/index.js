const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN ist nicht gesetzt!");
  process.exit(1);
}

const ROLE_ID = "1515119690219786250";
const ADMIN_CHANNEL_ID = "1519014718369697902";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

const pendingChecks = new Map();

async function checkActivity() {
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
    await reportInactive(member, guildId, "DM konnte nicht zugestellt werden");
    return;
  }

  if (pendingChecks.has(userId)) clearTimeout(pendingChecks.get(userId));

  const timeout = setTimeout(async () => {
    pendingChecks.delete(userId);
    console.log(`[Bot] Timeout für ${member.user.tag} — melde als inaktiv`);
    await reportInactive(member, guildId, "Keine Antwort nach 5 Minuten");
  }, RESPONSE_TIMEOUT_MS);

  pendingChecks.set(userId, timeout);
}

const PING_USER_ID = "1478376025585881119";

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

client.once("clientReady", () => {
  console.log(`[Bot] Eingeloggt als: ${client.user.tag}`);
  checkActivity();
  setInterval(checkActivity, CHECK_INTERVAL_MS);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
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

  console.log(`[Bot] ${interaction.user.tag} hat bestätigt: aktiv ✅`);
  await interaction.update({ content: "✅ Danke! Du wurdest als **aktiv** markiert.", embeds: [], components: [] });
});

client.on("error", (err) => console.error("[Bot] Client-Fehler:", err));

client.login(TOKEN);
