import okx from './okx.js';
import binance from './binance.js';
import mexc from './mexc.js';
import bitunix from './bitunix.js';
import hyperliquid from './hyperliquid.js';
import coinbase from './coinbase.js';

export const adapters = { okx, binance, mexc, bitunix, hyperliquid, coinbase };

export const catalog = Object.values(adapters).map((a) => ({
  id: a.id, name: a.name, markets: a.markets, transport: a.transport, notes: a.notes || {},
}));
