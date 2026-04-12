// Vaulthoric — Position Manager (Withdraw)
// Scans recorded vault positions and handles withdrawal via direct or LI.FI routes.

require('dotenv').config();

const axios    = require('axios');
const readline = require('readline');
const { ethers } = require('ethers');
const {
  ERC20_ABI,
  ERC4626_ABI,
  AAVE_POOL_ABI,
  AAVE_POOLS,
  USDC_ADDRESSES,
  getProviderWithFallback,
  getChainName,
  loadPositions,
  savePositions,
  suppressRpcNoise,
} = require('./tools');
const { ensureAllowance, sendTx, pollStatus } = require('./composer');

suppressRpcNoise();

const LIFI_API_KEY = process.env.LIFI_API_KEY || '';
const LIFI_HEADERS = LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : {};

const BAL_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function convertToAssets(uint256 shares) view returns (uint256 assets)',
];

// ─── Position Scanner ─────────────────────────────────────────────────────────

async function scanPositions(walletAddress) {
  console.log('\n📡 Scanning vault positions...');
  const saved = loadPositions();

  if (saved.length === 0) {
    console.log('  ℹ️  No positions recorded. Use ask.js to deposit first.');
    return [];
  }

  const results = [];

  for (const v of saved) {
    try {
      const provider = await getProviderWithFallback(v.chainId);
      const contract = new ethers.Contract(v.address, BAL_ABI, provider);
      const bal      = await contract.balanceOf(walletAddress);
      if (bal === 0n) continue;

      let decimals = v.decimals || 18;
      let symbol   = v.symbol || '?';
      try {
        decimals = await contract.decimals();
        symbol   = await contract.symbol();
      } catch {}

      const amount = parseFloat(ethers.formatUnits(bal, decimals));
      if (amount < 0.0001) continue;

      // Convert shares to underlying USDC for accurate USD display.
      // Falls back to share count if convertToAssets is unavailable.
      let valueUsd = amount;
      try {
        const assets = await contract.convertToAssets(bal);
        valueUsd = parseFloat(ethers.formatUnits(assets, 6)); // USDC is 6 decimals
      } catch {}

      console.log(`  ✅ ${v.protocol} ${v.name}: ${amount.toFixed(4)} ${symbol} (~$${valueUsd.toFixed(2)})`);
      results.push({
        chainId:        v.chainId,
        network:        String(v.chainId),
        vaultAddress:   v.address,
        lpTokenAddress: v.address,
        lpSymbol:       symbol,
        lpDecimals:     Number(decimals),
        lpBalance:      bal,
        amount,
        valueUsd,
        apy:            0,
        protocol:       v.protocol,
        vaultName:      v.name,
        depositPack:    v.depositPack || '',
      });
    } catch {}
  }

  // Remove positions where balanceOf returned zero.
  const activeKeys = new Set(results.map(r => `${r.chainId}-${r.vaultAddress.toLowerCase()}`));
  const remaining  = saved.filter(v => activeKeys.has(`${v.chainId}-${v.address.toLowerCase()}`));
  if (remaining.length !== saved.length) {
    savePositions(remaining);
    console.log(`  🧹 Cleaned ${saved.length - remaining.length} empty position(s)`);
  }

  return results;
}

// ─── Table Display ────────────────────────────────────────────────────────────

function printPositionsTable(positions) {
  const header = ['#', 'Network', 'Protocol', 'Vault', 'Balance', 'Value (USD)'];
  const data   = positions.map((p, i) => [
    `${i + 1}`,
    p.network,
    p.protocol,
    p.vaultName,
    `${p.amount.toFixed(4)} ${p.lpSymbol}`,
    `$${p.valueUsd.toFixed(2)}`,
  ]);
  const cols = header.map((h, i) => Math.max(h.length, ...data.map(r => r[i].length)));
  const sep  = '+-' + cols.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const fmt  = (row) => '| ' + row.map((cell, i) => cell.padEnd(cols[i])).join(' | ') + ' |';
  console.log('\n' + sep);
  console.log(fmt(header));
  console.log(sep);
  data.forEach(row => console.log(fmt(row)));
  console.log(sep);
}

