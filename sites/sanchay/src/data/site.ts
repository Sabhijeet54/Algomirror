/** All site content in one place. */

export const APP = 'https://trade.sanchaytechnologies.com';

export const site = {
  name: 'Sanchay Technologies',
  short: 'Sanchay',
  url: 'https://sanchaytechnologies.com',
  email: 'info@sanchaytechnologies.com',
  description:
    'Sanchay Technologies builds automated trading software for traders, brokers and trading desks in India: ready plans, white label platforms and custom builds.',
  app: APP,
  login: `${APP}/login`,
  signup: `${APP}/register`,
  enquiryApi: `${APP}/api/enquiries`,
  nav: [
    { href: '/#platform', label: 'Platform' },
    { href: '/partners/', label: 'Partners' },
    { href: '/pricing/', label: 'Pricing' },
    { href: '/contact/', label: 'Contact' },
  ],
  legal: [
    { href: '/privacy-policy/', label: 'Privacy policy' },
    { href: '/terms/', label: 'Terms and conditions' },
    { href: '/refund-policy/', label: 'Refund policy' },
    { href: '/disclaimer/', label: 'Risk disclaimer' },
  ],
};

/** Brokers the platform connects to today. */
export const brokers = ['Zerodha', 'Angel One', 'Upstox', 'Dhan', 'Fyers', 'Kotak Neo', '5paisa', 'Alice Blue', 'Groww', 'Motilal Oswal'];

export const products = [
  {
    code: 'EXE',
    name: 'Execution engine',
    text: 'One strategy signal is placed in every linked account through that account’s own broker, at its own lot size, in a fraction of a second.',
  },
  {
    code: 'AUT',
    name: 'Strategy automation',
    text: 'TradingView and Chartink alerts, timed entry and exit schedules, opening range breakout, trailing stop loss and re-entry rules that run without anyone at the screen.',
  },
  {
    code: 'RSK',
    name: 'Risk controls',
    text: 'Daily loss and profit limits, maximum trade value and position limits per client, automatic square off, and one kill switch that stops trading and exits open positions.',
  },
  {
    code: 'ADM',
    name: 'Admin and licences',
    text: 'Issue and renew client licences, add sub-admins, see every order a client received, and keep an audit log of logins, changes and trades.',
  },
  {
    code: 'BRK',
    name: 'Broker connections',
    text: 'Clients log in with their own broker. Credentials are encrypted at rest, and orders can go out through a registered static IP where the broker asks for one.',
  },
];

export const steps = [
  { title: 'Connect', text: 'Each client links their own broker account. Money never leaves it.' },
  { title: 'Pick a strategy', text: 'Choose the automated strategy that should trade, and the size for each account.' },
  { title: 'It runs by itself', text: 'Entries and exits are placed in every linked account, inside its own limits.' },
  { title: 'Watch and stop', text: 'Live positions and logs for every account, and one switch to stop all of it.' },
];

export const audiences = [
  { name: 'Brokers and authorised persons', text: 'Offer automation to active clients without building it in house.' },
  { name: 'Advisors and research analysts', text: 'Give clients disciplined, automated execution inside limits they set.' },
  { name: 'Trader educators', text: 'Give members a tested system that runs in their own accounts.' },
  { name: 'Trading desks', text: 'Run one strategy across many accounts with limits per account.' },
];

export const faqs = [
  {
    q: 'Does the software hold or manage client money?',
    a: 'No. Every order goes to the client’s own broker account, and the funds stay there. We provide software; we do not take custody of money or securities.',
  },
  {
    q: 'Will it make money?',
    a: 'No software can promise that. It makes sure trades follow the rules you set, at the size you set, in every account. Markets can still go against those trades, and losses are part of trading.',
  },
  {
    q: 'What is a white label platform?',
    a: 'The same platform running under your brand: your name, logo, colours and domain, with your own admin panel to manage your clients. It is ready now and can go live quickly.',
  },
  {
    q: 'What does custom development cover?',
    a: 'Features built for your business on top of our engine: a strategy of your own, a broker we do not support yet, a mobile app, billing, or reports in your format. We scope it with you first.',
  },
  {
    q: 'Which brokers are supported?',
    a: `${brokers.slice(0, -1).join(', ')} and ${brokers.at(-1)}. Ask us if yours is not on the list.`,
  },
  {
    q: 'Can a client stop at any time?',
    a: 'Yes. A client can pause automation from their own dashboard, and an admin can stop everything at once with the kill switch.',
  },
];

/** Partner options: white label is ready now, custom development is built for you. */
export const partnerOptions = {
  whiteLabel: {
    id: 'WHITE_LABEL',
    name: 'White label solution',
    status: 'Ready now',
    text: 'Our running platform under your brand. Your clients see your name, your logo and your domain. You get the admin panel, licences and support.',
    points: ['Your brand, logo and domain', 'Admin panel and client licences', 'Automated execution, strategies and risk controls included', 'Setup, training and ongoing support'],
  },
  custom: {
    id: 'CUSTOM_DEVELOPMENT',
    name: 'Custom development',
    status: 'Built for you',
    text: 'Software made to your brief on top of our trading engine. Tell us what you need and we will scope it, quote it and build it with you.',
  },
};

