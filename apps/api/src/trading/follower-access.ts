import type { StrategyFollower } from "@ctp/database";

/** stoppedReason written when a master / admin removes a client from a strategy: the client loses access to it. */
export const REMOVED_REASON = "Removed from strategy";

export const isRemoved = (
  f: Pick<StrategyFollower, "copyStatus" | "stoppedReason">,
) => f.copyStatus === "OFF" && f.stoppedReason === REMOVED_REASON;

/**
 * May this client see the strategy in the marketplace and (re)connect it himself? Yes while it is assigned,
 * and after the client disconnected it himself. No once a master / sub-admin / admin removed it — including
 * from inside the client's panel, where the remover is recorded as the master.
 */
export const canReconnect = (
  f: Pick<StrategyFollower, "copyStatus" | "stoppedReason" | "stoppedByUserId">,
  clientId: string,
) => !isRemoved(f) || f.stoppedByUserId === clientId;

/** Human label of a subscription's allocation ("2× lots", "1 lot", "₹50,000"). */
export function allocationLabel(
  s: Pick<
    StrategyFollower,
    | "allocationMode"
    | "allocationPercent"
    | "allocationAmount"
    | "fixedLots"
    | "fixedQuantity"
  >,
): string {
  if (s.allocationMode === "FIXED_QUANTITY")
    return s.fixedLots
      ? `${s.fixedLots} lot${s.fixedLots > 1 ? "s" : ""}`
      : `${s.fixedQuantity ?? 0} qty`;
  if (s.allocationMode === "CAPITAL_PERCENTAGE")
    return `${+(Number(s.allocationPercent ?? 0) / 100).toFixed(2)}× lots`;
  return `₹${Number(s.allocationAmount ?? 0).toLocaleString("en-IN")} capital`;
}
