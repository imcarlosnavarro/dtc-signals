const express = require('express');
const app = express();
app.use(express.json());

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_CFD    = process.env.CHANNEL_CFD;
const CHANNEL_FUTURE = process.env.CHANNEL_FUTURE;
const SECRET_KEY     = process.env.SECRET_KEY || 'dtc2026';
const TWELVE_KEY     = process.env.TWELVE_API_KEY || 'demo';
const SHEET_ID       = process.env.SHEET_ID;

const COOLDOWN_MIN = 5;
const lastPossible = {};
const activeTrades = {};
let tradeCounter = 0;

function emptyStats() {
  return { total:0, wins:0, losses:0, tp1Hits:0, tp2Hits:0, tp3Hits:0, slHits:0, pnlR:0, history:[], weeklyStats:{total:0,wins:0,losses:0,pnlR:0}, weeklyStart:new Date().toISOString() };
}
const stats = { XAUUSD: emptyStats(), MNQU26: emptyStats() };
function getStats(asset) { return stats[asset] || stats['XAUUSD']; }

// ── Google Sheets ─────────────────────────────────────────────
const { google } = require('googleapis');

async function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Leer estadísticas desde Google Sheets ────────────────────
async function readStatsFromSheet(asset) {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A:N'
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return null; // solo cabecera

    // Filtrar por activo
    const filtered = rows.slice(1).filter(r => !asset || r[1] === asset);

    const total   = filtered.length;
    const wins    = filtered.filter(r => r[8] === 'WIN').length;
    const losses  = filtered.filter(r => r[8] === 'LOSS').length;
    const tp1Hits = filtered.filter(r => r[9] === 'SI').length;
    const tp2Hits = filtered.filter(r => r[10] === 'SI').length;
    const tp3Hits = filtered.filter(r => r[11] === 'SI').length;
    const slHits  = filtered.filter(r => r[8] === 'LOSS').length;
    const pnlR    = filtered.reduce((sum, r) => sum + (parseFloat(r[12]) || 0), 0);
    const wr      = total > 0 ? (wins/total*100).toFixed(1) : '0.0';

    // Semana actual (últimos 7 días)
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
    const thisWeek = filtered.filter(r => {
      const parts = (r[0]||'').split('/');
      if (parts.length < 3) return false;
      const d = new Date(parts[2], parts[1]-1, parts[0]);
      return d >= weekAgo;
    });
    const wTotal  = thisWeek.length;
    const wWins   = thisWeek.filter(r => r[8]==='WIN').length;
    const wPnl    = thisWeek.reduce((sum,r) => sum+(parseFloat(r[12])||0),0);
    const wWr     = wTotal>0 ? (wWins/wTotal*100).toFixed(1) : '0.0';

    // Últimas 10
    const last10 = filtered.slice(-10).reverse().map(r => ({
      date:r[0], asset:r[1], direction:r[2], result:r[8], pnlR:r[12]
    }));

    return { total, wins, losses, tp1Hits, tp2Hits, tp3Hits, slHits,
             pnlR:pnlR.toFixed(2), win_rate:wr+'%',
             this_week:{ total:wTotal, wins:wWins, pnlR:wPnl.toFixed(2), win_rate:wWr+'%' },
             last_10:last10 };
  } catch(e) {
    console.error('readStats error:', e.message);
    return null;
  }
}

async function appendToSheet(row) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Hoja 1!A:N',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    console.log('✅ Fila añadida a Google Sheets');
  } catch(e) {
    console.error('❌ Sheets error:', e.message);
  }
}

// ── Discord ──────────────────────────────────────────────────
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

client.once('ready', async () => {
  console.log(`✅ Bot conectado: ${client.user.tag}`);
  startPriceMonitor();
  scheduleWeeklyReport();

  // Registrar comandos slash
  const commands = [
    new SlashCommandBuilder().setName('stats').setDescription('Ver estadísticas de señales DTC'),
    new SlashCommandBuilder().setName('resumen').setDescription('Forzar resumen semanal ahora'),
    new SlashCommandBuilder().setName('activas').setDescription('Ver operaciones activas ahora mismo'),
  ].map(c => c.toJSON());

  const rest = new REST({ version:'10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Comandos slash registrados');
  } catch(e) { console.error('Slash error:', e.message); }
});

