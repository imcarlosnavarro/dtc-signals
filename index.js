const express = require('express');
const app = express();
app.use(express.json());

const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CHANNEL_CFD    = process.env.CHANNEL_CFD;
const CHANNEL_FUTURE = process.env.CHANNEL_FUTURE;
const SECRET_KEY     = process.env.SECRET_KEY || 'dtc2026';
const TWELVE_KEY     = process.env.TWELVE_API_KEY || 'demo';
const SHEET_ID       = process.env.SHEET_ID;
const ACTIVE_TAB      = 'Activos';

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

// ── Detección automática de pestaña por activo ──────────────────
let tabsCache = { list: null, at: 0 };

async function getSheetTitles() {
  const now = Date.now();
  if (tabsCache.list && (now - tabsCache.at) < 5 * 60 * 1000) return tabsCache.list;
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const titles = (meta.data.sheets || []).map(s => s.properties.title);
  tabsCache = { list: titles, at: now };
  console.log('📑 Pestañas detectadas en el Sheet:', titles);
  return titles;
}

function keywordsFor(asset) {
  if (asset === 'XAUUSD') return ['xau', 'oro', 'gold'];
  return ['mnq', 'nas', 'nasdaq'];
}

async function resolveTabName(asset) {
  try {
    const titles = await getSheetTitles();
    const kws = keywordsFor(asset);
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const match = titles.find(t => {
      const nt = norm(t);
      return kws.some(k => nt.includes(k));
    });
    if (match) return match;
    console.error(`⚠️ No se encontró pestaña para ${asset}. Pestañas disponibles:`, titles);
    return titles[0] || 'Hoja 1';
  } catch (e) {
    console.error('resolveTabName error:', e.message);
    return 'Hoja 1';
  }
}

// ── Leer estadísticas desde Google Sheets (pestaña propia por activo) ──
// Win rate = wins / (wins + losses). Los BE (histórico antiguo) NO cuentan
// ni como ganadora ni como perdedora — se excluyen del cálculo por completo,
// igual que en el Excel original de Carlos.
async function readStatsFromSheet(asset) {
  try {
    const sheets = await getSheetsClient();
    const tab = await resolveTabName(asset);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A:N`
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) return null; // solo cabecera

    const filtered = rows.slice(1).filter(r => r && r[0]);

    const total   = filtered.length;
    const wins    = filtered.filter(r => r[8] === 'WIN').length;
    const losses  = filtered.filter(r => r[8] === 'LOSS').length;
    const be      = filtered.filter(r => r[8] === 'BE').length;
    const decided = wins + losses; // excluye BE del divisor
    const tp1Hits = filtered.filter(r => r[9] === 'SI').length;
    const tp2Hits = filtered.filter(r => r[10] === 'SI').length;
    const tp3Hits = filtered.filter(r => r[11] === 'SI').length;
    const slHits  = losses; // solo cuentan como "SL tocado" las derrotas reales
    const pnlR    = filtered.reduce((sum, r) => sum + (parseFloat(r[12]) || 0), 0);
    const wr      = decided > 0 ? (wins/decided*100).toFixed(1) : '0.0';

    // Semana actual (últimos 7 días)
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
    const thisWeek = filtered.filter(r => {
      const parts = (r[0]||'').split('/');
      if (parts.length < 3) return false;
      const d = new Date(parts[2], parts[1]-1, parts[0]);
      return d >= weekAgo;
    });
    const wTotal   = thisWeek.length;
    const wWins    = thisWeek.filter(r => r[8]==='WIN').length;
    const wLosses  = thisWeek.filter(r => r[8]==='LOSS').length;
    const wDecided = wWins + wLosses;
    const wPnl     = thisWeek.reduce((sum,r) => sum+(parseFloat(r[12])||0),0);
    const wWr      = wDecided>0 ? (wWins/wDecided*100).toFixed(1) : '0.0';

    // Últimas 10
    const last10 = filtered.slice(-10).reverse().map(r => ({
      date:r[0], asset:r[1], direction:r[2], result:r[8], pnlR:r[12]
    }));

    return { total, wins, losses, be, tp1Hits, tp2Hits, tp3Hits, slHits,
             pnlR:pnlR.toFixed(2), win_rate:wr+'%', tab,
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
    const asset = row[1];
    const tab = await resolveTabName(asset);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A:N`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    console.log(`✅ Fila añadida a Google Sheets → pestaña "${tab}"`);
  } catch(e) {
    console.error('❌ Sheets error:', e.message);
  }
}

