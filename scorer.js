// リスク調整済みvaultスコアリング
// APYはAPIから%単位で返ってくる（例: 5.34 = 5.34%）
// net_apy = (gross_yield - gas_cost) / amount * 100
// score = net_apy * stability * (1 + tvl_bonus) * trust * penalty

const MIN_TVL_USD = 1_000_000;
const MIN_APY = 0.1;

// プロトコル信頼スコア（LI.FI Earn対応プロトコル全11種）
const PROTOCOL_TRUST = {
  'aave-v3':         1.3,
  'morpho-v1':       1.25,
  'euler-v2':        1.2,
  'ether.fi-liquid': 1.15,
  'ether.fi-stake':  1.15,
  'pendle':          1.15,
  'ethena-usde':     1.1,
  'maple':           1.05,
  'upshift':         1.0,
  'yo-protocol':     0.9,
  'neverland':       0.9,
};

// チェーンごとのvault deposit推定ガスコスト（USD）
const GAS_COST_USD = {
  1:      0.5,   // Ethereum
  10:     0.01,  // Optimism
  56:     0.01,  // BSC
  100:    0.01,  // Gnosis
  130:    0.01,  // Unichain
  137:    0.01,  // Polygon
  143:    0.01,  // Monad
  146:    0.01,  // Sonic
  5000:   0.01,  // Mantle
  8453:   0.01,  // Base
  42161:  0.01,  // Arbitrum
  42220:  0.01,  // Celo
  43114:  0.01,  // Avalanche
  59144:  0.01,  // Linea
  80094:  0.01,  // Berachain
  534352: 0.01,  // Scroll
  747474: 0.01,  // Katana
};

// ブリッジコスト推定（USD）
const BRIDGE_COST_USD = 0.5;

// APY安定性スコア（変動係数ベース、0〜1）
function apyStability(vault) {
  const { apy, apy1d, apy7d, apy30d } = vault.analytics;
  const current = apy.total;
  const values = [current, apy1d, apy7d, apy30d].filter(v => v != null && v > 0);
  if (values.length < 2) return 0.5;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  return Math.max(0, 1 - cv);
}

// TVLボーナス（log10スケール）
function tvlBonus(vault) {
  const tvlUsd = parseFloat(vault.analytics.tvl.usd);
  if (tvlUsd < MIN_TVL_USD) return 0;
  return Math.log10(tvlUsd / MIN_TVL_USD + 1);
}

// ペナルティ係数
function penalties(vault) {
  let penalty = 1.0;
  if (vault.kyc) penalty *= 0.5;
  if (vault.timeLock > 86400) penalty *= 0.8;
  return penalty;
}

// メインスコアリング
function scoreVault(vault, amountUsd = 1000, fromChainId = null) {
  const apy = vault.analytics.apy.total;
  if (!apy || apy < MIN_APY) return null;

  // LI.FI APIでdeposit/redeemが両方対応してるvaultのみ対象
  if (!vault.isTransactional) return null;
  if (!vault.isRedeemable) return null;
  if (!vault.redeemPacks || vault.redeemPacks.length === 0) return null;
  if (!vault.depositPacks || vault.depositPacks.length === 0) return null;

  const stability = apyStability(vault);
  const tvl = tvlBonus(vault);
  const penalty = penalties(vault);
  const trust = PROTOCOL_TRUST[vault.protocol.name] || 1.0;

  // ガスコスト計算
  const chainGas = GAS_COST_USD[vault.chainId] || 0.5;
  const needsBridge = fromChainId && fromChainId !== vault.chainId;
  const totalGasCost = chainGas + (needsBridge ? BRIDGE_COST_USD : 0);

  // 年間収益（gross）
  const grossYield = amountUsd * (apy / 100);

  // net APY（ガスコスト差し引き後）
  const netYield = grossYield - totalGasCost;
  const netApy = (netYield / amountUsd) * 100;

  // 総合スコア
  const score = netApy * stability * (1 + tvl * 0.2) * trust * penalty;

  return {
    score: parseFloat(score.toFixed(4)),
    apy: parseFloat(apy.toFixed(2)),
    netApy: parseFloat(netApy.toFixed(2)),
    stability: parseFloat(stability.toFixed(3)),
    tvlUsd: parseFloat(vault.analytics.tvl.usd),
    penalty: parseFloat(penalty.toFixed(2)),
    trust,
    totalGasCost: parseFloat(totalGasCost.toFixed(3)),
    grossYield: parseFloat(grossYield.toFixed(2)),
    netYield: parseFloat(netYield.toFixed(2)),
    vault: {
      address: vault.address,
      chainId: vault.chainId,
      name: vault.name,
      protocol: vault.protocol.name,
      network: vault.network,
      slug: vault.slug,
      underlyingTokens: vault.underlyingTokens,
      depositPacks: vault.depositPacks,
      redeemPacks: vault.redeemPacks,
    }
  };
}

// vault配列をスコアリングしてソート
function rankVaults(vaults, amountUsd = 1000, fromChainId = null) {
  return vaults
    .map(v => scoreVault(v, amountUsd, fromChainId))
    .filter(v => v !== null && v.netApy > 0)
    .sort((a, b) => b.score - a.score);
}

// asset別トップvault
function topVaultsByAsset(vaults, topN = 3, amountUsd = 1000, fromChainId = null) {
  const ranked = rankVaults(vaults, amountUsd, fromChainId);
  const byAsset = {};
  for (const result of ranked) {
    const symbols = result.vault.underlyingTokens.map(t => t.symbol).join('+');
    if (!byAsset[symbols]) byAsset[symbols] = [];
    if (byAsset[symbols].length < topN) byAsset[symbols].push(result);
  }
  return byAsset;
}

module.exports = { scoreVault, rankVaults, topVaultsByAsset, PROTOCOL_TRUST, GAS_COST_USD, BRIDGE_COST_USD };