// Manejar comandos slash
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'stats') {
    await interaction.deferReply();
    const xau = await readStatsFromSheet('XAUUSD') || {};
    const mnq = await readStatsFromSheet('MNQU26') || {};
    const desc = [
      `## 📊 ESTADÍSTICAS DTC SIGNALS`,``,
      `**🥇 XAUUSD (Oro)**`,
      `Trades: ${xau.total||0} | Wins: ${xau.wins||0} | Losses: ${xau.losses||0}`,
      `Win Rate: ${xau.win_rate||'0.0%'} | PnL: ${xau.pnlR||'0.00'}R`,
      `TP1: ${xau.tp1Hits||0} | TP2: ${xau.tp2Hits||0} | TP3: ${xau.tp3Hits||0} | SL: ${xau.slHits||0}`,
      `Esta semana: ${xau.this_week?.total||0} trades | ${xau.this_week?.win_rate||'0.0%'} WR`,
      ``,
      `**📈 MNQU26 (Nasdaq)**`,
      `Trades: ${mnq.total||0} | Wins: ${mnq.wins||0} | Losses: ${mnq.losses||0}`,
      `Win Rate: ${mnq.win_rate||'0.0%'} | PnL: ${mnq.pnlR||'0.00'}R`,
      `TP1: ${mnq.tp1Hits||0} | TP2: ${mnq.tp2Hits||0} | TP3: ${mnq.tp3Hits||0} | SL: ${mnq.slHits||0}`,
      `Esta semana: ${mnq.this_week?.total||0} trades | ${mnq.this_week?.win_rate||'0.0%'} WR`,
      ``,
      `**Operaciones activas:** ${Object.keys(activeTrades).length}`,
      `📊 *Datos del historial permanente en Google Sheets*`,
      ``,
      `*— Despierta Tu Capital (DTC)*`
    ].join('\n');
    await interaction.editReply({ embeds: [{ color:0x00BFFF, description:desc,
      footer:{text:'DTC · Historial permanente Google Sheets'}, timestamp:new Date().toISOString() }] });
  }

  else if (interaction.commandName === 'resumen') {
    await interaction.reply({ content:'⏳ Generando resumen semanal...', ephemeral:true });
    await sendWeeklyReport();
  }

  else if (interaction.commandName === 'activas') {
    const ids = Object.keys(activeTrades);
    if (ids.length === 0) {
      await interaction.reply({ content:'No hay operaciones activas ahora mismo.', ephemeral:true });
      return;
    }
    const lines = ids.map(id => {
      const t = activeTrades[id];
      return `**${t.asset} ${t.direction}** | Entrada: ${t.entry} | SL: ${t.sl} | TP1: ${t.tp1} | TP3: ${t.tp3}`;
    });
    await interaction.reply({ embeds: [{ color:0xD4E600,
      description:`## ⚡ OPERACIONES ACTIVAS\n\n${lines.join('\n')}`,
      footer:{text:'DTC · Monitor en tiempo real'}, timestamp:new Date().toISOString() }] });
  }
});
client.login(DISCORD_TOKEN);

const COLOR_WARN=0xD4E600, COLOR_LONG=0x00C853, COLOR_SHORT=0xFF3B5C;
const COLOR_SL=0xFF0000, COLOR_TP1=0x00E676, COLOR_TP2=0x00C853;
const COLOR_TP3=0xFFD700, COLOR_STATS=0x00BFFF;

// ── Precio actual ─────────────────────────────────────────────
async function getCurrentPrice(asset) {
  try {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const symbol = asset === 'XAUUSD' ? 'XAU/USD' : 'NDX';
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_KEY}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const price = parseFloat(json.price);
            if (!isNaN(price)) { console.log(`💰 ${asset}: ${price}`); resolve(price); }
            else reject(new Error('No price: ' + data));
          } catch(e) { reject(e); }
        });
      }).on('error', reject);
    });
  } catch(e) {
    console.error('Price error:', e.message);
    return null;
  }
}

