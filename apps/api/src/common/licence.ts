import type { PrismaClient } from '@ctp/database';

const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

/**
 * Licence expiry: `days` full days after `from`, running to the END of that day in IST (23:59:59.999 IST).
 * A licence therefore never stops in the middle of a trading day: a 2-day licence given on 2 Nov at 3 pm is
 * valid until 4 Nov 23:59 IST (it used to stop at 3 pm on 4 Nov). Extending from an expiry adds whole days.
 */
export function licenceExpiry(from: Date, days: number): Date {
  const ist = new Date(from.getTime() + days * DAY_MS + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 23, 59, 59, 999) - IST_MS);
}

export interface LicenceHistoryItem {
  at: string;
  /** ASSIGNED (fresh) | EXTENDED | REVOKED | CREATED (user created with a licence) */
  kind: 'ASSIGNED' | 'EXTENDED' | 'REVOKED' | 'CREATED';
  days: number | null;
  demo: boolean;
  /** Expiry set by this change (revoke = the moment it was revoked). */
  expiresAt: string | null;
  by: { name: string; role: string } | null;
}

type Meta = {
  licenceDays?: number | null;
  demo?: boolean;
  extend?: boolean;
  expiresAt?: string;
  licenceRevoked?: boolean;
  createdByAdmin?: boolean;
  createdByMaster?: boolean;
};

/**
 * Licence history of one user, newest first, from the audit trail (every assign / extend / revoke and
 * "created with a licence" is already logged there — older changes show up too).
 */
export async function licenceHistory(prisma: PrismaClient, userId: string): Promise<LicenceHistoryItem[]> {
  const rows = await prisma.auditLog.findMany({
    where: { targetType: 'User', targetId: userId, action: 'PROFILE_UPDATED' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { actor: { select: { name: true, role: true } } },
  });
  const out: LicenceHistoryItem[] = [];
  for (const r of rows) {
    const m = (r.metadata ?? {}) as Meta;
    const by = r.actor ? { name: r.actor.name, role: r.actor.role } : null;
    if (m.licenceRevoked) {
      out.push({ at: r.createdAt.toISOString(), kind: 'REVOKED', days: null, demo: false, expiresAt: r.createdAt.toISOString(), by });
    } else if ((m.createdByAdmin || m.createdByMaster) && m.licenceDays) {
      out.push({
        at: r.createdAt.toISOString(),
        kind: 'CREATED',
        days: m.licenceDays,
        demo: !!m.demo,
        expiresAt: m.expiresAt ?? new Date(r.createdAt.getTime() + m.licenceDays * DAY_MS).toISOString(),
        by,
      });
    } else if (m.licenceDays && m.expiresAt) {
      out.push({ at: r.createdAt.toISOString(), kind: m.extend ? 'EXTENDED' : 'ASSIGNED', days: m.licenceDays, demo: !!m.demo, expiresAt: m.expiresAt, by });
    }
  }
  return out;
}

/** Free trial licence: demo (paper only, any days) or the 2-day licence. */
export const isTrialLicence = (days: number | null | undefined, demo: boolean | undefined) => !!demo || days === 2;

/** True once this user has ever been given a free trial (demo / 2 days) — a trial is given only once. */
export async function trialUsed(prisma: PrismaClient, userId: string): Promise<boolean> {
  return (await licenceHistory(prisma, userId)).some((h) => h.kind !== 'REVOKED' && isTrialLicence(h.days, h.demo));
}

/**
 * A client deleted by the master and created again with the same email does not get a second trial:
 * the deleted account's history (found through the delete audit entry) still counts.
 */
export async function emailTrialUsed(prisma: PrismaClient, email: string): Promise<boolean> {
  const rows = await prisma.auditLog.findMany({
    where: { targetType: 'User', action: 'PROFILE_UPDATED', metadata: { path: ['email'], equals: email.toLowerCase() } },
    select: { targetId: true, metadata: true },
    take: 20,
  });
  for (const r of rows) {
    if ((r.metadata as { clientDeleted?: boolean } | null)?.clientDeleted && r.targetId && (await trialUsed(prisma, r.targetId))) return true;
  }
  return false;
}
