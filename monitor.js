// Vaulthoric — Position Monitor
// Runs periodically (via cron) to check if better yield opportunities exist.
// Notifies via Discord webhook when a significant improvement is found.

require('dotenv').config();

const axios    = require('axios');
const { ethers } = require('ethers');
const { getVaults }  = require('./earn');
const { rankVaults } = require('./scorer');
const {
  getChainName,
  loadPositions,
  getProviderWithFallback,
  getUsdcAddress,
  suppressRpcNoise,
} = require('./tools');

suppressRpcNoise();

const { execSync }       = require('child_process');
const WEBHOOK_URL        = process.env.DISCORD_WEBHOOK_URL;
const AUTO_REBALANCE     = process.env.AUTO_REBALANCE === 'true';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5';
const WALLET             = new ethers.Wallet(process.env.PRIVATE_KEY).address;

// Minimum APY improvement (absolute %) to trigger a notification
const IMPROVEMENT_THRESHOLD_SAME  = 0.5; // Same-chain: 0.5% APY improvement
const IMPROVEMENT_THRESHOLD_CROSS = 2.0; // Cross-chain: 2.0% APY improvement (bridge cost + risk)

// Estimated transaction costs (USD) and efficiency threshold
const ESTIMATED_COST_USD = { sameChain: 0.01, crossChain: 0.02 };
const COST_RATIO_THRESHOLD = 0.10; // flag as inefficient if cost > 10% of position value

const BAL_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256 assets)',
];

// ─── Discord ──────────────────────────────────────────────────────────────────

async function notify(embed) {
  if (!WEBHOOK_URL) { console.log('⚠️  No DISCORD_WEBHOOK_URL set'); return; }
  await axios.post(WEBHOOK_URL, { embeds: [embed] });
}

// ─── AI Summary ───────────────────────────────────────────────────────────────

async function generateSwitchReason(current, better, costUsd, costRatio, isEfficient) {
  if (!OPENROUTER_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:      OPENROUTER_MODEL,
        max_tokens: 120,
        messages: [
          {
            role:    'system',
            content: 'You are a DeFi investment analyst. In 2 sentences, explain the yield opportunity and whether the switch is recommended given transaction costs. Be concise and specific. No markdown.',
          },
          {
            role: 'user',
            content: `Current: ${current.name} (${current.protocol}) — APY ${current.apy.toFixed(2)}%, stability ${current.stability.toFixed(3)}
Better:  ${better.vault.name} (${better.vault.protocol}) — APY ${better.apy.toFixed(2)}%, stability ${better.stability.toFixed(3)}
Improvement: +${(better.apy - current.apy).toFixed(2)}% APY
Estimated cost: $${costUsd.toFixed(2)} (${(costRatio * 100).toFixed(1)}% of position)
Cost efficient: ${isEfficient ? 'Yes' : 'No — position may be too small for this switch'}`,
          },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://vaulthoric.xyz',
          'X-Title':       'Vaulthoric Monitor',
        },
      }
    );
    return res.data.choices[0].message.content.trim();
  } catch {
    return null;
  }
}

// ─── Position Value ───────────────────────────────────────────────────────────

