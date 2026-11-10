/**
 * Groww / Motilal Oswal: instrument-master mapping, login and order request shapes, with the network mocked
 * (sample rows copied from each broker's published instrument file).
 */
type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };
const calls: Call[] = [];
let routes: [RegExp, (c: Call) => { status?: number; text: string }][] = [];

jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  return {
    ...actual,
    fetch: jest.fn(async (url: string, init: Call['init'] = {}) => {
      const c = { url: String(url), init };
      calls.push(c);
      const r = routes.find(([re]) => re.test(String(url)));
      if (!r) throw new Error(`unmocked ${url}`);
      const out = r[1](c);
      return { ok: (out.status ?? 200) < 400, status: out.status ?? 200, text: async () => out.text, json: async () => JSON.parse(out.text), arrayBuffer: async () => new ArrayBuffer(0) };
    }),
  };
});

import { createHash } from 'node:crypto';
import { GrowwAdapter, GrowwClient, growwInstruments, growwReference, growwStatus } from '../../src/trading/groww.adapter';
import { MotilalAdapter, MotilalClient, motilalExpiry, motilalInstruments, motilalStatus } from '../../src/trading/motilal.adapter';

const json = (v: unknown) => ({ text: JSON.stringify(v) });

beforeEach(() => {
  calls.length = 0;
});

