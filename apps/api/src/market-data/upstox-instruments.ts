import { Logger } from '@nestjs/common';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { fetch as undiciFetch } from 'undici';
import { jsonArrayObjects } from './broker-instruments';
import { canonicalFromParts } from '../trading/symbols';

/**
 * Upstox instrument master (public, refreshed daily by Upstox). Upstox orders / quotes take an
 * `instrument_key` such as "NSE_FO|36708" or "NSE_EQ|INE848E01016" instead of a trading symbol, so every
 * platform (canonical) symbol is mapped to its key here — and back, when reading the order book / positions.
 * One file per Upstox exchange (NSE / BSE / MCX), loaded lazily once per IST day, shared by every adapter.
 */
const FILE: Record<string, string> = {
  NSE: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
  MCX: 'https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz',
};
/** Upstox segment → platform exchange. */
const SEGMENT: Record<string, string> = { NSE_EQ: 'NSE', BSE_EQ: 'BSE', NSE_FO: 'NFO', BSE_FO: 'BFO', MCX_FO: 'MCX', NCD_FO: 'CDS', BCD_FO: 'BCD' };
/** Platform exchange → Upstox file. */
const FILE_OF: Record<string, string> = { NSE: 'NSE', NFO: 'NSE', CDS: 'NSE', BSE: 'BSE', BFO: 'BSE', BCD: 'BSE', MCX: 'MCX' };

const gunzipAsync = promisify(gunzip);
const istDay = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const istDate = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

export interface UpstoxInstrument {
  key: string;
  exchange: string;
  symbol: string; // canonical platform symbol
  lotSize: number;
}

interface Row {
  segment?: string;
  instrument_type?: string;
  instrument_key?: string;
  trading_symbol?: string;
  underlying_symbol?: string;
  asset_symbol?: string;
  name?: string;
  expiry?: number;
  strike_price?: number;
  lot_size?: number;
}

class UpstoxInstrumentStore {
  private readonly logger = new Logger('UpstoxInstruments');
  private readonly day = new Map<string, string>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly byCanonical = new Map<string, UpstoxInstrument>(); // `${exchange}:${symbol}`
  private readonly byKey = new Map<string, UpstoxInstrument>();

  /** Loads the Upstox file that holds `exchange` (platform exchange code). */
  async ensure(exchange: string): Promise<void> {
    const file = FILE_OF[exchange.toUpperCase()];
    if (!file || this.day.get(file) === istDay()) return;
    let p = this.loading.get(file);
    if (!p) {
      p = this.load(file).finally(() => this.loading.delete(file));
      this.loading.set(file, p);
    }
    return p;
  }

  get(exchange: string, canonical: string): UpstoxInstrument | undefined {
    return this.byCanonical.get(`${exchange.toUpperCase()}:${canonical.toUpperCase()}`);
  }

  fromKey(key: string): UpstoxInstrument | undefined {
    return this.byKey.get(key);
  }

  /** Platform exchange of an Upstox instrument key ("NSE_FO|123" → "NFO"). */
  exchangeOfKey(key: string): string | undefined {
    return SEGMENT[key.split('|')[0] ?? ''];
  }

  private async load(file: string): Promise<void> {
    try {
      const res = await undiciFetch(FILE[file]!, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const rows = jsonArrayObjects<Row>((await gunzipAsync(buf)).toString('utf8'));
      let n = 0;
      for (const r of rows) {
        const exchange = SEGMENT[r.segment ?? ''];
        if (!exchange || !r.instrument_key || !r.instrument_type) continue;
        const t = r.instrument_type.toUpperCase();
        let symbol: string | null;
        if (t === 'CE' || t === 'PE' || t === 'FUT') {
          if (!r.expiry) continue;
          const name = (r.underlying_symbol || r.asset_symbol || r.name || '').toUpperCase();
          symbol = canonicalFromParts(name, istDate(Number(r.expiry)), t === 'FUT' ? null : Number(r.strike_price), t);
        } else {
          symbol = (r.trading_symbol ?? '').toUpperCase() || null;
        }
        if (!symbol) continue;
        const inst: UpstoxInstrument = { key: r.instrument_key, exchange, symbol, lotSize: Number(r.lot_size) || 1 };
        const ck = `${exchange}:${symbol}`;
        // Equity: keep the main (EQ) series when a symbol appears twice.
        if (!this.byCanonical.has(ck) || t === 'EQ') this.byCanonical.set(ck, inst);
        this.byKey.set(inst.key, inst);
        n++;
      }
      if (!n) throw new Error('empty instrument file');
      this.day.set(file, istDay());
      this.logger.log(`Loaded ${n} Upstox ${file} instruments`);
    } catch (err) {
      this.logger.warn(`Upstox ${file} instrument file failed: ${(err as Error).message}`);
      throw err;
    }
  }
}

export const upstoxInstruments = new UpstoxInstrumentStore();
