// Vaulthoric — Rebalance
// Withdraws from a current vault position and re-deposits into the best
// available vault, optionally on a different chain.

require('dotenv').config();

const readline = require('readline');
const { ethers } = require('ethers');
const { getVaults }  = require('./earn');
const { rankVaults } = require('./scorer');
const {
  getChainName,
  getUsdcAddress,
  getProviderWithFallback,
  loadPositions,
  suppressRpcNoise,
} = require('./tools');
const { scanPositions, withdrawAll } = require('./withdraw');
const { run: askRun }               = require('./ask');

suppressRpcNoise();

function prompt(rl, q) {
  return new Promise(r => rl.question(q, r));
}

// ─── Instruction Parser ──────────────────────────────────────────────────────

async function parseRebalanceInstruction(instruction) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5';
  if (!OPENROUTER_API_KEY || !instruction) return null;

  const axios = require('axios');
  const res   = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model:      OPENROUTER_MODEL,
      max_tokens: 100,
      messages: [
        {
          role:    'system',
          content: 'Extract rebalance parameters from the instruction. Return JSON only, no explanation: {"from": "VAULT_NAME", "to": "VAULT_NAME_or_best"}. Examples: "CSUSDC to STEAKUSDC" -> {"from":"CSUSDC","to":"STEAKUSDC"}. "BBQUSDC to best" -> {"from":"BBQUSDC","to":"best"}. If destination is best/optimal/highest, always use "best".',
        },
        { role: 'user', content: instruction },
      ],
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://vaulthoric.xyz',
        'X-Title':       'Vaulthoric Rebalance',
      },
    }
  );
  const raw = res.data.choices[0].message.content.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Find Better Vault ────────────────────────────────────────────────────────

async function findBetterVault(position, valueUsd) {
  const allVaults     = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
  const sameChain     = allVaults.filter(v => v.chainId === position.chainId);
  const ranked        = rankVaults(sameChain, valueUsd, position.chainId);

  const current = ranked.find(v => v.vault.address.toLowerCase() === position.vaultAddress.toLowerCase());
  const best    = ranked.filter(v => v.vault.address.toLowerCase() !== position.vaultAddress.toLowerCase())[0];

  return { current, best, ranked };
}

// ─── Wait for USDC ────────────────────────────────────────────────────────────

