require('dotenv').config();

// ethers.jsの内部RPCエラーログを抑制
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  const msg = chunk.toString();
  if (msg.includes('JsonRpcProvider failed') || msg.includes('retry in')) return true;
  return originalStderrWrite(chunk, ...args);
};

const axios = require('axios');
const readline = require('readline');
const { ethers } = require('ethers');
const { getVaults, getPortfolio } = require('./earn');
const { ensureAllowance, sendTx, pollStatus } = require('./composer');
const { getChainName, getProviderWithFallback, getScanChainIds } = require('./tools');

const USDC_ADDRESSES = {
  1:      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  10:     '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  56:     '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  137:    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  8453:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  43114:  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  59144:  '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  534352: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
};

const BALANCE_OF_ABI = ['function balanceOf(address) view returns (uint256)'];
const LIFI_API_KEY = process.env.LIFI_API_KEY || '';
const LIFI_HEADERS = LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : {};

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// バッチでbalanceOfを呼ぶ（RPC batch制限対応、5件ずつ）
async function batchBalanceOf(provider, addresses, walletAddress, batchSize = 5) {
  const results = [];
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(addr => {
        const contract = new ethers.Contract(addr, BALANCE_OF_ABI, provider);
        return contract.balanceOf(walletAddress);
      })
    );
    results.push(...batchResults);
  }
  return results;
}

// 全チェーンのvaultポジションをスキャン
async function scanPositions(walletAddress) {
  console.log('\n📡 Scanning vault positions...');

  // まずLI.FI portfolio APIを試す
  try {
    const apiPositions = await getPortfolio(walletAddress);
    if (apiPositions.length > 0) {
      console.log('  ✅ Using LI.FI portfolio API');
      return apiPositions.map(p => ({
        chainId: p.chainId,
        network: String(p.chainId),
        vaultAddress: p.asset.address,
        lpTokenAddress: p.asset.address,
        lpSymbol: p.asset.symbol,
        lpDecimals: p.asset.decimals,
        lpBalance: BigInt(p.balanceNative),
        amount: parseFloat(ethers.formatUnits(p.balanceNative, p.asset.decimals)),
        valueUsd: parseFloat(p.balanceUsd),
        apy: 0,
        protocol: p.protocolName,
        vaultName: p.asset.name,
        isRedeemable: true,
        source: 'api',
      }));
    }
  } catch (e) { /* fallthrough */ }

  console.log('  Portfolio API empty, scanning on-chain...');

  const allVaults = await getVaults({ minTvlUsd: 0 });
  const positions = [];

  // isRedeemable && redeemPacks対応のvaultのみ対象
  const redeemableVaults = allVaults.filter(v =>
    v.isRedeemable && v.redeemPacks && v.redeemPacks.length > 0
  );

  // デモ用：Baseのみ（全チェーンは getScanChainIds() に変更）
  for (const chainId of [8453]) {
    const chainVaults = redeemableVaults.filter(v => v.chainId === chainId);
    if (chainVaults.length === 0) continue;

    let provider;
    try {
      provider = await getProviderWithFallback(chainId);
    } catch (e) {
      console.log(`  ⚠️  No RPC for ${getChainName(chainId)}`);
      continue;
    }

    // lpTokenアドレス一覧（vault addressをフォールバック）
    const lpAddresses = chainVaults.map(v =>
      ethers.getAddress(v.lpTokens?.[0]?.address || v.address)
    );

    // バッチでbalanceOf
    const balances = await batchBalanceOf(provider, lpAddresses, walletAddress);

    balances.forEach((result, idx) => {
      if (result.status !== 'fulfilled') return;
      const balance = result.value;
      if (BigInt(balance.toString()) === 0n) return;

      const vault = chainVaults[idx];
      const lpDecimals = vault.lpTokens?.[0]?.decimals ?? 6;
      const lpSymbol = vault.lpTokens?.[0]?.symbol || vault.name;
      const amount = parseFloat(ethers.formatUnits(balance, lpDecimals));
      if (amount < 0.0001) return;

      const priceUsd = parseFloat(vault.lpTokens?.[0]?.priceUsd || '1');
      const valueUsd = amount * priceUsd;

      const position = {
        chainId,
        network: vault.network,
        vaultAddress: vault.address,
        lpTokenAddress: lpAddresses[idx],
        lpSymbol,
        lpDecimals,
        lpBalance: balance,
        amount,
        valueUsd,
        apy: vault.analytics?.apy?.total || 0,
        protocol: vault.protocol.name,
        vaultName: vault.name,
        isRedeemable: true,
      };

      positions.push(position);
      console.log(`  ✅ ${getChainName(chainId).padEnd(12)} | ${amount.toFixed(4)} ${lpSymbol} (~$${valueUsd.toFixed(2)}) | ${vault.protocol.name} ${vault.name}`);
    });
  }

  return positions;
}

