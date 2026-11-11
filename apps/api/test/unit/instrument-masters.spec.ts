/**
 * Instrument-master regressions (2026-11-11), using rows copied from each broker's published file:
 * - Kotak Neo's bse_fo file types contracts IO/SO/IF/SF (not OPTIDX…), which left BFO empty.
 * - Motilal names BSE index derivatives BSX/BKX/SX50, and MCX expiries landed a day late.
 * - Alice Blue's contract master is now JSON.
 * - The streaming readers that keep 30–40 MB files inside the API heap.
 */
let routes: [RegExp, () => { status?: number; text: string }][] = [];

jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  return {
    ...actual,
    fetch: jest.fn(async (url: string) => {
      const r = routes.find(([re]) => re.test(String(url)));
      if (!r) throw new Error(`unmocked ${url}`);
      const out = r[1]();
      return { ok: (out.status ?? 200) < 400, status: out.status ?? 200, headers: new Map(), text: async () => out.text, json: async () => JSON.parse(out.text) };
    }),
  };
});

import { csvRows, jsonArrayObjects } from '../../src/market-data/broker-instruments';
import { aliceInstruments } from '../../src/trading/aliceblue.adapter';
import { kotakInstruments } from '../../src/trading/kotak.adapter';
import { motilalExpiry, motilalInstruments } from '../../src/trading/motilal.adapter';

const KOTAK_HEAD =
  'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pOptionType,pScripRefKey,pISIN,pAssetCode,pSubGroup,pCombinedSymbol,pDesc,pAmcCode,pContractId,dTickSize ,lLotSize,lExpiryDate ,lMultiplier ,lPrecision,dStrikePrice;';

describe('streaming readers', () => {
  it('csvRows handles quotes, CRLF and blank lines', () => {
    expect([...csvRows('a,b\r\n"x,1","say ""hi"""\n\nlast,')]).toEqual([['a', 'b'], ['x,1', 'say "hi"'], ['last', '']]);
  });

  it('jsonArrayObjects yields flat objects, honours strings with braces and the keep filter', () => {
    const text = '{"NFO":[{"a":"{x}","n":1},{"a":"y","n":2,"o":{"k":1}},{"a":"z","n":3}]}';
    expect([...jsonArrayObjects<{ n: number }>(text.slice(text.indexOf('[')))].map((o) => o.n)).toEqual([1, 2, 3]);
    expect([...jsonArrayObjects<{ n: number }>('[{"n":1},{"n":2}]', (raw) => raw.includes('2'))]).toEqual([{ n: 2 }]);
  });
});

describe('Kotak Neo bse_fo / mcx_fo', () => {
  beforeAll(() => {
    routes = [
      [/file-paths$/, () => ({ text: JSON.stringify({ data: { filesPaths: ['https://k/x/bse_fo.csv', 'https://k/x/mcx_fo.csv'] } }) })],
      [
        /bse_fo\.csv$/,
        () => ({
          text: [
            KOTAK_HEAD,
            '821516,,bse_fo,IO,SENSEX,SENSEX26N1982200CE,CE,SENSEX19NOV2682200.00CE,,1,,,SENSEX26N1982200CE,,,5,20,1795112999,1,2,8.22e+06',
            '1114575,,bse_fo,SO,UPL,UPL26NOV520PE,PE,UPL26NOV26520.00PE,,512070,,,UPL26NOV520PE,,,5,1355,1795717799,1,2,52000',
            '1177361,,bse_fo,SF,MANKIND,MANKIND27JANFUT,XX,MANKIND28JAN27FUT,,543904,,,MANKIND27JANFUT,,,5,250,1801160999,1,2,0',
          ].join('\n'),
        }),
      ],
      [/mcx_fo\.csv$/, () => ({ text: [KOTAK_HEAD, '591827,,mcx_fo,OPTFUT,GOLDM,GOLDM29JAN27160500CE,CE,,,,,,,,,1,100,1801267199,-1,2,1.605e+07'].join('\n') })],
    ];
  });

  it('maps IO/SO options and SF futures', async () => {
    await kotakInstruments.ensure('BFO', { baseUrl: 'https://kotak', consumerKey: 'k' });
    expect(kotakInstruments.get('BFO', 'SENSEX19NOV2682200CE')).toMatchObject({ key: '821516', lotSize: 20 });
    expect(kotakInstruments.get('BFO', 'UPL26NOV26520PE')).toMatchObject({ key: '1114575' });
    expect(kotakInstruments.get('BFO', 'MANKIND28JAN27FUT')).toMatchObject({ key: '1177361' });
  });

  it('keeps the MCX expiry on its own day', async () => {
    await kotakInstruments.ensure('MCX', { baseUrl: 'https://kotak', consumerKey: 'k' });
    expect(kotakInstruments.get('MCX', 'GOLDM29JAN27160500CE')).toMatchObject({ key: '591827' });
  });
});

