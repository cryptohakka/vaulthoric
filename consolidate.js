// Vaulthoric — Consolidate
// Scans all chains for idle USDC, bridges to a target chain in parallel, and
// optionally deposits into the best vault.

require('dotenv').config();

const readline = require('readline');
const axios    = require('axios');
const { ethers } = require('ethers');
const { getVaults }  = require('./earn');
const { rankVaults } = require('./scorer');
const { depositToVault } = require('./composer');
const {
  ERC20_ABI,
  CHAINS,
  getUsdcAddress,
  getProviderWithFallback,
  getScanChainIds,
  getChainName,
  recordPosition,
  suppressRpcNoise,
} = require('./tools');
const { ensureAllowance, pollStatus } = require('./composer');

suppressRpcNoise();

const LIFI_API = 'https://li.quest/v1';
const MIN_USD  = 0.5;
const POLL_MAX = 120; // 10 min max per bridge
const POLL_MS  = 5000;

function prompt(rl, q) {
  return new Promise(r => rl.question(q, r));
}

function fmtDuration(seconds) {
  if (!seconds) return '?';
  const m = Math.ceil(seconds / 60);
  return m < 1 ? '<1 min' : `~${m} min`;
}

function fmtGas(usd) {
  if (usd === 0) return '$0';
  if (usd < 0.001) return `$${usd.toFixed(4)}`;
  if (usd < 0.01)  return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ─── Signer ───────────────────────────────────────────────────────────────────

function getSigner(chainId) {
  const rpc = CHAINS[chainId]?.rpcs?.[0];
  if (!rpc) throw new Error(`No RPC for chainId ${chainId}`);
  return new ethers.Wallet(process.env.PRIVATE_KEY, new ethers.JsonRpcProvider(rpc));
}

// ─── Balance ──────────────────────────────────────────────────────────────────

async function getUsdcBalance(chainId, wallet) {
  const usdcAddr = getUsdcAddress(chainId);
  if (!usdcAddr) return { chainId, name: getChainName(chainId), usdc: null, amount: 0, raw: 0n, decimals: 6 };
  try {
    const provider = await getProviderWithFallback(chainId);
    const token    = new ethers.Contract(usdcAddr, ERC20_ABI, provider);
    const [bal, dec] = await Promise.all([token.balanceOf(wallet), token.decimals()]);
    const amount = parseFloat(ethers.formatUnits(bal, dec));
    return { chainId, name: getChainName(chainId), usdc: usdcAddr, amount, raw: bal, decimals: Number(dec) };
  } catch {
    return { chainId, name: getChainName(chainId), usdc: usdcAddr, amount: 0, raw: 0n, decimals: 6 };
  }
}

async function scanAllBalances(wallet) {
  const chainIds = getScanChainIds();
  process.stdout.write(`🔍 Scanning ${chainIds.length} chains`);
  const results = await Promise.all(
    chainIds.map(async (cid) => {
      const r = await getUsdcBalance(cid, wallet);
      process.stdout.write('.');
      return r;
    })
  );
  console.log(' done\n');
  return results.filter(r => r.amount >= MIN_USD).sort((a, b) => b.amount - a.amount);
}

// ─── Best Vault Suggestion ────────────────────────────────────────────────────

async function suggestTargetChain() {
  try {
    const vaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
    const ranked = rankVaults(vaults);
    const best   = ranked[0];
    return { chainId: best.vault.chainId, name: getChainName(best.vault.chainId), vault: best };
  } catch {
    return { chainId: 8453, name: 'Base', vault: null };
  }
}

// ─── Bridge Quote ─────────────────────────────────────────────────────────────

async function getBridgeQuote({ fromChainId, toChainId, amountWei, wallet }) {
  const fromUsdc = getUsdcAddress(fromChainId);
  const toUsdc   = getUsdcAddress(toChainId);
  const res = await axios.get(`${LIFI_API}/quote`, {
    params: {
      fromChain:   fromChainId,
      toChain:     toChainId,
      fromToken:   fromUsdc,
      toToken:     toUsdc,
      fromAmount:  amountWei.toString(),
      fromAddress: wallet,
      slippage:    '0.005',
      integrator:  'vaulthoric',
    },
  });
  return res.data;
}

// ─── Bridge Execute ───────────────────────────────────────────────────────────

async function executeBridge({ fromChainId, toChainId, quote, wallet }) {
  const fromUsdc = getUsdcAddress(fromChainId);
  const signer   = getSigner(fromChainId);

  if (quote.estimate.approvalAddress) {
    await ensureAllowance(signer, fromUsdc, quote.estimate.approvalAddress, quote.action.fromAmount);
  }

  const txReq = quote.transactionRequest;
  const tx = await signer.sendTransaction({
    to:       txReq.to,
    data:     txReq.data,
    value:    txReq.value ? BigInt(txReq.value) : 0n,
    gasLimit: txReq.gasLimit ? BigInt(Math.floor(Number(txReq.gasLimit) * 1.2)) : undefined,
  });
  await tx.wait();
  console.log(`  🔗 ${getChainName(fromChainId)} tx: ${tx.hash}`);
  return {
    txHash:      tx.hash,
    fromChainId,
    estOut:      parseFloat(ethers.formatUnits(quote.estimate.toAmount, quote.action.toToken.decimals)),
  };
}

// Poll a single bridge tx until DONE/FAILED/TIMEOUT.
async function waitForBridge({ txHash, fromChainId, toChainId, estOut }) {
  const name = getChainName(fromChainId);
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    try {
      const res = await axios.get(`${LIFI_API}/status`, {
        params: { txHash, bridge: 'lifi', fromChain: fromChainId, toChain: toChainId },
      });
      const s = res.data.status;
      if (s === 'DONE')   { console.log(`  ✅ ${name}: complete (+${estOut.toFixed(4)} USDC)`); return { status: 'DONE',    estOut }; }
      if (s === 'FAILED') { console.log(`  ❌ ${name}: failed`);                                return { status: 'FAILED',  estOut: 0 }; }
    } catch { /* retry */ }
  }
  console.log(`  ⏰ ${name}: timeout`);
  return { status: 'TIMEOUT', estOut: 0 };
}

