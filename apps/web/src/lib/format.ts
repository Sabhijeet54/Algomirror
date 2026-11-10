const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN');
const dateTime = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

/** Formats a decimal string from the API as ₹ (Indian grouping). */
export function formatINR(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? inr.format(n) : '—';
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : num.format(value);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${dateTime.format(d)} IST`;
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function brokerLabel(broker: string): string {
  switch (broker) {
    case 'ZERODHA':
      return 'Zerodha';
    case 'ANGEL_ONE':
      return 'Angel One';
    case 'UPSTOX':
      return 'Upstox';
    case 'DHAN':
      return 'Dhan';
    case 'FYERS':
      return 'Fyers';
    case 'KOTAK_NEO':
      return 'Kotak Neo';
    case 'FIVE_PAISA':
      return '5paisa';
    case 'ALICE_BLUE':
      return 'Alice Blue';
    case 'GROWW':
      return 'Groww';
    case 'MOTILAL_OSWAL':
      return 'Motilal Oswal';
    case 'MOCK':
      return 'Paper (Mock)';
    default:
      return broker;
  }
}
