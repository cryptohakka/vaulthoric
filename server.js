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

  let dotBuffer = '';
  child.stdout.on('data', (data) => {
    const raw = data.toString();
    // Accumulate dot progress lines and flush when done
    if (raw.includes('Scanning') || dotBuffer) {
      dotBuffer += raw;
      if (dotBuffer.includes('done')) {
        const collapsed = dotBuffer.replace(/\n/g, '').trim();
        broadcast('log', { text: collapsed });
        dotBuffer = '';
      }
      return;
    }
    const lines = raw.split('\n').filter(l => l.trim());
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
        if (current) runs.push(current);
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

      // Detect position being checked (current vault name)
      const posMatch = line.match(/Current APY: ([0-9.]+)%\s*\|\s*Best available: ([0-9.]+)%/);
      if (posMatch && current.aData) {
        current.aData.currentApy = posMatch[1];
        current.aData.bestApy = posMatch[2];
      }

      // Detect alert: both formats
      // Old: "Better vault found: NAME (+X%)" 
      // New: "Better vault found: NAME (0xaddr) +X%"
      if (line.includes('🚀 Better vault found')) {
        current.aData = current.aData || {};
        // New format: NAME (0xaddr…) +X%
        let m = line.match(/Better vault found: (.+?)\s*\(0x[^)]+\)\s*\+([0-9.]+)%/);
        if (!m) {
          // Old format: NAME (+X%)
          m = line.match(/Better vault found: (.+?)\s*\(\+([0-9.]+)%\)/);
        }
        if (m) {
          current.aData.betterName = m[1].trim();
          current.aData.improvement = m[2];
        }
      }

      // Cost line
      if (current.aData) {
        const c = line.match(/Est\. cost: (\$[0-9.]+ \([0-9.]+%[^)]+\))/);
        if (c) current.aData.cost = c[1];
        if (line.includes('✅') && line.includes('cost')) current.aData.efficient = true;
        if (line.includes('❌') && line.includes('cost')) current.aData.efficient = false;
        if (/cross.?chain/i.test(line)) current.aData.cross = true;
        const ai = line.match(/🤖 AI Analysis: (.+)/);
        if (ai) current.aData.aiAnalysis = ai[1].trim();
      }

      // "📨 Discord notification sent for VAULTNAME" — commit alert
      if (line.includes('📨 Discord notification sent')) {
        if (!current.aData) current.aData = {};
        // Extract vault name from "sent for VAULTNAME"
        const vn = line.match(/sent for (\S+)/);
        if (vn && !current.aData.currentName) current.aData.currentName = vn[1];
        current.alerts.push({ ...current.aData });
        current.aData = null;
      }
    }
    if (current) runs.push(current);
    runs.reverse(); // newest first

    // Clean up internal state field
    for (const r of runs) { delete r.aData; r.rawLines = r.rawLines.filter(Boolean); }

    const lastRun = runs[0]?.time || null;
    res.json({ runs: runs.slice(0, 48), lastRun }); // max 48 entries
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// TX History — read from tx_history.json
app.get('/api/tx-history', (req, res) => {
  try {
    const p = path.join(__dirname, 'tx_history.json');
    if (!fs.existsSync(p)) return res.json({ txs: [] });
    const txs = JSON.parse(fs.readFileSync(p, 'utf8'));
    const CHAIN_NAMES = {1:'Ethereum',8453:'Base',10:'Optimism',42161:'Arbitrum',137:'Polygon',59144:'Linea',534352:'Scroll',146:'Sonic',143:'Monad',5000:'Mantle'};
    const formatted = txs.map(t => {
      // from/to semantics by type:
      // deposit:     from=USDC (asset),       to=vault token
      // withdraw:    from=vault token,         to=USDC (asset)
      // rebalance:   from=fromVault,           to=toVault
      // consolidate: from=fromVault or chains, to=toVault
      let from, to;
      if (t.type === 'deposit') {
        from = t.asset || 'USDC';
        to   = t.toVault || '—';
      } else if (t.type === 'withdraw') {
        from = t.fromVault || '—';
        to   = t.asset || 'USDC';
      } else if (t.type === 'consolidate-bridge') {
        from = CHAIN_NAMES[t.fromChainId] || String(t.fromChainId || '—');
        to   = CHAIN_NAMES[t.toChainId]   || String(t.toChainId   || '—');
      } else if (t.type === 'consolidate-deposit') {
        from = t.asset || 'USDC';
        to   = t.toVault || '—';
      } else if (t.type === 'rebalance-withdraw') {
        from = t.fromVault || '—';
        to   = t.asset || 'USDC';
      } else if (t.type === 'rebalance-deposit') {
        from = t.asset || 'USDC';
        to   = t.toVault || '—';
      } else if (t.type === 'consolidate') {
        from = t.fromVault || (t.fromChainId ? (CHAIN_NAMES[t.fromChainId] || String(t.fromChainId)) : '—');
        to   = t.toVault   || (t.toChainId   ? (CHAIN_NAMES[t.toChainId]   || String(t.toChainId))   : '—');
      } else {
        from = t.fromVault || '—';
        to   = t.toVault   || '—';
      }
      const chainId = t.chainId || t.fromChainId || t.toChainId || null;
      return {
        time: t.time ? new Date(t.time).toLocaleString('ja-JP', { timeZone: 'Asia/Tbilisi', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—',
        from,
        to,
        chain: chainId,
        chainName: CHAIN_NAMES[chainId] || String(chainId || '—'),
        value: t.valueUsd ? String(t.valueUsd) : null,
        txHash:   t.txHash    || null,
        txHash2:  t.txHash2   || null,
        protocol: t.protocol  || null,
        type: t.type || 'tx',
      };
    });
    res.json({ txs: formatted.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