// ─── Withdrawal ───────────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function withdrawPosition(position, walletAddress) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n💰 Position: ${position.amount.toFixed(4)} ${position.lpSymbol} (~$${position.valueUsd.toFixed(2)})`);
    console.log('  1. Withdraw all');
    console.log('  2. Custom amount');
    const choice = await prompt(rl, '\nSelect (1/2): ');
    let amountWei;

    if (choice === '1') {
      amountWei = position.lpBalance;
      console.log(`  Withdrawing all: ${position.amount.toFixed(4)} ${position.lpSymbol}`);
    } else if (choice === '2') {
      const customAmount = await prompt(rl, `  Enter amount (max ${position.amount.toFixed(4)}): `);
      const parsed = parseFloat(customAmount);
      if (isNaN(parsed) || parsed <= 0 || parsed > position.amount) {
        console.log('❌ Invalid amount.'); rl.close(); return;
      }
      amountWei = ethers.parseUnits(parsed.toFixed(position.lpDecimals), position.lpDecimals);
    } else {
      console.log('❌ Invalid choice.'); rl.close(); return;
    }

    const toToken = USDC_ADDRESSES[position.chainId];
    if (!toToken) { console.log('❌ No USDC address.'); rl.close(); return; }

    const provider = await getProviderWithFallback(position.chainId);
    const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // aave-zaps / neverland-zaps → Aave Pool direct withdraw
    if ((position.depositPack === 'aave-zaps' || position.depositPack === 'neverland-zaps') && AAVE_POOLS[position.chainId]) {
      console.log('\n🏦 Withdrawing from Aave directly...');
      const pool           = new ethers.Contract(AAVE_POOLS[position.chainId], AAVE_POOL_ABI, signer);
      // Use valueUsd (underlying USDC amount) for Aave withdraw, not share count.
      const withdrawAmount = choice === '1'
        ? ethers.parseUnits(position.valueUsd.toFixed(6), 6)
        : amountWei;
      const tx = await pool.withdraw(toToken, withdrawAmount, await signer.getAddress());
      console.log(`🔗 Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
      rl.close();
      console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
      return;
    }

    // ERC-4626 redeem → LI.FI fallback on failure
    // estimateGas first to avoid wasting gas on a doomed tx.
    try {
      console.log('\n🔄 Trying ERC-4626 redeem...');
      const vault        = new ethers.Contract(position.vaultAddress, ERC4626_ABI, signer);
      const redeemAmount = choice === '1' ? position.lpBalance : amountWei;
      const signerAddr   = await signer.getAddress();

      await vault.redeem.estimateGas(redeemAmount, signerAddr, signerAddr);

      const tx = await vault.redeem(redeemAmount, signerAddr, signerAddr);
      console.log(`🔗 Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
      rl.close();
      console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
      return;
    } catch (redeemErr) {
      console.log(`  ⚠️  ERC-4626 redeem not available: ${redeemErr.message?.slice(0, 80)}`);
    }

    // LI.FI Composer fallback
    console.log('\n🔍 Getting withdrawal quote...');
    const params = new URLSearchParams({
      fromChain:   position.chainId,
      toChain:     position.chainId,
      fromToken:   position.lpTokenAddress,
      toToken,
      fromAmount:  amountWei.toString(),
      fromAddress: walletAddress,
      toAddress:   walletAddress,
      slippage:    '0.005',
    });
    const res   = await axios.get(`https://li.quest/v1/quote?${params}`, { headers: LIFI_HEADERS });
    const quote = res.data;

    console.log(`\n📋 Withdrawal Plan:`);
    console.log(`  From  : ${position.amount.toFixed(4)} ${position.lpSymbol}`);
    console.log(`  To    : ~${ethers.formatUnits(quote.estimate?.toAmount || '0', 6)} USDC`);
    console.log(`  Gas   : ~$${quote.estimate?.gasCosts?.[0]?.amountUSD || '?'}`);

    const confirm = await prompt(rl, '\n✅ Proceed with withdrawal? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Withdrawal cancelled.'); rl.close(); return;
    }

    // Refresh quote before executing to avoid expiry.
    console.log('\n🔄 Refreshing quote...');
    const res2       = await axios.get(`https://li.quest/v1/quote?${params}`, { headers: LIFI_HEADERS });
    const freshQuote = res2.data;

    await ensureAllowance(signer, freshQuote.action.fromToken.address, freshQuote.estimate.approvalAddress, freshQuote.action.fromAmount);
    const tx = await sendTx(signer, freshQuote.transactionRequest);
    await pollStatus(tx.hash, position.chainId, position.chainId);

    rl.close();
    console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
  } catch (e) {
    console.error('\n❌ Error:', e.response?.data?.message || e.message);
    rl.close();
  }
}


