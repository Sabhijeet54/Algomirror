import type { Prisma } from '@ctp/database';

type Num = number | Prisma.Decimal | null | undefined;
const F = (v: Num): number | null => (v == null ? null : Number(v));

export interface QtyStrategy {
  masterCapital: Num;
  maxOrderValue: Num;
  maxQuantityPerOrder: number | null;
}
export interface QtySettings {
  allocationMode: 'FIXED_QUANTITY' | 'CAPITAL_PERCENTAGE' | 'PROPORTIONAL';
  allocationPercent: Num;
  allocationAmount: Num;
  fixedQuantity: number | null;
  fixedLots?: number | null;
  maxLots?: number | null;
  maxQuantity: number | null;
  maxTradeValue: Num;
}

/**
 * Follower quantity for one master fill. Pure and synchronous (runs in the order hot path).
 *  - FIXED_QUANTITY: fixedLots × lot (if set) else fixedQuantity
 *  - CAPITAL_PERCENTAGE: master qty × percent/100  (i.e. multiplier = percent/100, 200% = 2×)
 *  - PROPORTIONAL: master qty × followerCapital / masterCapital
 * Rounded down to the lot size, then capped by maxLots, maxQuantity, strategy max qty and value caps.
 */
export function computeCopyQuantity(
  strategy: QtyStrategy,
  f: QtySettings,
  masterQty: number,
  price: number | null,
  lotSize: number,
): { qty: number; reason?: string } {
  const lot = Math.max(1, lotSize);
  let qty: number;
  if (f.allocationMode === 'FIXED_QUANTITY') {
    qty = f.fixedLots && f.fixedLots > 0 ? f.fixedLots * lot : (f.fixedQuantity ?? 0);
  } else if (f.allocationMode === 'CAPITAL_PERCENTAGE') {
    qty = Math.floor((masterQty * (F(f.allocationPercent) ?? 0)) / 100);
  } else {
    const masterCap = F(strategy.masterCapital) ?? 0;
    const followerCap = F(f.allocationAmount) ?? 0;
    if (masterCap <= 0) return { qty: 0, reason: 'Strategy has no master capital set for proportional allocation' };
    qty = Math.floor((masterQty * followerCap) / masterCap);
  }
  qty = Math.floor(qty / lot) * lot;
  if (f.maxLots && f.maxLots > 0) qty = Math.min(qty, f.maxLots * lot);
  const caps = [f.maxQuantity, strategy.maxQuantityPerOrder].filter((c): c is number => typeof c === 'number' && c > 0);
  for (const c of caps) qty = Math.min(qty, Math.floor(c / lot) * lot);
  if (price && price > 0) {
    const valueCaps = [F(f.maxTradeValue), F(strategy.maxOrderValue)].filter((c): c is number => c != null && c > 0);
    for (const c of valueCaps) qty = Math.min(qty, Math.floor(c / price / lot) * lot);
  }
  if (qty <= 0) return { qty: 0, reason: 'Calculated quantity is 0 (allocation or limits too small)' };
  return { qty };
}
