import type { BrokerAccount, BrokerName } from '@ctp/database';
import { BrokerApiError } from '../brokers/broker-http';
import type { ApiConfig } from '../config/config.module';
import { AngelOneAdapter, ANGEL_API_ROOT } from './angel.adapter';
import type { BrokerAdapter } from './broker-adapter';
import { KITE_API_ROOT, ZerodhaAdapter } from './zerodha.adapter';
import { UPSTOX_API_ROOT, UpstoxAdapter } from './upstox.adapter';
import { DHAN_API_ROOT, DhanAdapter } from './dhan.adapter';
import { FYERS_API_ROOT, FyersAdapter } from './fyers.adapter';
import { KOTAK_LOGIN_ROOT, KotakNeoAdapter } from './kotak.adapter';
import { FIVEPAISA_API_ROOT, FivePaisaAdapter } from './fivepaisa.adapter';
import { ALICEBLUE_API_ROOT, AliceBlueAdapter } from './aliceblue.adapter';
import { GROWW_API_ROOT, GrowwAdapter } from './groww.adapter';
import { MOTILAL_API_ROOT, MotilalAdapter } from './motilal.adapter';

/**
 * Broker adapter registry. To add a broker (Upstox / Dhan / Fyers):
 *   1. add it to the BrokerName enum (Prisma + @ctp/types),
 *   2. implement BrokerAdapter in trading/<broker>.adapter.ts (call assertCanTrade() first in placeOrder),
 *   3. add a login flow in brokers/ and register a factory here.
 * Nothing in the copy engine changes.
 */
/** Per-account overrides from the client's own broker API app (stored encrypted with the session). */
export interface AccountOverrides {
  apiKey?: string;
  /** Client's static-IP proxy — every call for this account goes out through it. */
  proxyUrl?: string;
  /** Public IP Angel expects in X-ClientPublicIP (the proxy's IP). */
  publicIp?: string;
  /** Whole decrypted session extra (broker-specific ids: Dhan client id, Kotak sid / base URL, …). */
  extra?: Record<string, string | undefined>;
}

export interface AdapterFactory {
  /** REST origin used to keep pooled connections warm. */
  origin: string;
  proxyUrl?: (c: ApiConfig) => string | undefined;
  create(c: ApiConfig, token: string, account: Pick<BrokerAccount, 'mode'>, o?: AccountOverrides): BrokerAdapter;
}

/** Reads overrides from a decrypted credential `extra` blob. */
export function overridesFrom(extra: Record<string, string | undefined> | null | undefined): AccountOverrides {
  if (!extra) return {};
  return { apiKey: extra.apiKey || undefined, proxyUrl: extra.proxyUrl || undefined, publicIp: extra.publicIp || undefined, extra };
}

export const ADAPTERS: Partial<Record<BrokerName, AdapterFactory>> = {
  ZERODHA: {
    origin: KITE_API_ROOT,
    proxyUrl: (c) => c.ZERODHA_PROXY_URL,
    create: (c, token, a, o) => {
      const apiKey = o?.apiKey ?? c.ZERODHA_API_KEY;
      if (!apiKey) throw new BrokerApiError('Zerodha is not configured on the server.');
      return new ZerodhaAdapter(apiKey, token, o?.proxyUrl ?? c.ZERODHA_PROXY_URL, { dataOnly: a.mode === 'DATA_ONLY' });
    },
  },
  ANGEL_ONE: {
    origin: ANGEL_API_ROOT,
    proxyUrl: (c) => c.ANGEL_PROXY_URL,
    create: (c, token, a, o) => {
      const apiKey = o?.apiKey ?? c.ANGEL_API_KEY;
      if (!apiKey) throw new BrokerApiError('Angel One is not configured on the server.');
      return new AngelOneAdapter(
        {
          apiKey,
          publicIp: o?.publicIp ?? c.ANGEL_PUBLIC_IP,
          localIp: c.ANGEL_LOCAL_IP,
          macAddress: c.ANGEL_MAC_ADDRESS,
          proxyUrl: o?.proxyUrl ?? c.ANGEL_PROXY_URL,
        },
        token,
        { dataOnly: a.mode === 'DATA_ONLY' },
      );
    },
  },
  UPSTOX: {
    origin: UPSTOX_API_ROOT,
    // Upstox only needs the Bearer token; orders go out through the client's own static-IP proxy.
    create: (_c, token, a, o) => new UpstoxAdapter(token, o?.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' }),
  },
  DHAN: {
    origin: DHAN_API_ROOT,
    create: (_c, token, a, o) => {
      const clientId = o?.extra?.clientId;
      if (!clientId) throw new BrokerApiError('Dhan session has no client ID — please reconnect.');
      return new DhanAdapter(clientId, token, o?.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' });
    },
  },
  FYERS: {
    origin: FYERS_API_ROOT,
    create: (_c, token, a, o) => {
      if (!o?.apiKey) throw new BrokerApiError('Fyers session has no App ID — please reconnect.');
      return new FyersAdapter(o.apiKey, token, o.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' });
    },
  },
  KOTAK_NEO: {
    origin: KOTAK_LOGIN_ROOT,
    create: (_c, token, a, o) => {
      const e = o?.extra ?? {};
      if (!e.sid || !e.baseUrl || !o?.apiKey) throw new BrokerApiError('Kotak Neo session is incomplete — please reconnect.');
      return new KotakNeoAdapter({ token, sid: e.sid, serverId: e.serverId ?? '', baseUrl: e.baseUrl, consumerKey: o.apiKey }, o.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' });
    },
  },
  FIVE_PAISA: {
    origin: FIVEPAISA_API_ROOT,
    create: (_c, token, a, o) => {
      const e = o?.extra ?? {};
      if (!o?.apiKey || !e.clientCode) throw new BrokerApiError('5paisa session is incomplete — please reconnect.');
      return new FivePaisaAdapter({ token, userKey: o.apiKey, clientCode: e.clientCode }, o.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' });
    },
  },
  ALICE_BLUE: {
    origin: ALICEBLUE_API_ROOT,
    create: (_c, token, a, o) => {
      const e = o?.extra ?? {};
      if (!e.clientCode) throw new BrokerApiError('Alice Blue session is incomplete — please reconnect.');
      return new AliceBlueAdapter(e.clientCode, token, o?.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' });
    },
  },
  GROWW: {
    origin: GROWW_API_ROOT,
    create: (_c, token, a, o) => new GrowwAdapter(token, o?.proxyUrl, { dataOnly: a.mode === 'DATA_ONLY' }),
  },
  MOTILAL_OSWAL: {
    origin: MOTILAL_API_ROOT,
    create: (c, token, a, o) => {
      const e = o?.extra ?? {};
      if (!o?.apiKey || !e.clientCode) throw new BrokerApiError('Motilal Oswal session is incomplete — please reconnect.');
      return new MotilalAdapter(
        {
          apiKey: o.apiKey,
          apiSecret: e.apiSecret,
          clientCode: e.clientCode,
          accessToken: e.accessToken,
          publicIp: o.publicIp,
          localIp: e.localIp ?? c.ANGEL_LOCAL_IP,
          macAddress: e.macAddress ?? c.ANGEL_MAC_ADDRESS,
          proxyUrl: o.proxyUrl,
        },
        token,
        { dataOnly: a.mode === 'DATA_ONLY' },
      );
    },
  },
};
