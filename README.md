# Vaulthoric

**AI-powered yield vault optimizer for DeFi.** Tell it where your USDC is, and Vaulthoric finds, evaluates, and deposits into the best vault — automatically.

> *Stay Vaulthoric.*

---

## The Problem

Jumper's vault feature covers 20+ protocols across 60+ chains. That's powerful — but also overwhelming. Which vault is actually the best? Is that 12% APY sustainable or a one-day spike? Should you bridge to another chain for a better rate?

**Vaulthoric answers these questions automatically.**

---

## What It Does

| Feature | Description |
|---|---|
| 🧠 Natural language deposit | `"put my USDC into the safest vault above 5% APY on Arbitrum"` |
| ⚖️ Risk-adjusted scoring | APY stability + TVL + protocol trust, not just raw APY |
| 🌉 Auto-bridge | Moves assets cross-chain to higher-yield opportunities |
| 📦 Consolidate | Sweeps USDC from all chains into one vault in a single flow |
| 🔄 Rebalance | Withdraw from current vault and re-deposit into a better one |
| 📡 Monitor | Periodic cron job that watches positions and alerts via Discord with AI analysis |
| 🖥️ Web UI | Real-time dashboard — Yield / Monitor / History tabs |
| 📜 Transaction History | Full audit log of all deposits, withdrawals, rebalances, and consolidations |
| 🏦 Vault management | View positions and withdraw anytime |

---

## Quick Start

```bash
git clone https://github.com/cryptohakka/vaulthoric
cd vaulthoric
npm install
cp .env.example .env
# Add PRIVATE_KEY, WALLET_ADDRESS, and OPENROUTER_API_KEY to .env
```

### Natural Language Deposit

```bash
node ask.js "put my USDC into the safest vault above 5% APY on Arbitrum"
node ask.js "find the highest yield USDC vault on Base"
node ask.js "deposit 100 USDC into a stable vault"
```

### Scan & Allocate

```bash
node agent.js scan USDC
node agent.js balance 8453
node agent.js allocate 8453 100
node agent.js allocate 8453 100 --execute
```

### Consolidate (Multi-chain → One Vault)

```bash
node consolidate.js
```

Scans all chains for USDC → shows balances → lets you pick target chain → bridges everything in parallel → deposits into the vault of your choice (Safest / Best / Highest yield). Each bridge and deposit step is recorded in `tx_history.json`.

```bash
node consolidate.js --dry-run   # fetch bridge quotes without executing
node consolidate.js --auto      # non-interactive
```

### Rebalance

```bash
node rebalance.js
node rebalance.js "CSUSDC to STEAKUSDC"
node rebalance.js "CSUSDC to best"
node rebalance.js "scope:all to highest"   # cross-chain
node rebalance.js "CSUSDC to 0xVaultAddress" --auto
```

Withdraws from the selected position → waits for USDC → deposits into target vault. Only triggers if APY improvement exceeds 0.1% (or 0% when a specific target is given).

### Monitor

```bash
node monitor.js
```

Checks all tracked positions against current vault rankings. Sends a Discord embed when a better opportunity is found, including AI-generated analysis. Logs each run to `monitor.log`, visible in the Web UI Monitor tab.

```bash
*/30 * * * * cd ~/vaulthoric && node monitor.js >> /tmp/vaulthoric-monitor.log 2>&1
```

Set `AUTO_REBALANCE=true` to auto-execute same-chain rebalances. Cross-chain always requires manual approval.

Notification thresholds:
- Same-chain: +0.5% APY improvement
- Cross-chain: +2.0% APY improvement

### Withdraw

```bash
node withdraw.js
```

Shows all vault positions → select position → withdraw all or custom amount.

### Web UI

```bash
node server.js        # local
docker compose up -d  # production
```

Available at `http://localhost:5000` (or `vaulthoric.a2aflow.space` if deployed).

**Tabs:**
- **Yield** — natural language deposit with streaming output
- **Monitor** — live position monitoring log with AI analysis cards
- **History** — transaction history with type badges, chain names, USD values, and explorer links
- **Sidebar** — current positions with balance, USD value, and APY; quick-action buttons

---

## Supported Chains

Ethereum, Optimism, Polygon, Base, Arbitrum, Avalanche, BSC, Linea, Scroll, Unichain, Sonic, Mantle, Monad

## Supported Protocols

aave-v3, morpho-v1, euler-v2, ether.fi, pendle, ethena, maple, upshift, yo-protocol, neverland

---

## How the Scoring Works

```
score = net_apy × stability × (1 + tvl_bonus) × trust × penalty
```

| Factor | What it measures |
|---|---|
| `net_apy` | APY minus estimated gas cost, calculated against actual deposit amount |
| `stability` | Coefficient of variation across apy1d / apy7d / apy30d |
| `tvl_bonus` | log10 of TVL above $1M threshold |
| `trust` | Protocol trust multiplier (aave=1.3, morpho=1.25, ... neverland=0.9) |
| `penalty` | Deductions for KYC requirements or time locks |

A vault showing 20% APY for one day scores lower than a vault at 6% APY with 30-day stability.

### Vault Selection Modes

| Mode | Sort by |
|---|---|
| `safest` | `stability × trust` |
| `best` | risk-adjusted `score` (default) |
| `highest` | raw `apy` |

---

## Architecture

