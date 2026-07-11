const express = require('express');
const app = express();
app.use(express.json());

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_CFD    = process.env.CHANNEL_CFD;
const CHANNEL_FUTURE = process.env.CHANNEL_FUTURE;
const SECRET_KEY     = process.env.SECRET_KEY || 'dtc2026';

// ── Cooldown posibles señales ─────────────────────────────────
const COOLDOWN_MIN = 5;
const lastPossible = {};

// ── Parámetros del sistema por activo ────────────────────────
const PARAMS = {
  'XAUUSD': { slMult: 1.5, tpMult: 4.1, atrApprox: null }, // ATR viene del mensaje
  'MNQU26': { slMult: 1.0, tpMult: 1.8, atrApprox: null },
};

// ── Discord ──────────────────────────────────────────────────
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`✅ Bot conectado: ${client.user.tag}`));
client.login(DISCORD_TOKEN);

const COLOR_WARN  = 0xD4E600;
const COLOR_LONG  = 0x00C853;
const COLOR_SHORT = 0xFF3B5C;

// ── Helper: calcular SL/TP si no vienen en el mensaje ────────
function calcLevels(entry, direction, atr, slMult, tpMult) {
  const e  = parseFloat(entry);
  const sl = parseFloat(atr) * slMult;
  const tp = parseFloat(atr) * tpMult;
  if (direction === 'LONG') {
    return {
      sl: (e - sl).toFixed(2),
      tp: (e + tp).toFixed(2),
    };
  } else {
    return {
      sl: (e + sl).toFixed(2),
      tp: (e - tp).toFixed(2),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /signal
// ═══════════════════════════════════════════════════════════════
app.post('/signal', async (req, res) => {
  try {
    if (req.query.key !== SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, asset, direction, entry, sl, tp, rr, score, atr } = req.body;
    console.log(`📨 ${type} | ${asset} | ${direction} | entry:${entry} atr:${atr}`);

    const isFuture  = asset === 'MNQU26' || asset === 'MNQ';
    const channelId = isFuture ? CHANNEL_FUTURE : CHANNEL_CFD;
    const channel   = await client.channels.fetch(channelId);
    if (!channel) return res.status(500).json({ error: 'Canal no encontrado' });

    // ── POSIBLE SEÑAL ─────────────────────────────────────────
    if (type === 'possible') {
      const now     = Date.now();
      const lastT   = lastPossible[asset] || 0;
      const diffMin = (now - lastT) / 60000;

      if (diffMin < COOLDOWN_MIN) {
        console.log(`⏳ Cooldown ${asset} — ${(COOLDOWN_MIN-diffMin).toFixed(1)}min restantes`);
        return res.status(200).json({ ok: true, skipped: true });
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
      console.log(`✅ Posible enviada → ${asset}`);
    }

    // ── SEÑAL CONFIRMADA ──────────────────────────────────────
    else if (type === 'confirmed') {
      lastPossible[asset] = 0;

      const isLong  = direction === 'LONG';
      const color   = isLong ? COLOR_LONG : COLOR_SHORT;
      const arrow   = isLong ? '📈' : '📉';
      const params  = PARAMS[asset] || PARAMS['MNQU26'];

      // Calcular SL/TP si no vienen o son undefined
      let slFinal = sl && sl !== 'undefined' ? sl : null;
      let tpFinal = tp && tp !== 'undefined' ? tp : null;

      if ((!slFinal || !tpFinal) && atr && entry) {
        const levels = calcLevels(entry, direction, atr, params.slMult, params.tpMult);
        slFinal = slFinal || levels.sl;
        tpFinal = tpFinal || levels.tp;
      }

      const rrFinal = rr || params.tpMult.toFixed(1);

      const lines = [
        `## ✅ SEÑAL CONFIRMADA — ${asset} ${arrow} ${direction}`,
        ``,
        `🎯 **Entrada:** \`${entry}\``,
        slFinal ? `🛑 **Stop Loss:** \`${slFinal}\`` : null,
        tpFinal ? `💰 **Take Profit:** \`${tpFinal}\`` : null,
        `📊 **RR:** \`1:${rrFinal}\``,
        score ? `⭐ **Score:** \`${score}/10\`` : null,
      ].filter(Boolean);

      // Aviso precio para futuros
      if (isFuture) {
        lines.push(``, `> ⚠️ *Precio en NAS100. En MNQU26 suma ~350 pts al precio de entrada.*`);
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
      console.log(`✅ Confirmada → ${asset} ${direction} entrada:${entry} sl:${slFinal} tp:${tpFinal}`);
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