// ─── Parallel Bridge ──────────────────────────────────────────────────────────

async function bridgeAllParallel({ sources, toChainId, wallet }) {
  // Step 1: Fetch all quotes in parallel
  console.log('\n📡 Fetching bridge quotes...');
  const quoted = await Promise.all(
    sources.map(async (src) => {
      try {
        const q        = await getBridgeQuote({ fromChainId: src.chainId, toChainId, amountWei: src.raw, wallet });
        const estOut   = parseFloat(ethers.formatUnits(q.estimate.toAmount, q.action.toToken.decimals));
        const gasCost  = parseFloat(q.estimate.gasCosts?.[0]?.amountUSD || '0');
        const duration = q.estimate.executionDuration || null;
        return { src, quote: q, estOut, gasCost, duration, error: null };
      } catch (e) {
        return { src, quote: null, estOut: 0, gasCost: 0, duration: null, error: e.message };
      }
    })
  );

  // Display plan with per-bridge duration estimates
  const durations   = quoted.filter(q => q.duration).map(q => q.duration);
  const maxDuration = durations.length ? Math.max(...durations) : null;
  console.log('\n📦 Bridge plan:');
  quoted.forEach(({ src, estOut, gasCost, duration, error }) => {
    if (error) {
      console.log(`  • ${src.name.padEnd(12)} → ${getChainName(toChainId)}: ❌ quote failed`);
    } else {
      console.log(
        `  • ${src.name.padEnd(12)} → ${getChainName(toChainId)}: ` +
        `${src.amount.toFixed(4)} USDC  ` +
        `(est. out: ${estOut.toFixed(4)}, gas: ${fmtGas(gasCost)}, ⏱️  ${fmtDuration(duration)})`
      );
    }
  });
  if (maxDuration) {
    console.log(`\n  ⏱️  Est. total wait (parallel): ${fmtDuration(maxDuration)}`);
  }

  const valid = quoted.filter(q => q.quote !== null);
  if (valid.length === 0) { console.log('❌ No valid bridge quotes.'); return 0; }

  // Step 2: Submit all txs in parallel
  console.log('\n🚀 Submitting bridge transactions in parallel...');
  const submitted = await Promise.all(
    valid.map(async ({ src, quote }) => {
      try {
        return await executeBridge({ fromChainId: src.chainId, toChainId, quote, wallet });
      } catch (e) {
        console.log(`  ❌ ${getChainName(src.chainId)}: tx failed — ${e.message?.slice(0, 60)}`);
        return null;
      }
    })
  );

  // Step 3: Poll all in parallel
  const pending = submitted.filter(Boolean);
  if (pending.length === 0) { console.log('❌ No transactions submitted.'); return 0; }

  console.log(`\n⏳ Waiting for ${pending.length} bridge(s) to complete...`);
  const results = await Promise.all(
    pending.map(({ txHash, fromChainId, estOut }) =>
      waitForBridge({ txHash, fromChainId, toChainId, estOut })
    )
  );

  return results.reduce((s, r) => s + (r.status === 'DONE' ? r.estOut : 0), 0);
}

