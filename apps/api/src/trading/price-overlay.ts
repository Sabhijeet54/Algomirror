import { startOfTradingDayIST } from '../admin/admin.service';
import type { Exchange, Position } from '@ctp/database';
import type { MarketFeedService } from '../market-data/market-feed.service';
import { instrumentKey, type PriceCacheService } from '../market-data/price-cache.service';
import type { LiveAccountData } from './trading.service';

/** A cached tick older than this is not used to re-price positions. */
const MAX_TICK_AGE_MS = 5 * 60_000;

function freshLtp(prices: PriceCacheService, exchange: string, symbol: string): number | null {
  const t = prices.getTick(instrumentKey(exchange, symbol));
  return t && Date.now() - t.ts <= MAX_TICK_AGE_MS ? t.ltp : null;
}

/**
 * Paper position for the API, re-priced with the live LTP from the master feed. The stored lastPrice /
 * unrealizedPnl are only written on fills, so without this a paper position never moves.
 */
export function paperPositionView(p: Position, prices: PriceCacheService, feed?: MarketFeedService) {
  if (p.quantity !== 0) feed?.ensure(p.exchange as Exchange, p.symbol);
  const avg = Number(p.averagePrice);
  const ltp = freshLtp(prices, p.exchange, p.symbol) ?? (p.lastPrice == null ? null : Number(p.lastPrice));
  const unrealized = ltp == null || p.quantity === 0 ? Number(p.unrealizedPnl) : p.quantity * (ltp - avg);
  return {
    ...p,
    averagePrice: p.averagePrice.toString(),
    lastPrice: ltp == null ? null : String(ltp),
    // realized P&L is shown for today only (a carried-forward row last touched earlier shows 0)
    realizedPnl: p.updatedAt < startOfTradingDayIST() ? '0' : p.realizedPnl.toString(),
    unrealizedPnl: unrealized.toFixed(2),
  };
}

/** Live broker positions: replace the broker's (polled) last price with the fresher feed LTP and move P&L by the difference. */
export function overlayLivePrices(live: LiveAccountData[], prices: PriceCacheService, feed?: MarketFeedService): LiveAccountData[] {
  for (const acc of live) {
    for (const p of acc.positions ?? []) {
      if (p.quantity !== 0) feed?.ensure(p.exchange, p.symbol);
      const ltp = freshLtp(prices, p.exchange, p.symbol);
      if (ltp == null) continue;
      if (p.pnl != null && p.lastPrice != null) p.pnl = p.pnl + (ltp - p.lastPrice) * p.quantity;
      p.lastPrice = ltp;
    }
  }
  return live;
}