// ── Registrar resultado ───────────────────────────────────────
async function recordResult(trade, result, rPnl) {
  const s = getStats(trade.asset);
  s.total++; s.weeklyStats.total++;
  if (result==='WIN')  { s.wins++;   s.weeklyStats.wins++; }
  if (result==='LOSS') { s.losses++; s.weeklyStats.losses++; }
  s.pnlR += rPnl; s.weeklyStats.pnlR += rPnl;

  const entry = {
    date: new Date().toLocaleDateString('es-ES'),
    asset: trade.asset, direction: trade.direction,
    result, rPnl: rPnl.toFixed(2),
    tp1: trade.tp1Hit, tp2: trade.tp2Hit, tp3: trade.tp3Hit
  };
  s.history.unshift(entry);
  if (s.history.length > 50) s.history.pop();

  // Escribir en Google Sheets
  const now = new Date();
  const row = [
    now.toLocaleDateString('es-ES'),
    trade.asset,
    trade.direction,
    trade.entry,
    trade.sl || '',
    trade.tp1 || '',
    trade.tp2 || '',
    trade.tp3 || '',
    result,
    trade.tp1Hit ? 'SI' : 'NO',
    trade.tp2Hit ? 'SI' : 'NO',
    trade.tp3Hit ? 'SI' : 'NO',
    rPnl.toFixed(2),
    trade.score || ''
  ];
  await appendToSheet(row);
}

// ── Monitor de precios ────────────────────────────────────────
function startPriceMonitor() {
  setInterval(async () => {
    const ids = Object.keys(activeTrades);
    if (ids.length === 0) return;
    console.log(`🔍 Monitorizando ${ids.length} trades...`);

    const assets = [...new Set(ids.map(id => activeTrades[id].asset))];
    for (const asset of assets) {
      const price = await getCurrentPrice(asset);
      if (!price) continue;

      for (const id of [...ids]) {
        const trade = activeTrades[id];
        if (!trade || trade.asset !== asset) continue;
        const isLong = trade.direction === 'LONG';
        const channel = await client.channels.fetch(trade.channelId).catch(() => null);
        if (!channel) continue;

        // SL
        if (!trade.slHit && (isLong ? price <= trade.sl : price >= trade.sl)) {
          trade.slHit = true; getStats(trade.asset).slHits++;
          await channel.send({ embeds: [{
            color: COLOR_SL,
            description: `## 🛑 STOP LOSS TOCADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**SL:** \`${trade.sl}\`\n\n*Operación cerrada con pérdida. −1R*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Gestión de riesgo' }, timestamp: new Date().toISOString()
          }]});
          await recordResult(trade, 'LOSS', -1);
          delete activeTrades[id]; continue;
        }

        // TP1
        if (!trade.tp1Hit && trade.tp1 && (isLong ? price >= trade.tp1 : price <= trade.tp1)) {
          trade.tp1Hit = true; getStats(trade.asset).tp1Hits++;
          await channel.send({ embeds: [{
            color: COLOR_TP1,
            description: `## 🟢 TP1 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP1:** \`${trade.tp1}\`  *(RR 1:0.75)*\n\n✅ *Cierra parcial o mueve SL a Break Even.*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Gestión de posición' }, timestamp: new Date().toISOString()
          }]});
        }

        // TP2
        if (trade.tp1Hit && !trade.tp2Hit && trade.tp2 && (isLong ? price >= trade.tp2 : price <= trade.tp2)) {
          trade.tp2Hit = true; getStats(trade.asset).tp2Hits++;
          await channel.send({ embeds: [{
            color: COLOR_TP2,
            description: `## 🟡 TP2 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP2:** \`${trade.tp2}\`\n\n✅ *Cierra otro parcial. SL en BE o TP1.*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Gestión de posición' }, timestamp: new Date().toISOString()
          }]});
        }

        // TP3
        if (trade.tp2Hit && !trade.tp3Hit && trade.tp3 && (isLong ? price >= trade.tp3 : price <= trade.tp3)) {
          trade.tp3Hit = true; getStats(trade.asset).tp3Hits++;
          await channel.send({ embeds: [{
            color: COLOR_TP3,
            description: `## 🏆 TP3 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP3:** \`${trade.tp3}\`\n\n🎯 *Objetivo final completado.*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Objetivo completado' }, timestamp: new Date().toISOString()
          }]});
          await recordResult(trade, 'WIN', trade.tp1Hit && trade.tp2Hit ? 2.74 : 1.75);
          delete activeTrades[id];
        }
      }
    }
  }, 60000);
}

