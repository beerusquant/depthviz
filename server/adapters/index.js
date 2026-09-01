import okx from './okx.js';
import binance from './binance.js';
import mexc from './mexc.js';
import bitunix from './bitunix.js';
import hyperliquid from './hyperliquid.js';
import coinbase from './coinbase.js';
import aster from './aster.js';
import lighter from './lighter.js';

export const adapters = { okx, binance, mexc, bitunix, hyperliquid, coinbase, aster, lighter };

export const catalog = Object.values(adapters).map((a) => ({
  id: a.id, name: a.name, markets: a.markets, transport: a.transport, notes: a.notes || {},
}));
