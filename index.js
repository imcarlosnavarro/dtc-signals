const express = require('express');
const app = express();
app.use(express.json());

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_CFD    = process.env.CHANNEL_CFD;
const CHANNEL_FUTURE = process.env.CHANNEL_FUTURE;
const SECRET_KEY     = process.env.SECRET_KEY || 'dtc2026';

const COOLDOWN_MIN = 5;
const lastPossible = {};

// ── Operaciones activas en memoria ───────────────────────────
// { id, asset, direction, entry, sl, tp1, tp2, tp3, tp1Hit, tp2Hit, tp3Hit, slHit, channelId, openTime }
const activeTrades = {};
let tradeCounter = 0;

const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
  console.log(`✅ Bot conectado: ${client.user.tag}`);
  startPriceMonitor();
});
client.login(DISCORD_TOKEN);

const COLOR_WARN  = 0xD4E600;
const COLOR_LONG  = 0x00C853;
const COLOR_SHORT = 0xFF3B5C;
const COLOR_SL    = 0xFF0000;
const COLOR_TP1   = 0x00E676;
const COLOR_TP2   = 0x00C853;
const COLOR_TP3   = 0xFFD700;

// ── Obtener precio actual via API gratuita ────────────────────
async function getCurrentPrice(asset) {
  try {
    const https = require('https');
    return new Promise((resolve, reject) => {
      // Twelve Data API — gratuita, no necesita key para algunos símbolos
      const symbol = asset === 'XAUUSD' ? 'XAU/USD' : 'NAS100/USD';
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=demo`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const price = parseFloat(json.price);
            if (!isNaN(price)) resolve(price);
            else reject(new Error('No price: ' + data));
          } catch(e) { reject(e); }
        });
      }).on('error', reject);
    });
  } catch(e) {
    console.error('Price fetch error:', e.message);
    return null;
  }
}

// ── Monitor de precios cada 60 segundos ──────────────────────
function startPriceMonitor() {
  setInterval(async () => {
    const tradeIds = Object.keys(activeTrades);
    if (tradeIds.length === 0) return;

    console.log(`🔍 Monitorizando ${tradeIds.length} operaciones activas...`);

    // Agrupar por asset para no hacer múltiples llamadas
    const assets = [...new Set(tradeIds.map(id => activeTrades[id].asset))];

    for (const asset of assets) {
      const price = await getCurrentPrice(asset);
      if (!price) continue;
      console.log(`💰 Precio ${asset}: ${price}`);

      // Revisar cada trade de ese asset
      for (const id of tradeIds) {
        const trade = activeTrades[id];
        if (trade.asset !== asset) continue;

        const isLong = trade.direction === 'LONG';
        const channel = await client.channels.fetch(trade.channelId).catch(() => null);
        if (!channel) continue;

        // Comprobar SL
        if (!trade.slHit) {
          const slHit = isLong ? price <= trade.sl : price >= trade.sl;
          if (slHit) {
            trade.slHit = true;
            await channel.send({
              embeds: [{
                color: COLOR_SL,
                description: `## 🛑 STOP LOSS TOCADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**SL:** \`${trade.sl}\`\n\n*Operación cerrada con pérdida.*\n*— Despierta Tu Capital (DTC)*`,
                footer: { text: 'DTC · Gestión de riesgo activa' },
                timestamp: new Date().toISOString(),
              }]
            });
            delete activeTrades[id];
            continue;
          }
        }

        // Comprobar TP1
        if (!trade.tp1Hit && trade.tp1) {
          const tp1Hit = isLong ? price >= trade.tp1 : price <= trade.tp1;
          if (tp1Hit) {
            trade.tp1Hit = true;
            await channel.send({
              embeds: [{
                color: COLOR_TP1,
                description: `## 🟢 TP1 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP1:** \`${trade.tp1}\`  *(RR 1:0.75)*\n\n✅ *Cierra parcial o mueve SL a BE.*\n*— Despierta Tu Capital (DTC)*`,
                footer: { text: 'DTC · Gestión de posición' },
                timestamp: new Date().toISOString(),
              }]
            });
          }
        }

        // Comprobar TP2
        if (trade.tp1Hit && !trade.tp2Hit && trade.tp2) {
          const tp2Hit = isLong ? price >= trade.tp2 : price <= trade.tp2;
          if (tp2Hit) {
            trade.tp2Hit = true;
            await channel.send({
              embeds: [{
                color: COLOR_TP2,
                description: `## 🟡 TP2 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP2:** \`${trade.tp2}\`\n\n✅ *Cierra otro parcial. SL en BE o TP1.*\n*— Despierta Tu Capital (DTC)*`,
                footer: { text: 'DTC · Gestión de posición' },
                timestamp: new Date().toISOString(),
              }]
            });
          }
        }

        // Comprobar TP3
        if (trade.tp2Hit && !trade.tp3Hit && trade.tp3) {
          const tp3Hit = isLong ? price >= trade.tp3 : price <= trade.tp3;
          if (tp3Hit) {
            trade.tp3Hit = true;
            await channel.send({
              embeds: [{
                color: COLOR_TP3,
                description: `## 🏆 TP3 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP3:** \`${trade.tp3}\`\n\n🎯 *Objetivo final completado. Operación cerrada.*\n*— Despierta Tu Capital (DTC)*`,
                footer: { text: 'DTC · Objetivo completado' },
                timestamp: new Date().toISOString(),
              }]
            });
            delete activeTrades[id];
          }
        }
      }
    }
  }, 60000); // cada 60 segundos
}

