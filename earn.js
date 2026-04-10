const axios = require('axios');

const EARN_BASE = 'https://earn.li.fi';
const API_KEY = process.env.LIFI_API_KEY || '';

const headers = API_KEY ? { 'x-lifi-api-key': API_KEY } : {};

// vault一覧取得（全ページ）
async function getVaults({ chainId, asset, minTvlUsd = 1000000 } = {}) {
  const allVaults = [];
  let cursor;

  do {
    const params = new URLSearchParams({ limit: '100', sortBy: 'apy' });
    if (chainId) params.set('chainId', chainId);
    if (asset) params.set('asset', asset);
    if (minTvlUsd) params.set('minTvlUsd', minTvlUsd);
    if (cursor) params.set('cursor', cursor);

    const res = await axios.get(`${EARN_BASE}/v1/earn/vaults?${params}`, { headers });
    allVaults.push(...res.data.data);
    cursor = res.data.nextCursor;
  } while (cursor);

  return allVaults;
}

// 単一vault取得
async function getVault(chainId, address) {
  const res = await axios.get(`${EARN_BASE}/v1/earn/vaults/${chainId}/${address}`, { headers });
  return res.data;
}

// 対応チェーン一覧
async function getChains() {
  const res = await axios.get(`${EARN_BASE}/v1/earn/chains`, { headers });
  return res.data;
}

// ユーザーポジション取得
async function getPortfolio(userAddress) {
  const res = await axios.get(`${EARN_BASE}/v1/earn/portfolio/${userAddress}/positions`, { headers });
  return res.data.positions;
}

module.exports = { getVaults, getVault, getChains, getPortfolio };
