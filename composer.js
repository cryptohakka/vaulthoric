const axios = require('axios');
const { ethers } = require('ethers');

const COMPOSER_BASE = 'https://li.quest';
const API_KEY = process.env.LIFI_API_KEY || '';

const headers = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { 'x-lifi-api-key': API_KEY } : {})
};

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Aave v3 Pool addresses
const AAVE_POOLS = {
  8453:  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  1:     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  10:    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  137:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};
const POOL_SUPPLY_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
];

// ERC-4626 ABI（Morpho等）
const ERC4626_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
];

// LI.FI quoteのgas見積もりがこれ以上なら直接depositにフォールバック（USD）
const GAS_FALLBACK_THRESHOLD_USD = 0.05;

// USDC addresses（bridge後のdeposit用）
const USDC_ADDRESSES = {
  8453:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  1:      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  10:     '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  137:    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  143:    '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
};

// quote取得
async function getQuote({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress }) {
  const params = new URLSearchParams({
    fromChain,
    toChain,
    fromToken,
    toToken,
    fromAmount: fromAmount.toString(),
    fromAddress,
    toAddress: fromAddress,
  });

  const res = await axios.get(`${COMPOSER_BASE}/v1/quote?${params}`, { headers });
  return res.data;
}

// token allowance確認・設定
async function ensureAllowance(signer, tokenAddress, approvalAddress, amount) {
  if (tokenAddress === ethers.ZeroAddress) return;

  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const currentAllowance = await erc20.allowance(owner, approvalAddress);

  if (currentAllowance < BigInt(amount)) {
    console.log(`🔓 Approving ${approvalAddress}...`);
    const tx = await erc20.approve(approvalAddress, amount);
    await tx.wait();
    console.log('✅ Approval confirmed');
  } else {
    console.log('✅ Allowance sufficient');
  }
}

// tx送信 + 確認
async function sendTx(signer, transactionRequest) {
  console.log('📤 Sending transaction...');

  // EIP-1559: gasPriceとmaxFeePerGasは共存不可なのでgasPriceを削除
  delete transactionRequest.gasPrice;

  // 常に現在のnetwork feeで上書き+20%バッファ
  const feeData = await signer.provider.getFeeData();
  if (feeData.maxFeePerGas) {
    transactionRequest.maxFeePerGas = (feeData.maxFeePerGas * 120n / 100n).toString();
    transactionRequest.maxPriorityFeePerGas = (
      feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas / 10n
    ).toString();
    console.log(`⚡ Gas set to current fee +20%: ${transactionRequest.maxFeePerGas}`);
  }

  // estimateGasで実際のgasLimit取得+20%バッファ
  try {
    const estimated = await signer.estimateGas(transactionRequest);
    transactionRequest.gasLimit = (estimated * 120n / 100n).toString();
    console.log(`⚡ gasLimit estimated: ${estimated} → ${transactionRequest.gasLimit}`);
  } catch(e) {
    console.log(`  ⚠️  estimateGas failed, using LI.FI value: ${transactionRequest.gasLimit}`);
  }

  const tx = await signer.sendTransaction(transactionRequest);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return tx;
}

