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
| 📡 Monitor | Periodic cron job that watches positions and alerts via Discord |
| 🖥️ Web UI | Real-time dashboard at `vaulthoric.a2aflow.space` |
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
# Scan top risk-adjusted vaults
node agent.js scan USDC

# Check wallet balance
node agent.js balance 8453

# Auto-allocate to best vault (dry run)
node agent.js allocate 8453 100

# Execute
node agent.js allocate 8453 100 --execute
```

### Consolidate (Multi-chain → One Vault)

```bash
node consolidate.js
```

Scans all chains for USDC → shows balances → lets you pick target chain → bridges everything in parallel → deposits into vault of your choice (Safest / Best / Highest yield). Target chain is suggested based on actual deposit amount, not a fixed default.

```bash
# Dry run — fetch bridge quotes without executing
node consolidate.js --dry-run

# Non-interactive
node consolidate.js --auto
```

### Rebalance

```bash
# Interactive — shows positions, prompts for selection
node rebalance.js

# Natural language — LLM parses vault names
node rebalance.js "CSUSDC to STEAKUSDC"
node rebalance.js "CSUSDC to best"
node rebalance.js "scope:all to highest"   # cross-chain rebalance

# Non-interactive (used by monitor auto-rebalance)
node rebalance.js "CSUSDC to 0xVaultAddress" --auto
```

Withdraws from the selected position → waits for USDC to arrive → deposits into the target vault. Only triggers if APY improvement exceeds 0.1% (or 0% when a specific target is given).

### Monitor

```bash
node monitor.js
```

Checks all tracked positions against current vault rankings. Sends a Discord embed when a better opportunity is found, including AI-generated analysis of why switching is recommended.

**Set up as a cron job:**

```bash
# Check every 30 minutes
*/30 * * * * cd ~/vaulthoric && node monitor.js >> /tmp/vaulthoric-monitor.log 2>&1
```

**Auto-rebalance mode** — set `AUTO_REBALANCE=true` in `.env` to automatically execute same-chain rebalances without manual confirmation. Cross-chain rebalances always require manual approval.

Notification thresholds:
- Same-chain: +0.5% APY improvement
- Cross-chain: +2.0% APY improvement (accounts for bridge cost and risk)

### Withdraw

```bash
node withdraw.js
```

Shows all vault positions → select position → withdraw all or custom amount.

### Web UI

Vaulthoric includes a real-time web dashboard powered by Express + SSE.

```bash
# Start the server (also starts monitor loop)
node server.js

# Or via Docker
docker compose up -d
```

The UI is available at `http://localhost:5000` (or `vaulthoric.a2aflow.space` if deployed). Features:

- **Yield tab** — natural language deposit interface with streaming output
- **Monitor tab** — live position monitoring log
- **History tab** — past actions
- **Sidebar** — current positions with balance, USD value, and APY; quick-action buttons

The production deployment uses nginx with Basic Auth and Cloudflare SSL (Full mode).

---

## Supported Chains

Ethereum, Optimism, Polygon, Base, Arbitrum, Avalanche, BSC, Linea, Scroll, Unichain, Sonic, Mantle, Monad

## Supported Protocols

aave-v3, morpho-v1, euler-v2, ether.fi, pendle, ethena, maple, upshift, yo-protocol, neverland

---

## How the Scoring Works

Vaulthoric uses a risk-adjusted score — not just raw APY — to select vaults:

```
score = net_apy × stability × (1 + tvl_bonus) × trust × penalty
```

| Factor | What it measures |
|---|---|
| `net_apy` | APY minus estimated gas cost, calculated against actual deposit amount |
| `stability` | Coefficient of variation across apy1d / apy7d / apy30d (lower variance = higher score) |
| `tvl_bonus` | log10 of TVL above $1M threshold |
| `trust` | Protocol trust multiplier (aave=1.3, morpho=1.25, ... neverland=0.9) |
| `penalty` | Deductions for KYC requirements or time locks |

A vault showing 20% APY for one day scores lower than a vault at 6% APY with rock-solid stability across 30 days. Gas costs are evaluated against the actual deposit amount — a $10 deposit will correctly penalise Ethereum-mainnet vaults even if their APY is competitive.

---

## Architecture

