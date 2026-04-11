require('dotenv').config();
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const msg = chunk.toString();
  if (msg.includes('JsonRpcProvider failed') || msg.includes('retry in 1s')) return true;
  return originalStdoutWrite(chunk, ...args);
};
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const msg = chunk.toString();
  if (msg.includes('JsonRpcProvider failed') || msg.includes('retry in 1s')) return true;
  return originalStderrWrite(chunk, ...args);
};

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const readline = require('readline');
const axios = require('axios');
const { getVaults } = require('./earn');
const { rankVaults } = require('./scorer');
const {
  CHAINS,
  getUsdcAddress,
  getProviderWithFallback,
  getScanChainIds,
  getChainName,
} = require('./tools');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

const LIFI_API = 'https://li.quest/v1';
const MIN_USD  = 0.5;
const POLL_MS  = 5000;
const POLL_MAX = 60;
const POSITIONS_FILE = path.join(__dirname, 'positions.json');

function prompt(rl, q) {
  return new Promise(r => rl.question(q, r));
}

function getSigner(chainId) {
  const rpc = CHAINS[chainId]?.rpcs?.[0];
  if (!rpc) throw new Error(`No RPC for chainId ${chainId}`);
  return new ethers.Wallet(process.env.PRIVATE_KEY, new ethers.JsonRpcProvider(rpc));
}

function recordPosition(vault, chainId) {
  let positions = [];
  try { positions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8')); } catch {}
  const key = `${chainId}-${vault.address.toLowerCase()}`;
  if (!positions.find(p => `${p.chainId}-${p.address.toLowerCase()}` === key)) {
    positions.push({
      address: vault.address,
      chainId,
      protocol: vault.protocol,
      name: vault.name,
      symbol: vault.underlyingTokens?.[0]?.symbol || 'USDC',
      decimals: 18,
      depositPack: vault.depositPacks?.[0]?.name || '',
      addedAt: new Date().toISOString(),
    });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
    console.log(`📝 Position recorded: ${vault.name} on chain ${chainId}`);
  }
}

async function getUsdcBalance(chainId, wallet) {
  const usdcAddr = getUsdcAddress(chainId);
  if (!usdcAddr) return { chainId, name: getChainName(chainId), usdc: null, amount: 0, raw: 0n, decimals: 6 };
  try {
    const provider = await getProviderWithFallback(chainId);
    const token = new ethers.Contract(usdcAddr, ERC20_ABI, provider);
    const [bal, dec] = await Promise.all([token.balanceOf(wallet), token.decimals()]);
    const amount = parseFloat(ethers.formatUnits(bal, dec));
    return { chainId, name: getChainName(chainId), usdc: usdcAddr, amount, raw: bal, decimals: Number(dec) };
  } catch {
    return { chainId, name: getChainName(chainId), usdc: usdcAddr, amount: 0, raw: 0n, decimals: 6 };
  }
}

async function ensureAllowance(signer, tokenAddr, spender, amountWei) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const current = await token.allowance(signer.address, spender);
  if (current >= BigInt(amountWei)) return;
  console.log(`  🔓 Approving ${spender.slice(0, 10)}...`);
  const tx = await token.approve(spender, amountWei);
  await tx.wait();
  console.log(`  ✅ Approved`);
}

async function pollStatus(txHash, fromChainId, toChainId) {
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    try {
      const res = await axios.get(`${LIFI_API}/status`, {
        params: { txHash, bridge: 'lifi', fromChain: fromChainId, toChain: toChainId },
      });
      const s = res.data.status;
      process.stdout.write(`\r  ⏳ Status: ${s}${' '.repeat(20)}`);
      if (s === 'DONE') { console.log(''); return 'DONE'; }
      if (s === 'FAILED') { console.log(''); return 'FAILED'; }
    } catch { /* retry */ }
  }
  console.log('');
  return 'TIMEOUT';
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

async function suggestTargetChain() {
  try {
    const vaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
    const ranked = rankVaults(vaults);
    const best = ranked[0];
    return { chainId: best.vault.chainId, name: getChainName(best.vault.chainId), vault: best };
  } catch {
    return { chainId: 8453, name: 'Base', vault: null };
  }
}

async function bridgeUsdc({ fromChainId, toChainId, amountWei, wallet }) {
  const fromUsdc = getUsdcAddress(fromChainId);
  const toUsdc   = getUsdcAddress(toChainId);
  console.log(`\n  📡 Getting bridge quote: ${getChainName(fromChainId)} → ${getChainName(toChainId)}`);

  const quote = await axios.get(`${LIFI_API}/quote`, {
    params: {
      fromChain: fromChainId, toChain: toChainId,
      fromToken: fromUsdc, toToken: toUsdc,
      fromAmount: amountWei.toString(),
      fromAddress: wallet, slippage: '0.005', integrator: 'vaulthoric',
    },
  });

  const q = quote.data;
  const estOut  = parseFloat(ethers.formatUnits(q.estimate.toAmount, q.action.toToken.decimals));
  const gasCost = parseFloat(q.estimate.gasCosts?.[0]?.amountUSD || '0');
  console.log(`  💱 Est. received: ${estOut.toFixed(4)} USDC | Gas: $${gasCost.toFixed(3)}`);

  const signer = getSigner(fromChainId);
  if (q.estimate.approvalAddress) {
    await ensureAllowance(signer, fromUsdc, q.estimate.approvalAddress, amountWei.toString());
  }

  console.log(`  📤 Sending bridge tx...`);
  const txReq = q.transactionRequest;
  const tx = await signer.sendTransaction({
    to: txReq.to, data: txReq.data,
    value: txReq.value ? BigInt(txReq.value) : 0n,
    gasLimit: txReq.gasLimit ? BigInt(Math.floor(Number(txReq.gasLimit) * 1.2)) : undefined,
  });
  await tx.wait();
  console.log(`  🔗 Tx: ${tx.hash}`);

  if (fromChainId !== toChainId) {
    const status = await pollStatus(tx.hash, fromChainId, toChainId);
    console.log(`  🏁 Bridge status: ${status}`);
    return { status, txHash: tx.hash, estOut };
  }
  return { status: 'DONE', txHash: tx.hash, estOut };
}

