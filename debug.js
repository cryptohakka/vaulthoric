require('dotenv').config();
const { getVaults } = require('./earn');
const { rankVaults } = require('./scorer');
async function test() {
  const vaults = await getVaults({ asset: 'USDC', minTvlUsd: 500000 });
  const base = vaults.filter(v => v.chainId === 8453);
  const ranked = rankVaults(base, 0.89, 42161);
  console.log('ranked count:', ranked.length);
  ranked.slice(0, 3).forEach(v => {
    console.log(v.vault.protocol, v.vault.name, '| score:', v.score, '| netApy:', v.netApy);
  });
}
test().catch(console.error);
