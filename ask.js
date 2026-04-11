// Vaulthoric — Natural Language Yield Agent
// Parses a plain-English instruction, finds the best vault, and executes deposit.

require('dotenv').config();

const axios    = require('axios');
const readline = require('readline');
const { ethers } = require('ethers');
const { getVaults }    = require('./earn');
const { rankVaults }   = require('./scorer');
const { depositToVault, getTokenBalance } = require('./composer');
const { printVaultTable } = require('./agent');
const {
  getChainName,
  getUsdcAddress,
  getScanChainIds,
  getProviderWithFallback,
  CHAIN_NAME_TO_ID,
  recordPosition,
  suppressRpcNoise,
} = require('./tools');

suppressRpcNoise();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5';

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ─── LLM Instruction Parser ───────────────────────────────────────────────────

async function parseInstruction(instruction) {
  const chainList = Object.entries(CHAIN_NAME_TO_ID)
    .map(([name, id]) => `${name}(${id})`).join(', ');

  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model:      OPENROUTER_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `Extract DeFi vault deposit parameters from user instruction. Return JSON only, no explanation.
Supported chains: ${chainList}
Output format:
{
  "asset": "USDC",
  "fromChainId": null,
  "chainId": 42161,
  "minApy": 5.0,
  "amount": null,
  "mode": "balanced"
}

fromChainId rules:
- "from Arbitrum", "my Arbitrum USDC", "using Base funds" → fromChainId: that chain's ID
- If source chain not specified → fromChainId: null (will auto-detect from wallet)

chainId rules:
- "into Base vault", "on Optimism", "deposit to Arbitrum" → chainId: that chain's ID
- If destination chain not specified → chainId: null (search all chains)

Mode selection rules (choose exactly one):
- "safe", "safest", "secure", "low risk", "conservative" → mode: "safest"
- "best", "optimal", "recommended", "good", "balanced"  → mode: "balanced"
- "highest", "maximum", "max yield", "most yield", "highest APY" → mode: "highest"
- default when unclear → mode: "balanced"

minApy rules:
- Extract explicit APY thresholds ("above 5%", "at least 3%", "minimum 7%") → minApy: number
- If no APY threshold mentioned → minApy: null`,
        },
        { role: 'user', content: instruction },
      ],
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://vaulthoric.xyz',
        'X-Title':       'Vaulthoric Agent',
      },
    }
  );
  const raw = res.data.choices[0].message.content.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Balance Check ────────────────────────────────────────────────────────────

async function checkBalance(chainId, walletAddress) {
  const tokenAddress = getUsdcAddress(chainId);
  if (!tokenAddress) return null;
  try {
    const provider = await getProviderWithFallback(chainId);
    const { balance, symbol, decimals } = await getTokenBalance(provider, tokenAddress, walletAddress);
    const usd = parseFloat(ethers.formatUnits(balance, decimals));
    return { balance, symbol, decimals, usd, tokenAddress, chainId };
  } catch {
    return null;
  }
}

// ─── Vault Filter ─────────────────────────────────────────────────────────────

function filterVaults(ranked, { minApy, mode } = {}) {
  let filtered = minApy ? ranked.filter(v => v.apy >= minApy) : [...ranked];
  if (mode === 'safest') {
    filtered.sort((a, b) => (b.stability * b.trust) - (a.stability * a.trust));
  } else if (mode === 'highest') {
    filtered.sort((a, b) => b.apy - a.apy);
  } else {
    filtered.sort((a, b) => b.score - a.score);
  }
  return filtered;
}

// ─── Main Flow ────────────────────────────────────────────────────────────────

