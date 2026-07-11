const express = require('express');
const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_CFD    = process.env.CHANNEL_CFD;
const CHANNEL_FUTURE = process.env.CHANNEL_FUTURE;
const SECRET_KEY     = process.env.SECRET_KEY || 'dtc2026';

// ── Cooldown — evita spam de "posible señal" ─────────────────
// Solo manda 1 posible señal por activo cada X minutos
const COOLDOWN_MIN = 5; // minutos entre posibles señales
const lastPossible = {}; // { "XAUUSD": timestamp, "MNQU26": timestamp }

// ── Discord client ────────────────────────────────────────────
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ DTC Signals Bot conectado como ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);

// ── Colores embed ─────────────────────────────────────────────
const COLOR_WARN  = 0xD4E600;
const COLOR_LONG  = 0x00C853;
const COLOR_SHORT = 0xFF3B5C;

// ═══════════════════════════════════════════════════════════════
// POST /signal
// ═══════════════════════════════════════════════════════════════
app.post('/signal', async (req, res) => {
  try {
    if (req.query.key !== SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, asset, direction, entry, sl, tp, rr, score } = req.body;
    console.log(`📨 Señal: type=${type} asset=${asset} dir=${direction}`);

    const isFuture  = asset === 'MNQU26' || asset === 'MNQ';
    const channelId = isFuture ? CHANNEL_FUTURE : CHANNEL_CFD;
    const channel   = await client.channels.fetch(channelId);

    if (!channel) {
      return res.status(500).json({ error: 'Canal no encontrado' });
    }

    // ── POSIBLE SEÑAL — con cooldown ─────────────────────────
    if (type === 'possible') {
      const now      = Date.now();
      const lastTime = lastPossible[asset] || 0;
      const diffMin  = (now - lastTime) / 1000 / 60;

      if (diffMin < COOLDOWN_MIN) {
        console.log(`⏳ Cooldown activo para ${asset} — faltan ${(COOLDOWN_MIN - diffMin).toFixed(1)} min`);
        return res.status(200).json({ ok: true, skipped: true, reason: 'cooldown' });
      }

      lastPossible[asset] = now;

      await channel.send({
        embeds: [{
          color: COLOR_WARN,
          description: `## ⚠️ POSIBLE SEÑAL — ${asset}\n\nEsperando confirmación... no te precipites !!!`,
          footer: { text: 'Despierta Tu Capital (DTC)' },
          timestamp: new Date().toISOString(),
        }]
      });
      console.log(`✅ Posible señal enviada → ${asset}`);
    }

    // ── SEÑAL CONFIRMADA ─────────────────────────────────────
    else if (type === 'confirmed') {
      // Reset cooldown al confirmar — permite nueva posible en el siguiente setup
      lastPossible[asset] = 0;

      const isLong = direction === 'LONG';
      const color  = isLong ? COLOR_LONG : COLOR_SHORT;
      const arrow  = isLong ? '📈' : '📉';

      const lines = [
        `## ✅ SEÑAL CONFIRMADA — ${asset} ${arrow} ${direction}`,
        ``,
        `🎯 **Entrada:** \`${entry}\``,
        `🛑 **Stop Loss:** \`${sl}\``,
        `💰 **Take Profit:** \`${tp}\``,
        `📊 **RR:** \`1:${rr}\``,
      ];
      if (score) lines.push(`⭐ **Score:** \`${score}/10\``);
      lines.push(``, `*— Despierta Tu Capital (DTC)*`);

      await channel.send({
        embeds: [{
          color,
          description: lines.join('\n'),
          footer: { text: 'DTC · Esto no es consejo de inversión' },
          timestamp: new Date().toISOString(),
        }]
      });
      console.log(`✅ Señal confirmada → ${asset} ${direction} entrada:${entry}`);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '✅ DTC Signals Bot running',
    cooldown_min: COOLDOWN_MIN,
    last_possible: lastPossible,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DTC Signals escuchando en puerto ${PORT}`);
});