// ═══════════════════════════════════════════════════════════════
// POST /signal
// ═══════════════════════════════════════════════════════════════
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
    }

    // ── CONFIRMADA ────────────────────────────────────────────
    else if (type === 'confirmed') {
      lastPossible[asset] = 0;
      const isLong = direction === 'LONG';
      const color  = isLong ? COLOR_LONG : COLOR_SHORT;
      const arrow  = isLong ? '📈' : '📉';

      // Resolver niveles
      let slFinal  = sl  && sl  !== 'undefined' ? parseFloat(sl)  : null;
      let tp1Final = tp1 && tp1 !== 'undefined' ? parseFloat(tp1) : (tp && tp !== 'undefined' ? parseFloat(tp) : null);
      let tp2Final = tp2 && tp2 !== 'undefined' ? parseFloat(tp2) : null;
      let tp3Final = tp3 && tp3 !== 'undefined' ? parseFloat(tp3) : null;

      if (atr && entry) {
        const atrV = parseFloat(atr);
        const entV = parseFloat(entry);
        const slM  = isFuture ? 1.0 : 1.5;
        const tp1M = isFuture ? 0.75 : 1.125;
        const tp2M = isFuture ? 1.25 : 2.625;
        const tp3M = isFuture ? 1.8  : 4.1;
        if (!slFinal)  slFinal  = isLong ? entV - atrV*slM  : entV + atrV*slM;
        if (!tp1Final) tp1Final = isLong ? entV + atrV*tp1M : entV - atrV*tp1M;
        if (!tp2Final) tp2Final = isLong ? entV + atrV*tp2M : entV - atrV*tp2M;
        if (!tp3Final) tp3Final = isLong ? entV + atrV*tp3M : entV - atrV*tp3M;
      }

      const rr1F = rr1 || '0.75';
      const rr2F = rr2 || (isFuture ? '1.25' : '1.75');
      const rr3F = rr3 || rr || (isFuture ? '1.8' : '2.74');

      const lines = [
        `## ✅ SEÑAL CONFIRMADA — ${asset} ${arrow} ${direction}`,
        ``,
        `🎯 **Entrada:** \`${entry}\``,
        slFinal  ? `🛑 **Stop Loss:** \`${Math.round(slFinal*100)/100}\`` : null,
        ``,
        tp1Final ? `🟢 **TP1:** \`${Math.round(tp1Final*100)/100}\`  *(RR 1:${rr1F})*` : null,
        tp2Final ? `🟡 **TP2:** \`${Math.round(tp2Final*100)/100}\`  *(RR 1:${rr2F})*` : null,
        tp3Final ? `🏆 **TP3:** \`${Math.round(tp3Final*100)/100}\`  *(RR 1:${rr3F})*` : null,
        score    ? `\n⭐ **Score:** \`${score}/10\`` : null,
      ].filter(Boolean);

      if (isFuture) lines.push(``, `> ⚠️ *Precio en NAS100. En MNQU26 suma ~350 pts.*`);
      lines.push(``, `*— Despierta Tu Capital (DTC)*`);

      await channel.send({
        embeds: [{
          color,
          description: lines.join('\n'),
          footer: { text: 'DTC · Esto no es consejo de inversión' },
          timestamp: new Date().toISOString(),
        }]
      });

      // Guardar trade activo para monitorizar
      if (slFinal || tp1Final) {
        const id = `trade_${++tradeCounter}`;
        activeTrades[id] = {
          id, asset, direction,
          entry: parseFloat(entry),
          sl: slFinal,
          tp1: tp1Final, tp2: tp2Final, tp3: tp3Final,
          tp1Hit: false, tp2Hit: false, tp3Hit: false, slHit: false,
          channelId,
          openTime: new Date().toISOString()
        };
        console.log(`📋 Trade activo guardado: ${id} | ${asset} ${direction}`);
      }
    }

    res.status(200).json({ ok: true, activeTrades: Object.keys(activeTrades).length });

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
    active_trades: Object.keys(activeTrades).length,
    trades: activeTrades
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
