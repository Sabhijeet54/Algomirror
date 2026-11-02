import { licenceExpiry } from '../../src/common/licence';

const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 19);

describe('licenceExpiry (end of the last day, IST)', () => {
  it('2 days from 3 pm IST on 2 Nov → 4 Nov 23:59:59 IST (not 3 pm)', () => {
    const from = new Date('2026-11-02T09:30:00Z'); // 15:00 IST
    expect(ist(licenceExpiry(from, 2))).toBe('2026-11-04 23:59:59');
  });
  it('late night IST (after UTC midnight shift) still counts the IST day', () => {
    const from = new Date('2026-11-02T19:00:00Z'); // 3 Nov 00:30 IST
    expect(ist(licenceExpiry(from, 1))).toBe('2026-11-04 23:59:59');
  });
  it('never earlier than from + days', () => {
    for (const h of [0, 5, 12, 18, 23]) {
      const from = new Date(Date.UTC(2026, 10, 2, h, 17));
      for (const days of [1, 2, 30, 365]) expect(licenceExpiry(from, days).getTime()).toBeGreaterThanOrEqual(from.getTime() + days * 86_400_000);
    }
  });
  it('extending from an end-of-day expiry adds whole days', () => {
    const e = licenceExpiry(new Date('2026-11-02T09:30:00Z'), 2);
    expect(ist(licenceExpiry(e, 30))).toBe('2026-12-04 23:59:59');
  });
});
