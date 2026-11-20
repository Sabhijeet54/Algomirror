/**
 * Enquiry forms from the public company website: a client enquiry or a partner request (white label / custom
 * development). Pure parsing and validation, so the rules are unit tested without HTTP.
 */

export const CLIENT_INTERESTS = ['TRADING_PLAN', 'ALGO_AUTOMATION', 'TRADINGVIEW_AUTOMATION', 'STRATEGY_SUBSCRIPTION', 'DEMO', 'OTHER'] as const;
export const PARTNER_INTERESTS = ['WHITE_LABEL', 'CUSTOM_DEVELOPMENT'] as const;
export const PARTNER_TYPES = ['BROKER', 'SUB_BROKER_AP', 'ADVISOR_RA', 'FINTECH', 'TRADER_EDUCATOR', 'OTHER'] as const;
export const CLIENT_SIZES = ['UNDER_50', '50_500', '500_5000', 'OVER_5000'] as const;
/** What a custom build can include (the partner ticks any). */
export const CUSTOM_MODULES = [
  'MULTI_ACCOUNT',
  'ALGO_STRATEGY',
  'TRADINGVIEW_WEBHOOK',
  'OPTION_CHAIN_TOOLS',
  'BACKTESTING',
  'BROKER_INTEGRATION',
  'MOBILE_APP',
  'ADMIN_CRM',
  'PAYMENTS_BILLING',
  'RISK_MANAGEMENT',
] as const;

export type EnquiryKind = 'CLIENT' | 'PARTNER';

export interface EnquiryInput {
  kind: EnquiryKind;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  city: string | null;
  interest: string;
  details: { partnerType?: string; clients?: string; modules?: string[] } | null;
  message: string | null;
  page: string | null;
}

export class EnquiryError extends Error {}

const text = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > max) throw new EnquiryError(`Please keep it under ${max} characters`);
  return s;
};
const multiline = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!s) return null;
  if (s.length > max) throw new EnquiryError(`Please keep the message under ${max} characters`);
  return s;
};
const pick = <T extends string>(v: unknown, list: readonly T[]): T | null => {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  return (list as readonly string[]).includes(s) ? (s as T) : null;
};

/**
 * Parses a form body (JSON object, or the JSON text a cross-site form posts as text/plain).
 * Returns null for a bot (the hidden `website` field is filled): the caller answers OK without saving.
 */
export function parseEnquiry(raw: unknown): EnquiryInput | null {
  let o: unknown = raw;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      throw new EnquiryError('Invalid form data');
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new EnquiryError('Invalid form data');
  const b = o as Record<string, unknown>;
  if (text(b.website, 500)) return null;

  const kind = pick(b.kind, ['CLIENT', 'PARTNER'] as const);
  if (!kind) throw new EnquiryError('Choose client or partner');

  const name = text(b.name, 80);
  if (!name || name.length < 2) throw new EnquiryError('Enter your name');
  const email = text(b.email, 120)?.toLowerCase() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new EnquiryError('Enter a valid email');
  const phone = (text(b.phone, 24) ?? '').replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,15}$/.test(phone)) throw new EnquiryError('Enter a valid phone number');

  const interest = kind === 'CLIENT' ? pick(b.interest, CLIENT_INTERESTS) : pick(b.interest, PARTNER_INTERESTS);
  if (!interest) throw new EnquiryError(kind === 'CLIENT' ? 'Choose what you are looking for' : 'Choose white label or custom development');

  let details: EnquiryInput['details'] = null;
  if (kind === 'PARTNER') {
    const partnerType = pick(b.partnerType, PARTNER_TYPES) ?? undefined;
    const clients = pick(b.clients, CLIENT_SIZES) ?? undefined;
    const rawModules = Array.isArray(b.modules) ? b.modules : [];
    const modules = interest === 'CUSTOM_DEVELOPMENT' ? [...new Set(rawModules.map((m) => pick(m, CUSTOM_MODULES)).filter((m): m is NonNullable<typeof m> => m != null))] : [];
    details = { ...(partnerType ? { partnerType } : {}), ...(clients ? { clients } : {}), ...(modules.length ? { modules } : {}) };
    if (!Object.keys(details).length) details = null;
  }

  return {
    kind,
    name,
    email,
    phone,
    company: text(b.company, 120),
    city: text(b.city, 80),
    interest,
    details,
    message: multiline(b.message, 2000),
    page: text(b.page, 200),
  };
}

const LABEL: Record<string, string> = {
  TRADING_PLAN: 'Automated trading plan',
  MULTI_ACCOUNT: 'Multi-account execution',
  ALGO_AUTOMATION: 'Algo automation',
  TRADINGVIEW_AUTOMATION: 'TradingView automation',
  STRATEGY_SUBSCRIPTION: 'Strategy plans and pricing',
  DEMO: 'Free demo',
  OTHER: 'Other',
  WHITE_LABEL: 'White label solution',
  CUSTOM_DEVELOPMENT: 'Custom development',
  BROKER: 'Broker',
  SUB_BROKER_AP: 'Sub-broker / AP',
  ADVISOR_RA: 'Advisor / RA',
  FINTECH: 'Fintech',
  TRADER_EDUCATOR: 'Trader / educator',
  UNDER_50: 'Under 50 clients',
  '50_500': '50 to 500 clients',
  '500_5000': '500 to 5,000 clients',
  OVER_5000: '5,000+ clients',
  ALGO_STRATEGY: 'Algo strategies',
  TRADINGVIEW_WEBHOOK: 'TradingView / alert automation',
  OPTION_CHAIN_TOOLS: 'Option chain tools',
  BACKTESTING: 'Backtesting',
  BROKER_INTEGRATION: 'Broker integration',
  MOBILE_APP: 'Mobile app',
  ADMIN_CRM: 'Admin / CRM',
  PAYMENTS_BILLING: 'Payments and billing',
  RISK_MANAGEMENT: 'Risk management',
};
const label = (v: string | undefined) => (v ? (LABEL[v] ?? v) : '');

/** The owner's notification email for a new enquiry (plain text; reply goes to the visitor). */
export function enquiryMail(e: EnquiryInput, at: Date, adminLink: string): { subject: string; text: string } {
  const what = e.kind === 'PARTNER' ? 'Partner request' : 'Client enquiry';
  const when = at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const rows: [string, string | null | undefined][] = [
    ['Name', e.name],
    ['Email', e.email],
    ['Phone', e.phone],
    ['Company', e.company],
    ['City', e.city],
    [e.kind === 'PARTNER' ? 'Partnership' : 'Looking for', label(e.interest)],
    ['Business type', label(e.details?.partnerType)],
    ['Client base', label(e.details?.clients)],
    ['Needs', e.details?.modules?.map(label).join(', ')],
    ['Received', `${when} IST`],
  ];
  const body = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    subject: `${what}: ${e.name}${e.company ? ` (${e.company})` : ''} · ${label(e.interest)}`,
    text: `New ${what.toLowerCase()} from sanchaytechnologies.com\n\n${body}${e.message ? `\n\nMessage:\n${e.message}` : ''}\n\nReply to this email to answer ${e.name} directly.\nAll enquiries: ${adminLink}\n`,
  };
}
