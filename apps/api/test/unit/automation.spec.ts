/** Strategy automation: settings validation, schedule timing, trailing SL, daily limit, re-entry, Chartink. */
import { BadRequestException } from "@nestjs/common";
import {
  AutomationError,
  dailyLimitHit,
  dayPnl,
  isDue,
  istNow,
  legAlert,
  normalizeAutomation,
  parseChartink,
  pctPoints,
  readAutomation,
  trailStep,
} from "../../src/trading/automation";
import { AutomationService } from "../../src/trading/automation.service";
import { parseAlert } from "../../src/trading/webhook-alert";

describe("automation settings", () => {
  it("fills defaults and never throws on stored junk", () => {
    expect(readAutomation(null).schedule.enabled).toBe(false);
    expect(
      readAutomation({ schedule: { entryTime: "bad" } }).schedule.entryTime,
    ).toBe("09:20");
  });

  it("validates the schedule", () => {
    const ok = normalizeAutomation({
      schedule: {
        enabled: true,
        entryTime: "09:20",
        exitTime: "15:10",
        days: [1, 3, 3, 9],
        legs: [
          {
            underlying: "nifty",
            option: "CE",
            strike: 0,
            side: "SELL",
            lots: 1,
          },
          { underlying: "NIFTY", option: "PE", side: "SELL" },
        ],
      },
      daily: { maxLoss: "5000" },
      reentry: { enabled: true, max: 2 },
    });
    expect(ok.schedule.days).toEqual([1, 3]);
    expect(ok.schedule.legs[0]).toEqual({
      underlying: "NIFTY",
      option: "CE",
      strike: 0,
      side: "SELL",
      lots: 1,
    });
    expect(ok.daily.maxLoss).toBe(5000);
    expect(ok.reentry.max).toBe(2);
    expect(() =>
      normalizeAutomation({ schedule: { enabled: true, legs: [] } }),
    ).toThrow(/at least one leg/);
    expect(() =>
      normalizeAutomation({ schedule: { entryTime: "9:20" } }),
    ).toThrow(AutomationError);
    expect(() =>
      normalizeAutomation({
        schedule: { entryTime: "10:00", exitTime: "09:30" },
      }),
    ).toThrow(/after the entry/);
    expect(() => normalizeAutomation({ reentry: { max: 3 } })).toThrow(
      /1 to 2/,
    );
    expect(() => normalizeAutomation({ daily: { maxLoss: -5 } })).toThrow(
      /positive/,
    );
  });

  it("turns a straddle leg into an alert the webhook parser accepts", () => {
    const s = normalizeAutomation({
      schedule: {
        legs: [
          {
            underlying: "NIFTY",
            option: "PE",
            strike: -1,
            side: "SELL",
            lots: 2,
          },
        ],
        stoplossPoints: 20,
      },
    }).schedule;
    const a = parseAlert(legAlert(s.legs[0]!, s));
    expect(a).toMatchObject({
      action: "SELL",
      underlying: "NIFTY",
      option: "PE",
      strike: { atmOffset: -1 },
      lots: 2,
      expiry: "nearest",
      stoplossPoints: 20,
      product: "INTRADAY",
    });
  });
});

describe("IST clock", () => {
  it("converts to IST and finds the due window", () => {
    const t = istNow(new Date("2026-11-13T03:50:30Z")); // 09:20:30 IST Friday
    expect(t).toMatchObject({ date: "2026-11-13", hhmm: "09:20", weekday: 5 });
    expect(t.dayStart.toISOString()).toBe("2026-11-12T18:30:00.000Z");
    expect(isDue("09:20", "09:20")).toBe(true);
    expect(isDue("09:20", "09:22")).toBe(true);
    expect(isDue("09:20", "09:23")).toBe(false);
    expect(isDue("09:20", "09:19")).toBe(false);
  });
});