// ─── Non-interactive Withdraw (for rebalance.js) ─────────────────────────────

async function withdrawAll(position) {
  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const toToken = USDC_ADDRESSES[position.chainId];
  if (!toToken) throw new Error(`No USDC address for chain ${position.chainId}`);

  const provider = await getProviderWithFallback(position.chainId);
  const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // aave-zaps / neverland-zaps → Aave Pool direct withdraw
  if ((position.depositPack === 'aave-zaps' || position.depositPack === 'neverland-zaps') && AAVE_POOLS[position.chainId]) {
    console.log('\n🏦 Withdrawing from Aave directly...');
    const pool           = new ethers.Contract(AAVE_POOLS[position.chainId], AAVE_POOL_ABI, signer);
    const withdrawAmount = ethers.parseUnits(position.valueUsd.toFixed(6), 6);
    const tx = await pool.withdraw(toToken, withdrawAmount, walletAddress);
    console.log(`🔗 Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
    return { success: true, txHash: tx.hash };
  }

  // ERC-4626 redeem
  try {
    console.log('\n🔄 Trying ERC-4626 redeem...');
    const vault = new ethers.Contract(position.vaultAddress, ERC4626_ABI, signer);
    await vault.redeem.estimateGas(position.lpBalance, walletAddress, walletAddress);
    const tx = await vault.redeem(position.lpBalance, walletAddress, walletAddress);
    console.log(`🔗 Tx hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
    return { success: true, txHash: tx.hash };
  } catch (redeemErr) {
    console.log(`  ⚠️  ERC-4626 redeem failed: ${redeemErr.message?.slice(0, 60)}`);
  }

  // LI.FI fallback
  console.log('\n🔍 Getting withdrawal quote...');
  const params = new URLSearchParams({
    fromChain:   position.chainId,
    toChain:     position.chainId,
    fromToken:   position.lpTokenAddress,
    toToken,
    fromAmount:  position.lpBalance.toString(),
    fromAddress: walletAddress,
    toAddress:   walletAddress,
    slippage:    '0.005',
  });
  const res        = await axios.get(`https://li.quest/v1/quote?${params}`, { headers: LIFI_HEADERS });
  const freshQuote = res.data;
  await ensureAllowance(signer, freshQuote.action.fromToken.address, freshQuote.estimate.approvalAddress, freshQuote.action.fromAmount);
  const tx = await sendTx(signer, freshQuote.transactionRequest);
  await pollStatus(tx.hash, position.chainId, position.chainId);
  return { success: true, txHash: tx.hash };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const auto   = args.includes('--auto');
  const posArg = args.find(a => !a.startsWith('--'));

  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  console.log(`\n🏦 Vaulthoric — Position Manager`);
  console.log(`👛 Wallet: ${walletAddress}`);

  const positions = await scanPositions(walletAddress);
  if (positions.length === 0) { console.log('\n❌ No vault positions found.'); return; }

  console.log(`\n📊 Your Vault Positions:`);
  printPositionsTable(positions);

  if (auto && posArg) {
    const idx = positions.findIndex(p => p.vaultName?.toLowerCase().includes(posArg.toLowerCase()));
    if (idx === -1) { console.log(`❌ Position "${posArg}" not found.`); return; }
    console.log(`\n⚡ Auto-withdrawing: ${positions[idx].vaultName}`);
    await withdrawAll(positions[idx]);
    console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
    return;
  }

  const rl     = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise(resolve => rl.question('\nSelect position to withdraw (number) or q to quit: ', resolve));
  rl.close();

  if (choice.toLowerCase() === 'q') { console.log('Bye!'); return; }
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= positions.length) { console.log('❌ Invalid selection.'); return; }
  await withdrawPosition(positions[idx], walletAddress);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { scanPositions, withdrawAll };
