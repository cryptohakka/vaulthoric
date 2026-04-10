require('dotenv').config();

const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const msg = chunk.toString();
  if (msg.includes('JsonRpcProvider failed') || msg.includes('retry in 1s')) return true;
  return originalStderrWrite(chunk, ...args);
};

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ethers } = require('ethers');
const { getProviderWithFallback } = require('./tools');
const { ensureAllowance, sendTx, pollStatus } = require('./composer');

const LIFI_API_KEY = process.env.LIFI_API_KEY || '';
const AAVE_POOLS = {
  8453:  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  1:     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  10:    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  137:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};
const POOL_ABI = ['function withdraw(address asset, uint256 amount, address to) returns (uint256)'];
const LIFI_HEADERS = LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : {};
const BAL_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const USDC = {
  8453:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  1:      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  10:     '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  137:    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

// ERC-4626 withdraw ABI（Morpho等）
const ERC4626_ABI = [
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
];

const POSITIONS_FILE = path.join(__dirname, 'positions.json');

function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function savePositions(positions) {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

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
      const bal = await contract.balanceOf(walletAddress);

      if (bal === 0n) continue;

      // on-chainでdecimals/symbolを取得（記録値より正確）
      let decimals = v.decimals || 18;
      let symbol = v.symbol || '?';
      try {
        decimals = await contract.decimals();
        symbol = await contract.symbol();
      } catch (e) {}

      const amount = parseFloat(ethers.formatUnits(bal, decimals));
      if (amount < 0.0001) continue;

      console.log(`  ✅ ${v.protocol} ${v.name}: ${amount.toFixed(4)} ${symbol}`);
      results.push({
        chainId: v.chainId,
        network: String(v.chainId),
        vaultAddress: v.address,
        lpTokenAddress: v.address,
        lpSymbol: symbol,
        lpDecimals: Number(decimals),
        lpBalance: bal,
        amount,
        valueUsd: amount,
        apy: 0,
        protocol: v.protocol,
        vaultName: v.name,
        depositPack: v.depositPack || '',
      });
    } catch (e) {}
  }

  // balanceOf=0になったpositionをpositions.jsonから削除
  const activeAddresses = new Set(results.map(r => `${r.chainId}-${r.vaultAddress.toLowerCase()}`));
  const remaining = saved.filter(v => {
    const key = `${v.chainId}-${v.address.toLowerCase()}`;
    return activeAddresses.has(key);
  });
  if (remaining.length !== saved.length) {
    savePositions(remaining);
    console.log(`  🧹 Cleaned ${saved.length - remaining.length} empty position(s)`);
  }

  return results;
}

function printPositionsTable(positions) {
  const header = ['#', 'Network', 'Protocol', 'Vault', 'Balance', 'Value (USD)'];
  const data = positions.map((p, i) => [
    `${i + 1}`,
    p.network,
    p.protocol,
    p.vaultName,
    `${p.amount.toFixed(4)} ${p.lpSymbol}`,
    `$${p.valueUsd.toFixed(2)}`,
  ]);
  const cols = header.map((h, i) => Math.max(h.length, ...data.map(r => r[i].length)));
  const sep = '+-' + cols.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const fmt = (row) => '| ' + row.map((cell, i) => cell.padEnd(cols[i])).join(' | ') + ' |';
  console.log('\n' + sep);
  console.log(fmt(header));
  console.log(sep);
  data.forEach(row => console.log(fmt(row)));
  console.log(sep);
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

    const toToken = USDC[position.chainId];
    if (!toToken) { console.log('❌ No USDC address.'); rl.close(); return; }

    const provider = await getProviderWithFallback(position.chainId);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // aave-zaps → Aave直接withdraw
    if (position.depositPack === 'aave-zaps' && AAVE_POOLS[position.chainId]) {
      console.log('\n🏦 Withdrawing from Aave directly...');
      const pool = new ethers.Contract(AAVE_POOLS[position.chainId], POOL_ABI, signer);
      const withdrawAmount = choice === '1' ? ethers.MaxUint256 : amountWei;
      const tx = await pool.withdraw(toToken, withdrawAmount, await signer.getAddress());
      console.log(`🔗 Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
      rl.close();
      console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
      return;
    }

    // morpho-zaps → ERC-4626 redeem直接
    if (position.depositPack === 'morpho-zaps') {
      console.log('\n🔷 Withdrawing from Morpho vault directly (ERC-4626 redeem)...');
      const vault = new ethers.Contract(position.vaultAddress, ERC4626_ABI, signer);
      const redeemAmount = choice === '1' ? position.lpBalance : amountWei;
      const tx = await vault.redeem(redeemAmount, await signer.getAddress(), await signer.getAddress());
      console.log(`🔗 Tx hash: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
      rl.close();
      console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
      return;
    }

    // その他 → LI.FI Composer経由
    console.log('\n🔍 Getting withdrawal quote...');
    const params = new URLSearchParams({
      fromChain: position.chainId, toChain: position.chainId,
      fromToken: position.lpTokenAddress, toToken,
      fromAmount: amountWei.toString(),
      fromAddress: walletAddress, toAddress: walletAddress,
      slippage: '0.03',
    });
    const res = await axios.get(`https://li.quest/v1/quote?${params}`, { headers: LIFI_HEADERS });
    const quote = res.data;

    console.log(`\n📋 Withdrawal Plan:`);
    console.log(`  From  : ${position.amount.toFixed(4)} ${position.lpSymbol}`);
    console.log(`  To    : ~${ethers.formatUnits(quote.estimate?.toAmount || '0', 6)} USDC`);
    console.log(`  Gas   : ~$${quote.estimate?.gasCosts?.[0]?.amountUSD || '?'}`);

    const confirm = await prompt(rl, '\n✅ Proceed with withdrawal? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Withdrawal cancelled.'); rl.close(); return;
    }

    console.log('\n🔄 Refreshing quote...');
    const res2 = await axios.get(`https://li.quest/v1/quote?${params}`, { headers: LIFI_HEADERS });
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

async function main() {
  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  console.log(`\n🏦 Vaulthoric — Position Manager`);
  console.log(`👛 Wallet: ${walletAddress}`);

  const positions = await scanPositions(walletAddress);
  if (positions.length === 0) { console.log('\n❌ No vault positions found.'); return; }

  console.log(`\n📊 Your Vault Positions:`);
  printPositionsTable(positions);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise(resolve => rl.question('\nSelect position to withdraw (number) or q to quit: ', resolve));
  rl.close();

  if (choice.toLowerCase() === 'q') { console.log('Bye!'); return; }
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= positions.length) { console.log('❌ Invalid selection.'); return; }
  await withdrawPosition(positions[idx], walletAddress);
}

main().catch(console.error);
