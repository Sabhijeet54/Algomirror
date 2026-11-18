/** ORB: range building, breakout on candle close, entries per day, settings and the option alert. */
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

describe('ORB breakout', () => {
  const range: [string, number][] = [
    ['09:15', 100],
    ['09:18', 110],
    ['09:19', 90],
  ];

  it('buys the CALL when a candle closes above the high (judged when the next candle starts)', () => {
    const { events } = run({ rangeMinutes: 5 }, [
      ...range,
      ['09:21', 112], // spikes above inside the candle ...
      ['09:24:50', 109], // ... but closes inside: no trade
      ['09:25', 111],
      ['09:29:59', 113], // closes above 110
      ['09:30', 113],
    ]);
    expect(events.filter((e) => e.type === 'ENTRY')).toEqual([{ type: 'ENTRY', option: 'CE', close: 113, level: 110 }]);
  });

  it('buys the PUT when a candle closes below the low', () => {
    const { events } = run({ rangeMinutes: 5 }, [...range, ['09:22', 85], ['09:25', 86]]);
    expect(events.at(-1)).toEqual({ type: 'ENTRY', option: 'PE', close: 85, level: 90 });
  });

  it('takes one entry a day by default; a second entry only on the other side', () => {
    const samples: [string, number][] = [...range, ['09:22', 115], ['09:25', 116], ['09:27', 117], ['09:30', 85], ['09:35', 80], ['09:40', 80]];
    expect(run({ rangeMinutes: 5 }, samples).events.filter((e) => e.type === 'ENTRY')).toHaveLength(1);
    const two = run({ rangeMinutes: 5, maxEntries: 2 }, samples).events.filter((e) => e.type === 'ENTRY');
    expect(two.map((e) => (e as { option: string }).option)).toEqual(['CE', 'PE']);
  });

  it('no entry from a candle that closes after the last entry time', () => {
    const { events } = run({ rangeMinutes: 15, lastEntry: '09:45' }, [['09:15', 100], ['09:29', 101], ['09:50', 130], ['10:00', 131]]);
    expect(events.filter((e) => e.type === 'ENTRY')).toEqual([]);
  });

  it('continues from a saved state after a restart without repeating the entry', () => {
    const first = run({ rangeMinutes: 5 }, [...range, ['09:22', 115], ['09:25', 116]]);
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
