import Link from 'next/link';
import { MirrorTicket } from '@/components/landing/mirror-ticket';
import './landing.css';

const CHECKS = [
  {
    title: 'Your broker, your account',
    body: 'Masters keep trading in Angel One as usual. Followers connect their own broker account, and funds never leave it.',
  },
  {
    title: 'Risk limits on every order',
    body: 'Allocation, maximum trade value, daily loss and position limits are checked before any follower order is placed.',
  },
  {
    title: 'Driven by real executions',
    body: 'Client orders are triggered by the master’s actual broker order executions, never by price movements alone.',
  },
  {
    title: 'Paper trading first',
    body: 'Every strategy can be validated end to end with simulated orders before a single rupee is at risk.',
  },
];

const BROKERS = ['Angel One', 'Upstox', 'Dhan', 'Fyers', 'Kotak Neo', '5paisa', 'Alice Blue', 'Groww', 'Motilal Oswal'];

function Cta({ href, children, variant = 'solid' }: { href: string; children: string; variant?: 'solid' | 'line' }) {
  return (
    <Link href={href} className={`am-cta am-cta--${variant}`}>
      <span className="am-cta__roll">
        <span>{children}</span>
        <span aria-hidden="true">{children}</span>
      </span>
    </Link>
  );
}

export default function Home() {
  return (
    <div className="am">
      <a href="#main" className="am-skip">
        Skip to content
      </a>
      <header className="am-top">
        <Link href="/" className="am-mark" aria-label="AlgoMirror home">
          Algo<span>Mirror</span>
        </Link>
        <nav aria-label="Account" className="am-top__nav">
          <Link href="/login" className="am-link">
            Sign in
          </Link>
          <Cta href="/register">Create account</Cta>
        </nav>
      </header>

      <main id="main">
        <section className="am-hero" aria-labelledby="hero-title">
          <h1 id="hero-title" className="am-hero__title">
            <span className="am-hero__left">Their trade.</span>
            <span className="am-hero__right">Your account.</span>
          </h1>
          <div className="am-hero__lede">
            <p>
              Strategy auto-trading for NSE, BSE and F&amp;O. A master trader’s executions are mirrored into your own broker account, at the
              size and within the limits you choose.
            </p>
            <div className="am-hero__ctas">
              <Cta href="/register">Get started</Cta>
              <Cta href="/login" variant="line">
                I already have an account
              </Cta>
            </div>
          </div>
          <MirrorTicket />
        </section>

        <section className="am-statement" aria-label="You stay in control">
          <p>
            Connect your broker, choose a strategy, set your allocation and risk limits, then switch auto trading on when you are ready.{' '}
            <em>Trading never starts on its own.</em>
          </p>
        </section>

        <section className="am-checklist" aria-labelledby="checks-title">
          <h2 id="checks-title" className="am-h2">
            What happens before an order reaches you
          </h2>
          <ol>
            {CHECKS.map((c) => (
              <li key={c.title}>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="am-brokers" aria-labelledby="brokers-title">
          <h2 id="brokers-title" className="am-h2">
            Works with the broker you already use
          </h2>
          <ul>
            {BROKERS.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="am-finale">
        <div className="am-finale__mark" aria-hidden="true">
          <span>AlgoMirror</span>
          <span className="am-finale__reflection">AlgoMirror</span>
        </div>
        <div className="am-finale__row">
          <p className="am-finale__ask">Ready when you are.</p>
          <div className="am-hero__ctas">
            <Cta href="/register">Create account</Cta>
            <Cta href="/login" variant="line">
              Sign in
            </Cta>
          </div>
        </div>
        <p className="am-finale__risk">
          Trading in securities and derivatives involves risk of loss. This platform does not provide investment advice and does not claim any
          regulatory approval. Past performance of a master trader does not guarantee future results.
        </p>
      </footer>
    </div>
  );
}
