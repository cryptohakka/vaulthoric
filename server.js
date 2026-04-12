// Vaulthoric — Web UI Server
// Express server with SSE for real-time log streaming

require('dotenv').config();

const express    = require('express');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.UI_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE Client Registry ──────────────────────────────────────────────────────

const clients = new Set();

function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ─── SSE Endpoint ─────────────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // heartbeat
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
  }, 15000);

  clients.add(res);
  req.on('close', () => { clients.delete(res); clearInterval(hb); });
});

// ─── Run Script Helper ────────────────────────────────────────────────────────

function runScript(scriptName, args = []) {
  const child = spawn('node', [path.join(__dirname, scriptName), ...args], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  broadcast('start', { script: scriptName, args });

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      broadcast('log', { line });
      console.log(`[${scriptName}]`, line);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      // suppress ethers/RPC noise
      if (line.includes('NETWORK_ERROR') || line.includes('eth_') || line.includes('WebSocket')) continue;
      broadcast('log', { line: `⚠️ ${line}` });
    }
  });

  child.on('close', (code) => {
    broadcast('done', { script: scriptName, code });
  });

  child.on('error', (err) => {
    broadcast('error', { message: err.message });
  });

  return child;
}

// ─── API Endpoints ────────────────────────────────────────────────────────────

// Monitor — check all positions
app.post('/api/monitor', (req, res) => {
  runScript('monitor.js');
  res.json({ ok: true });
});

// Ask — natural language deposit
app.post('/api/ask', (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  runScript('ask.js', [query, '--auto']);
  res.json({ ok: true });
});

// Rebalance — natural language or address
app.post('/api/rebalance', (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  runScript('rebalance.js', [query, '--auto']);
  res.json({ ok: true });
});

// Consolidate — bridge all to best vault
app.post('/api/consolidate', (req, res) => {
  const { target, dryRun } = req.body;
  const args = target ? [target] : ['--all'];
  if (dryRun) args.push('--dry-run');
  args.push('--auto');
  runScript('consolidate.js', args);
  res.json({ ok: true });
});

// Withdraw
app.post('/api/withdraw', (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  const posName = query.replace(/^withdraw\s+(all\s+from\s+|from\s+)?/i, '').trim();
  runScript('withdraw.js', [posName, '--auto']);
  res.json({ ok: true });
});

// Monitor log — parse monitor.log into structured run history
app.get('/api/monitor-log', (req, res) => {
  try {
    const logPath = path.join(__dirname, 'monitor.log');
    if (!fs.existsSync(logPath)) return res.json({ runs: [], lastRun: null });

    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n');

    // Split into runs by detecting "🤖 Vaulthoric Monitor —" header lines
    const runs = [];
    let current = null;

    for (const line of lines) {
      if (line.includes('🤖 Vaulthoric Monitor —')) {
        if (current) runs.unshift(current); // prepend so newest first
        const timeMatch = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.Z]+)/);
        const rawTime = timeMatch ? new Date(timeMatch[1]) : null;
        current = {
          time: rawTime ? rawTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tbilisi', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—',
          alerts: [],
          rawLines: [],
          aData: null,
        };
      }
      if (!current) continue;
      current.rawLines.push(line);

      // Detect alert start
      if (line.includes('🚀 Better vault found')) {
        current.aData = {};
        const m = line.match(/Better vault found: (.+?) \(/);
        if (m) current.aData.betterName = m[1];
        const imp = line.match(/\+([0-9.]+)%/);
        if (imp) current.aData.improvement = imp[1];
      }
      if (current.aData) {
        const c = line.match(/Est\. cost: (\$[0-9.]+ \([0-9.]+%[^)]+\))/);
        if (c) current.aData.cost = c[1];
        if (line.includes('✅') && line.includes('cost')) current.aData.efficient = true;
        if (line.includes('❌') && line.includes('cost')) current.aData.efficient = false;
        if (/cross.?chain/i.test(line)) current.aData.cross = true;
      }
      if (line.includes('📨 Discord notification sent') && current.aData) {
        current.alerts.push({
          ...current.aData,
          query: current.aData.betterName ? `best to ${current.aData.betterName}` : 'best',
        });
        current.aData = null;
      }
    }
    if (current) runs.unshift(current);

    // Clean up internal state field
    for (const r of runs) { delete r.aData; r.rawLines = r.rawLines.filter(Boolean); }

    const lastRun = runs[0]?.time || null;
    res.json({ runs: runs.slice(0, 48), lastRun }); // max 48 entries
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Positions — scan live balances and clean up positions.json
const { scanPositions } = require('./withdraw');
const { getVault } = require('./earn');
let _posCache = null, _posCacheAt = 0;
const POS_TTL = 60_000; // 60s cache
app.get('/api/positions', async (req, res) => {
  try {
    const wallet = process.env.WALLET_ADDRESS;
    if (!wallet) return res.json([]);
    const now = Date.now();
    if (_posCache && (now - _posCacheAt) < POS_TTL) return res.json(_posCache);
    const positions = await scanPositions(wallet);
    // Enrich with live APY from LI.FI Earn API
    await Promise.all(positions.map(async p => {
      try {
        const v = await getVault(p.chainId, p.vaultAddress);
        p.apy = v?.analytics?.apy?.total ?? 0;
      } catch { p.apy = 0; }
    }));
    _posCache = JSON.parse(JSON.stringify(positions, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    _posCacheAt = now;
    res.json(_posCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🏦 Vaulthoric UI → http://localhost:${PORT}`);
});