async function getPositionValue(position) {
  try {
    const provider = await getProviderWithFallback(position.chainId);
    const contract = new ethers.Contract(position.address, BAL_ABI, provider);
    const bal      = await contract.balanceOf(WALLET);
    if (bal === 0n) return null;

    // ERC-4626はconvertToAssetsで換算、aave-v3 aTokenなど非対応の場合は
    // balanceOfをそのまま使う（aTokenはUSDCと1:1）
    try {
      const assets = await contract.convertToAssets(bal);
      return parseFloat(ethers.formatUnits(assets, 6));
    } catch {
      return parseFloat(ethers.formatUnits(bal, 6));
    }
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 Vaulthoric Monitor — ${new Date().toISOString()}`);
  console.log(`👛 Wallet: ${WALLET}`);

  const positions = loadPositions();
  if (positions.length === 0) {
    console.log('  ℹ️  No positions to monitor.');
    return;
  }

  console.log(`\n📡 Checking ${positions.length} position(s)...`);

  const allVaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
  const alerts    = [];

  for (const pos of positions) {
    console.log(`\n  🔍 ${pos.name} (${pos.protocol}) on ${getChainName(pos.chainId)}`);

    const valueUsd = await getPositionValue(pos);
    if (!valueUsd || valueUsd < 0.01) {
      console.log(`     ⚠️  Could not read position value, skipping`);
      continue;
    }
    console.log(`     Value: ~$${valueUsd.toFixed(2)}`);

    // Find current vault in ranked list
    const ranked  = rankVaults(allVaults, valueUsd, pos.chainId);
    const current = ranked.find(v => v.vault.address.toLowerCase() === pos.address.toLowerCase());
    const best    = ranked[0];

    if (!current || !best) continue;

    console.log(`     Current APY: ${current.apy.toFixed(2)}% | Best available: ${best.apy.toFixed(2)}% (${best.vault.name})`);

    const improvement    = best.apy - current.apy;
    const isSameChain    = pos.chainId === best.vault.chainId;
    const threshold      = isSameChain ? IMPROVEMENT_THRESHOLD_SAME : IMPROVEMENT_THRESHOLD_CROSS;
    const isBetter       = improvement >= threshold && best.vault.address.toLowerCase() !== pos.address.toLowerCase();

    if (isBetter) {
      console.log(`     🚀 Better vault found: ${best.vault.name} (${best.vault.address.slice(0,6)}…${best.vault.address.slice(-4)}) +${improvement.toFixed(2)}%`);
      const costUsd    = isSameChain ? ESTIMATED_COST_USD.sameChain : ESTIMATED_COST_USD.crossChain;
      const costRatio  = costUsd / valueUsd;
      const isEfficient = costRatio <= COST_RATIO_THRESHOLD;
      console.log(`     💸 Est. cost: $${costUsd.toFixed(2)} (${(costRatio * 100).toFixed(1)}% of position) ${isEfficient ? '✅' : '❌'}`);
      const reason = await generateSwitchReason(
        { name: pos.name, protocol: pos.protocol, apy: current.apy, stability: current.stability },
        best, costUsd, costRatio, isEfficient
      );
      console.log(`     🤖 AI Analysis: ${reason}`);
      alerts.push({ pos, current, best, improvement, valueUsd, reason, isSameChain, costUsd, costRatio, isEfficient });
    } else {
      console.log(`     ✅ Current vault is optimal`);
    }
  }

  // ── Send Discord notifications ──
  if (alerts.length === 0) {
    console.log('\n✅ All positions are optimal. No action needed.');

    await notify({
      title:       '✅ Vaulthoric Monitor',
      description: 'All positions are currently optimal. No rebalancing needed.',
      color:       0x00c853,
      footer:      { text: `Checked at ${new Date().toUTCString()}` },
    });
    return;
  }

  for (const { pos, current, best, improvement, valueUsd, reason, isSameChain, costUsd, costRatio, isEfficient } of alerts) {
    const costField  = `Est. cost: $${costUsd.toFixed(2)} (${(costRatio * 100).toFixed(1)}% of position) ${isEfficient ? '✅ Efficient' : '❌ Not recommended'}`;
    const recommendation = isEfficient
      ? `✅ Switching is beneficial — yield gain offsets transaction cost.`
      : `⚠️ Not recommended at current position size. Consider rebalancing when position exceeds ~$${(costUsd / COST_RATIO_THRESHOLD).toFixed(0)}.`;

    const embed = {
      title: '🔔 Vaulthoric — Better Yield Found',
      color: isEfficient ? 0xf4a020 : 0x9e9e9e,
      fields: [
        {
          name:   '📉 Current Position',
          value:  `**${pos.name}** (${pos.protocol})\nAPY: ${current.apy.toFixed(2)}% | Value: ~$${valueUsd.toFixed(2)}\nChain: ${getChainName(pos.chainId)}`,
          inline: true,
        },
        {
          name:   '📈 Better Opportunity',
          value:  `**${best.vault.name}** (${best.vault.protocol})\nAPY: ${best.apy.toFixed(2)}% | +${improvement.toFixed(2)}%\nChain: ${getChainName(best.vault.chainId)}\n\`${best.vault.address.slice(0,6)}…${best.vault.address.slice(-4)}\``,
          inline: true,
        },
        {
          name:   '💸 Cost Efficiency',
          value:  costField,
          inline: false,
        },
        {
          name:   '🤖 AI Analysis',
          value:  reason || 'Higher risk-adjusted yield available with similar stability profile.',
          inline: false,
        },
        {
          name:   '⚠️ Recommendation',
          value:  recommendation,
          inline: false,
        },
        {
          name:   '⚡ Suggested Action',
          value:  isSameChain
            ? `\`node rebalance.js "${pos.name} to ${best.vault.address}"\``
            : `\`node rebalance.js "${pos.name} to ${best.vault.address}"\`\n⚠️ Cross-chain bridge required`,
          inline: false,
        },
      ],
      footer: { text: `Vaulthoric Monitor • ${new Date().toUTCString()} — Monitoring active` },
    };

    await notify(embed);
    console.log(`\n📨 Discord notification sent for ${pos.name}`);

    // Auto-rebalance if enabled (same-chain only)
    if (AUTO_REBALANCE && isSameChain) {
      console.log(`\n🔄 AUTO_REBALANCE=true — executing same-chain rebalance...`);
      try {
        execSync(
          `node ${__dirname}/rebalance.js "${pos.name} to ${best.vault.address}" --auto`,
          { stdio: 'inherit', cwd: __dirname }
        );
        await notify({
          title:       '✅ Vaulthoric — Auto-Rebalance Complete',
          color:       0x00c853,
          description: `Successfully moved **${pos.name}** → **${best.vault.name}** (\`${best.vault.address.slice(0,6)}…${best.vault.address.slice(-4)}\`)\nNew APY: ${best.apy.toFixed(2)}%`,
          footer:      { text: `Vaulthoric Monitor • ${new Date().toUTCString()}` },
        });
      } catch (e) {
        console.error(`  ❌ Auto-rebalance failed: ${e.message?.slice(0, 80)}`);
        await notify({
          title:       '❌ Vaulthoric — Auto-Rebalance Failed',
          color:       0xff1744,
          description: `Could not rebalance **${pos.name}**. Please run manually:\n\`node rebalance.js "${pos.name} to ${best.vault.address}"\``,
          footer:      { text: `Vaulthoric Monitor • ${new Date().toUTCString()}` },
        });
      }
    }
  }
}

main().catch(e => {
  console.error('❌ Monitor error:', e.message);
  process.exit(1);
});