// ── Resumen semanal ───────────────────────────────────────────
function scheduleWeeklyReport() {
  setInterval(async () => {
    const now = new Date();
    if (now.getDay()===1 && now.getHours()===8 && now.getMinutes()<1) {
      await sendWeeklyReport();
    }
  }, 60000);
}

async function sendWeeklyReport() {
  try {
    const pairs = [
      { asset:'XAUUSD', chId:CHANNEL_CFD,    emoji:'🥇' },
      { asset:'MNQU26', chId:CHANNEL_FUTURE,  emoji:'📈' }
    ];
    for (const { asset, chId, emoji } of pairs) {
      const s = getStats(asset).weeklyStats;
      const st = getStats(asset);
      const wr  = s.total>0 ? Math.round(s.wins/s.total*100) : 0;
      const pnl = s.pnlR>=0 ? `+${s.pnlR.toFixed(2)}R` : `${s.pnlR.toFixed(2)}R`;
      const desc = [
        `## 📊 RESUMEN SEMANAL — ${emoji} ${asset}`,``,
        `**Señales totales:** ${s.total}`,
        `**Ganadoras:** ${s.wins}  |  **Perdedoras:** ${s.losses}`,
        `**Win Rate:** ${wr}%`,
        `**PnL semana:** \`${pnl}\``,``,
        `🟢 TP1 tocados: ${st.tp1Hits}`,
        `🟡 TP2 tocados: ${st.tp2Hits}`,
        `🏆 TP3 tocados: ${st.tp3Hits}`,
        `🛑 SL tocados: ${st.slHits}`,``,
        `*— Despierta Tu Capital (DTC)*`
      ].join('\n');
      const ch = await client.channels.fetch(chId).catch(()=>null);
      if (ch) await ch.send({ embeds: [{ color:COLOR_STATS, description:desc,
        footer:{text:'DTC · Resultados semanales'}, timestamp:new Date().toISOString() }]});
      getStats(asset).weeklyStats = { total:0, wins:0, losses:0, pnlR:0 };
      getStats(asset).weeklyStart = new Date().toISOString();
    }
    console.log('✅ Resumen semanal enviado');
  } catch(e) { console.error('Weekly error:', e.message); }
}

