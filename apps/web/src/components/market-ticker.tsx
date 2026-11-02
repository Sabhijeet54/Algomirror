'use client';

import { useEffect, useRef } from 'react';

/** Symbols shown in the scrolling market strip (TradingView ticker tape). */
const SYMBOLS = [
  { proName: 'BSE:SENSEX', title: 'SENSEX' },
  { proName: 'FX_IDC:USDINR', title: 'USD to INR' },
  { proName: 'FOREXCOM:SPXUSD', title: 'S&P 500 Index' },
  { proName: 'CAPITALCOM:US100', title: 'US 100 Cash CFD' },
  { proName: 'FX:EURUSD', title: 'EUR to USD' },
  { proName: 'TVC:GOLD', title: 'Gold' },
  { proName: 'BITSTAMP:BTCUSD', title: 'Bitcoin' },
  { proName: 'BITSTAMP:ETHUSD', title: 'Ethereum' },
];

/** Live market ticker strip at the top of the dashboard (TradingView widget, loaded once). */
export function MarketTicker() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || host.querySelector('script')) return;
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js';
    script.async = true;
    script.type = 'text/javascript';
    script.innerHTML = JSON.stringify({
      symbols: SYMBOLS,
      showSymbolLogo: true,
      isTransparent: true,
      displayMode: 'adaptive',
      colorTheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      locale: 'en',
    });
    host.appendChild(script);
  }, []);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div ref={ref} className="tradingview-widget-container min-h-[46px]">
        <div className="tradingview-widget-container__widget" />
      </div>
    </div>
  );
}