// ─── Dry Run Quote Display ────────────────────────────────────────────────────

async function showDryRunPlan({ toBridge, toChainId, alreadyThere, wallet }) {
  console.log('\n🧪 DRY RUN — fetching quotes for estimate only...');
  const quoted = await Promise.all(
    toBridge.map(async (src) => {
      try {
        const q        = await getBridgeQuote({ fromChainId: src.chainId, toChainId, amountWei: src.raw, wallet });
        const estOut   = parseFloat(ethers.formatUnits(q.estimate.toAmount, q.action.toToken.decimals));
        const gasCost  = parseFloat(q.estimate.gasCosts?.[0]?.amountUSD || '0');
        const duration = q.estimate.executionDuration || null;
        return { src, estOut, gasCost, duration, error: null };
      } catch (e) {
        return { src, estOut: 0, gasCost: 0, duration: null, error: e.message };
      }
    })
  );

  const durations   = quoted.filter(q => q.duration).map(q => q.duration);
  const maxDuration = durations.length ? Math.max(...durations) : null;
  const targetName  = getChainName(toChainId);

  console.log('\n📦 Bridge plan (dry run):');
  quoted.forEach(({ src, estOut, gasCost, duration, error }) => {
    if (error) {
      console.log(`  • ${src.name.padEnd(12)} → ${targetName}: ❌ quote failed`);
    } else {
      console.log(
        `  • ${src.name.padEnd(12)} → ${targetName}: ` +
        `${src.amount.toFixed(4)} USDC  ` +
        `(est. out: ${estOut.toFixed(4)}, gas: ${fmtGas(gasCost)}, ⏱️  ${fmtDuration(duration)})`
      );
    }
  });
  if (alreadyThere) console.log(`  • ${targetName.padEnd(12)}: ${alreadyThere.amount.toFixed(4)} USDC (already there)`);
  if (maxDuration)  console.log(`\n  ⏱️  Est. total wait (parallel): ${fmtDuration(maxDuration)}`);
  console.log('\n  Remove --dry-run to execute.');
}

// ─── Vault Deposit ────────────────────────────────────────────────────────────

async function promptVaultMode(rl, chainName) {
  console.log(`\n🏦 Deposit consolidated USDC into vault on ${chainName}?`);
  console.log('  1. 🛡️  Safest   (stability & trust first)');
  console.log('  2. ⚖️  Best     (risk-adjusted score)');
  console.log('  3. 🚀 Highest  (max APY)');
  console.log('  n. Skip');
  const choice  = await prompt(rl, '\nSelect (1/2/3/n): ');
  const modeMap = { '1': 'safest', '2': 'best', '3': 'highest' };
  return modeMap[choice] || null;
}

