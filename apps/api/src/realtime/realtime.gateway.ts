import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { PrismaClient } from '@ctp/database';
import { ACCESS_COOKIE } from '../auth/auth-cookies';
import { TokenService } from '../auth/token.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { API_CONFIG, ApiConfig } from '../config/config.module';

const userRoom = (userId: string) => `user:${userId}`;
const ROLE_ROOM = (role: string) => `role:${role}`;

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * Socket.IO endpoint (path /socket.io; the web app reaches it as /api/socket.io through the Next.js proxy).
 * Authenticated with the same httpOnly access cookie as REST. Each socket joins `user:<id>` and `role:<ROLE>`,
 * so events are only ever delivered to the user they belong to (or to admins).
 */
// addTrailingSlash:false — Next.js strips the trailing slash when proxying /api/socket.io/ → /socket.io, which made
// engine.io (expecting /socket.io/) answer 404. Without the slash requirement both forms match.
@WebSocketGateway({ path: '/socket.io', addTrailingSlash: false, serveClient: false, cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly tokens: TokenService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const origin = client.handshake.headers.origin;
      if (origin && origin !== this.config.WEB_ORIGIN && !this.config.EXTRA_WEB_ORIGINS.includes(origin) && this.config.APP_ENV !== 'development') throw new Error('bad origin');
      const token = readCookie(client.handshake.headers.cookie, ACCESS_COOKIE);
      if (!token) throw new Error('no token');
      const payload = await this.tokens.verifyAccess(token);
      const session = await this.prisma.session.findUnique({
        where: { id: payload.sid },
        select: { revokedAt: true, expiresAt: true, userId: true, user: { select: { status: true, role: true } } },
      });
      if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
        throw new Error('session');
      }
      await client.join([userRoom(payload.sub), ROLE_ROOM(session.user.role)]);
      client.data.userId = payload.sub;
    } catch {
      client.emit('auth.error', { message: 'Not authenticated' });
      client.disconnect(true);
    }
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(userRoom(userId)).emit(event, payload);
  }

  emitToRole(role: 'ADMIN' | 'MASTER' | 'FOLLOWER', event: string, payload: unknown): void {
    this.server?.to(ROLE_ROOM(role)).emit(event, payload);
  }
}

/** Thin facade so services don't depend on the gateway class directly. Never throws. */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger('Realtime');
  constructor(private readonly gateway: RealtimeGateway) {}

  toUser(userId: string, event: string, payload: unknown): void {
    try {
      this.gateway.emitToUser(userId, event, payload);
    } catch (err) {
      this.logger.warn(`emit ${event} failed: ${(err as Error).message}`);
    }
  }

  toRole(role: 'ADMIN' | 'MASTER' | 'FOLLOWER', event: string, payload: unknown): void {
    try {
      this.gateway.emitToRole(role, event, payload);
    } catch (err) {
      this.logger.warn(`emit ${event} failed: ${(err as Error).message}`);
    }
  }
}