// ── Persistencia de operaciones activas ─────────────────────────
// Guarda activeTrades en una pestaña "Activos" del Sheet para que,
// si el bot se reinicia (redeploy, crash, etc.), no se pierda el
// seguimiento de las operaciones que ya están abiertas.
async function loadActiveTradesFromSheet() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${ACTIVE_TAB}'!A:R`
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) { console.log('📂 No hay operaciones activas guardadas en el Sheet.'); return; }
    let restored = 0;
    for (const r of rows.slice(1)) {
      if (!r || !r[0]) continue;
      const [id, asset, direction, entry, sl, tp1, tp2, tp3, rr1, rr2, rr3, tp1Hit, tp2Hit, tp3Hit, slHit, channelId, score, openTime] = r;
      activeTrades[id] = {
        id, asset, direction,
        entry: parseFloat(entry),
        sl:  sl  ? parseFloat(sl)  : null,
        tp1: tp1 ? parseFloat(tp1) : null,
        tp2: tp2 ? parseFloat(tp2) : null,
        tp3: tp3 ? parseFloat(tp3) : null,
        rr1: parseFloat(rr1) || 0.75,
        rr2: parseFloat(rr2) || 1.75,
        rr3: parseFloat(rr3) || 2.74,
        tp1Hit: tp1Hit === 'SI', tp2Hit: tp2Hit === 'SI', tp3Hit: tp3Hit === 'SI', slHit: slHit === 'SI',
        channelId, score: score || '', openTime: openTime || new Date().toISOString()
      };
      restored++;
    }
    console.log(`📂 ${restored} operación(es) activa(s) restaurada(s) desde el Sheet`);
  } catch(e) {
    console.error('loadActiveTrades error:', e.message);
  }
}

async function syncActiveTradesToSheet() {
  try {
    const sheets = await getSheetsClient();
    const rows = Object.values(activeTrades).map(t => [
      t.id, t.asset, t.direction, t.entry,
      t.sl ?? '', t.tp1 ?? '', t.tp2 ?? '', t.tp3 ?? '',
      t.rr1 ?? '', t.rr2 ?? '', t.rr3 ?? '',
      t.tp1Hit ? 'SI' : 'NO', t.tp2Hit ? 'SI' : 'NO', t.tp3Hit ? 'SI' : 'NO', t.slHit ? 'SI' : 'NO',
      t.channelId, t.score ?? '', t.openTime
    ]);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${ACTIVE_TAB}'!A2:R2000` });
    if (rows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${ACTIVE_TAB}'!A2`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: rows }
      });
    }
  } catch(e) {
    console.error('syncActiveTrades error:', e.message);
  }
}

// ── Discord ──────────────────────────────────────────────────
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