async function depositBestVault({ chainId, amountWei, wallet, mode = 'best' }) {
  const vaults  = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
  const onChain = vaults.filter(v => v.chainId === chainId);
  if (onChain.length === 0) { console.log(`  ⚠️  No vaults on chain ${chainId}`); return null; }

  const ranked = rankVaults(onChain).filter(v => v.vault.depositPacks?.length > 0);
  const candidates = mode === 'safest'
    ? [...ranked].sort((a, b) => (b.stability * b.trust) - (a.stability * a.trust))
    : mode === 'highest'
    ? [...ranked].sort((a, b) => b.apy - a.apy)
    : ranked;

  const modeLabel = { safest: '🛡️  Safest', best: '⚖️  Best', highest: '🚀 Highest yield' }[mode] || mode;
  const signer    = getSigner(chainId);

  for (const candidate of candidates.slice(0, 5)) {
    const depositUsd    = parseFloat(ethers.formatUnits(amountWei, 6));
    const grossYield    = depositUsd * (candidate.apy / 100);
    const netYield      = grossYield - candidate.totalGasCost;
    const breakEvenDays = netYield > 0 ? Math.ceil((candidate.totalGasCost / grossYield) * 365) : null;
    const riskLabel     = candidate.trust >= 1.25 && candidate.stability >= 0.9 ? 'Low'
                        : candidate.trust >= 1.1  && candidate.stability >= 0.7 ? 'Low-Medium'
                        : candidate.trust >= 1.0                                 ? 'Medium'
                        : 'Higher';
    const liquidLabel   = candidate.vault.depositPacks?.[0]?.name?.includes('aave') ? 'Yes (instant)' : 'Yes';

    console.log(`\n  ${modeLabel} vault: ${candidate.vault.name} (${candidate.vault.protocol})`);
    console.log(`  APY: ${candidate.apy.toFixed(2)}% | Stability: ${candidate.stability.toFixed(3)} | Score: ${candidate.score.toFixed(2)}`);

    console.log(`\n  💡 Why this vault?`);
    console.log(`    Stability : ${candidate.stability.toFixed(3)} / 1.0  (APY consistency over 30d)`);
    console.log(`    Trust     : ${candidate.trust.toFixed(2)}  (protocol credibility score)`);
    console.log(`    Risk      : ${riskLabel}`);
    console.log(`    Withdraw  : ${liquidLabel}`);

    console.log(`\n  📈 Expected economics:`);
    console.log(`    Gross yield/yr : $${grossYield.toFixed(2)}`);
    console.log(`    Est. costs     : $${candidate.totalGasCost.toFixed(2)}`);
    console.log(`    Net yield/yr   : $${netYield.toFixed(2)}`);
    if (breakEvenDays !== null) {
      console.log(`    Break-even     : ${breakEvenDays} day${breakEvenDays === 1 ? '' : 's'}`);
    }
    try {
      const result = await depositToVault({
        signer,
        fromChainId:       chainId,
        toChainId:         chainId,
        fromTokenAddress:  getUsdcAddress(chainId),
        vaultTokenAddress: candidate.vault.address,
        amountWei:         amountWei.toString(),
        depositPack:       candidate.vault.depositPacks?.[0]?.name || '',
      });
      recordPosition(candidate.vault, chainId);
      return result;
    } catch (e) {
      console.log(`  ⚠️  Failed: ${e.message?.slice(0, 60)} — trying next vault...`);
    }
  }
  console.log('❌ All vault candidates failed.');
  return null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const rl     = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n🏦 Vaulthoric — Consolidate`);
  console.log(`👛 Wallet: ${wallet}`);
  console.log(`${'─'.repeat(50)}`);

  const balances = await scanAllBalances(wallet);

  if (balances.length === 0) {
    console.log('❌ No USDC balance found on any chain (minimum $0.50).');
    rl.close(); return;
  }

  const totalUsd = balances.reduce((s, b) => s + b.amount, 0);
  console.log('📊 USDC balances found:\n');
  balances.forEach((b, i) => {
    console.log(`  ${i + 1}. ${b.name.padEnd(12)} ${b.amount.toFixed(4).padStart(12)} USDC  ($${b.amount.toFixed(2)})`);
  });
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Total: ${totalUsd.toFixed(4)} USDC\n`);

  // Single chain — nothing to bridge
  if (balances.length === 1) {
    console.log(`ℹ️  Only 1 chain has balance. Nothing to consolidate.`);
    if (process.argv.includes('--dry-run')) {
      console.log('\n🧪 DRY RUN — no transactions sent.');
      rl.close(); return;
    }
    const mode = await promptVaultMode(rl, balances[0].name);
    if (mode) {
      await depositBestVault({ chainId: balances[0].chainId, amountWei: balances[0].raw, wallet, mode });
      console.log('\n🎉 Done! Stay Vaulthoric.');
    }
    rl.close(); return;
  }

  // Suggest best target chain
  console.log('🤖 Finding best vault across all chains...');
  const suggested = await suggestTargetChain();
  console.log(`\n💡 Suggested target: ${suggested.name}`);
  if (suggested.vault) {
    console.log(`   Best vault: ${suggested.vault.vault.name} | APY ${suggested.vault.apy.toFixed(2)}% | score=${suggested.vault.score.toFixed(2)}`);
  }

  // Build chain selection list
  const scanIds       = getScanChainIds();
  const targetOptions = Object.entries(CHAINS).filter(([cid]) => {
    const id = parseInt(cid);
    return scanIds.includes(id) || balances.some(b => b.chainId === id);
  });

  console.log('\nSelect target chain:');
  targetOptions.forEach(([cid, cfg], i) => {
    const isSuggested = parseInt(cid) === suggested.chainId ? ' ⭐' : '';
    const hasBalance  = balances.find(b => b.chainId === parseInt(cid));
    const balStr      = hasBalance ? ` (have ${hasBalance.amount.toFixed(2)} USDC)` : '';
    console.log(`  ${i + 1}. ${cfg.name}${isSuggested}${balStr}`);
  });
  console.log(`  0. Auto (${suggested.name} ⭐)`);

  const chainChoice = await prompt(rl, '\nTarget chain (number or 0 for auto): ');
  let targetChainId;
  if (chainChoice === '0' || chainChoice === '') {
    targetChainId = suggested.chainId;
  } else {
    const idx = parseInt(chainChoice) - 1;
    if (isNaN(idx) || idx < 0 || idx >= targetOptions.length) {
      console.log('❌ Invalid selection.'); rl.close(); return;
    }
    targetChainId = parseInt(targetOptions[idx][0]);
  }
  const targetName = getChainName(targetChainId);
  console.log(`\n✅ Target: ${targetName} (chain=${targetChainId})`);

  const toBridge     = balances.filter(b => b.chainId !== targetChainId);
  const alreadyThere = balances.find(b => b.chainId === targetChainId);

  if (toBridge.length === 0) {
    console.log(`\nℹ️  All USDC is already on ${targetName}.`);
  } else {
    if (process.argv.includes('--dry-run')) {
      await showDryRunPlan({ toBridge, toChainId: targetChainId, alreadyThere, wallet });
      rl.close(); return;
    }

    const go = await prompt(rl, '\n🚀 Execute bridge? (y/n): ');
    if (go.toLowerCase() !== 'y') { console.log('❌ Cancelled.'); rl.close(); return; }

    const totalBridged = await bridgeAllParallel({ sources: toBridge, toChainId: targetChainId, wallet });
    const grandTotal   = totalBridged + (alreadyThere?.amount || 0);
    console.log(`\n💰 Estimated total on ${targetName}: ${grandTotal.toFixed(4)} USDC`);
  }

  // Optionally deposit into best vault
  const mode = await promptVaultMode(rl, targetName);
  if (mode) {
    console.log(`\n🔄 Checking final balance on ${targetName}...`);
    await new Promise(r => setTimeout(r, 3000));
    const finalBal = await getUsdcBalance(targetChainId, wallet);
    if (finalBal.amount < MIN_USD) {
      console.log('⚠️  Balance too low or bridge still pending.');
    } else {
      console.log(`  💰 ${finalBal.amount.toFixed(4)} USDC available`);
      await depositBestVault({ chainId: targetChainId, amountWei: finalBal.raw, wallet, mode });
    }
  }

  console.log('\n🎉 Stay Vaulthoric.');
  rl.close();
}

if (require.main === module) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { bridgeAllParallel, getUsdcBalance, depositBestVault, getBridgeQuote };