async function run(instruction, walletAddress) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n🤖 Vaulthoric Agent');
    console.log('===================');
    console.log(`📝 Instruction: "${instruction}"`);

    // Step 1: Parse natural language instruction
    console.log('\n🧠 Parsing instruction...');
    let params;
    try {
      params = await parseInstruction(instruction);
      console.log(`  Asset: ${params.asset || 'USDC'} | From: ${params.fromChainId ? getChainName(params.fromChainId) : 'auto'} | To: ${params.chainId ? getChainName(params.chainId) : 'any'} | Min APY: ${params.minApy || 'any'}% | Amount: ${params.amount ? '$' + params.amount : 'all'} | Mode: ${params.mode || 'balanced'}`);
    } catch {
      console.log('  ⚠️  Could not parse instruction, using defaults');
      params = { asset: 'USDC', fromChainId: null, chainId: null, minApy: null, amount: null, mode: 'balanced' };
    }

    const asset = params.asset || 'USDC';

    // Step 2: Resolve balance
    // Priority:
    //   1. fromChainId specified → use that chain only
    //   2. chainId specified, no fromChainId → check destination first, then scan all
    //   3. Neither specified → scan all chains
    console.log(`\n💰 Checking ${asset} balance...`);
    let balanceInfo = null;

    if (params.fromChainId) {
      balanceInfo = await checkBalance(params.fromChainId, walletAddress);
      if (balanceInfo && balanceInfo.usd > 0.01) {
        console.log(`  ${getChainName(params.fromChainId)}: ${balanceInfo.usd.toFixed(4)} ${asset}`);
      } else {
        console.log(`  ❌ No ${asset} found on ${getChainName(params.fromChainId)}`);
        rl.close(); return;
      }
    } else if (params.chainId) {
      const b = await checkBalance(params.chainId, walletAddress);
      if (b && b.usd > 0.01) {
        balanceInfo = b;
        console.log(`  ${getChainName(params.chainId)}: ${b.usd.toFixed(4)} ${asset}`);
      } else {
        console.log(`  ${getChainName(params.chainId)}: no balance — scanning all chains...`);
        for (const chainId of getScanChainIds()) {
          if (chainId === params.chainId) continue;
          const b2 = await checkBalance(chainId, walletAddress);
          if (b2 && b2.usd > 0.01) {
            if (!balanceInfo || b2.usd > balanceInfo.usd) balanceInfo = b2;
            console.log(`  ${getChainName(chainId).padEnd(12)}: ${b2.usd.toFixed(4)} ${asset}`);
          }
        }
      }
    } else {
      for (const chainId of getScanChainIds()) {
        const b = await checkBalance(chainId, walletAddress);
        if (b && b.usd > 0.01) {
          if (!balanceInfo || b.usd > balanceInfo.usd) balanceInfo = b;
          console.log(`  ${getChainName(chainId).padEnd(12)}: ${b.usd.toFixed(4)} ${asset}`);
        }
      }
    }

    if (!balanceInfo || balanceInfo.usd < 0.01) {
      console.log(`\n❌ No ${asset} balance found. Cannot proceed.`);
      rl.close(); return;
    }

    const depositAmount = params.amount ? Math.min(params.amount, balanceInfo.usd) : balanceInfo.usd;
    const fromChainId   = balanceInfo.chainId;
    console.log(`\n  Using: $${depositAmount.toFixed(2)} ${asset} from ${getChainName(fromChainId)}`);

    // Step 3: Search vaults
    console.log(`\n🔍 Searching vaults...`);
    const allVaults  = await getVaults({ asset, minTvlUsd: 500000 });
    const chainVaults = params.chainId
      ? allVaults.filter(v => v.chainId === params.chainId)
      : allVaults;

    let ranked   = rankVaults(chainVaults, depositAmount, fromChainId);
    let filtered = filterVaults(ranked, { minApy: params.minApy, mode: params.mode });

    // Step 4: Vault selection with fallback
    let selectedVault = null;

    if (filtered.length > 0) {
      selectedVault = filtered[0];
    } else if (params.minApy) {
      console.log(`\n  ⚠️  No vault with APY >= ${params.minApy}% on ${getChainName(params.chainId)}`);
      const lowerApy = params.minApy * 0.6;
      const fallback1 = filterVaults(ranked, { minApy: lowerApy, mode: params.mode });

      if (fallback1.length > 0) {
        console.log(`  Best available: ${fallback1[0].apy}% APY (${fallback1[0].vault.protocol} on ${fallback1[0].vault.network})`);
        const ans = await prompt(rl, `  Accept ${fallback1[0].apy}% APY? (below your ${params.minApy}% target) (y/n): `);
        if (ans.toLowerCase() === 'y') selectedVault = fallback1[0];
      }

      if (!selectedVault) {
        console.log(`\n  Searching all chains for APY >= ${params.minApy}%...`);
        const allRanked = rankVaults(allVaults, depositAmount, fromChainId);
        const fallback2 = filterVaults(allRanked, { minApy: params.minApy, mode: params.mode });

        if (fallback2.length > 0) {
          console.log(`  Found: ${fallback2[0].vault.name} (${fallback2[0].vault.protocol}) on ${fallback2[0].vault.network} — ${fallback2[0].apy}% APY`);
          const ans2 = await prompt(rl, `  Accept vault on ${fallback2[0].vault.network}? (y/n): `);
          if (ans2.toLowerCase() === 'y') {
            selectedVault = fallback2[0];
          } else {
            console.log('\n❌ No suitable vault accepted. Exiting.');
            rl.close(); return;
          }
        } else {
          console.log(`\n❌ No vault found with APY >= ${params.minApy}% across all chains.`);
          rl.close(); return;
        }
      }
    } else {
      selectedVault = ranked[0];
    }

    if (!selectedVault) {
      console.log('\n❌ No suitable vault found. Exiting.');
      rl.close(); return;
    }

    // Step 5: Present proposal
    const needsBridge = fromChainId !== selectedVault.vault.chainId;
    console.log(`\n📋 Vault Proposal:`);
    console.log(`  Vault     : ${selectedVault.vault.name} (${selectedVault.vault.protocol})`);
    console.log(`  Network   : ${selectedVault.vault.network} (chain=${selectedVault.vault.chainId})`);
    console.log(`  APY       : ${selectedVault.apy}% → Net APY: ${selectedVault.netApy}%`);
    console.log(`  Stability : ${selectedVault.stability} | Trust: ${selectedVault.trust}`);
    console.log(`  TVL       : $${(selectedVault.tvlUsd / 1e6).toFixed(1)}M`);
    console.log(`  Deposit   : $${depositAmount.toFixed(2)} ${asset} from ${getChainName(fromChainId)}`);
    console.log(`  Gas est.  : $${selectedVault.totalGasCost.toFixed(2)}${needsBridge ? ' (incl. bridge)' : ''}`);
    console.log(`  Net yield : $${selectedVault.netYield.toFixed(2)}/year`);

    // Step 6: Confirm
    const confirm = await prompt(rl, '\n✅ Proceed with deposit? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Deposit cancelled.');
      rl.close(); return;
    }

    // Step 7: Execute
    console.log('\n🚀 Executing deposit...');
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error('PRIVATE_KEY not set');

    const provider  = await getProviderWithFallback(fromChainId);
    const signer    = new ethers.Wallet(pk, provider);
    const amountWei = ethers.parseUnits(depositAmount.toFixed(6), balanceInfo.decimals);

    const result = await depositToVault({
      signer,
      fromChainId,
      toChainId:          selectedVault.vault.chainId,
      fromTokenAddress:   balanceInfo.tokenAddress,
      vaultTokenAddress:  selectedVault.vault.address,
      amountWei:          amountWei.toString(),
      depositPack:        selectedVault.vault.depositPacks?.[0]?.name || '',
    });

    recordPosition(selectedVault.vault, selectedVault.vault.chainId);
    console.log('\n🎉 Deposit complete! Stay Vaulthoric.');
    rl.close();
    return result;

  } catch (e) {
    console.error('\n❌ Error:', e.message);
    rl.close();
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const instruction = process.argv.slice(2).join(' ');
  if (!instruction) {
    console.log(`
🏦 Vaulthoric — Natural Language Yield Agent
Stay Vaulthoric.

Usage:
  node ask.js "<instruction>"

Examples:
  node ask.js "put my USDC from Arbitrum into highest yield vault on Base"
  node ask.js "find the safest USDC vault above 5% APY on Arbitrum"
  node ask.js "deposit 100 USDC into a stable vault"
    `);
    return;
  }

  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  console.log(`\n👛 Wallet: ${walletAddress}`);
  await run(instruction, walletAddress);
}

main().catch(console.error);

module.exports = { run, parseInstruction };