/** What a custom build can include (values match the API). */
export const customModules = [
  { id: 'MULTI_ACCOUNT', label: 'Multi-account execution' },
  { id: 'ALGO_STRATEGY', label: 'Your own algo strategies' },
  { id: 'TRADINGVIEW_WEBHOOK', label: 'TradingView / alert automation' },
  { id: 'OPTION_CHAIN_TOOLS', label: 'Option chain tools' },
  { id: 'BACKTESTING', label: 'Backtesting' },
  { id: 'BROKER_INTEGRATION', label: 'New broker integration' },
  { id: 'MOBILE_APP', label: 'Mobile app' },
  { id: 'ADMIN_CRM', label: 'Admin panel / CRM' },
  { id: 'PAYMENTS_BILLING', label: 'Payments and billing' },
  { id: 'RISK_MANAGEMENT', label: 'Risk management' },
];

export const clientInterests = [
  { id: 'TRADING_PLAN', label: 'An automated trading plan' },
  { id: 'ALGO_AUTOMATION', label: 'Algo automation' },
  { id: 'TRADINGVIEW_AUTOMATION', label: 'TradingView automation' },
  { id: 'STRATEGY_SUBSCRIPTION', label: 'Strategy plans and pricing' },
  { id: 'DEMO', label: 'A free demo' },
  { id: 'OTHER', label: 'Something else' },
];

export const partnerTypes = [
  { id: 'BROKER', label: 'Broker' },
  { id: 'SUB_BROKER_AP', label: 'Sub-broker / authorised person' },
  { id: 'ADVISOR_RA', label: 'Advisor / research analyst' },
  { id: 'FINTECH', label: 'Fintech company' },
  { id: 'TRADER_EDUCATOR', label: 'Trader / educator' },
  { id: 'OTHER', label: 'Other' },
];

export const clientSizes = [
  { id: 'UNDER_50', label: 'Under 50' },
  { id: '50_500', label: '50 to 500' },
  { id: '500_5000', label: '500 to 5,000' },
  { id: 'OVER_5000', label: 'Over 5,000' },
];

/** Client plans (B2B partners get a quote instead). */
export const plans = [
  {
    id: 'MONTHLY',
    name: 'Monthly',
    price: '24,999',
    per: 'per month',
    badge: null,
    maintenance: 'Maintenance included',
    lots: 'Up to 2 lots',
    features: [
      'NIFTY and BANKNIFTY',
      '1 to 2 selected strategies',
      'Automated trade execution',
      'Advanced trading dashboard',
      'Strategy monitoring',
      'Previous studies and performance analysis',
      'Basic education and system guidance',
    ],
  },
  {
    id: 'QUARTERLY',
    name: 'Quarterly',
    price: '64,999',
    per: 'per quarter',
    badge: null,
    maintenance: '₹1,500 a month maintenance',
    lots: 'Up to 4 lots',
    features: [
      'NIFTY, BANKNIFTY and SENSEX',
      'Multiple strategy access',
      'Automated entry and exit',
      'Advanced dashboard',
      'Previous studies and performance data',
      'Strategy performance monitoring',
      'Education and system guidance',
    ],
  },
  {
    id: 'HALF_YEARLY',
    name: 'Half-yearly',
    price: '1,09,999',
    per: 'per 6 months',
    badge: 'Most popular',
    maintenance: '₹1,500 a month maintenance',
    lots: 'Up to 6 lots',
    features: [
      'NIFTY, BANKNIFTY and SENSEX',
      'Selected stock options',
      'Multiple advanced strategies',
      'Fully automated execution',
      'Advanced dashboard and trade monitoring',
      'Previous studies and performance analysis',
      'Strategy updates and optimisation',
      'Education and system guidance',
    ],
  },
  {
    id: 'YEARLY',
    name: 'Yearly',
    price: '1,51,000',
    per: 'per year',
    badge: 'Complete premium access',
    maintenance: 'No maintenance charge',
    lots: 'No lot limit',
    features: [
      'NIFTY, BANKNIFTY and SENSEX',
      'Index and stock options',
      'All available strategies',
      'Fully automated trading system',
      'Advanced dashboard',
      'Strategy and performance monitoring',
      'Previous studies and analysis',
      'Strategy updates and optimisation',
      'Complete education and system guidance',
    ],
  },
];

export const engagements = [
  {
    name: 'White label',
    who: 'Brokers, advisors, educators',
    gets: 'The full platform under your brand with admin panel and client licences. Priced on your client base.',
    href: '/contact/?type=partner&interest=WHITE_LABEL',
  },
  {
    name: 'Custom development',
    who: 'Firms with a specific need',
    gets: 'Features built to your brief. Priced after we scope the work together.',
    href: '/contact/?type=partner&interest=CUSTOM_DEVELOPMENT',
  },
];