```
vaulthoric/
├── server.js       # Express server + SSE (Web UI backend)
├── public/         # Web UI frontend (index.html, CSS, JS)
├── ask.js          # Natural language interface (LLM → params → deposit)
├── agent.js        # CLI: scan / balance / allocate
├── consolidate.js  # Multi-chain sweep → bridge → vault deposit
├── rebalance.js    # Withdraw from current vault → deposit into better vault
├── monitor.js      # Cron-based position monitor with Discord alerts
├── withdraw.js     # Position viewer & withdrawal
├── earn.js         # LI.FI Earn API wrapper (vault discovery)
├── scorer.js       # Risk-adjusted scoring engine
├── composer.js     # LI.FI Composer API + direct ERC-4626 deposit
├── tools.js        # Chain config, RPC fallback, USDC addresses, position I/O
└── positions.json  # Local position tracking
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
      ├─→ scorer.js     ← Risk-adjusted ranking (actual deposit amount)
      │
      ▼
  composer.js
      │
      ├─→ LI.FI Composer API  (bridge + deposit quote)
      │
      ├─→ ERC-4626 redeem/deposit  (direct, no bridge needed)
      │
      └─→ Aave Pool withdraw       (protocol-specific)

monitor.js (cron)
      │
      ├─→ earn.js + scorer.js  ← re-rank all positions
      │
      ├─→ Discord webhook      ← notify if better vault found
      │
      └─→ rebalance.js --auto  ← execute if AUTO_REBALANCE=true (same-chain only)

server.js (Web UI)
      │
      ├─→ SSE stream           ← real-time output to browser
      │
      ├─→ ask / rebalance / withdraw / consolidate  ← subprocess execution
      │
      └─→ /api/positions       ← live position data with APY enrichment
```

### Deposit Strategy (composer.js)

Composer selects a deposit path based on the vault's protocol pack:

1. **Aave Pool direct** — `aave-zaps` / `neverland-zaps` (LI.FI Composer does not support these protocols)
2. **Direct ERC-4626 deposit** — `morpho-zaps` and other known packs
3. **LI.FI Composer quote** — unknown packs; handles routing, bridging, and deposit in one tx
4. **Cross-chain fallback** — if Composer fails, bridge via LI.FI then direct deposit on destination chain

Gas cost is compared against deposit value before execution. If gas exceeds `GAS_FALLBACK_THRESHOLD_USD` ($0.05 default), Vaulthoric falls back to direct deposit over LI.FI Composer.

### Vault Selection Modes

| Mode | Sort by |
|---|---|
| `safest` | `stability × trust` |
| `best` | risk-adjusted `score` (default) |
| `highest` | raw `apy` |

All modes skip vaults that fail `estimateGas` and automatically fall back to the next candidate.

---

## Environment Variables

```env
PRIVATE_KEY=0x...
WALLET_ADDRESS=0x...          # used by Web UI position scanner
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=google/gemini-2.5-flash-lite   # optional
LIFI_API_KEY=                                    # optional, increases rate limits

# Monitor
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
AUTO_REBALANCE=false          # set to true to auto-execute same-chain rebalances

# Gas threshold for direct deposit fallback
GAS_FALLBACK_THRESHOLD_USD=0.05
```

---

## Known Limitations

- **LI.FI Earn API `isTransactional` field is unreliable** — the API may return vaults with paused or broken deposits regardless of this flag. Vaulthoric handles this via `estimateGas` pre-check and automatic fallback to the next candidate.
- **Morpho warning vaults not filtered** — vaults flagged with warnings (e.g. bad debt events) in the Morpho API are not automatically excluded. They may still appear in results and will be caught by the `estimateGas` fallback if deposits are paused.
- **Cross-chain auto-rebalance not supported** — `AUTO_REBALANCE=true` only executes same-chain rebalances. Cross-chain opportunities are notified via Discord but require manual execution.
- **Position tracking is local** — `positions.json` is written on the VPS running Vaulthoric. Positions opened outside of Vaulthoric (e.g. via Jumper directly) are not tracked unless added manually.
- **Ghost positions in positions.json** — positions with zero balance are not automatically removed. They remain until a successful withdraw is detected. The Web UI APY enrichment will show stale data for these entries.

---

## Roadmap

- [x] **Rebalance** — Withdraw from current vault and re-deposit into better vault (same-chain, natural language, `--auto` flag)
- [x] **Monitor** — Cron-based position monitor with Discord alerts and auto-rebalance
- [x] **Position dashboard** — Web UI with real-time streaming output and position viewer
- [ ] **Auto-compound** — Periodic harvest and re-deposit of yield
- [ ] **Multi-asset support** — ETH, WBTC, stablecoins beyond USDC
- [ ] **Telegram / Discord interface** — Natural language via chat

---

## Built With

- [LI.FI Earn API](https://earn.li.fi) — Vault discovery across 20+ protocols
- [LI.FI Composer API](https://li.quest/v1) — Cross-chain routing and deposit
- [ethers.js v6](https://docs.ethers.org) — On-chain interactions
- [OpenRouter](https://openrouter.ai) — LLM for natural language parsing (Gemini Flash)

---

## License

MIT

---

*Vaulthoric — because finding the right vault shouldn't feel like a second job.*