// クロスチェーンステータスポーリング
async function pollStatus(txHash, fromChain, toChain, intervalMs = 5000) {
  if (fromChain === toChain) return { status: 'DONE' };

  console.log('⏳ Polling cross-chain status...');
  let status;
  do {
    const res = await axios.get(`${COMPOSER_BASE}/v1/status`, {
      params: { txHash, fromChain, toChain },
      headers
    });
    status = res.data;
    console.log(`📊 Status: ${status.status} ${status.substatus ? '(' + status.substatus + ')' : ''}`);

    if (status.status !== 'DONE' && status.status !== 'FAILED') {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  } while (status.status !== 'DONE' && status.status !== 'FAILED');

  return status;
}

// Aave直接deposit
async function _depositAave(signer, fromTokenAddress, toChainId, amountWei) {
  const fromAddress = await signer.getAddress();
  const poolAddress = AAVE_POOLS[toChainId];
  console.log('\n🏦 Depositing to Aave directly...');
  await ensureAllowance(signer, fromTokenAddress, poolAddress, amountWei);
  const pool = new ethers.Contract(poolAddress, POOL_SUPPLY_ABI, signer);
  const tx = await pool.supply(fromTokenAddress, amountWei, fromAddress, 0);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return { tx, finalStatus: { status: 'DONE' } };
}

// Morpho（ERC-4626）直接deposit
async function _depositERC4626(signer, fromTokenAddress, vaultTokenAddress, amountWei) {
  const fromAddress = await signer.getAddress();
  console.log('\n🔷 Depositing to Morpho vault directly (ERC-4626)...');
  await ensureAllowance(signer, fromTokenAddress, vaultTokenAddress, amountWei);
  const vault = new ethers.Contract(vaultTokenAddress, ERC4626_ABI, signer);
  const tx = await vault.deposit(amountWei, fromAddress);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return { tx, finalStatus: { status: 'DONE' } };
}

// PARTIAL後のリカバリ: toChainのUSDC残高確認 → 直接deposit
async function _recoverPartial({ fromAddress, toChainId, vaultTokenAddress, pack }) {
  const { getProviderWithFallback } = require('./tools');
  const toUsdcAddress = USDC_ADDRESSES[toChainId];
  if (!toUsdcAddress) {
    console.log('  ⚠️  No USDC address for recovery, skipping');
    return null;
  }

  console.log('\n🔄 PARTIAL detected — checking USDC balance on destination chain...');
  // 少し待ってからon-chain確認（bridgeの完了に時間がかかる場合がある）
  await new Promise(r => setTimeout(r, 5000));

  const toProvider = await getProviderWithFallback(toChainId);
  const toSigner = new ethers.Wallet(process.env.PRIVATE_KEY, toProvider);
  const erc20 = new ethers.Contract(toUsdcAddress, ERC20_ABI, toProvider);
  const bal = await erc20.balanceOf(fromAddress);

  if (bal === 0n) {
    console.log('  ⚠️  No USDC found on destination chain yet, manual deposit needed');
    return null;
  }

  console.log(`  Found ${ethers.formatUnits(bal, 6)} USDC — proceeding with direct deposit`);

  if (pack === 'aave-zaps' && AAVE_POOLS[toChainId]) {
    return await _depositAave(toSigner, toUsdcAddress, toChainId, bal);
  }
  if (pack === 'morpho-zaps') {
    return await _depositERC4626(toSigner, toUsdcAddress, vaultTokenAddress, bal);
  }
  console.log(`  ⚠️  No direct deposit support for pack="${pack}"`);
  return null;
}

// 2段階cross-chain deposit: LI.FI bridgeのみ → toChainで直接deposit
async function _depositCrossChain2Step({ signer, fromChainId, toChainId, fromTokenAddress, vaultTokenAddress, amountWei, pack }) {
  const fromAddress = await signer.getAddress();
  const toUsdcAddress = USDC_ADDRESSES[toChainId];
  if (!toUsdcAddress) throw new Error(`No USDC address for chainId ${toChainId}`);

  // ステップ1: LI.FI bridge USDC → toChain USDC
  console.log(`\n🌉 Step 1: Bridging USDC from chain ${fromChainId} → chain ${toChainId}...`);
  const bridgeQuote = await getQuote({
    fromChain: fromChainId,
    toChain: toChainId,
    fromToken: fromTokenAddress,
    toToken: toUsdcAddress,
    fromAmount: amountWei,
    fromAddress,
  });

  const bridgeGasUsd = parseFloat(bridgeQuote.estimate?.gasCosts?.[0]?.amountUSD || '0');
  const bridgedAmount = bridgeQuote.estimate?.toAmount || amountWei;
  console.log(`  Bridge gas: $${bridgeGasUsd} | Est. received: ${ethers.formatUnits(bridgedAmount, 6)} USDC`);

  await ensureAllowance(
    signer,
    bridgeQuote.action.fromToken.address,
    bridgeQuote.estimate.approvalAddress,
    bridgeQuote.action.fromAmount
  );

  const bridgeTx = await sendTx(signer, bridgeQuote.transactionRequest);
  const bridgeStatus = await pollStatus(bridgeTx.hash, fromChainId, toChainId);

  if (bridgeStatus.status === 'FAILED') throw new Error('Bridge failed');
  console.log(`✅ Bridge complete`);

  // ステップ2: toChainのsignerでdirect deposit
  console.log(`\n🏦 Step 2: Depositing to vault on chain ${toChainId}...`);
  const { getProviderWithFallback } = require('./tools');
  const toProvider = await getProviderWithFallback(toChainId);
  const toSigner = new ethers.Wallet(process.env.PRIVATE_KEY, toProvider);

  if (pack === 'aave-zaps' && AAVE_POOLS[toChainId]) {
    return await _depositAave(toSigner, toUsdcAddress, toChainId, bridgedAmount);
  }
  if (pack === 'morpho-zaps') {
    return await _depositERC4626(toSigner, toUsdcAddress, vaultTokenAddress, bridgedAmount);
  }
  throw new Error(`No direct deposit support for pack="${pack}" on cross-chain fallback`);
}

// メイン実行関数: fromToken → vault deposit
async function depositToVault({ signer, fromChainId, toChainId, fromTokenAddress, vaultTokenAddress, amountWei, depositPack }) {
  const fromAddress = await signer.getAddress();
  const isSameChain = fromChainId === toChainId;
  const pack = depositPack || '';

  // ステップ1: LI.FI quoteを取得してgas見積もり確認
  console.log(`\n🔍 Getting LI.FI quote...`);
  console.log(`  From: chain=${fromChainId} token=${fromTokenAddress}`);
  console.log(`  To:   chain=${toChainId} vault=${vaultTokenAddress}`);
  console.log(`  Amount: ${amountWei}`);

  let quote = null;
  let quoteGasUsd = null;

  try {
    quote = await getQuote({
      fromChain: fromChainId,
      toChain: toChainId,
      fromToken: fromTokenAddress,
      toToken: vaultTokenAddress,
      fromAmount: amountWei,
      fromAddress,
    });
    quoteGasUsd = parseFloat(quote.estimate?.gasCosts?.[0]?.amountUSD || '0');
    console.log(`\n💡 Quote received:`);
    console.log(`  Est. output: ${quote.estimate?.toAmount} ${quote.action?.toToken?.symbol}`);
    console.log(`  Gas est: $${quoteGasUsd} USD`);
  } catch (e) {
    console.log(`  ⚠️  LI.FI quote failed: ${e.message}`);
  }

  // ステップ2: gasが高すぎる or quoteが取れなかった場合はフォールバック
  const gasIsTooHigh = quoteGasUsd !== null && quoteGasUsd > GAS_FALLBACK_THRESHOLD_USD;
  const quoteFailed = quote === null;

  if (gasIsTooHigh || quoteFailed) {
    if (gasIsTooHigh) {
      console.log(`\n⚠️  LI.FI gas $${quoteGasUsd} exceeds $${GAS_FALLBACK_THRESHOLD_USD} — falling back to direct deposit`);
    }

    if (isSameChain) {
      if (pack === 'aave-zaps' && AAVE_POOLS[toChainId]) {
        return await _depositAave(signer, fromTokenAddress, toChainId, amountWei);
      }
      if (pack === 'morpho-zaps') {
        return await _depositERC4626(signer, fromTokenAddress, vaultTokenAddress, amountWei);
      }
    } else {
      console.log(`\n🔀 Cross-chain fallback: bridge → direct deposit`);
      return await _depositCrossChain2Step({
        signer, fromChainId, toChainId, fromTokenAddress,
        vaultTokenAddress, amountWei, pack,
      });
    }
    console.log(`  ⚠️  No direct deposit support for pack="${pack}", proceeding with LI.FI anyway`);
  }

  // ステップ3: LI.FI Composer経由で実行（1段階）
  if (!quote) {
    throw new Error('LI.FI quote unavailable and no direct deposit fallback');
  }

  await ensureAllowance(
    signer,
    quote.action.fromToken.address,
    quote.estimate.approvalAddress,
    quote.action.fromAmount
  );

  const tx = await sendTx(signer, quote.transactionRequest);
  const finalStatus = await pollStatus(tx.hash, fromChainId, toChainId);
  console.log(`\n🏁 Final status: ${finalStatus.status}`);

  // DONE (PARTIAL): bridgeは成功したがvault depositが未完 → リカバリ
  if (finalStatus.status === 'DONE' && finalStatus.substatus === 'PARTIAL') {
    console.log('\n⚠️  Bridge succeeded but vault deposit incomplete — attempting recovery...');
    const recovered = await _recoverPartial({ fromAddress, toChainId, vaultTokenAddress, pack });
    if (recovered) return recovered;
  }

  return { tx, quote, finalStatus };
}

// walletの残高確認
async function getTokenBalance(provider, tokenAddress, walletAddress) {
  if (tokenAddress === ethers.ZeroAddress) {
    const balance = await provider.getBalance(walletAddress);
    return { balance, symbol: 'ETH', decimals: 18 };
  }
  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const balance = await erc20.balanceOf(walletAddress);
  let symbol = 'USDC', decimals = 6;
  try {
    [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  } catch (e) {
    // fallbackのままで続行
  }
  return { balance, symbol, decimals };
}

module.exports = { getQuote, ensureAllowance, sendTx, pollStatus, depositToVault, getTokenBalance };
