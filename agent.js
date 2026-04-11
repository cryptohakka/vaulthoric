// Vaulthoric — Core Agent
// Vault scanning, portfolio display, balance checks, and auto-allocation.
// Also exports shared UI helpers (printVaultTable) used by ask.js.

require('dotenv').config();

const { ethers } = require('ethers');
const { getVaults, getPortfolio } = require('./earn');
const { rankVaults } = require('./scorer');
const { depositToVault, getTokenBalance } = require('./composer');
const {
  getChainName,
  getChainRpc,
  getUsdcAddress,
  getSupportedChainIds,
  getProviderWithFallback,
} = require('./tools');

// ─── Provider / Signer ────────────────────────────────────────────────────────

function getProvider(chainId) {
  const rpc = getChainRpc(chainId);
  if (!rpc) throw new Error(`No RPC for chainId ${chainId}`);
  return new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
}

function getSigner(chainId) {
  const provider = getProvider(chainId);
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set in .env');
  return new ethers.Wallet(pk, provider);
}

// ─── Vault Table ──────────────────────────────────────────────────────────────

function printVaultTable(ranked, topN = 10, amountUsd = 1000) {
  const rows   = ranked.slice(0, topN);
  const header = ['Rank', 'Score※1', 'APY%', 'Net APY%※2', 'Stability※3', 'TVL', 'Trust※4', 'Gas+Bridge', 'Net Yield/yr', 'Protocol', 'Network'];
  const data   = rows.map((v, i) => [
    `#${i + 1}`,
    v.score.toFixed(2),
    v.apy.toFixed(2) + '%',
    v.netApy.toFixed(2) + '%',
    v.stability.toFixed(3),
    '$' + (v.tvlUsd / 1e6).toFixed(1) + 'M',
    v.trust.toFixed(2),
    '$' + v.totalGasCost.toFixed(2),
    '$' + v.netYield.toFixed(2),
    v.vault.protocol,
    v.vault.network,
  ]);

  const cols = header.map((h, i) => Math.max(h.length, ...data.map(r => r[i].length)));
  const sep  = '+-' + cols.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const fmt  = (row) => '| ' + row.map((cell, i) => cell.padEnd(cols[i])).join(' | ') + ' |';

  console.log('\n' + sep);
  console.log(fmt(header));
  console.log(sep);
  data.forEach(row => console.log(fmt(row)));
  console.log(sep);

  console.log(`
※1 Score      : Net APY × Stability × TVL bonus × Trust × Penalty
※2 Net APY    : (Gross yield - Est. gas+bridge) / Deposit × 100 ($${amountUsd} assumed)
※3 Stability  : APY consistency (0–1) based on variance of apy1d/7d/30d
※4 Trust      : Protocol credibility — aave:1.30 morpho:1.25 euler:1.20 pendle/etherfi:1.15
                 ethena:1.10 maple:1.05 upshift:1.00 yo/neverland:0.90`);
}

// ─── Vault Scanner ────────────────────────────────────────────────────────────

async function findBestVault({ asset = 'USDC', minTvlUsd = 1000000, topN = 10, amountUsd = 1000, fromChainId = null } = {}) {
  console.log(`\n🔍 Scanning vaults for ${asset} (deposit: $${amountUsd})...`);
  const vaults = await getVaults({ asset, minTvlUsd });
  console.log(`  Found ${vaults.length} vaults across all chains`);

  const ranked = rankVaults(vaults, amountUsd, fromChainId);
  console.log(`\n🏆 Top ${topN} Risk-Adjusted Vaults:`);
  printVaultTable(ranked, topN, amountUsd);

  return ranked[0];
}

// ─── Balance Check ────────────────────────────────────────────────────────────

async function checkBalance(chainId, tokenAddress) {
  const provider = getProvider(chainId);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY);
  const { balance, symbol, decimals } = await getTokenBalance(provider, tokenAddress, wallet.address);
  const formatted = ethers.formatUnits(balance, decimals);
  console.log(`\n💰 Balance on ${getChainName(chainId)}: ${formatted} ${symbol}`);
  return { balance, symbol, decimals, formatted };
}

// ─── Suggest Mode ─────────────────────────────────────────────────────────────

async function suggest({ walletAddress, asset = 'USDC', minTvlUsd = 1000000 } = {}) {
  console.log('\n🤖 Vaulthoric — Yield Suggestion');
  console.log('=================================');

  console.log(`\n📡 Scanning ${asset} balances for ${walletAddress}...`);
  const balances = [];

  for (const chainId of getSupportedChainIds()) {
    const tokenAddress = getUsdcAddress(chainId);
    if (!tokenAddress) continue;
    try {
      const provider = getProvider(chainId);
      const { balance, symbol, decimals } = await getTokenBalance(provider, tokenAddress, walletAddress);
      const usd = parseFloat(ethers.formatUnits(balance, decimals));
      if (usd > 0.01) {
        balances.push({ chainId, tokenAddress, symbol, usd, balance, decimals });
        console.log(`  ${getChainName(chainId).padEnd(12)} | ${usd.toFixed(4)} ${symbol}`);
      }
    } catch { /* skip */ }
  }

  if (balances.length === 0) {
    console.log(`  No idle ${asset} found across supported chains`);
    return;
  }

  const totalUsd      = balances.reduce((a, b) => a + b.usd, 0);
  const primaryChainId = balances.sort((a, b) => b.usd - a.usd)[0].chainId;
  console.log(`\n  Total idle ${asset}: $${totalUsd.toFixed(2)} (largest on ${getChainName(primaryChainId)})`);

  const vaults = await getVaults({ asset, minTvlUsd });
  const ranked = rankVaults(vaults, totalUsd, primaryChainId);

  console.log(`\n🏆 Top 10 Risk-Adjusted Vaults (deposit: $${totalUsd.toFixed(2)} from ${getChainName(primaryChainId)}):`);
  printVaultTable(ranked, 10, totalUsd);

  const best = ranked[0];
  if (!best) return;

  console.log(`\n💡 Recommendation:`);
  console.log(`  Deposit $${totalUsd.toFixed(2)} ${asset} into:`);
  console.log(`  → ${best.vault.name} (${best.vault.protocol}) on ${best.vault.network}`);
  console.log(`  → APY: ${best.apy}% → Net APY: ${best.netApy}% after gas`);
  console.log(`  → Est. annual net yield: $${best.netYield.toFixed(2)}`);
  console.log(`\n  To execute:`);
  console.log(`  node agent.js allocate ${primaryChainId} ${totalUsd.toFixed(2)} --execute`);

  return { balances, best, totalUsd };
}