describe('Motilal BSE index names and MCX expiry', () => {
  const HEAD = 'exchange,exchangename,scripcode,scripname,marketlot,scripshortname,issuspended,instrumentname,expirydate,strikeprice,optiontype,markettype';
  beforeAll(() => {
    routes = [
      [/name=BSEFO$/, () => ({ text: [HEAD, '9,BSEFO,1149111,BSX 12-NOV-2026 PE 74400,20,BSX,N,OPTIDX,1478908800,74400.000,PE," "', '9,BSEFO,1,BKX 26-NOV-2026 FUT,30,BKX,N,FUTIDX,1480118400,-1,XX," "'].join('\n') })],
      [/name=MCX$/, () => ({ text: [HEAD, '6,MCX,588645,CRUDEOIL 19-Apr-2027,100,CRUDEOIL,N,FUTCOM,1492646399,-1.000,XX," "'].join('\n') })],
    ];
  });

  it('reads expiries on the IST wall clock', () => {
    expect(motilalExpiry('1479911400')).toBe('2026-11-23');
    expect(motilalExpiry('1492646399')).toBe('2027-04-19');
  });

  it('maps BSX/BKX to SENSEX/BANKEX and MCX futures to the right day', async () => {
    await motilalInstruments.ensure('BFO');
    expect(motilalInstruments.get('BFO', 'SENSEX12NOV2674400PE')).toMatchObject({ key: '1149111', lotSize: 20 });
    expect(motilalInstruments.get('BFO', 'BANKEX26NOV26FUT')).toMatchObject({ key: '1' });
    await motilalInstruments.ensure('MCX');
    expect(motilalInstruments.get('MCX', 'CRUDEOIL19APR27FUT')).toMatchObject({ key: '588645' });
  });
});

describe('Alice Blue JSON contract master', () => {
  beforeAll(() => {
    routes = [
      [
        /exch=NFO$/,
        () => ({
          text: JSON.stringify({
            NFO: [
              { exch: 'NFO', expiry_date: 1795392000000, instrument_type: 'OPTIDX', lot_size: '60', option_type: 'CE', strike_price: '28150', symbol: 'FINNIFTY', token: '35050', trading_symbol: 'FINNIFTY23NOV26C28150' },
              { exch: 'NFO', expiry_date: 1795392000000, instrument_type: 'FUTIDX', lot_size: '65', option_type: 'XX', strike_price: '-1', symbol: 'NIFTY', token: '61471', trading_symbol: 'NIFTY23NOV26F' },
            ],
          }),
        }),
      ],
      [/exch=NSE$/, () => ({ text: JSON.stringify({ NSE: [{ exch: 'NSE', lot_size: '1', symbol: 'GRANULES', token: '11872', trading_symbol: 'GRANULES-EQ' }, { exch: 'NSE', lot_size: '1200', symbol: 'GRAPHISAD', token: '20454', trading_symbol: 'GRAPHISAD-SM' }] }) })],
    ];
  });

  it('loads derivatives and EQ series from JSON', async () => {
    await aliceInstruments.ensure('NFO');
    expect(aliceInstruments.get('NFO', 'FINNIFTY23NOV2628150CE')).toMatchObject({ key: '35050', lotSize: 60, tradingSymbol: 'FINNIFTY23NOV26C28150' });
    expect(aliceInstruments.get('NFO', 'NIFTY23NOV26FUT')).toMatchObject({ key: '61471' });
    await aliceInstruments.ensure('NSE');
    expect(aliceInstruments.get('NSE', 'GRANULES')).toMatchObject({ key: '11872' });
    expect(aliceInstruments.get('NSE', 'GRAPHISAD')).toBeUndefined();
  });
});
