const express = require('express');
const app = express();
app.use(express.json());

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_CFD    = process.env.CHANNEL_CFD;
const CHANNEL_FUTURE = process.env.CHANNEL_FUTURE;
const SECRET_KEY     = process.env.SECRET_KEY || 'dtc2026';

const COOLDOWN_MIN = 5;
const lastPossible = {};

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`✅ Bot conectado: ${client.user.tag}`));
client.login(DISCORD_TOKEN);

const COLOR_WARN  = 0xD4E600;
const COLOR_LONG  = 0x00C853;
const COLOR_SHORT = 0xFF3B5C;

app.post('/signal', async (req, res) => {
  try {
    if (req.query.key !== SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, asset, direction, entry, sl, tp, tp1, tp2, tp3, rr, rr1, rr2, rr3, score, atr } = req.body;
    console.log(`📨 ${type} | ${asset} | ${direction}`);

    const isFuture  = asset === 'MNQU26' || asset === 'MNQ';
    const channelId = isFuture ? CHANNEL_FUTURE : CHANNEL_CFD;
    const channel   = await client.channels.fetch(channelId);
    if (!channel) return res.status(500).json({ error: 'Canal no encontrado' });

    // ── POSIBLE ───────────────────────────────────────────────
    if (type === 'possible') {
      const now     = Date.now();
      const lastT   = lastPossible[asset] || 0;
      const diffMin = (now - lastT) / 60000;

      if (diffMin < COOLDOWN_MIN) {
        console.log(`⏳ Cooldown ${asset}`);
        return res.status(200).json({ ok: true, skipped: true });
      }
      lastPossible[asset] = now;

      const dirTxt = direction ? ` ${direction}` : '';
      await channel.send({
        embeds: [{
          color: COLOR_WARN,
          description: `## ⚠️ POSIBLE SEÑAL — ${asset}${dirTxt}\n\nEsperando confirmación... no te precipites !!!`,
          footer: { text: 'Despierta Tu Capital (DTC)' },
          timestamp: new Date().toISOString(),
        }]
      });
      console.log(`✅ Posible → ${asset}`);
    }

    // ── CONFIRMADA ────────────────────────────────────────────
    else if (type === 'confirmed') {
      lastPossible[asset] = 0;

      const isLong = direction === 'LONG';
      const color  = isLong ? COLOR_LONG : COLOR_SHORT;
      const arrow  = isLong ? '📈' : '📉';

      // Determinar si usa 3 TPs o 1 TP
      const has3TP = tp1 && tp2 && tp3;

      // Calcular SL/TP si vienen por ATR
      let slFinal  = sl && sl !== 'undefined' ? sl : null;
      let tp1Final = tp1 && tp1 !== 'undefined' ? tp1 : (tp && tp !== 'undefined' ? tp : null);
      let tp2Final = tp2 && tp2 !== 'undefined' ? tp2 : null;
      let tp3Final = tp3 && tp3 !== 'undefined' ? tp3 : null;

      if (!slFinal && atr && entry) {
        const atrV = parseFloat(atr);
        const entV = parseFloat(entry);
        const slM  = isFuture ? 1.0 : 1.5;
        slFinal = isLong ? (entV - atrV * slM).toFixed(2) : (entV + atrV * slM).toFixed(2);
      }
      if (!tp1Final && atr && entry) {
        const atrV  = parseFloat(atr);
        const entV  = parseFloat(entry);
        const tp1M  = isFuture ? 0.75 : 1.125;
        const tp2M  = isFuture ? 1.25 : 2.625;
        const tp3M  = isFuture ? 1.8  : 4.1;
        tp1Final = isLong ? (entV + atrV * tp1M).toFixed(2) : (entV - atrV * tp1M).toFixed(2);
        tp2Final = isLong ? (entV + atrV * tp2M).toFixed(2) : (entV - atrV * tp2M).toFixed(2);
        tp3Final = isLong ? (entV + atrV * tp3M).toFixed(2) : (entV - atrV * tp3M).toFixed(2);
      }

      const rr1Final = rr1 || '0.75';
      const rr2Final = rr2 || '1.75';
      const rr3Final = rr3 || (rr || (isFuture ? '1.8' : '2.74'));

      const lines = [
        `## ✅ SEÑAL CONFIRMADA — ${asset} ${arrow} ${direction}`,
        ``,
        `🎯 **Entrada:** \`${entry}\``,
        slFinal ? `🛑 **Stop Loss:** \`${slFinal}\`` : null,
        ``,
        tp1Final ? `🟢 **TP1:** \`${tp1Final}\`  *(RR 1:${rr1Final})*` : null,
        tp2Final ? `🟡 **TP2:** \`${tp2Final}\`  *(RR 1:${rr2Final})*` : null,
        tp3Final ? `🏆 **TP3:** \`${tp3Final}\`  *(RR 1:${rr3Final})*` : null,
        score    ? `\n⭐ **Score:** \`${score}/10\`` : null,
      ].filter(Boolean);

      if (isFuture) {
        lines.push(``, `> ⚠️ *Precio en NAS100. En MNQU26 suma ~350 pts.*`);
      }

      lines.push(``, `*— Despierta Tu Capital (DTC)*`);

      await channel.send({
        embeds: [{
          color,
          description: lines.join('\n'),
          footer: { text: 'DTC · Esto no es consejo de inversión' },
          timestamp: new Date().toISOString(),
        }]
      });
      console.log(`✅ Confirmada → ${asset} ${direction}`);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: '✅ DTC Signals Bot running', cooldown_min: COOLDOWN_MIN });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