// ポジション一覧テーブル表示
function printPositionsTable(positions) {
  const header = ['#', 'Network', 'Protocol', 'Vault', 'Balance', 'Value (USD)', 'APY%'];
  const data = positions.map((p, i) => [
    `${i + 1}`,
    p.network,
    p.protocol,
    p.vaultName.slice(0, 18),
    `${p.amount.toFixed(4)} ${p.lpSymbol}`,
    `$${p.valueUsd.toFixed(2)}`,
    `${p.apy.toFixed(2)}%`,
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

// 引き出し実行
async function withdrawPosition(position, walletAddress) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 引き出し額選択
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
        console.log('❌ Invalid amount.');
        rl.close();
        return;
      }
      amountWei = ethers.parseUnits(parsed.toFixed(position.lpDecimals), position.lpDecimals);
      console.log(`  Withdrawing: ${parsed} ${position.lpSymbol}`);
    } else {
      console.log('❌ Invalid choice.');
      rl.close();
      return;
    }

    // toTokenはUSDC
    const toTokenAddress = USDC_ADDRESSES[position.chainId];
    if (!toTokenAddress) {
      console.log(`❌ No USDC address for chain ${position.chainId}`);
      rl.close();
      return;
    }

    // Composer quoteで引き出し
    console.log('\n🔍 Getting withdrawal quote...');
    const params = new URLSearchParams({
      fromChain: position.chainId,
      toChain: position.chainId,
      fromToken: position.lpTokenAddress,
      toToken: toTokenAddress,
      fromAmount: amountWei.toString(),
      fromAddress: walletAddress,
      toAddress: walletAddress,
    });

    const res = await axios.get(`https://li.quest/v1/quote?${params}`, { headers: LIFI_HEADERS });
    const quote = res.data;

    console.log(`\n📋 Withdrawal Plan:`);
    console.log(`  From  : ${position.amount.toFixed(4)} ${position.lpSymbol} (${position.protocol} on ${position.network})`);
    console.log(`  To    : ~${ethers.formatUnits(quote.estimate?.toAmount || '0', 6)} USDC`);
    console.log(`  Gas   : ~$${quote.estimate?.gasCosts?.[0]?.amountUSD || '?'}`);

    const confirm = await prompt(rl, '\n✅ Proceed with withdrawal? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Withdrawal cancelled.');
      rl.close();
      return;
    }

    // approve + sendTx
    const provider = await getProviderWithFallback(position.chainId);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    await ensureAllowance(
      signer,
      quote.action.fromToken.address,
      quote.estimate.approvalAddress,
      quote.action.fromAmount
    );

    const tx = await sendTx(signer, quote.transactionRequest);
    await pollStatus(tx.hash, position.chainId, position.chainId);

    console.log('\n🎉 Withdrawal complete! Stay Vaulthoric.');
    rl.close();
    return tx;

  } catch (e) {
    console.error('\n❌ Error:', e.response?.data?.message || e.message);
    rl.close();
  }
}

// メインフロー
async function main() {
  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  console.log(`\n🏦 Vaulthoric — Position Manager`);
  console.log(`👛 Wallet: ${walletAddress}`);

  const positions = await scanPositions(walletAddress);

  if (positions.length === 0) {
    console.log('\n❌ No vault positions found.');
    return;
  }

  console.log(`\n📊 Your Vault Positions:`);
  printPositionsTable(positions);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise(resolve => rl.question('\nSelect position to withdraw (number) or q to quit: ', resolve));
  rl.close();

  if (choice.toLowerCase() === 'q') {
    console.log('Bye!');
    return;
  }

  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= positions.length) {
    console.log('❌ Invalid selection.');
    return;
  }

  await withdrawPosition(positions[idx], walletAddress);
}

main().catch(console.error);
