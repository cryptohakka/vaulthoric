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
  if (tokenAddress === ethers.ZeroAddress) return; // nativeトークンはスキップ

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
  const tx = await signer.sendTransaction(transactionRequest);
  console.log(`🔗 Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block: ${receipt.blockNumber}`);
  return tx;
}

// クロスチェーンステータスポーリング
async function pollStatus(txHash, fromChain, toChain, intervalMs = 5000) {
  if (fromChain === toChain) return { status: 'DONE' }; // same-chainはスキップ

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

// メイン実行関数: fromToken → vault deposit
async function depositToVault({ signer, fromChainId, toChainId, fromTokenAddress, vaultTokenAddress, amountWei }) {
  const fromAddress = await signer.getAddress();

  console.log(`\n🔍 Getting quote...`);
  console.log(`  From: chain=${fromChainId} token=${fromTokenAddress}`);
  console.log(`  To:   chain=${toChainId} vault=${vaultTokenAddress}`);
  console.log(`  Amount: ${amountWei}`);

  const quote = await getQuote({
    fromChain: fromChainId,
    toChain: toChainId,
    fromToken: fromTokenAddress,
    toToken: vaultTokenAddress,
    fromAmount: amountWei,
    fromAddress,
  });

  console.log(`\n💡 Quote received:`);
  console.log(`  Est. output: ${quote.estimate?.toAmount} ${quote.action?.toToken?.symbol}`);
  console.log(`  Gas est: ${quote.estimate?.gasCosts?.[0]?.amountUSD} USD`);

  // allowance設定
  await ensureAllowance(
    signer,
    quote.action.fromToken.address,
    quote.estimate.approvalAddress,
    quote.action.fromAmount
  );

  // tx送信
  const tx = await sendTx(signer, quote.transactionRequest);

  // ステータス確認
  const finalStatus = await pollStatus(tx.hash, fromChainId, toChainId);
  console.log(`\n🏁 Final status: ${finalStatus.status}`);

  return { tx, quote, finalStatus };
}

// walletの残高確認
async function getTokenBalance(provider, tokenAddress, walletAddress) {
  if (tokenAddress === ethers.ZeroAddress) {
    const balance = await provider.getBalance(walletAddress);
    return { balance, symbol: 'ETH', decimals: 18 };
  }
  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [balance, symbol, decimals] = await Promise.all([
    erc20.balanceOf(walletAddress),
    erc20.symbol(),
    erc20.decimals(),
  ]);
  return { balance, symbol, decimals };
}

module.exports = { getQuote, ensureAllowance, sendTx, pollStatus, depositToVault, getTokenBalance };