async function waitForUsdc(chainId, walletAddress, expectedMin, maxWaitMs = 30000) {
  const ERC20_ABI  = ['function balanceOf(address) view returns (uint256)'];
  const usdcAddr   = getUsdcAddress(chainId);
  const provider   = await getProviderWithFallback(chainId);
  const { ethers: e } = require('ethers');
  const token      = new e.Contract(usdcAddr, ERC20_ABI, provider);

  console.log(`\n⏳ Waiting for USDC to arrive on ${getChainName(chainId)}...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const bal = await token.balanceOf(walletAddress);
    const usd = parseFloat(e.formatUnits(bal, 6));
    if (usd >= expectedMin * 0.95) {
      console.log(`  💰 ${usd.toFixed(4)} USDC available`);
      return usd;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('USDC did not arrive in time — withdraw may still be pending');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const walletAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const instruction = process.argv[2] || null;
  const isAuto      = process.argv.includes('--auto');
  let autoFrom = null;
  let autoTo   = null;

  if (instruction) {
    console.log(`\n📝 Instruction: "${instruction}"`);
    console.log('🧠 Parsing...');
    try {
      const parsed = await parseRebalanceInstruction(instruction);
      autoFrom = parsed?.from || null;
      autoTo   = parsed?.to   || null;
      console.log(`  From: ${autoFrom || 'auto'} | To: ${autoTo || 'best'}`);
    } catch {
      console.log('  ⚠️  Could not parse instruction, switching to interactive mode');
    }
  }

  console.log(`\n🏦 Vaulthoric — Rebalance`);
  console.log(`👛 Wallet: ${walletAddress}`);
  console.log(`${'─'.repeat(50)}`);

  // Step 1: Scan positions
  const positions = await scanPositions(walletAddress);
  if (positions.length === 0) {
    console.log('\n❌ No vault positions found.');
    rl.close(); return;
  }

  const allVaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });

  // Enrich with current APY
  const enriched = positions.map((p, i) => {
    const ranked  = rankVaults(allVaults.filter(v => v.chainId === p.chainId), p.valueUsd, p.chainId);
    const current = ranked.find(v => v.vault.address.toLowerCase() === p.vaultAddress.toLowerCase());
    return { ...p, currentApy: current?.apy || null, ranked, current };
  });

  // Auto-select from position if instruction provided
  let position;
  if (autoFrom) {
    const match = enriched.find(p => p.vaultName.toLowerCase().includes(autoFrom.toLowerCase()));
    if (match) {
      position = match;
      console.log(`\n✅ Auto-selected: ${position.vaultName} ($${position.valueUsd.toFixed(2)}, APY: ${position.currentApy?.toFixed(2)}%)`);
    }
  }

  if (!position) {
    console.log(`\n📊 Your Vault Positions:`);
    enriched.forEach((p, i) => {
      const apy = p.currentApy ? `${p.currentApy.toFixed(2)}%` : 'N/A';
      console.log(`  ${i + 1}. ${p.vaultName.padEnd(12)} (${p.protocol}) | $${p.valueUsd.toFixed(2)} | APY: ${apy} | ${getChainName(p.chainId)}`);
    });

    const pick = await prompt(rl, '\nSelect position to rebalance (number) or q to quit: ');
    if (pick.toLowerCase() === 'q') { rl.close(); return; }

    const idx = parseInt(pick) - 1;
    if (isNaN(idx) || idx < 0 || idx >= enriched.length) {
      console.log('❌ Invalid selection.'); rl.close(); return;
    }
    position = enriched[idx];
  }

  // Step 2: Find better vault
  console.log(`\n🔍 Finding better vault for ${position.vaultName}...`);
  const { current, best: bestAuto, ranked } = await findBetterVault(position, position.valueUsd);

  // If specific target vault specified, find it in ranked list
  // Supports both vault address (0x...) and vault name
  let best = bestAuto;
  if (autoTo && autoTo !== 'best') {
    const isAddress = autoTo.startsWith('0x') && autoTo.length >= 10;
    const specified = isAddress
      ? ranked.find(v => v.vault.address.toLowerCase() === autoTo.toLowerCase())
      : ranked.find(v => v.vault.name.toLowerCase().includes(autoTo.toLowerCase()));

    if (specified) {
      best = specified;
      console.log(`  Using specified vault: ${best.vault.name} (${best.vault.address.slice(0,6)}…${best.vault.address.slice(-4)})`);
    } else {
      console.log(`  ⚠️  "${autoTo}" not found in ranked vaults, using best available`);
    }
  }

  if (!best) {
    console.log(`✅ No better vault found. ${position.vaultName} is already the best on ${getChainName(position.chainId)}.`);
    rl.close(); return;
  }

  const improvement = best.apy - (current?.apy || 0);
  // Only block if no specific target was given and improvement is negligible
  if (!autoTo && improvement < 0.1) {
    console.log(`✅ ${position.vaultName} is already the best vault on ${getChainName(position.chainId)} (APY: ${current?.apy.toFixed(2)}%).`);
    rl.close(); return;
  }

  console.log(`\n📋 Rebalance Plan:`);
  console.log(`  From : ${position.vaultName} (${position.protocol}) — APY: ${current?.apy.toFixed(2) || 'N/A'}%`);
  console.log(`  To   : ${best.vault.name} (${best.vault.protocol}) — APY: ${best.apy.toFixed(2)}%`);
  console.log(`  Gain : +${improvement.toFixed(2)}% APY`);
  console.log(`  Value: ~$${position.valueUsd.toFixed(2)}`);

  if (!isAuto) {
    const confirm = await prompt(rl, '\n✅ Proceed with rebalance? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('\n❌ Cancelled.'); rl.close(); return;
    }
  } else {
    console.log('\n🤖 Auto-rebalance: proceeding automatically...');
  }

  // Step 3: Withdraw
  console.log(`\n🔄 Step 1: Withdrawing from ${position.vaultName}...`);
  await withdrawAll(position);

  // Step 4: Wait for USDC
  const usdcAvailable = await waitForUsdc(position.chainId, walletAddress, position.valueUsd * 0.95);

  // Step 5: Deposit into target vault (no fallback — rebalance intent is explicit)
  console.log(`\n🚀 Step 2: Depositing into ${best.vault.name}...`);
  rl.close();

  const { depositToVault } = require('./composer');
  const { recordPosition, getProviderWithFallback: getProvider } = require('./tools');
  const { ethers: e } = require('ethers');

  const ERC20_ABI_MIN = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
  const toProvider   = await getProvider(best.vault.chainId);
  const signer       = new e.Wallet(process.env.PRIVATE_KEY, toProvider);
  const usdcAddr     = getUsdcAddress(best.vault.chainId);
  const usdcContract = new e.Contract(usdcAddr, ERC20_ABI_MIN, toProvider);
  const [usdcBal, usdcDec] = await Promise.all([usdcContract.balanceOf(walletAddress), usdcContract.decimals()]);

  try {
    await depositToVault({
      signer,
      fromChainId:       best.vault.chainId,
      toChainId:         best.vault.chainId,
      fromTokenAddress:  usdcAddr,
      vaultTokenAddress: best.vault.address,
      amountWei:         usdcBal.toString(),
      depositPack:       best.vault.depositPacks?.[0]?.name || '',
    });
    recordPosition(best.vault, best.vault.chainId);
    console.log(`\n🎉 Rebalance complete! Stay Vaulthoric.`);
    console.log(`\n🤖 Vaulthoric will monitor your position and notify you`);
    console.log(`   if better yield opportunities appear.`);
  } catch (e) {
    console.log(`\n❌ Deposit into ${best.vault.name} failed: ${e.message?.slice(0, 80)}`);
    console.log(`   Your USDC is now idle on ${getChainName(best.vault.chainId)}.`);
    console.log(`   Run: node ask.js "put my USDC into best vault on ${getChainName(best.vault.chainId)}"`);
  }
}

main().catch(e => {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
}).finally(() => process.exit(0));