describe('Groww', () => {
  beforeAll(() => {
    routes = [
      [
        /instrument\.csv/,
        () => ({
          text: [
            'exchange,exchange_token,trading_symbol,groww_symbol,name,instrument_type,segment,series,isin,underlying_symbol,underlying_exchange_token,expiry_date,strike_price,lot_size,tick_size,freeze_quantity,is_reserved,buy_allowed,sell_allowed,internal_trading_symbol,is_intraday',
            'NSE,2885,RELIANCE,NSE-RELIANCE,Reliance Industries,EQ,CASH,EQ,INE002A01018,,,,,1,0.1,,,1,1,RELIANCE-EQ,1',
            'NSE,61471,NIFTY26NOVFUT,NSE-NIFTY-23Nov26-FUT,,FUT,FNO,,,NIFTY,26000,2026-11-23,-0.01,65,0.1,1801,0,1,1,NIFTY26NOVFUT,0',
            'NSE,35028,NIFTY26N1717350CE,NSE-NIFTY-17Nov26-17350-CE,,CE,FNO,,,NIFTY,26000,2026-11-17,17350,65,0.05,1801,1,1,1,NIFTY26N1717350CE,0',
            'BSE,1163250,SENSEX26N1264600CE,BSE-SENSEX-12Nov26-64600-CE,,CE,FNO,,,SENSEX,1,2026-11-12,64600,20,0.05,1001,0,1,1,SENSEX26N1264600CE,0',
          ].join('\n'),
        }),
      ],
      [/\/token\/api\/access$/, () => json({ token: 'acc-tok', expiry: '2099-01-01T06:00:00' })],
      [/\/order\/create$/, () => json({ status: 'SUCCESS', payload: { groww_order_id: 'GMK39038RDT490CCVRO', order_status: 'OPEN' } })],
      [
        /\/order\/list\?segment=FNO/,
        () =>
          json({
            status: 'SUCCESS',
            payload: {
              order_list: [
                { groww_order_id: 'G1', trading_symbol: 'NIFTY26N1717350CE', order_status: 'EXECUTED', quantity: 65, filled_quantity: 65, average_fill_price: 12.5, exchange: 'NSE', order_type: 'MARKET', transaction_type: 'BUY', product: 'MIS', created_at: '2026-11-10T10:15:30', order_reference_id: 'ctpcopy-abc12345' },
              ],
            },
          }),
      ],
      [/\/order\/list\?segment=CASH/, () => json({ status: 'SUCCESS', payload: { order_list: [] } })],
      [/\/order\/cancel$/, () => json({ status: 'SUCCESS', payload: { groww_order_id: 'G1', order_status: 'CANCELLED' } })],
    ];
  });

  it('maps the instrument file to canonical symbols', async () => {
    await growwInstruments.ensure('NFO');
    expect(growwInstruments.get('NSE', 'RELIANCE')).toMatchObject({ key: 'RELIANCE' });
    expect(growwInstruments.get('NFO', 'NIFTY23NOV26FUT')).toMatchObject({ key: 'NIFTY26NOVFUT', lotSize: 65 });
    expect(growwInstruments.get('NFO', 'NIFTY17NOV2617350CE')).toMatchObject({ key: 'NIFTY26N1717350CE' });
    expect(growwInstruments.get('BFO', 'SENSEX12NOV2664600CE')).toMatchObject({ key: 'SENSEX26N1264600CE', lotSize: 20 });
  });

  it('logs in with the TOTP flow', async () => {
    const r = await new GrowwClient().loginWithTotp('api-key', '123456');
    expect(r.accessToken).toBe('acc-tok');
    const c = calls.find((x) => /token\/api\/access/.test(x.url))!;
    expect(c.init.headers).toMatchObject({ Authorization: 'Bearer api-key' });
    expect(JSON.parse(c.init.body!)).toEqual({ key_type: 'totp', totp: '123456' });
  });

  it('places an F&O order with exchange + segment + trading_symbol', async () => {
    const r = await new GrowwAdapter('tok').placeOrder({ exchange: 'NFO', symbol: 'NIFTY17NOV2617350CE', side: 'BUY', quantity: 65, orderType: 'MARKET', productType: 'INTRADAY', tag: 'ctpcopy' });
    expect(r.brokerOrderId).toBe('GMK39038RDT490CCVRO');
    const c = calls.find((x) => /order\/create/.test(x.url))!;
    expect(c.init.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-API-VERSION': '1.0' });
    const body = JSON.parse(c.init.body!);
    expect(body).toMatchObject({ trading_symbol: 'NIFTY26N1717350CE', exchange: 'NSE', segment: 'FNO', product: 'MIS', order_type: 'MARKET', transaction_type: 'BUY', quantity: 65, price: 0, validity: 'DAY' });
    expect(body.order_reference_id).toMatch(/^ctpcopy-[0-9a-f]+$/);
  });

  it('reads the order book back in canonical form and cancels with the segment', async () => {
    const [o] = await new GrowwAdapter('tok').orders();
    expect(o).toMatchObject({ brokerOrderId: 'G1', exchange: 'NFO', symbol: 'NIFTY17NOV2617350CE', status: 'FILLED', productType: 'INTRADAY', tag: 'ctpcopy-abc12345', averagePrice: 12.5 });
    await new GrowwAdapter('tok').cancelOrder('G1');
    expect(JSON.parse(calls.find((x) => /order\/cancel/.test(x.url))!.init.body!)).toEqual({ segment: 'FNO', groww_order_id: 'G1' });
  });

  it('reference ids follow Groww rules (8–20 chars, ≤2 hyphens)', () => {
    for (const tag of ['ctpcopy', 'ctpsqoff', undefined, 'ctp mirror#1']) {
      const id = growwReference(tag);
      expect(id).toMatch(/^[A-Za-z0-9-]{8,20}$/);
      expect((id.match(/-/g) ?? []).length).toBeLessThanOrEqual(2);
    }
    expect(growwStatus('ACKED')).toBe('OPEN');
    expect(growwStatus('FAILED')).toBe('REJECTED');
  });
});

describe('Motilal Oswal', () => {
  const header =
    'exchange,exchangename,scripcode,scripname,marketlot,scripshortname,issuspended,instrumentname,expirydate,strikeprice,optiontype,markettype,foexposurepercent,lowerexchcircuitprice,upperexchcircuitprice,ticksize,scripisinno,indicesidentifier,isbanscrip,scripfullname,facevalue,calevel,maxqtyperorder,ultoken';
  beforeAll(() => {
    routes = [
      [
        /getscripmastercsv\?name=NSEFO/,
        () => ({
          text: [
            header,
            '2,NSEFO,48951,AUBANK 23-Nov-2026 CE 1230,500,AUBANK,N,OPTSTK,1479911400,1230.000,CE," ",5.250,0.050,20.050,0.050,,0,N,AUBANK 23-Nov-2026 CE 1230,0,0,25000,21238',
            '2,NSEFO,61466,BANKNIFTY 23-Nov-2026,30,BANKNIFTY,N,FUTIDX,1479911400,-1.000,XX," ",2.000,53643.398,65563.797,0.200,,0,N,BANKNIFTY 23-Nov-2026,0,0,900,26009',
          ].join('\n'),
        }),
      ],
      [
        /getscripmastercsv\?name=NSE$/,
        () => ({
          text: [
            header,
            '0,NSE,2885,RELIANCE EQ,1,RELIANCE,N,"      ",0,0.000,EQ," ",0.000,1192.000,1456.800,0.100,INE002A01018,26038506076,N,RELIANCE INDUSTRIES LTD-RELIANCE EQ,10,0,0,2885',
            '0,NSE,15759,735AP39 SG,100,735AP39,N,"      ",0,0.000,SG," ",0.000,90.250,99.750,0.010,IN1020230125,0,N,SDL AP 7.35% 2039-735AP39 SG,100,0,0,15759',
          ].join('\n'),
        }),
      ],
      [/authdirectapi$/, () => json({ status: 'SUCCESS', message: 'ok', errorcode: '', AuthToken: 'auth-tok', isAuthTokenVerified: 'TRUE' })],
      [/getaccesstoken$/, () => json({ status: 'SUCCESS', accesstoken: 'acc2' })],
      [/placeorder$/, () => json({ status: 'SUCCESS', message: 'Order placed', errorcode: '', uniqueorderid: '1100000012345' })],
      [/getorderbook$/, () => json({ status: 'FAILURE', message: 'Token Expired', errorcode: 'MO8002', data: null })],
      [/getltpdata$/, () => json({ status: 'SUCCESS', data: { exchange: 'NSE', scripcode: 2885, ltp: 132450 } })],
    ];
  });

  const session = { apiKey: 'KEY', clientCode: 'AB1234', publicIp: '1.2.3.4' };

  it('maps the scrip master (1980 epoch expiries, NSE EQ series only)', async () => {
    expect(motilalExpiry('1479911400')).toBe('2026-11-23');
    await motilalInstruments.ensure('NFO');
    await motilalInstruments.ensure('NSE');
    expect(motilalInstruments.get('NFO', 'AUBANK23NOV261230CE')).toMatchObject({ key: '48951', lotSize: 500 });
    expect(motilalInstruments.get('NFO', 'BANKNIFTY23NOV26FUT')).toMatchObject({ key: '61466', lotSize: 30 });
    expect(motilalInstruments.get('NSE', 'RELIANCE')).toMatchObject({ key: '2885' });
    expect(motilalInstruments.get('NSE', '735AP39')).toBeUndefined();
  });

  it('logs in with sha256(password + apiKey), 2FA and TOTP', async () => {
    const r = await new MotilalClient(session).login('secret', '01/01/1990', '654321');
    expect(r).toEqual({ authToken: 'auth-tok', accessToken: 'acc2' });
    const c = calls.find((x) => /authdirectapi/.test(x.url))!;
    expect(c.url).toContain('/rest/login/v7/authdirectapi');
    expect(c.init.headers).toMatchObject({ ApiKey: 'KEY', vendorinfo: 'AB1234', ClientPublicIp: '1.2.3.4', SourceId: 'WEB', Authorization: '' });
    expect(JSON.parse(c.init.body!)).toEqual({ userid: 'AB1234', password: createHash('sha256').update('secretKEY').digest('hex'), '2FA': '01/01/1990', totp: '654321' });
  });

  it('places F&O orders in lots with the scrip code', async () => {
    const r = await new MotilalAdapter(session, 'auth-tok').placeOrder({ exchange: 'NFO', symbol: 'AUBANK23NOV261230CE', side: 'SELL', quantity: 1000, orderType: 'LIMIT', productType: 'CARRY_FORWARD', price: 10.5, tag: 'ctpcopy' });
    expect(r.brokerOrderId).toBe('1100000012345');
    const c = calls.find((x) => /placeorder/.test(x.url))!;
    expect(c.init.headers).toMatchObject({ Authorization: 'auth-tok' });
    expect(JSON.parse(c.init.body!)).toMatchObject({ exchange: 'NSEFO', symboltoken: 48951, buyorsell: 'SELL', ordertype: 'LIMIT', producttype: 'NORMAL', quantityinlot: 2, price: 10.5, orderduration: 'DAY', amoorder: 'N', tag: 'ctpcopy' });
  });

  it('rejects odd lots and SL-M before calling the broker', async () => {
    const a = new MotilalAdapter(session, 'auth-tok');
    await expect(a.placeOrder({ exchange: 'NFO', symbol: 'AUBANK23NOV261230CE', side: 'BUY', quantity: 700, orderType: 'MARKET', productType: 'INTRADAY' })).rejects.toThrow(/lot size/);
    await expect(a.placeOrder({ exchange: 'NSE', symbol: 'RELIANCE', side: 'BUY', quantity: 1, orderType: 'SL_M', productType: 'INTRADAY', triggerPrice: 1300 })).rejects.toThrow(/SL-M/);
  });

  it('flags expired sessions and converts LTP from paise', async () => {
    const a = new MotilalAdapter(session, 'auth-tok');
    await expect(a.orders()).rejects.toMatchObject({ brokerCode: 'TOKEN_EXPIRED' });
    expect(await a.ltp('NSE', 'RELIANCE')).toBe(1324.5);
    expect(motilalStatus('Traded')).toBe('FILLED');
    expect(motilalStatus('Confirm')).toBe('OPEN');
  });
});
