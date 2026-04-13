// Vaulthoric — Natural Language Yield Agent
// Parses a plain-English instruction, finds the best vault, and executes deposit.

require('dotenv').config();

const axios    = require('axios');
const readline = require('readline');
const AUTO_MODE = process.argv.includes('--auto');
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
  recordTx,
} = require('./tools');

suppressRpcNoise();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5';

function prompt(rl, question) {
  if (AUTO_MODE) {
    console.log(question + 'y (auto)');
    return Promise.resolve('y');
  }
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

// ─── AI Vault Analysis ───────────────────────────────────────────────────────

async function generateWhyAnalysis(candidate, depositUsd) {
  if (!OPENROUTER_API_KEY) return null;
  try {
    const costRatio = candidate.totalGasCost > 0 && depositUsd * (candidate.apy / 100) > 0
      ? ((candidate.totalGasCost / (depositUsd * (candidate.apy / 100))) * 100).toFixed(1)
      : 'N/A';

    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:      OPENROUTER_MODEL,
        max_tokens: 120,
        messages: [
          {
            role: 'system',
            content: `You are a DeFi investment analyst. Explain in 2-4 sentences why this vault was selected. Use risk-adjusted reasoning and simple language. No hype, no bullet points, no markdown. Plain text only.`,
          },
          {
            role: 'user',
            content: `Vault: ${candidate.vault.name} (${candidate.vault.protocol})
Network: ${candidate.vault.network}
APY: ${candidate.apy}%
Stability: ${candidate.stability.toFixed(3)} / 1.0 (30-day consistency)
TVL: $${(candidate.tvlUsd / 1e6).toFixed(1)}M
Trust score: ${candidate.trust}
Risk: ${candidate.trust >= 1.25 && candidate.stability >= 0.9 ? 'Low' : candidate.trust >= 1.1 && candidate.stability >= 0.7 ? 'Low-Medium' : 'Medium'}
Gas cost ratio: ${costRatio}% of annual yield
Deposit amount: $${depositUsd.toFixed(2)}`,
          },
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
    return res.data.choices[0].message.content.trim();
  } catch {
    return null;
  }
}

// ─── Candidate Proposal Display ──────────────────────────────────────────────

async function printCandidateProposal(candidate, depositUsd, fromChainId, asset) {
  const grossYield    = depositUsd * (candidate.apy / 100);
  const netYield      = grossYield - candidate.totalGasCost;
  const breakEvenDays = netYield > 0 ? Math.ceil((candidate.totalGasCost / grossYield) * 365) : null;
  const riskLabel     = candidate.trust >= 1.25 && candidate.stability >= 0.9 ? 'Low'
                      : candidate.trust >= 1.1  && candidate.stability >= 0.7 ? 'Low-Medium'
                      : candidate.trust >= 1.0                                 ? 'Medium'
                      : 'Higher';
  const liquidLabel   = candidate.vault.depositPacks?.[0]?.name?.includes('aave') ? 'Yes (instant)' : 'Yes';
  const needsBridge   = fromChainId !== candidate.vault.chainId;

  console.log(`\n📋 Next Vault Proposal:`);
  const addr1 = candidate.vault.address?.slice(-4) || '????';
  console.log(`  Vault     : ${candidate.vault.name} (${candidate.vault.protocol}) [0x…${addr1}]`);
  console.log(`  Network   : ${candidate.vault.network} (chain=${candidate.vault.chainId})`);
  console.log(`  APY       : ${candidate.apy}% → Net APY: ${candidate.netApy}%`);
  console.log(`  TVL       : $${(candidate.tvlUsd / 1e6).toFixed(1)}M`);
  console.log(`  Deposit   : $${depositUsd.toFixed(2)} ${asset} from ${getChainName(fromChainId)}`);
  console.log(`  Gas est.  : $${candidate.totalGasCost.toFixed(2)}${needsBridge ? ' (incl. bridge)' : ''}`);
  console.log(`\n💡 Why this vault?`);
  const aiAnalysis = await generateWhyAnalysis(candidate, depositUsd);
  if (aiAnalysis) {
    console.log(`  🤖 AI Analysis:`);
    console.log(`  ${aiAnalysis}`);
    console.log('');
  }
  console.log(`  Stability : ${candidate.stability.toFixed(3)} / 1.0  (APY consistency over 30d)`);
  console.log(`  Trust     : ${candidate.trust.toFixed(2)}  (protocol credibility score)`);
  console.log(`  Risk      : ${riskLabel}`);
  console.log(`  Withdraw  : ${liquidLabel}`);
  const costRatio = grossYield > 0 ? (candidate.totalGasCost / grossYield) * 100 : 999;
  const costRatioLabel = costRatio > 25 ? '❌ Very high' : costRatio > 10 ? '⚠️  High' : '✅ OK';

  console.log(`\n📈 Expected economics:`);
  console.log(`  Gross yield/yr : $${grossYield.toFixed(2)}`);
  console.log(`  Est. costs     : $${candidate.totalGasCost.toFixed(2)}`);
  console.log(`  Cost ratio     : ${costRatio.toFixed(1)}%  ${costRatioLabel}`);
  console.log(`  Net yield/yr   : $${netYield.toFixed(2)}`);
  if (breakEvenDays !== null) {
    console.log(`  Break-even     : ${breakEvenDays} day${breakEvenDays === 1 ? '' : 's'}`);
  }

  const costRatioVal = grossYield > 0 ? (candidate.totalGasCost / grossYield) * 100 : 999;
  if (costRatioVal > 25) {
    const minRec = Math.max(50, Math.ceil(candidate.totalGasCost / (candidate.apy / 100) / 0.05));
    console.log(`\n  ❌ Not recommended: gas costs are ${costRatioVal.toFixed(1)}% of expected yield.`);
    console.log(`     Recommended minimum deposit: ~$${minRec}`);
  } else if (costRatioVal > 10) {
    const minRec = Math.max(50, Math.ceil(candidate.totalGasCost / (candidate.apy / 100) / 0.05));
    console.log(`\n  ⚠️  Warning: gas costs are ${costRatioVal.toFixed(1)}% of expected yield.`);
    console.log(`     Recommended minimum deposit: ~$${minRec}`);
  }
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
    //   1. fromChainId specified -> use that chain only, no selection prompt
    //   2. Otherwise -> scan all relevant chains, prompt user to pick source
    console.log(`\n💰 Checking ${asset} balance...`);
    let allBalances = [];

    if (params.fromChainId) {
      const b = await checkBalance(params.fromChainId, walletAddress);
      if (b && b.usd > 0.01) {
        allBalances = [b];
        console.log(`  ${getChainName(params.fromChainId)}: ${b.usd.toFixed(4)} ${asset}`);
      } else {
        console.log(`  ❌ No ${asset} found on ${getChainName(params.fromChainId)}`);
        rl.close(); return;
      }
    } else {
      const scanIds = getScanChainIds();
      const ordered = params.chainId
        ? [params.chainId, ...scanIds.filter(id => id !== params.chainId)]
        : scanIds;

      for (const chainId of ordered) {
        const b = await checkBalance(chainId, walletAddress);
        if (b && b.usd > 0.01) {
          allBalances.push(b);
          console.log(`  ${getChainName(chainId).padEnd(12)}: ${b.usd.toFixed(4)} ${asset}`);
        }
      }
    }

    if (allBalances.length === 0) {
      console.log(`\n❌ No ${asset} balance found. Cannot proceed.`);
      rl.close(); return;
    }

    // Step 2b: Source selection (when multiple chains found)
    let balanceInfo    = null;
    let consolidateAll = false;

    if (allBalances.length === 1 || params.fromChainId) {
      balanceInfo = allBalances[0];
    } else {
      const totalUsd = allBalances.reduce((s, b) => s + b.usd, 0);
      console.log(`\n  Select source:`);
      allBalances.forEach((b, i) => {
        console.log(`    ${i + 1}. ${getChainName(b.chainId).padEnd(12)} ${b.usd.toFixed(4)} ${asset}`);
      });
      console.log(`    ${allBalances.length + 1}. Consolidate all -> bridge everything to target chain ($${totalUsd.toFixed(2)} total)`);
      console.log(`    Enter = largest (${getChainName(allBalances[0].chainId)})`);

      const pick = await prompt(rl, '\n  Select (number or Enter): ');

      if (pick === '') {
        balanceInfo = allBalances[0];
      } else if (parseInt(pick) === allBalances.length + 1) {
        consolidateAll = true;
        balanceInfo    = { usd: totalUsd, chainId: allBalances[0].chainId };
      } else {
        const idx = parseInt(pick) - 1;
        if (isNaN(idx) || idx < 0 || idx >= allBalances.length) {
          console.log('❌ Invalid selection.'); rl.close(); return;
        }
        balanceInfo = allBalances[idx];
      }
    }

    console.log(consolidateAll
      ? `\n  Consolidating all chains -> target chain`
      : `\n  Using: $${balanceInfo.usd.toFixed(2)} ${asset} from ${getChainName(balanceInfo.chainId)}`
    );

    const depositAmount = params.amount ? Math.min(params.amount, balanceInfo.usd) : balanceInfo.usd;
    const fromChainId   = balanceInfo.chainId;

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
    const toChainIdStep5 = selectedVault.vault.chainId;
    const needsBridge    = consolidateAll || fromChainId !== toChainIdStep5;

    // For consolidateAll: fetch real bridge quotes for accurate cost/time estimate
    let totalGasCost = selectedVault.totalGasCost;
    let bridgeQuotes = [];

    if (consolidateAll) {
      const { getBridgeQuote } = require('./consolidate');
      const toBridge = allBalances
        .filter(b => b.chainId !== toChainIdStep5)
        .map(b => ({ ...b, name: getChainName(b.chainId), raw: b.balance, amount: b.usd }));
      console.log(`\n📡 Fetching bridge quotes for estimate...`);
      bridgeQuotes = await Promise.all(
        toBridge.map(async (b) => {
          try {
            const q       = await getBridgeQuote({ fromChainId: b.chainId, toChainId: toChainIdStep5, amountWei: b.balance, wallet: walletAddress });
            const estOut  = parseFloat(ethers.formatUnits(q.estimate.toAmount, q.action.toToken.decimals));
            const gasCost = parseFloat(q.estimate.gasCosts?.[0]?.amountUSD || '0');
            const dur     = q.estimate.executionDuration ? Math.ceil(q.estimate.executionDuration / 60) : null;
            return { name: getChainName(b.chainId), amount: b.usd, estOut, gasCost, dur, error: null };
          } catch (e) {
            return { name: getChainName(b.chainId), amount: b.usd, estOut: 0, gasCost: 0, dur: null, error: e.message };
          }
        })
      );
      totalGasCost += bridgeQuotes.reduce((s, q) => s + q.gasCost, 0);
    }

    const grossYield    = depositAmount * (selectedVault.apy / 100);
    const netYield      = grossYield - totalGasCost;
    const breakEvenDays = netYield > 0 ? Math.ceil((totalGasCost / grossYield) * 365) : null;
    const riskLabel     = selectedVault.trust >= 1.25 && selectedVault.stability >= 0.9 ? 'Low'
                        : selectedVault.trust >= 1.1  && selectedVault.stability >= 0.7 ? 'Low-Medium'
                        : selectedVault.trust >= 1.0                                    ? 'Medium'
                        : 'Higher';
    const liquidLabel   = selectedVault.vault.depositPacks?.[0]?.name?.includes('aave') ? 'Yes (instant)' : 'Yes';

    console.log(`\n📋 Vault Proposal:`);
    const addrSuffix = selectedVault.vault.address?.slice(-4) || '????';
    console.log(`  Vault     : ${selectedVault.vault.name} (${selectedVault.vault.protocol}) [0x…${addrSuffix}]`);
    console.log(`  Network   : ${selectedVault.vault.network} (chain=${toChainIdStep5})`);
    console.log(`  APY       : ${selectedVault.apy}% → Net APY: ${selectedVault.netApy}%`);
    console.log(`  TVL       : $${(selectedVault.tvlUsd / 1e6).toFixed(1)}M`);
    console.log(`  Deposit   : $${depositAmount.toFixed(2)} ${asset}${consolidateAll ? ' (all chains combined)' : ` from ${getChainName(fromChainId)}`}`);

    if (consolidateAll && bridgeQuotes.length > 0) {
      const maxDur = Math.max(...bridgeQuotes.filter(q => q.dur).map(q => q.dur));
      console.log(`\n📦 Bridge plan:`);
      bridgeQuotes.forEach(q => {
        if (q.error) {
          console.log(`  • ${q.name.padEnd(12)}: ❌ quote failed`);
        } else {
          const gas = q.gasCost < 0.001 ? q.gasCost.toFixed(4) : q.gasCost.toFixed(3);
          const dur = q.dur ? `~${q.dur} min` : '?';
          console.log(`  • ${q.name.padEnd(12)}: ${q.amount.toFixed(4)} USDC  (est. out: ${q.estOut.toFixed(4)}, gas: $${gas}, ⏱️  ${dur})`);
        }
      });
      if (maxDur) console.log(`  ⏱️  Est. total wait (parallel): ~${maxDur} min`);
      console.log(`  Gas total : $${totalGasCost.toFixed(3)} (bridges + deposit)`);
    } else {
      console.log(`  Gas est.  : $${totalGasCost.toFixed(2)}${needsBridge ? ' (incl. bridge)' : ''}`);
    }

    console.log(`\n💡 Why this vault?`);
    const aiAnalysis = await generateWhyAnalysis(selectedVault, depositAmount);
    if (aiAnalysis) {
      console.log(`  🤖 AI Analysis:`);
      console.log(`  ${aiAnalysis}`);
      console.log('');
    }
    console.log(`  Stability : ${selectedVault.stability.toFixed(3)} / 1.0  (APY consistency over 30d)`);
    console.log(`  Trust     : ${selectedVault.trust.toFixed(2)}  (protocol credibility score)`);
    console.log(`  Risk      : ${riskLabel}`);
    console.log(`  Withdraw  : ${liquidLabel}`);

    const costRatio      = grossYield > 0 ? (totalGasCost / grossYield) * 100 : 999;
    const costRatioLabel = costRatio > 25 ? '❌ Very high' : costRatio > 10 ? '⚠️  High' : '✅ OK';

    console.log(`\n📈 Expected economics:`);
    console.log(`  Gross yield/yr : $${grossYield.toFixed(2)}`);
    console.log(`  Est. costs     : $${totalGasCost.toFixed(2)}`);
    console.log(`  Cost ratio     : ${costRatio.toFixed(1)}%  ${costRatioLabel}`);
    console.log(`  Net yield/yr   : $${netYield.toFixed(2)}`);
    if (breakEvenDays !== null) {
      console.log(`  Break-even     : ${breakEvenDays} day${breakEvenDays === 1 ? '' : 's'}`);
    }

    // Warning if cost ratio is too high
    if (costRatio > 25) {
      console.log(`\n❌ Not recommended: gas costs are ${costRatio.toFixed(1)}% of expected yield.`);
      const minRec1 = Math.max(50, Math.ceil(totalGasCost / (selectedVault.apy / 100) / 0.05));
      console.log(`   Recommended minimum deposit: ~$${minRec1}`);
    } else if (costRatio > 10) {
      console.log(`\n⚠️  Warning: gas costs are ${costRatio.toFixed(1)}% of expected yield.`);
      const minRec1 = Math.max(50, Math.ceil(totalGasCost / (selectedVault.apy / 100) / 0.05));
      console.log(`   Recommended minimum deposit: ~$${minRec1}`);
    }


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

    const toChainId = selectedVault.vault.chainId;

    if (consolidateAll) {
      // Bridge all chains to target, then deposit
      const { bridgeAllParallel, depositBestVault, getUsdcBalance } = require('./consolidate');
      const toBridge = allBalances
        .filter(b => b.chainId !== toChainId)
        .map(b => ({ ...b, name: getChainName(b.chainId), raw: b.balance, amount: b.usd }));
      if (toBridge.length > 0) {
        await bridgeAllParallel({ sources: toBridge, toChainId, wallet: walletAddress });
      }
      console.log(`\n🔄 Checking final balance on ${getChainName(toChainId)}...`);
      await new Promise(r => setTimeout(r, 3000));
      const finalBal = await getUsdcBalance(toChainId, walletAddress);
      if (finalBal.amount < 0.01) {
        console.log('⚠️  Balance too low or bridge still pending.');
        rl.close(); return;
      }
      const finalWei = ethers.parseUnits(finalBal.amount.toFixed(6), finalBal.decimals);
      const provider = await getProviderWithFallback(toChainId);
      const signer   = new ethers.Wallet(pk, provider);

      // Try selected vault first, then confirm + fall back on failure.
      // Restrict fallback to same destination chain — no re-bridging on failure.
      const candidates = [selectedVault, ...filtered.slice(1, 4)]
        .filter(Boolean)
        .filter(v => v.vault.chainId === toChainId);

      for (const candidate of candidates) {
        const isFirst = candidate === selectedVault;

        if (!isFirst) {
          await printCandidateProposal(candidate, depositAmount, fromChainId, asset);
          const ans = await prompt(rl, '\n✅ Proceed with this vault? (y/n/q): ');
          if (ans.toLowerCase() === 'q') { console.log('\n❌ Cancelled.'); rl.close(); return; }
          if (ans.toLowerCase() !== 'y') { console.log('  Skipping...'); continue; }
        }

        try {
          const result = await depositToVault({
            signer,
            fromChainId:       toChainId,
            toChainId,
            fromTokenAddress:  finalBal.usdc,
            vaultTokenAddress: candidate.vault.address,
            amountWei:         finalWei.toString(),
            depositPack:       candidate.vault.depositPacks?.[0]?.name || '',
          });
          recordPosition(candidate.vault, toChainId);
          recordTx({ type:'consolidate', toVault: candidate.vault.name, toChainId: toChainId, valueUsd: depositAmount, asset: asset || 'USDC', txHash: result?.tx?.hash || result?.txHash || result?.hash || null, txHash2: result?.txHash2 || null });
          console.log('\n🎉 Consolidate + deposit complete!');
          console.log('\n🤖 Vaulthoric will monitor your position and notify you');
          console.log('   if better yield opportunities appear. Stay Vaulthoric.');
          rl.close();
          return result;
        } catch (e) {
          console.log(`  ⚠️  ${candidate.vault.name} failed: ${e.message?.slice(0, 80)}`);
          if (candidates.indexOf(candidate) < candidates.length - 1) {
            console.log('  Next candidate available...');
          }
        }
      }
      console.log(`\n❌ All vault candidates on ${getChainName(toChainId)} failed.`);
      console.log(`   Your USDC is now idle on ${getChainName(toChainId)}.`);
      console.log(`   Run: node ask.js "put my USDC into best vault on ${getChainName(toChainId)}"`);
      rl.close();
      return;
    }

    const provider  = await getProviderWithFallback(fromChainId);
    const signer    = new ethers.Wallet(pk, provider);
    const amountWei = ethers.parseUnits(depositAmount.toFixed(6), balanceInfo.decimals);

    // Try selected vault first, then confirm + fall back on failure.
    // Fallback is restricted to the same destination chain to avoid re-bridging.
    const targetChainId = selectedVault.vault.chainId;
    const candidates = [selectedVault, ...filtered.slice(1, 4)]
      .filter(Boolean)
      .filter(v => v.vault.chainId === targetChainId); // same chain only

    for (const candidate of candidates) {
      const isFirst = candidate === selectedVault;

      if (!isFirst) {
        await printCandidateProposal(candidate, depositAmount, fromChainId, asset);
        const ans = await prompt(rl, '\n✅ Proceed with this vault? (y/n/q): ');
        if (ans.toLowerCase() === 'q') { console.log('\n❌ Cancelled.'); rl.close(); return; }
        if (ans.toLowerCase() !== 'y') { console.log('  Skipping...'); continue; }
      }

      try {
        const result = await depositToVault({
          signer,
          fromChainId,
          toChainId:         candidate.vault.chainId,
          fromTokenAddress:  balanceInfo.tokenAddress,
          vaultTokenAddress: candidate.vault.address,
          amountWei:         amountWei.toString(),
          depositPack:       candidate.vault.depositPacks?.[0]?.name || '',
        });
        recordPosition(candidate.vault, candidate.vault.chainId);
        recordTx({ type:'deposit', toVault: candidate.vault.name, toChainId: candidate.vault.chainId, valueUsd: depositAmount, asset: asset || 'USDC', txHash: result?.tx?.hash || result?.txHash || result?.hash || null, txHash2: result?.txHash2 || null });
        console.log('\n🎉 Deposit complete!');
        console.log('\n🤖 Vaulthoric will monitor your position and notify you');
        console.log('   if better yield opportunities appear. Stay Vaulthoric.');
        rl.close();
        return result;
      } catch (e) {
        console.log(`  ⚠️  ${candidate.vault.name} failed: ${e.message?.slice(0, 80)}`);
        if (candidates.indexOf(candidate) < candidates.length - 1) {
          console.log('  Next candidate available...');
        }
      }
    }

    console.log(`\n❌ All vault candidates on ${getChainName(targetChainId)} failed.`);
    if (fromChainId !== targetChainId) {
      console.log(`   Your USDC is now idle on ${getChainName(targetChainId)}.`);
      console.log(`   Run: node ask.js "put my USDC into best vault on ${getChainName(targetChainId)}"`);
    }
    rl.close();

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

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, parseInstruction };
