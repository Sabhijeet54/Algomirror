/** ORB: range building, live breakout (no candle close), entries per day, settings and the option alert. */
import { AutomationError, normalizeAutomation, readAutomation } from '../../src/trading/automation';
import { DEFAULT_ORB, newOrbState, normalizeOrb, orbAlert, orbOnPrice, type OrbEvent, type OrbState } from '../../src/trading/orb';

const at = (hhmm: string, s = 0) => (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60 + s;

/** Feeds [time, price] samples and returns the final state and every event. */
function run(cfg: Partial<typeof DEFAULT_ORB>, samples: [string, number][], from: OrbState = newOrbState()) {
  const c = { ...DEFAULT_ORB, ...cfg };
  let s = from;
  const events: OrbEvent[] = [];
  for (const [t, p] of samples) {
    const r = orbOnPrice(s, c, at(t.slice(0, 5), Number(t.slice(6) || 0)), p);
    s = r.state;
    events.push(...r.events);
  }
  return { s, events };
}

describe('ORB range', () => {
  it('5 minute range is 09:15 to 09:20; 15 minute range is 09:15 to 09:30', () => {
    const samples: [string, number][] = [
      ['09:15', 100],
      ['09:17', 108],
      ['09:19', 95],
      ['09:22', 120], // after a 5 min range, inside a 15 min range
      ['09:31', 101],
    ];
    expect(run({ rangeMinutes: 5 }, samples).events[0]).toEqual({ type: 'RANGE', high: 108, low: 95 });
    expect(run({ rangeMinutes: 15 }, samples).events[0]).toEqual({ type: 'RANGE', high: 120, low: 95 });
  });

  it('ignores prices before 09:15 and skips the day when the range start was missed', () => {
    expect(run({ rangeMinutes: 5 }, [['09:10', 500], ['09:15', 100], ['09:21', 100]]).events[0]).toEqual({ type: 'RANGE', high: 100, low: 100 });
    const late = run({ rangeMinutes: 15 }, [['09:20', 100], ['09:31', 130], ['09:46', 130]]);
    expect(late.events).toEqual([{ type: 'SKIP', reason: expect.stringMatching(/start of the range/) }]);
    expect(late.s.skipped).toBe(true);
  });
});

describe('ORB breakout (live, no candle close)', () => {
  const range: [string, number][] = [
    ['09:15', 100],
    ['09:18', 110],
    ['09:19', 90],
  ];

  it('buys the CALL the moment price goes above the high, inside the running candle', () => {
    const { events } = run({ rangeMinutes: 5 }, [...range, ['09:20', 105], ['09:21', 110], ['09:21:07', 111], ['09:21:30', 108]]);
    expect(events.filter((e) => e.type === 'ENTRY')).toEqual([{ type: 'ENTRY', option: 'CE', close: 111, level: 110 }]);
  });

  it('buys the PUT the moment price goes below the low', () => {
    const { events } = run({ rangeMinutes: 5 }, [...range, ['09:20:05', 89.5]]);
    expect(events).toEqual([
      { type: 'RANGE', high: 110, low: 90 },
      { type: 'ENTRY', option: 'PE', close: 89.5, level: 90 },
    ]);
  });

  it('15 minute range: 09:15 to 09:30, then trades the first break', () => {
    const { events } = run({ rangeMinutes: 15 }, [['09:15', 100], ['09:22', 120], ['09:29', 95], ['09:30:02', 119], ['09:31', 121]]);
    expect(events.filter((e) => e.type === 'ENTRY')).toEqual([{ type: 'ENTRY', option: 'CE', close: 121, level: 120 }]);
  });

  it('takes one entry a day by default; a second entry only on the other side', () => {
    const samples: [string, number][] = [...range, ['09:21', 115], ['09:22', 117], ['09:30', 85], ['09:35', 80]];
    expect(run({ rangeMinutes: 5 }, samples).events.filter((e) => e.type === 'ENTRY')).toHaveLength(1);
    const two = run({ rangeMinutes: 5, maxEntries: 2 }, samples).events.filter((e) => e.type === 'ENTRY');
    expect(two.map((e) => (e as { option: string }).option)).toEqual(['CE', 'PE']);
  });

  it('no entry after the last entry time', () => {
    const { events } = run({ rangeMinutes: 15, lastEntry: '09:45' }, [['09:15', 100], ['09:29', 101], ['09:46', 130]]);
    expect(events.filter((e) => e.type === 'ENTRY')).toEqual([]);
  });

  it('continues from a saved state after a restart without repeating the entry', () => {
    const first = run({ rangeMinutes: 5 }, [...range, ['09:22', 115]]);
    expect(first.s.entries).toBe(1);
    const after = run({ rangeMinutes: 5 }, [['09:31', 120], ['09:36', 121]], JSON.parse(JSON.stringify(first.s)));
    expect(after.events).toEqual([]);
  });
});

describe('ORB settings and order', () => {
  it('validates and defaults', () => {
    expect(readAutomation(null).orb).toEqual(DEFAULT_ORB);
    expect(normalizeOrb({ underlying: 'banknifty', rangeMinutes: '5' })).toMatchObject({ underlying: 'BANKNIFTY', rangeMinutes: 5 });
    expect(() => normalizeOrb({ rangeMinutes: 7 })).toThrow(AutomationError);
    expect(() => normalizeOrb({ stoploss: 100, stoplossUnit: 'PCT' })).toThrow(/below 100/);
    expect(() => normalizeAutomation({ orb: { exitTime: '10:30', lastEntry: '11:00' } })).toThrow(/after the last entry/);
    expect(() => normalizeOrb({ rangeMinutes: 15, lastEntry: '09:30' })).toThrow(/after the range ends/);
    expect(normalizeOrb({ rangeMinutes: 15, lastEntry: '09:31' }).lastEntry).toBe('09:31');
  });

  it('buys ATM with stop loss and target = stop loss × ratio', () => {
    const cfg = normalizeOrb({ underlying: 'NIFTY', stoploss: 20, targetRatio: 2, lots: 2 });
    expect(orbAlert(cfg, 'CE', 24510)).toEqual({
      action: 'BUY',
      underlying: 'NIFTY',
      option: 'CE',
      strike: 'ATM',
      spot: 24510,
      expiry: 'nearest',
      lots: 2,
      product: 'INTRADAY',
      stoplossPoints: 20,
      targetPoints: 40,
    });
    expect(orbAlert(normalizeOrb({ stoploss: 25, stoplossUnit: 'PCT', targetRatio: 1.5 }), 'PE', 1)).toMatchObject({ stoplossPct: 25, targetPct: 37.5 });
    expect(orbAlert(normalizeOrb({ stoploss: null, targetRatio: 2 }), 'PE', 1)).not.toHaveProperty('targetPoints');
  });
});