// ═══════════════════════════════════════════════════════════════
// POST /signal
// ═══════════════════════════════════════════════════════════════
app.post('/signal', async (req, res) => {
  try {
    if (req.query.key !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });

    const { type, asset, direction, entry, sl, tp, tp1, tp2, tp3, rr, rr1, rr2, rr3, score, atr } = req.body;
    console.log(`📨 ${type} | ${asset} | ${direction}`);

    const isFuture  = asset==='MNQU26'||asset==='MNQ';
    const channelId = isFuture ? CHANNEL_FUTURE : CHANNEL_CFD;
    const channel   = await client.channels.fetch(channelId);
    if (!channel) return res.status(500).json({ error: 'Canal no encontrado' });

    if (type === 'possible') {
      const now = Date.now();
      if ((now-(lastPossible[asset]||0))/60000 < COOLDOWN_MIN)
        return res.status(200).json({ ok:true, skipped:true });
      lastPossible[asset] = now;
      await channel.send({ embeds: [{
        color: COLOR_WARN,
        description: `## ⚠️ POSIBLE SEÑAL — ${asset}${direction?' '+direction:''}\n\nEsperando confirmación... no te precipites !!!`,
        footer:{text:'Despierta Tu Capital (DTC)'}, timestamp:new Date().toISOString()
      }]});
    }

    else if (type === 'confirmed') {
      lastPossible[asset] = 0;
      const isLong = direction==='LONG';
      const color  = isLong ? COLOR_LONG : COLOR_SHORT;
      const arrow  = isLong ? '📈' : '📉';

      let slF  = sl  && sl !=='undefined' ? parseFloat(sl)  : null;
      let tp1F = tp1 && tp1!=='undefined' ? parseFloat(tp1) : (tp&&tp!=='undefined'?parseFloat(tp):null);
      let tp2F = tp2 && tp2!=='undefined' ? parseFloat(tp2) : null;
      let tp3F = tp3 && tp3!=='undefined' ? parseFloat(tp3) : null;

      if (atr && entry) {
        const atrV=parseFloat(atr), entV=parseFloat(entry);
        const slM=isFuture?1.0:1.5, t1=isFuture?0.75:1.125, t2=isFuture?1.25:2.625, t3=isFuture?1.8:4.1;
        if (!slF)  slF  = isLong ? entV-atrV*slM : entV+atrV*slM;
        if (!tp1F) tp1F = isLong ? entV+atrV*t1  : entV-atrV*t1;
        if (!tp2F) tp2F = isLong ? entV+atrV*t2  : entV-atrV*t2;
        if (!tp3F) tp3F = isLong ? entV+atrV*t3  : entV-atrV*t3;
      }

      const r=(v)=>v?Math.round(v*100)/100:null;
      const rr1F=rr1||'0.75', rr2F=rr2||(isFuture?'1.25':'1.75'), rr3F=rr3||rr||(isFuture?'1.8':'2.74');

      const lines = [
        `## ✅ SEÑAL CONFIRMADA — ${asset} ${arrow} ${direction}`,``,
        `🎯 **Entrada:** \`${entry}\``,
        slF  ? `🛑 **Stop Loss:** \`${r(slF)}\`` : null,``,
        tp1F ? `🟢 **TP1:** \`${r(tp1F)}\`  *(RR 1:${rr1F})*` : null,
        tp2F ? `🟡 **TP2:** \`${r(tp2F)}\`  *(RR 1:${rr2F})*` : null,
        tp3F ? `🏆 **TP3:** \`${r(tp3F)}\`  *(RR 1:${rr3F})*` : null,
        score ? `\n⭐ **Score:** \`${score}/10\`` : null,
      ].filter(Boolean);

      if (isFuture) lines.push(``,`> ⚠️ *Precio en NAS100. En MNQU26 suma ~350 pts.*`);
      lines.push(``,`*— Despierta Tu Capital (DTC)*`);

      await channel.send({ embeds: [{ color, description:lines.join('\n'),
        footer:{text:'DTC · Esto no es consejo de inversión'}, timestamp:new Date().toISOString() }]});

      if (slF || tp1F) {
        const id = `trade_${++tradeCounter}`;
        activeTrades[id] = {
          id, asset, direction, entry:parseFloat(entry),
          sl:slF, tp1:tp1F, tp2:tp2F, tp3:tp3F,
          tp1Hit:false, tp2Hit:false, tp3Hit:false, slHit:false,
          channelId, score: score||'', openTime:new Date().toISOString()
        };
        console.log(`📋 Trade guardado: ${id} | ${asset} ${direction}`);
      }
    }

    res.status(200).json({ ok:true, active_trades:Object.keys(activeTrades).length });

  } catch(err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error:err.message });
  }
});

// ── GET /stats ────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const asset = req.query.asset; // opcional: ?asset=XAUUSD o ?asset=MNQU26
    const xau = await readStatsFromSheet('XAUUSD');
    const mnq = await readStatsFromSheet('MNQU26');
    res.json({
      source: 'Google Sheets (histórico permanente)',
      active_trades: Object.keys(activeTrades).length,
      XAUUSD: xau || { error: 'Sin datos aún' },
      MNQU26: mnq || { error: 'Sin datos aún' }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req,res) => res.json({
  status:'✅ DTC Signals Bot running',
  cooldown_min:COOLDOWN_MIN,
  active_trades:Object.keys(activeTrades).length,
  stats_url:'/stats'
}));

app.post('/weekly', async (req,res) => {
  if (req.query.key!==SECRET_KEY) return res.status(401).json({error:'Unauthorized'});
  await sendWeeklyReport();
  res.json({ok:true});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
