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
| 🏦 Vault management | View positions and withdraw anytime |

---

## Quick Start

```bash
git clone https://github.com/cryptohakka/vaulthoric
cd vaulthoric
npm install
cp .env.example .env
# Add PRIVATE_KEY and OPENROUTER_API_KEY to .env
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

Scans all chains for USDC → shows balances → lets you pick target chain → bridges everything → deposits into vault of your choice (Safest / Best / Highest yield).

### Withdraw

```bash
node withdraw.js
```

Shows all vault positions → select position → withdraw all or custom amount.

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
| `net_apy` | APY minus estimated gas cost |
| `stability` | Coefficient of variation across apy1d / apy7d / apy30d (lower variance = higher score) |
| `tvl_bonus` | log10 of TVL above $1M threshold |
| `trust` | Protocol trust multiplier (aave=1.3, morpho=1.25, ... neverland=0.9) |
| `penalty` | Deductions for KYC requirements or time locks |

A vault showing 20% APY for one day scores lower than a vault at 6% APY with rock-solid stability across 30 days.

---

## Architecture

```
vaulthoric/
├── ask.js          # Natural language interface (LLM → params → deposit)
├── agent.js        # CLI: scan / balance / allocate
├── consolidate.js  # Multi-chain sweep → bridge → vault deposit
├── withdraw.js     # Position viewer & withdrawal
├── earn.js         # LI.FI Earn API wrapper (vault discovery)
├── scorer.js       # Risk-adjusted scoring engine
├── composer.js     # LI.FI Composer API + direct ERC-4626 deposit
├── tools.js        # Chain config, RPC fallback, USDC addresses
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
      ├─→ scorer.js     ← Risk-adjusted ranking
      │
      ▼
  composer.js
      │
      ├─→ LI.FI Composer API  (bridge + deposit quote)
      │
      ├─→ ERC-4626 redeem/deposit  (direct, no bridge needed)
      │
      └─→ Aave Pool withdraw       (protocol-specific)
```

### Deposit Strategy (composer.js)

Composer uses a tiered fallback strategy:

1. **LI.FI Composer quote** — handles routing, bridging, and deposit in one tx
2. **Direct ERC-4626 deposit** — if LI.FI quote exceeds gas threshold or returns 404
3. **Aave Pool direct withdraw** — for aave-zaps and neverland-zaps protocol packs
4. **Cross-chain fallback** — bridge first, then direct deposit on destination chain

### Vault Selection Modes

| Mode | Sort by |
|---|---|
| `safest` | `stability × trust` |
| `best` | risk-adjusted `score` (default) |
| `highest` | raw `apy` |

All modes skip vaults that fail on deposit (auto-fallback to next candidate).

---

## Environment Variables

```env
PRIVATE_KEY=0x...
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=google/gemini-flash-1.5   # optional
LIFI_API_KEY=                              # optional, increases rate limits

# Optional RPC overrides
RPC_BASE=https://mainnet.base.org
RPC_ARB=https://arb1.arbitrum.io/rpc
RPC_MONAD=https://rpc.monad.xyz
# ... etc
```

---

## Roadmap

- [ ] **Rebalance** — Monitor positions and auto-switch to better vault when score improvement exceeds threshold (same chain, same asset)
- [ ] **Auto-compound** — Periodic harvest and re-deposit of yield
- [ ] **Multi-asset support** — ETH, WBTC, stablecoins beyond USDC
- [ ] **Telegram / Discord interface** — Natural language via chat
- [ ] **Position dashboard** — Web UI for portfolio overview

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
