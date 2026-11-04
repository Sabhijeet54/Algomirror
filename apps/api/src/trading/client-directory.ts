import type { PrismaClient } from '@ctp/database';
import { isRemoved } from './follower-access';

/**
 * Active client (FOLLOWER) accounts for the "Assign client" picker — name, email, mobile and whether the client
 * already has `strategyId`. Never returns secrets.
 */
export async function clientDirectory(prisma: PrismaClient, search?: string, strategyId?: string, masterUserId?: string) {
  const q = search?.trim().slice(0, 100);
  const users = await prisma.user.findMany({
    where: {
      role: 'FOLLOWER',
      status: 'ACTIVE',
      ...(masterUserId ? { AND: [masterScope(masterUserId)] } : {}),
      ...(q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { mobile: { contains: q } }] }
        : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      mobile: true,
      follows: strategyId ? { where: { strategyId }, select: { copyStatus: true, stoppedReason: true } } : false,
    },
    orderBy: { name: 'asc' },
    take: 50,
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    mobile: u.mobile,
    assigned: Array.isArray(u.follows) && u.follows.some((f) => !isRemoved(f)),
  }));
}

/**
 * Multi-master isolation: a master only sees his own clients — created by him (parentUserId), or not yet owned
 * by any master (self sign-ups) and not on another master's strategy. Clients of other masters never show.
 */
export function masterScope(masterUserId: string) {
  return {
    OR: [
      { parentUserId: masterUserId },
      {
        parentUserId: null,
        OR: [{ follows: { some: { strategy: { masterUserId } } } }, { follows: { none: { strategy: { masterUserId: { not: masterUserId } } } } }],
      },
    ],
  };
}

/** The master a client belongs to: the one who created it, else the master of its first strategy (null = nobody yet). */
export async function clientOwner(prisma: PrismaClient, client: { id: string; parentUserId: string | null }): Promise<string | null> {
  if (client.parentUserId) return client.parentUserId;
  const first = await prisma.strategyFollower.findFirst({
    where: { followerUserId: client.id },
    orderBy: { createdAt: 'asc' },
    select: { strategy: { select: { masterUserId: true } } },
  });
  return first?.strategy.masterUserId ?? null;
}
