/** Website enquiry form: validation, client vs partner answers, bot trap. */
import { EnquiryError, enquiryMail, parseEnquiry } from '../../src/enquiries/enquiry';

const base = { name: 'Ravi Kumar', email: 'Ravi@Example.com', phone: '+91 98765 43210' };

describe('parseEnquiry', () => {
  it('accepts a client enquiry and cleans the fields', () => {
    expect(parseEnquiry({ ...base, kind: 'client', interest: 'trading_plan', city: '  Jaipur ', message: 'Line one\r\n\r\n\r\nLine two' })).toEqual({
      kind: 'CLIENT',
      name: 'Ravi Kumar',
      email: 'ravi@example.com',
      phone: '+919876543210',
      company: null,
      city: 'Jaipur',
      interest: 'TRADING_PLAN',
      details: null,
      message: 'Line one\n\nLine two',
      page: null,
    });
  });

  it('reads the JSON text a cross-site form posts as text/plain', () => {
    expect(parseEnquiry(JSON.stringify({ ...base, kind: 'CLIENT', interest: 'DEMO' }))?.interest).toBe('DEMO');
    expect(() => parseEnquiry('not json')).toThrow(EnquiryError);
  });

  it('keeps partner answers; modules only for custom development', () => {
    const custom = parseEnquiry({ ...base, kind: 'PARTNER', interest: 'CUSTOM_DEVELOPMENT', partnerType: 'broker', clients: '500_5000', modules: ['MOBILE_APP', 'mobile_app', 'HACK', 'BACKTESTING'] });
    expect(custom?.details).toEqual({ partnerType: 'BROKER', clients: '500_5000', modules: ['MOBILE_APP', 'BACKTESTING'] });
    const white = parseEnquiry({ ...base, kind: 'PARTNER', interest: 'WHITE_LABEL', modules: ['MOBILE_APP'] });
    expect(white?.details).toBeNull();
  });

  it('rejects bad input with a readable message', () => {
    expect(() => parseEnquiry({ ...base, kind: 'X', interest: 'DEMO' })).toThrow(/client or partner/);
    expect(() => parseEnquiry({ ...base, kind: 'CLIENT', name: 'A', interest: 'DEMO' })).toThrow(/name/);
    expect(() => parseEnquiry({ ...base, kind: 'CLIENT', email: 'nope', interest: 'DEMO' })).toThrow(/email/);
    expect(() => parseEnquiry({ ...base, kind: 'CLIENT', phone: '12345', interest: 'DEMO' })).toThrow(/phone/);
    expect(() => parseEnquiry({ ...base, kind: 'PARTNER', interest: 'DEMO' })).toThrow(/white label/);
    expect(() => parseEnquiry({ ...base, kind: 'CLIENT', interest: 'DEMO', message: 'x'.repeat(2001) })).toThrow(/under 2000/);
  });

  it('returns null for a bot that filled the hidden field', () => {
    expect(parseEnquiry({ ...base, kind: 'CLIENT', interest: 'DEMO', website: 'http://spam' })).toBeNull();
  });
});

describe('enquiryMail', () => {
  it('summarises a partner request for the owner', () => {
    const e = parseEnquiry({ ...base, kind: 'PARTNER', company: 'Demo Broking', interest: 'CUSTOM_DEVELOPMENT', partnerType: 'BROKER', modules: ['MOBILE_APP'], message: 'Need an app' })!;
    const m = enquiryMail(e, new Date('2026-11-20T06:30:00Z'), 'https://trade.example.com/admin/enquiries');
    expect(m.subject).toBe('Partner request: Ravi Kumar (Demo Broking) · Custom development');
    expect(m.text).toContain('Phone: +919876543210');
    expect(m.text).toContain('Business type: Broker');
    expect(m.text).toContain('Needs: Mobile app');
    expect(m.text).toContain('Received: 20 Nov 2026, 12:00 pm IST');
    expect(m.text).toContain('Message:\nNeed an app');
    expect(m.text).toContain('https://trade.example.com/admin/enquiries');
    expect(m.text).not.toContain('City:');
  });
});
