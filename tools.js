// Vaulthoric — Chain & Token Configuration
// 全チェーン・トークン・RPC設定の一元管理

require('dotenv').config();

// チェーン情報（RPCは優先順にフォールバック）
const CHAINS = {
  1: {
    name: 'Ethereum', network: 'ethereum',
    rpcs: [
      process.env.RPC_ETHEREUM,
      'https://cloudflare-eth.com',
      'https://ethereum.drpc.org',
      'https://rpc.ankr.com/eth',
    ].filter(Boolean),
  },
  10: {
    name: 'Optimism', network: 'optimism',
    rpcs: [
      process.env.RPC_OPTIMISM,
      'https://mainnet.optimism.io',
      'https://optimism.drpc.org',
    ].filter(Boolean),
  },
  56: {
    name: 'BSC', network: 'bsc',
    rpcs: [
      process.env.RPC_BSC,
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.defibit.io',
    ].filter(Boolean),
  },
  100: {
    name: 'Gnosis', network: 'gnosis',
    rpcs: [
      process.env.RPC_GNOSIS,
      'https://rpc.gnosischain.com',
      'https://gnosis.drpc.org',
    ].filter(Boolean),
  },
  130: {
    name: 'Unichain', network: 'unichain',
    rpcs: [
      process.env.RPC_UNICHAIN,
      'https://mainnet.unichain.org',
    ].filter(Boolean),
  },
  137: {
    name: 'Polygon', network: 'polygon',
    rpcs: [
      process.env.RPC_POLYGON,
      'https://polygon-rpc.com',
      'https://polygon.drpc.org',
      'https://rpc.ankr.com/polygon',
    ].filter(Boolean),
  },
  143: {
    name: 'Monad', network: 'monad',
    rpcs: [
      process.env.RPC_MONAD,
      'https://rpc.monad.xyz',
    ].filter(Boolean),
  },
  146: {
    name: 'Sonic', network: 'sonic',
    rpcs: [
      process.env.RPC_SONIC,
      'https://rpc.soniclabs.com',
      'https://sonic.drpc.org',
    ].filter(Boolean),
  },
  5000: {
    name: 'Mantle', network: 'mantle',
    rpcs: [
      process.env.RPC_MANTLE,
      'https://rpc.mantle.xyz',
      'https://mantle.drpc.org',
    ].filter(Boolean),
  },
  8453: {
    name: 'Base', network: 'base',
    rpcs: [
      process.env.RPC_BASE,
      'https://mainnet.base.org',
      'https://base.drpc.org',
      'https://rpc.ankr.com/base',
    ].filter(Boolean),
  },
  42161: {
    name: 'Arbitrum', network: 'arbitrum',
    rpcs: [
      process.env.RPC_ARB,
      'https://arbitrum.drpc.org',
      'https://arb1.arbitrum.io/rpc',
      'https://rpc.ankr.com/arbitrum',
    ].filter(Boolean),
  },
  42220: {
    name: 'Celo', network: 'celo',
    rpcs: [
      process.env.RPC_CELO,
      'https://forno.celo.org',
    ].filter(Boolean),
  },
  43114: {
    name: 'Avalanche', network: 'avalanche',
    rpcs: [
      process.env.RPC_AVAX,
      'https://avalanche.drpc.org',
      'https://api.avax.network/ext/bc/C/rpc',
      'https://rpc.ankr.com/avalanche',
    ].filter(Boolean),
  },
  59144: {
    name: 'Linea', network: 'linea',
    rpcs: [
      process.env.RPC_LINEA,
      'https://rpc.linea.build',
      'https://linea.drpc.org',
    ].filter(Boolean),
  },
  80094: {
    name: 'Berachain', network: 'berachain',
    rpcs: [
      process.env.RPC_BERA,
      'https://rpc.berachain.com',
    ].filter(Boolean),
  },
  534352: {
    name: 'Scroll', network: 'scroll',
    rpcs: [
      process.env.RPC_SCROLL,
      'https://rpc.scroll.io',
      'https://scroll.drpc.org',
    ].filter(Boolean),
  },
  747474: {
    name: 'Katana', network: 'katana',
    rpcs: [
      process.env.RPC_KATANA,
      'https://rpc.katana.network',
    ].filter(Boolean),
  },
};

// 残高スキャン対象チェーン（安定してるチェーンのみ）
const SCAN_CHAIN_IDS = [
  1,      // Ethereum
  10,     // Optimism
  56,     // BSC
  137,    // Polygon
  8453,   // Base
  42161,  // Arbitrum
  43114,  // Avalanche
  59144,  // Linea
  534352, // Scroll
  130,    // Unichain
  146,    // Sonic
  5000,   // Mantle
];

// USDC token addresses per chain
const USDC_ADDRESSES = {
  1:      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  10:     '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  56:     '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  100:    '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
  130:    '0x078D888E40faA0dC9E1F0aB2Ac6a4BfC5236C9F3',
  137:    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  143:    '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea',
  146:    '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  5000:   '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
  8453:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  42161:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  42220:  '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  43114:  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  59144:  '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  80094:  '0x549943e04f40284185054145c6E4e9568C1D3241',
  534352: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
  747474: '0x203C7Dd982b9255c3E17b49e44B42de27A0B4C24',
};

// チェーン名→IDのマッピング（自然言語解析用）
const CHAIN_NAME_TO_ID = Object.fromEntries(
  Object.entries(CHAINS).map(([id, c]) => [c.name.toLowerCase(), parseInt(id)])
);
CHAIN_NAME_TO_ID['eth'] = 1;
CHAIN_NAME_TO_ID['mainnet'] = 1;
CHAIN_NAME_TO_ID['op'] = 10;
CHAIN_NAME_TO_ID['arb'] = 42161;
CHAIN_NAME_TO_ID['avax'] = 43114;
CHAIN_NAME_TO_ID['matic'] = 137;

// ヘルパー関数
function getChainName(chainId) {
  return CHAINS[chainId]?.name || `chain_${chainId}`;
}

// 最初のRPCを返す（フォールバックはgetProvider側で処理）
function getChainRpc(chainId) {
  return CHAINS[chainId]?.rpcs?.[0] || null;
}

// 複数RPCを順番に試してProviderを返す
async function getProviderWithFallback(chainId) {
  const { ethers } = require('ethers');
  const rpcs = getChainRpcs(chainId);
  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
      await provider.getBlockNumber();
      return provider;
    } catch (e) {
      // 次のRPCを試す
    }
  }
  throw new Error(`No working RPC for chainId ${chainId}`);
}

// 全RPCリストを返す
function getChainRpcs(chainId) {
  return CHAINS[chainId]?.rpcs || [];
}

function getChainIdByName(name) {
  return CHAIN_NAME_TO_ID[name?.toLowerCase()] || null;
}

function getUsdcAddress(chainId) {
  return USDC_ADDRESSES[chainId] || null;
}

function getSupportedChainIds() {
  return Object.keys(CHAINS).map(Number);
}

function getScanChainIds() {
  return SCAN_CHAIN_IDS;
}

module.exports = {
  CHAINS,
  USDC_ADDRESSES,
  CHAIN_NAME_TO_ID,
  SCAN_CHAIN_IDS,
  getChainName,
  getChainRpc,
  getChainRpcs,
  getProviderWithFallback,
  getChainIdByName,
  getUsdcAddress,
  getSupportedChainIds,
  getScanChainIds,
};