describe("trailing stop loss", () => {
  it("moves SL by whole steps in favour only", () => {
    expect(
      trailStep({ side: "BUY", stopLoss: 90, anchor: 100, step: 10, ltp: 109 }),
    ).toBeNull();
    expect(
      trailStep({ side: "BUY", stopLoss: 90, anchor: 100, step: 10, ltp: 125 }),
    ).toEqual({ stopLoss: 110, anchor: 120 });
    expect(
      trailStep({ side: "SELL", stopLoss: 110, anchor: 100, step: 5, ltp: 94 }),
    ).toEqual({ stopLoss: 105, anchor: 95 });
    expect(
      trailStep({
        side: "SELL",
        stopLoss: 110,
        anchor: 100,
        step: 5,
        ltp: 103,
      }),
    ).toBeNull();
  });
});

describe("daily P&L limit", () => {
  it("adds realized and open P&L and checks the limits", () => {
    const pnl = dayPnl([
      { side: "BUY", entry: 100, openQty: 0, realizedPnl: -1500, ltp: null },
      { side: "SELL", entry: 200, openQty: 50, realizedPnl: 0, ltp: 230 },
      { side: "BUY", entry: 50, openQty: 10, realizedPnl: 0, ltp: null },
    ]);
    expect(pnl).toBe(-3000);
    expect(dailyLimitHit(pnl, { maxLoss: 3000, maxProfit: null })).toBe("LOSS");
    expect(dailyLimitHit(pnl, { maxLoss: 3500, maxProfit: null })).toBeNull();
    expect(dailyLimitHit(4000, { maxLoss: null, maxProfit: 4000 })).toBe(
      "PROFIT",
    );
  });
});

describe("Chartink", () => {
  it("reads stocks and trigger prices", () => {
    const r = parseChartink(
      '{"stocks":"SBIN, reliance,SBIN,bad name","trigger_prices":"601.5,2890","scan_name":"Breakout"}',
    );
    expect(r).toEqual({
      scan: "Breakout",
      stocks: [
        { symbol: "SBIN", price: 601.5 },
        { symbol: "RELIANCE", price: 2890 },
      ],
    });
    expect(() => parseChartink({ stocks: "" })).toThrow(/no stocks/);
    expect(pctPoints(601.5, 1)).toBe(6);
  });
});

