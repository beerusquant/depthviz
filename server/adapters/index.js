import okx from './okx.js';
import binance from './binance.js';
import mexc from './mexc.js';
import bitunix from './bitunix.js';
import hyperliquid from './hyperliquid.js';
import coinbase from './coinbase.js';
import aster from './aster.js';
import lighter from './lighter.js';
import { assertAdapter } from './contract.js';

export const adapters = { okx, binance, mexc, bitunix, hyperliquid, coinbase, aster, lighter };

// Checked here, at import, rather than trusted. A missing transport entry or a
// note filed under a market that is not served is a typo that would otherwise
// surface as a 500 on the first viewer who picked that venue — see contract.js.
for (const [key, a] of Object.entries(adapters)) assertAdapter(a, key);

export const catalog = Object.values(adapters).map((a) => ({
  id: a.id, name: a.name, markets: a.markets, transport: a.transport, notes: a.notes || {},
}));