// mode: 'safest' | 'best' | 'highest'

async function promptVaultMode(rl, chainName) {
  console.log(`\n🏦 Deposit consolidated USDC into vault on ${chainName}?`);
  console.log('  1. 🛡️  Safest   (stability & trust重視)');
  console.log('  2. ⚖️  Best     (risk-adjusted score)');
  console.log('  3. 🚀 Highest  (APY最大)');
  console.log('  n. Skip');
  const choice = await prompt(rl, '\nSelect (1/2/3/n): ');
  const modeMap = { '1': 'safest', '2': 'best', '3': 'highest' };
  return modeMap[choice] || null;
}
function selectByMode(ranked, mode) {
  if (mode === 'safest') {
    return [...ranked].sort((a, b) => (b.stability * b.trust) - (a.stability * a.trust))[0];
  } else if (mode === 'highest') {
    return [...ranked].sort((a, b) => b.apy - a.apy)[0];
  }
  return ranked[0]; // best = score順
}

async function depositBestVault({ chainId, amountWei, wallet, mode = 'best' }) {
  const { depositToVault } = require('./composer');
  const vaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
  const onChain = vaults.filter(v => v.chainId === chainId);
  if (onChain.length === 0) { console.log(`  ⚠️  No vaults on chain ${chainId}`); return null; }

  const ranked = rankVaults(onChain).filter(v => v.vault.depositPacks?.length > 0);
  const candidates = mode === 'safest'
    ? [...ranked].sort((a,b) => (b.stability*b.trust)-(a.stability*a.trust))
    : mode === 'highest'
    ? [...ranked].sort((a,b) => b.apy-a.apy)
    : ranked;

  const modeLabel = { safest: '🛡️  Safest', best: '⚖️  Best', highest: '🚀 Highest yield' }[mode] || mode;
  const signer = getSigner(chainId);

  for (const candidate of candidates.slice(0, 5)) {
    console.log(`\n  ${modeLabel} vault: ${candidate.vault.name} (${candidate.vault.protocol})`);
    console.log(`  APY: ${candidate.apy.toFixed(2)}% | Stability: ${candidate.stability.toFixed(3)} | Score: ${candidate.score.toFixed(2)}`);
    try {
      const result = await depositToVault({
        signer,
        fromChainId: chainId, toChainId: chainId,
        fromTokenAddress: getUsdcAddress(chainId),
        vaultTokenAddress: candidate.vault.address,
        amountWei: amountWei.toString(),
        depositPack: candidate.vault.depositPacks?.[0]?.name || '',
      });
      recordPosition(candidate.vault, chainId);
      return result;
    } catch (e) {
      console.log(`  ⚠️  Failed: ${e.message?.slice(0,60)} — trying next vault...`);
    }
  }
  console.log('❌ All vault candidates failed.');
  return null;
}

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

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

  console.log('🤖 Finding best vault across all chains...');
  const suggested = await suggestTargetChain();
  console.log(`\n💡 Suggested target: ${suggested.name}`);
  if (suggested.vault) {
    console.log(`   Best vault: ${suggested.vault.vault.name} | APY ${suggested.vault.apy.toFixed(2)}% | score=${suggested.vault.score.toFixed(2)}`);
  }

  const scanIds = getScanChainIds();
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

  const toBridge = balances.filter(b => b.chainId !== targetChainId);
  const alreadyThere = balances.find(b => b.chainId === targetChainId);

  if (toBridge.length === 0) {
    console.log(`\nℹ️  All USDC is already on ${targetName}.`);
  } else {
    console.log(`\n📦 Bridge plan:`);
    toBridge.forEach(b => console.log(`  • ${b.name.padEnd(12)} → ${targetName}: ${b.amount.toFixed(4)} USDC`));
    if (alreadyThere) console.log(`  • ${targetName.padEnd(12)}: ${alreadyThere.amount.toFixed(4)} USDC (already there)`);

    if (process.argv.includes('--dry-run')) {
      console.log('\n🧪 DRY RUN — no transactions sent. Remove --dry-run to execute.');
      rl.close(); return;
    }

    const go = await prompt(rl, '\n🚀 Execute bridge? (y/n): ');
    if (go.toLowerCase() !== 'y') { console.log('❌ Cancelled.'); rl.close(); return; }

    let totalBridged = 0;
    for (const src of toBridge) {
      console.log(`\n🌉 Bridging from ${src.name}...`);
      try {
        const result = await bridgeUsdc({ fromChainId: src.chainId, toChainId: targetChainId, amountWei: src.raw, wallet });
        if (result.status === 'DONE') {
          totalBridged += result.estOut;
          console.log(`  ✅ Done: +${result.estOut.toFixed(4)} USDC on ${targetName}`);
        } else {
          console.log(`  ⚠️  Status: ${result.status}`);
        }
      } catch (e) {
        console.error(`  ❌ Bridge failed: ${e.response?.data?.message || e.message}`);
      }
    }
    console.log(`\n💰 Estimated total on ${targetName}: ${(totalBridged + (alreadyThere?.amount || 0)).toFixed(4)} USDC`);
  }

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

main().catch(e => { console.error('❌', e.message); process.exit(1); });