client.once('ready', async () => {
  console.log(`✅ Bot conectado: ${client.user.tag}`);
  await loadActiveTradesFromSheet();
  startPriceMonitor();
  scheduleWeeklyReport();

  const commands = [
    new SlashCommandBuilder().setName('stats').setDescription('Ver estadísticas de señales DTC'),
    new SlashCommandBuilder().setName('resumen').setDescription('Forzar resumen semanal ahora'),
    new SlashCommandBuilder().setName('activas').setDescription('Ver operaciones activas ahora mismo'),
    new SlashCommandBuilder().setName('cerrar')
      .setDescription('Cerrar manualmente una operación activa colgada (no registra resultado ni escribe en el Sheet)')
      .addStringOption(opt => opt.setName('id').setDescription('ID de la operación, ej. trade_3 (mira /activas)').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('cerrartodas')
      .setDescription('Cerrar TODAS las operaciones activas de golpe (no registra resultado ni escribe en el Sheet)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());

  const rest = new REST({ version:'10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Comandos slash registrados');
  } catch(e) { console.error('Slash error:', e.message); }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'stats') {
    await interaction.deferReply();
    const xau = await readStatsFromSheet('XAUUSD') || {};
    const mnq = await readStatsFromSheet('MNQU26') || {};
    const desc = [
      `## 📊 ESTADÍSTICAS DTC SIGNALS`,``,
      `**🥇 XAUUSD (Oro)**`,
      `Trades: ${xau.total||0} | Wins: ${xau.wins||0} | Losses: ${xau.losses||0}${xau.be?` | BE (antiguas, no cuentan): ${xau.be}`:''}`,
      `Win Rate: ${xau.win_rate||'0.0%'} | PnL: ${xau.pnlR||'0.00'}R`,
      `TP1: ${xau.tp1Hits||0} | TP2: ${xau.tp2Hits||0} | TP3: ${xau.tp3Hits||0} | SL: ${xau.slHits||0}`,
      `Esta semana: ${xau.this_week?.total||0} trades | ${xau.this_week?.win_rate||'0.0%'} WR`,
      ``,
      `**📈 MNQU26 (Nasdaq)**`,
      `Trades: ${mnq.total||0} | Wins: ${mnq.wins||0} | Losses: ${mnq.losses||0}${mnq.be?` | BE (antiguas, no cuentan): ${mnq.be}`:''}`,
      `Win Rate: ${mnq.win_rate||'0.0%'} | PnL: ${mnq.pnlR||'0.00'}R`,
      `TP1: ${mnq.tp1Hits||0} | TP2: ${mnq.tp2Hits||0} | TP3: ${mnq.tp3Hits||0} | SL: ${mnq.slHits||0}`,
      `Esta semana: ${mnq.this_week?.total||0} trades | ${mnq.this_week?.win_rate||'0.0%'} WR`,
      ``,
      `**Operaciones activas:** ${Object.keys(activeTrades).length}`,
      `📊 *Win Rate = Wins / (Wins + Losses). Las BE del histórico antiguo no cuentan.*`,
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
      return `\`${id}\` — **${t.asset} ${t.direction}** | Entrada: ${t.entry} | SL: ${t.sl} | TP1: ${t.tp1}${t.tp1Hit?' ✅':''} | TP3: ${t.tp3}`;
    });
    await interaction.reply({ embeds: [{ color:0xD4E600,
      description:`## ⚡ OPERACIONES ACTIVAS\n\n${lines.join('\n')}\n\n*Usa /cerrar id:<ID> para cerrar una manualmente si se queda colgada.*`,
      footer:{text:'DTC · Monitor en tiempo real'}, timestamp:new Date().toISOString() }] });
  }

  else if (interaction.commandName === 'cerrar') {
    const id = interaction.options.getString('id');
    const t = activeTrades[id];
    if (!t) {
      await interaction.reply({ content: `❌ No encuentro ninguna operación activa con ID \`${id}\`. Usa /activas para ver los IDs disponibles.`, ephemeral:true });
      return;
    }
    delete activeTrades[id];
    await syncActiveTradesToSheet();
    await interaction.reply({ content: `✅ Operación \`${id}\` (${t.asset} ${t.direction}) cerrada manualmente. No se ha registrado ningún resultado ni se ha escrito nada en el Google Sheet.`, ephemeral:true });
  }

  else if (interaction.commandName === 'cerrartodas') {
    const ids = Object.keys(activeTrades);
    if (ids.length === 0) {
      await interaction.reply({ content: '✅ No hay ninguna operación activa que cerrar.', ephemeral:true });
      return;
    }
    const resumen = ids.map(id => `\`${id}\` — ${activeTrades[id].asset} ${activeTrades[id].direction}`).join('\n');
    for (const id of ids) delete activeTrades[id];
    await syncActiveTradesToSheet();
    await interaction.reply({ content: `✅ Se han cerrado ${ids.length} operación(es) manualmente. No se ha registrado ningún resultado ni se ha escrito nada en el Google Sheet.\n\n${resumen}`, ephemeral:true });
  }
});
client.login(DISCORD_TOKEN);

const COLOR_WARN=0xD4E600, COLOR_LONG=0x00C853, COLOR_SHORT=0xFF3B5C;
const COLOR_SL=0xFF0000, COLOR_TP1=0x00E676, COLOR_TP2=0x00C853;
const COLOR_TP3=0xFFD700, COLOR_STATS=0x00BFFF, COLOR_LOCKED=0x00E676;

// ── Precio actual ─────────────────────────────────────────────
// IMPORTANTE: esta función NUNCA debe lanzar/rechazar — si algo falla
// (símbolo no disponible en el plan, red caída, JSON inválido, etc.)
// tiene que devolver null en vez de tirar el proceso entero abajo.
async function getCurrentPrice(asset) {
  return new Promise((resolve) => {
    try {
      const https = require('https');
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
            else { console.error(`⚠️ Price error (${asset}): ${data}`); resolve(null); }
          } catch(e) { console.error('Price parse error:', e.message); resolve(null); }
        });
      }).on('error', (e) => { console.error('Price request error:', e.message); resolve(null); });
    } catch(e) {
      console.error('Price error:', e.message);
      resolve(null);
    }
  });
}

