'use client';

import { useEffect, useRef, useState } from 'react';

/** Illustration only: example orders showing how a master order is resized for a follower. Not live data. */
const EXAMPLES = [
  { side: 'BUY', symbol: 'NIFTY 24500 CE', unit: 'lots', master: 10, yours: 2 },
  { side: 'SELL', symbol: 'BANKNIFTY 52000 PE', unit: 'lots', master: 5, yours: 1 },
  { side: 'BUY', symbol: 'RELIANCE', unit: 'shares', master: 500, yours: 100 },
] as const;

const CHECKS = ['Allocation 20%', 'Max trade value', 'Daily loss limit', 'Position limit'];
const CYCLE_MS = 6500;

export function MirrorTicket() {
  const [i, setI] = useState(0);
  const [run, setRun] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    if (root.current) io.observe(root.current);
    const t = window.setInterval(() => {
      if (!visible || document.hidden) return;
      setI((n) => (n + 1) % EXAMPLES.length);
      setRun((n) => n + 1);
    }, CYCLE_MS);
    return () => {
      window.clearInterval(t);
      io.disconnect();
    };
  }, []);

  const ex = EXAMPLES[i];
  return (
    <div ref={root} className="am-mirror" aria-label="Example: how one strategy order is placed in your account">
      <div className="am-ticket am-ticket--master" key={`m${run}`}>
        <p className="am-ticket__head">
          <span>Strategy</span>
          <span>Executed</span>
        </p>
        <p className="am-ticket__side" data-side={ex.side}>
          {ex.side}
        </p>
        <p className="am-ticket__sym">{ex.symbol}</p>
        <p className="am-ticket__qty">
          <span className="am-num">{ex.master}</span> {ex.unit}
        </p>
      </div>

      <ol className="am-checks" key={`c${run}`} aria-label="Checks run before your order">
        {CHECKS.map((c, n) => (
          <li key={c} style={{ '--n': n } as React.CSSProperties}>
            <span aria-hidden="true" className="am-checks__tick" />
            {c}
          </li>
        ))}
      </ol>

      <div className="am-ticket am-ticket--yours" key={`y${run}`}>
        <p className="am-ticket__head">
          <span>Your account</span>
          <span>Placed</span>
        </p>
        <p className="am-ticket__side" data-side={ex.side}>
          {ex.side}
        </p>
        <p className="am-ticket__sym">{ex.symbol}</p>
        <p className="am-ticket__qty">
          <span className="am-num">{ex.yours}</span> {ex.yours === 1 ? ex.unit.slice(0, -1) : ex.unit}
        </p>
      </div>

      <p className="am-mirror__note">Illustration with a 20% allocation. Not live data.</p>
    </div>
  );
}