```
vaulthoric/
├── server.js       # Express server + SSE (Web UI backend)
├── public/         # Web UI frontend (index.html)
├── ask.js          # Natural language interface (LLM → params → deposit)
├── agent.js        # CLI: scan / balance / allocate
├── consolidate.js  # Multi-chain sweep → bridge → vault deposit
├── rebalance.js    # Withdraw → deposit into better vault
├── monitor.js      # Cron-based position monitor with Discord alerts
├── withdraw.js     # Position viewer & withdrawal
├── earn.js         # LI.FI Earn API wrapper (vault discovery)
├── scorer.js       # Risk-adjusted scoring engine
├── composer.js     # LI.FI Composer API + direct ERC-4626 deposit
├── tools.js        # Chain config, RPC fallback, USDC addresses, position I/O, tx recording
├── positions.json  # Live position tracking (auto-updated on deposit/withdraw)
├── tx_history.json # Full transaction audit log
└── monitor.log     # Monitor run history with AI analysis
```

### Flow Diagram

```
User Instruction
      │
      ▼
  ask.js (LLM parse)
      │
      ├─→ earn.js       ← LI.FI Earn API (vault discovery)
      │       │
      │       ▼
      ├─→ scorer.js     ← Risk-adjusted ranking
      │
      ▼
  composer.js
      │
      ├─→ LI.FI Composer API  (bridge + deposit in one tx)
      ├─→ ERC-4626 deposit    (direct, same-chain)
      └─→ Aave Pool supply    (protocol-specific)
            │
            ▼
        tools.js recordTx()  ← writes to tx_history.json

monitor.js (cron)
      │
      ├─→ earn.js + scorer.js  ← re-rank all positions
      ├─→ LLM AI analysis      ← explains why switching is recommended
      ├─→ Discord webhook       ← embed with AI analysis
      ├─→ monitor.log           ← structured run log
      └─→ rebalance.js --auto  ← if AUTO_REBALANCE=true (same-chain only)

server.js (Web UI)
      │
      ├─→ SSE stream           ← real-time output to browser
      ├─→ /api/monitor-log     ← parsed monitor.log for Monitor tab
      ├─→ /api/tx-history      ← tx_history.json for History tab
      └─→ /api/positions       ← live position data with APY enrichment
```

### Deposit Strategy (composer.js)

1. **Aave Pool direct** — `aave-zaps` / `neverland-zaps`
2. **Direct ERC-4626 deposit** — `morpho-zaps` and known packs
3. **LI.FI Composer quote** — unknown packs; handles routing + bridging + deposit
4. **Cross-chain fallback** — bridge via LI.FI then direct deposit on destination

If gas exceeds `GAS_FALLBACK_THRESHOLD_USD` ($0.05), falls back to direct deposit over Composer.

---

## Transaction History (`tx_history.json`)

Every action is recorded automatically:

| Type | Trigger |
|---|---|
| `deposit` | `ask.js` successful deposit |
| `withdraw` | `withdraw.js` successful withdrawal |
| `rebalance` | `rebalance.js` successful rebalance |
| `consolidate-bridge` | `consolidate.js` bridge step |
| `consolidate-deposit` | `consolidate.js` final vault deposit |

Each record includes: timestamp, vault name, chain, USD value, asset, and tx hash (with block explorer link in the Web UI).

---

## Environment Variables

```env
PRIVATE_KEY=0x...
WALLET_ADDRESS=0x...
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=google/gemini-2.5-flash-lite   # optional
LIFI_API_KEY=                                    # optional

# Monitor
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
AUTO_REBALANCE=false

# Gas threshold for direct deposit fallback
GAS_FALLBACK_THRESHOLD_USD=0.05
```

---

## Known Limitations

- **LI.FI Earn API `isTransactional` unreliable** — handled via `estimateGas` pre-check and automatic fallback
- **Morpho warning vaults not filtered** — will be caught by `estimateGas` fallback if deposits are paused
- **Cross-chain auto-rebalance not supported** — notified via Discord, requires manual execution
- **Position tracking is local** — `positions.json` only tracks positions opened through Vaulthoric
- **Ghost positions** — zero-balance positions remain until a successful withdraw is detected

---

## Roadmap

- [x] **Rebalance** — Withdraw and re-deposit into better vault (same-chain, natural language, `--auto`)
- [x] **Monitor** — Cron-based monitor with Discord alerts, AI analysis, and auto-rebalance
- [x] **Position dashboard** — Web UI with real-time streaming and position viewer
- [x] **Transaction history** — Full audit log with type badges, chain names, tx hashes, and explorer links
- [x] **Consolidate** — Multi-chain sweep into single vault with bridge + deposit tracking
- [ ] **Auto-compound** — Periodic harvest and re-deposit of yield
- [ ] **Multi-asset support** — ETH, WBTC, stablecoins beyond USDC
- [ ] **Telegram / Discord interface** — Natural language via chat
- [ ] **Wallet balance view** — Idle USDC across chains displayed in sidebar
- [ ] **Wallet connect** — Browser wallet support (MetaMask, WalletConnect)

---

## Built With

- [LI.FI Earn API](https://earn.li.fi) — Vault discovery across 20+ protocols
- [LI.FI Composer API](https://li.quest/v1) — Cross-chain routing and deposit
- [ethers.js v6](https://docs.ethers.org) — On-chain interactions
- [OpenRouter](https://openrouter.ai) — LLM for natural language parsing and AI analysis

---

## License

MIT

---

*Vaulthoric — because finding the right vault shouldn't feel like a second job.*