// ── Registrar resultado ───────────────────────────────────────
// Solo existen dos resultados posibles: WIN o LOSS. No hay BE.
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
// Regla clave: si el precio ya tocó algún TP y luego retrocede hasta el SL
// original, la operación se cuenta como GANADORA (con el R del último TP
// alcanzado), nunca como perdedora. El SL solo cuenta como derrota real
// si se toca ANTES de tocar cualquier TP.
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
       try {
        const trade = activeTrades[id];
        if (!trade || trade.asset !== asset) continue;
        const isLong = trade.direction === 'LONG';
        const channel = await client.channels.fetch(trade.channelId).catch(() => null);
        if (!channel) continue;

        // SL / cierre tras haber tocado algún TP
        if (!trade.slHit && (isLong ? price <= trade.sl : price >= trade.sl)) {
          trade.slHit = true;

          if (trade.tp1Hit) {
            // Ya había tocado al menos TP1 → se cuenta como GANADORA
            const rUsed = trade.tp3Hit ? trade.rr3 : (trade.tp2Hit ? trade.rr2 : trade.rr1);
            await channel.send({ embeds: [{
              color: COLOR_LOCKED,
              description: `## 🔒 CIERRE ASEGURADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n\nYa había tocado ${trade.tp3Hit?'TP2':'TP1'} antes de volver al nivel de SL — cuenta como **operación GANADORA (+${rUsed}R)**, no como pérdida.\n*— Despierta Tu Capital (DTC)*`,
              footer: { text: 'DTC · Gestión de posición' }, timestamp: new Date().toISOString()
            }]});
            await recordResult(trade, 'WIN', rUsed);
          } else {
            // SL directo, sin haber tocado ningún TP → derrota real
            getStats(trade.asset).slHits++;
            await channel.send({ embeds: [{
              color: COLOR_SL,
              description: `## 🛑 STOP LOSS TOCADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**SL:** \`${trade.sl}\`\n\n*Operación cerrada con pérdida. −1R*\n*— Despierta Tu Capital (DTC)*`,
              footer: { text: 'DTC · Gestión de riesgo' }, timestamp: new Date().toISOString()
            }]});
            await recordResult(trade, 'LOSS', -1);
          }
          delete activeTrades[id]; await syncActiveTradesToSheet(); continue;
        }

        // TP1
        if (!trade.tp1Hit && trade.tp1 && (isLong ? price >= trade.tp1 : price <= trade.tp1)) {
          trade.tp1Hit = true; getStats(trade.asset).tp1Hits++;
          await channel.send({ embeds: [{
            color: COLOR_TP1,
            description: `## 🟢 TP1 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP1:** \`${trade.tp1}\`  *(RR 1:${trade.rr1})*\n\n✅ *A partir de aquí, aunque vuelva al SL, ya cuenta como GANADORA.*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Gestión de posición' }, timestamp: new Date().toISOString()
          }]});
          await syncActiveTradesToSheet();
        }

        // TP2
        if (trade.tp1Hit && !trade.tp2Hit && trade.tp2 && (isLong ? price >= trade.tp2 : price <= trade.tp2)) {
          trade.tp2Hit = true; getStats(trade.asset).tp2Hits++;
          await channel.send({ embeds: [{
            color: COLOR_TP2,
            description: `## 🟡 TP2 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP2:** \`${trade.tp2}\`  *(RR 1:${trade.rr2})*\n\n✅ *Cierra otro parcial. SL en BE o TP1.*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Gestión de posición' }, timestamp: new Date().toISOString()
          }]});
          await syncActiveTradesToSheet();
        }

        // TP3
        if (trade.tp2Hit && !trade.tp3Hit && trade.tp3 && (isLong ? price >= trade.tp3 : price <= trade.tp3)) {
          trade.tp3Hit = true; getStats(trade.asset).tp3Hits++;
          await channel.send({ embeds: [{
            color: COLOR_TP3,
            description: `## 🏆 TP3 ALCANZADO — ${asset} ${trade.direction}\n\n**Precio:** \`${price}\`\n**TP3:** \`${trade.tp3}\`  *(RR 1:${trade.rr3})*\n\n🎯 *Objetivo final completado.*\n*— Despierta Tu Capital (DTC)*`,
            footer: { text: 'DTC · Objetivo completado' }, timestamp: new Date().toISOString()
          }]});
          await recordResult(trade, 'WIN', trade.rr3);
          delete activeTrades[id]; await syncActiveTradesToSheet();
        }
       } catch(e) {
         console.error(`⚠️ Error monitorizando trade ${id}:`, e.message);
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
      const decided = s.wins + s.losses;
      const wr  = decided>0 ? Math.round(s.wins/decided*100) : 0;
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
        `🛑 SL tocados (derrota real): ${st.slHits}`,``,
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
      const rr1F = parseFloat(rr1) || 0.75;
      const rr2F = parseFloat(rr2) || (isFuture?1.25:1.75);
      const rr3F = parseFloat(rr3) || parseFloat(rr) || (isFuture?1.8:2.74);

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
        const id = `trade_${Date.now()}`;
        activeTrades[id] = {
          id, asset, direction, entry:parseFloat(entry),
          sl:slF, tp1:tp1F, tp2:tp2F, tp3:tp3F,
          rr1:rr1F, rr2:rr2F, rr3:rr3F,
          tp1Hit:false, tp2Hit:false, tp3Hit:false, slHit:false,
          channelId, score: score||'', openTime:new Date().toISOString()
        };
        console.log(`📋 Trade guardado: ${id} | ${asset} ${direction}`);
        await syncActiveTradesToSheet();
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
    const xau = await readStatsFromSheet('XAUUSD');
    const mnq = await readStatsFromSheet('MNQU26');
    res.json({
      source: 'Google Sheets (histórico permanente, pestañas auto-detectadas por activo)',
      note: 'win_rate = wins / (wins + losses). Los BE del histórico antiguo no cuentan.',
      active_trades: Object.keys(activeTrades).length,
      XAUUSD: xau || { error: 'Sin datos aún' },
      MNQU26: mnq || { error: 'Sin datos aún' }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug-sheets', async (req, res) => {
  try {
    const titles = await getSheetTitles();
    const xauTab = await resolveTabName('XAUUSD');
    const mnqTab = await resolveTabName('MNQU26');
    res.json({ titles_found: titles, XAUUSD_resolves_to: xauTab, MNQU26_resolves_to: mnqTab });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req,res) => res.json({
  status:'✅ DTC Signals Bot running',
  cooldown_min:COOLDOWN_MIN,
  active_trades:Object.keys(activeTrades).length,
  stats_url:'/stats',
  debug_url:'/debug-sheets'
}));

app.post('/weekly', async (req,res) => {
  if (req.query.key!==SECRET_KEY) return res.status(401).json({error:'Unauthorized'});
  await sendWeeklyReport();
  res.json({ok:true});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));