describe("AutomationService", () => {
  const make = (automation: unknown, opts: { halted?: boolean } = {}) => {
    const store = new Map<string, string>();
    if (opts.halted) store.set(`ctp:auto:halt:st1:${istNow().date}`, "LOSS");
    const redis = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) =>
        store.has(k) ? null : (store.set(k, v), "OK"),
      ),
    };
    const strategy = {
      id: "st1",
      name: "S",
      masterUserId: "m1",
      status: "ACTIVE",
      automation,
    };
    const trades: unknown[] = [];
    const prisma = {
      strategy: {
        findMany: jest.fn(async () => [strategy]),
        findUnique: jest.fn(async () => strategy),
        update: jest.fn(async () => strategy),
      },
      masterTrade: { findMany: jest.fn(async () => trades) },
    };
    let exitListener: ((s: unknown, r: string) => void) | undefined;
    const signals = {
      onExit: (fn: (s: unknown, r: string) => void) => (exitListener = fn),
      squareOffStrategy: jest.fn(async () => ({
        closed: 2,
        failed: 0,
        errors: [],
      })),
    };
    const hooks = {
      runAlert: jest.fn(async () => true),
      logEvent: jest.fn(async () => undefined),
    };
    const prices = { get: jest.fn(() => 230) };
    const svc = new AutomationService(
      prisma as never,
      redis as never,
      { NODE_ENV: "test" } as never,
      signals as never,
      hooks as never,
      prices as never,
    );
    svc.onApplicationBootstrap();
    return {
      svc,
      signals,
      hooks,
      trades,
      store,
      exit: (s: unknown, r: string) => exitListener!(s, r),
    };
  };
  const SCHED = {
    schedule: {
      enabled: true,
      entryTime: "09:20",
      exitTime: "15:15",
      days: [5],
      legs: [
        { underlying: "NIFTY", option: "CE", side: "SELL" },
        { underlying: "NIFTY", option: "PE", side: "SELL" },
      ],
    },
  };

  it("enters each leg once at the entry time and exits all at the exit time", async () => {
    const { svc, hooks, signals } = make(SCHED);
    await svc.tick(new Date("2026-11-13T03:50:10Z")); // Fri 09:20 IST
    await svc.tick(new Date("2026-11-13T03:51:10Z")); // 09:21 — already done
    expect(hooks.runAlert).toHaveBeenCalledTimes(2);
    expect(hooks.runAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "SELL", option: "PE", strike: "ATM" }),
      "SCHEDULE 09:20",
    );
    await svc.tick(new Date("2026-11-13T09:45:30Z")); // 15:15 IST
    expect(signals.squareOffStrategy).toHaveBeenCalledWith("st1", "m1");
  });

  it("does not trade on a day that is not picked", async () => {
    const { svc, hooks } = make(SCHED);
    await svc.tick(new Date("2026-11-12T03:50:10Z")); // Thursday
    expect(hooks.runAlert).not.toHaveBeenCalled();
  });

  it("exits everything and stops entries when the daily max loss is hit", async () => {
    const { svc, signals, trades, store, hooks } = make({
      daily: { maxLoss: 1000 },
    });
    trades.push({
      side: "SELL",
      exchange: "NFO",
      symbol: "X",
      price: 200,
      averagePrice: 200,
      quantity: 50,
      filledQuantity: 50,
      closedQuantity: 0,
      realizedPnl: 0,
    }); // LTP 230 → −1500
    await svc.tick();
    await svc.tick();
    expect(signals.squareOffStrategy).toHaveBeenCalledTimes(1);
    expect(store.get(`ctp:auto:halt:st1:${istNow().date}`)).toBe("LOSS");
    expect(hooks.logEvent).toHaveBeenCalledWith(
      "st1",
      expect.objectContaining({ action: "DAILY LIMIT" }),
    );
  });

  it("re-enters after a stop loss up to the limit, with the original SL distance", async () => {
    const { exit, hooks } = make({ reentry: { enabled: true, max: 1 } });
    const sig = {
      id: "s1",
      strategyId: "st1",
      side: "BUY",
      exchange: "NFO",
      symbol: "NIFTY17NOV2625200CE",
      quantity: 65,
      filledQuantity: 65,
      productType: "INTRADAY",
      price: 100,
      averagePrice: 100,
      targetPrice: 140,
      stopLossPrice: 110,
      trailPoints: 10,
      trailAnchor: 130,
      reentryCount: 0,
    };
    exit(sig, "STOPLOSS");
    exit({ ...sig, id: "s2", reentryCount: 1 }, "STOPLOSS"); // already re-entered once
    exit({ ...sig, id: "s3" }, "TARGET");
    await new Promise((r) => setImmediate(r));
    expect(hooks.runAlert).toHaveBeenCalledTimes(1);
    expect(hooks.runAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "BUY",
        symbol: "NIFTY17NOV2625200CE",
        qty: 65,
        targetPoints: 40,
        stoplossPoints: 20,
        trailPoints: 10,
      }),
      "RE-ENTRY 1/1",
      { reentryCount: 1 },
    );
  });

  it("skips the timed entry when the daily limit is already hit, and rejects bad settings", async () => {
    const { svc, hooks } = make(SCHED, { halted: true });
    await svc.tick(new Date(`${istNow().date}T03:50:10Z`));
    expect(hooks.runAlert).not.toHaveBeenCalled();
    await expect(
      svc.save({ id: "st1" } as never, { reentry: { max: 9 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