// ─── Auto-Allocate ────────────────────────────────────────────────────────────

async function autoAllocate({ fromChainId, asset = 'USDC', amountUsd, minTvlUsd = 1000000, dryRun = true } = {}) {
  console.log('\n🤖 Vaulthoric Auto-Allocate');
  console.log('============================');

  const amountForScore = amountUsd || 100;
  const best = await findBestVault({ asset, minTvlUsd, amountUsd: amountForScore, fromChainId });
  if (!best) { console.log('❌ No suitable vault found'); return; }

  const targetVault = best.vault;
  const fromToken   = getUsdcAddress(fromChainId);
  if (!fromToken) { console.log(`❌ No USDC address for chainId ${fromChainId}`); return; }

  const { balance, decimals, formatted } = await checkBalance(fromChainId, fromToken);
  const amountWei = amountUsd ? ethers.parseUnits(amountUsd.toString(), decimals) : balance;

  if (amountWei > balance) {
    console.log(`❌ Insufficient balance: have ${formatted}, need ${ethers.formatUnits(amountWei, decimals)}`);
    return;
  }

  const needsBridge = fromChainId !== targetVault.chainId;
  console.log(`\n📋 Allocation Plan:`);
  console.log(`  From    : ${getChainName(fromChainId)} | ${ethers.formatUnits(amountWei, decimals)} ${asset}`);
  console.log(`  To      : ${targetVault.network} | ${targetVault.name} (${targetVault.protocol})`);
  console.log(`  APY     : ${best.apy}% → Net APY: ${best.netApy}%`);
  console.log(`  Gas est.: $${best.totalGasCost.toFixed(2)}${needsBridge ? ' (incl. bridge)' : ''}`);
  console.log(`  Est. annual net yield: $${best.netYield.toFixed(2)}`);

  if (dryRun) {
    console.log('\n🧪 DRY RUN — no transaction sent');
    console.log('  Add --execute to run for real');
    return { best, plan: { fromChainId, fromToken, targetVault, amountWei: amountWei.toString() } };
  }

  const signer = getSigner(fromChainId);
  return await depositToVault({
    signer,
    fromChainId,
    toChainId:         targetVault.chainId,
    fromTokenAddress:  fromToken,
    vaultTokenAddress: targetVault.address,
    amountWei:         amountWei.toString(),
  });
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

async function showPortfolio(walletAddress) {
  console.log(`\n📊 Portfolio for ${walletAddress}`);
  const positions = await getPortfolio(walletAddress);
  if (positions.length === 0) { console.log('  No positions found'); return; }
  positions.forEach(p => {
    console.log(`  ${p.protocolName.padEnd(20)} | ${p.asset.symbol.padEnd(8)} | $${parseFloat(p.balanceUsd).toFixed(2).padStart(10)} | ${getChainName(p.chainId)}`);
  });
  return positions;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'scan') {
    const asset      = process.argv[3] || 'USDC';
    const amount     = parseFloat(process.argv[4] || '1000');
    const fromChain  = process.argv[5] ? parseInt(process.argv[5]) : null;
    await findBestVault({ asset, amountUsd: amount, fromChainId: fromChain });

  } else if (cmd === 'balance') {
    const chainId = parseInt(process.argv[3] || '8453');
    await checkBalance(chainId, getUsdcAddress(chainId));

  } else if (cmd === 'portfolio') {
    const wallet = process.argv[3] || new ethers.Wallet(process.env.PRIVATE_KEY).address;
    await showPortfolio(wallet);

  } else if (cmd === 'suggest') {
    const wallet = process.argv[3] || new ethers.Wallet(process.env.PRIVATE_KEY).address;
    await suggest({ walletAddress: wallet });

  } else if (cmd === 'allocate') {
    const fromChainId = parseInt(process.argv[3] || '8453');
    const amountUsd   = process.argv[4] ? parseFloat(process.argv[4]) : null;
    const dryRun      = process.argv[5] !== '--execute';
    await autoAllocate({ fromChainId, asset: 'USDC', amountUsd, dryRun });

  } else {
    console.log(`
🏦 Vaulthoric — Risk-Adjusted Yield Optimizer
Stay Vaulthoric.

Usage:
  node agent.js scan [ASSET] [amount] [fromChainId]
  node agent.js balance [chainId]
  node agent.js portfolio [address]
  node agent.js suggest [address]
  node agent.js allocate [chainId] [amt] [--execute]

Examples:
  node agent.js scan USDC 500 8453
  node agent.js suggest 0x1234...
  node agent.js allocate 8453 100
  node agent.js allocate 8453 100 --execute
    `);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { findBestVault, autoAllocate, suggest, showPortfolio, checkBalance, printVaultTable };
