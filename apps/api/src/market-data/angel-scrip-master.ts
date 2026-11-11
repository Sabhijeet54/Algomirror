import { Logger } from '@nestjs/common';
import { fetch as undiciFetch } from 'undici';
import { canonicalFromParts } from '../trading/symbols';
import { jsonArrayObjects } from './broker-instruments';

/**
 * Angel One OpenAPI scrip master (public JSON, every exchange, refreshed daily by Angel). Gives the EXACT
 * Angel tradingsymbol + token for a platform (canonical) symbol — e.g. BFO SENSEX15OCT2674500CE →
 * Angel's own BSE weekly name and token — so the market feed and orders never depend on guessing names.
 * Loaded lazily once per IST day and shared by every adapter (plain module singleton, no DI).
 */
const URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const MON: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const FNO = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);
const istDay = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export interface AngelContract {
  exchange: string;
  name: string;
  expiry: string; // YYYY-MM-DD
  type: 'CE' | 'PE' | 'FUT';
  strike: number;
  lotSize: number;
  token: string;
  symbol: string;
}

class AngelScripMasterStore {
  private readonly logger = new Logger('AngelScripMaster');
  private day: string | null = null;
  private loading?: Promise<void>;
  private byCanonical = new Map<string, AngelContract>();
  contracts: AngelContract[] = [];

  async ensure(): Promise<void> {
    if (this.day === istDay()) return;
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  /** Exact Angel contract for a canonical derivative symbol (after ensure()). */
  get(exchange: string, canonical: string): AngelContract | undefined {
    return this.byCanonical.get(`${exchange.toUpperCase()}:${canonical.toUpperCase()}`);
  }

  private async load(): Promise<void> {
    try {
      const res = await undiciFetch(URL, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      type Row = { token?: string; symbol?: string; name?: string; expiry?: string; strike?: string; lotsize?: string; instrumenttype?: string; exch_seg?: string };
      // ~38 MB / 200k rows: res.json() needed more than the API's whole heap, so scan and parse only F&O rows.
      const fno = /"exch_seg"\s*:\s*"(NFO|BFO|MCX|CDS|BCD)"/;
      const rows = jsonArrayObjects<Row>(await res.text(), (raw) => fno.test(raw));
      const list: AngelContract[] = [];
      const map = new Map<string, AngelContract>();
      for (const r of rows) {
        if (!r.exch_seg || !FNO.has(r.exch_seg) || !r.expiry || !r.instrumenttype || !r.symbol || !r.token) continue;
        const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(r.expiry.toUpperCase());
        if (!m || !MON[m[2]!]) continue;
        const fut = r.instrumenttype.startsWith('FUT');
        const sym = r.symbol.toUpperCase();
        const type = fut ? 'FUT' : sym.endsWith('CE') ? 'CE' : sym.endsWith('PE') ? 'PE' : null;
        if (!type) continue;
        const c: AngelContract = {
          exchange: r.exch_seg,
          name: (r.name ?? '').trim().toUpperCase(),
          expiry: `${m[3]}-${MON[m[2]!]}-${m[1]}`,
          type,
          strike: fut ? 0 : Number(r.strike) / 100, // Angel strikes are in paise
          lotSize: Number(r.lotsize) || 1,
          token: r.token,
          symbol: r.symbol,
        };
        list.push(c);
        const canon = canonicalFromParts(c.name, c.expiry, fut ? null : c.strike, type);
        if (canon) map.set(`${c.exchange}:${canon}`, c);
      }
      if (!list.length) throw new Error('empty scrip master');
      this.contracts = list;
      this.byCanonical = map;
      this.day = istDay();
      this.logger.log(`Loaded ${list.length} Angel One F&O contracts`);
    } catch (err) {
      this.logger.warn(`Angel One scrip master load failed: ${(err as Error).message}`);
      throw err;
    }
  }
}

export const angelScripMaster = new AngelScripMasterStore();
