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

const WEBHOOK_URL        = process.env.DISCORD_WEBHOOK_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'google/gemini-flash-1.5';
const WALLET             = new ethers.Wallet(process.env.PRIVATE_KEY).address;

// Minimum APY improvement (absolute %) to trigger a notification
const IMPROVEMENT_THRESHOLD = 0.5;

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

async function generateSwitchReason(current, better) {
  if (!OPENROUTER_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:      OPENROUTER_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content: 'You are a DeFi investment analyst. In 2 sentences, explain why switching vaults is recommended. Be concise and specific. No markdown.',
          },
          {
            role: 'user',
            content: `Current: ${current.name} (${current.protocol}) — APY ${current.apy.toFixed(2)}%, stability ${current.stability.toFixed(3)}
Better:  ${better.vault.name} (${better.vault.protocol}) — APY ${better.apy.toFixed(2)}%, stability ${better.stability.toFixed(3)}
Improvement: +${(better.apy - current.apy).toFixed(2)}% APY`,
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
    try {
      const assets = await contract.convertToAssets(bal);
      return parseFloat(ethers.formatUnits(assets, 6));
    } catch {
      return null;
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

    console.log(`     Current APY: ${current.apy.toFixed(2)}% | Best available: ${best.apy.toFixed(2)}%`);

    const improvement = best.apy - current.apy;
    const isBetter    = improvement >= IMPROVEMENT_THRESHOLD && best.vault.address.toLowerCase() !== pos.address.toLowerCase();

    if (isBetter) {
      console.log(`     🚀 Better vault found: ${best.vault.name} (+${improvement.toFixed(2)}%)`);
      const reason = await generateSwitchReason(
        { name: pos.name, protocol: pos.protocol, apy: current.apy, stability: current.stability },
        best
      );
      alerts.push({ pos, current, best, improvement, valueUsd, reason });
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

  for (const { pos, current, best, improvement, valueUsd, reason } of alerts) {
    const embed = {
      title:       '🔔 Vaulthoric — Better Yield Found',
      color:       0xf4a020,
      fields: [
        {
          name:   '📉 Current Position',
          value:  `**${pos.name}** (${pos.protocol})\nAPY: ${current.apy.toFixed(2)}% | Value: ~$${valueUsd.toFixed(2)}\nChain: ${getChainName(pos.chainId)}`,
          inline: true,
        },
        {
          name:   '📈 Better Opportunity',
          value:  `**${best.vault.name}** (${best.vault.protocol})\nAPY: ${best.apy.toFixed(2)}% | +${improvement.toFixed(2)}%\nChain: ${getChainName(best.vault.chainId)}`,
          inline: true,
        },
        {
          name:   '🤖 AI Analysis',
          value:  reason || 'Higher risk-adjusted yield available with similar stability profile.',
          inline: false,
        },
        {
          name:   '⚡ Action',
          value:  `\`node rebalance.js "${pos.name} to ${best.vault.name}"\``,
          inline: false,
        },
      ],
      footer: { text: `Vaulthoric Monitor • ${new Date().toUTCString()}` },
    };

    await notify(embed);
    console.log(`\n📨 Discord notification sent for ${pos.name}`);
  }
}

main().catch(e => {
  console.error('❌ Monitor error:', e.message);
  process.exit(1);
});
