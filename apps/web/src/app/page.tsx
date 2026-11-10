import { ArrowRight, GitBranch, Lock, ShieldCheck, Zap } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

const FEATURES = [
  {
    icon: GitBranch,
    title: 'Your broker, your account',
    body: 'Masters keep trading in Angel One as usual. Followers connect their own broker account — funds never leave it.',
  },
  {
    icon: ShieldCheck,
    title: 'Risk limits on every order',
    body: 'Allocation, maximum trade value, daily loss and position limits are checked before any follower order is placed.',
  },
  {
    icon: Zap,
    title: 'Driven by real executions',
    body: 'Client orders are triggered by the master’s actual broker order executions — never by price movements alone.',
  },
  {
    icon: Lock,
    title: 'Paper trading first',
    body: 'Every strategy can be validated end-to-end with simulated orders before a single rupee is at risk.',
  },
];

export default function Home() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="text-sm font-semibold tracking-tight">AlgoMirror</span>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/register">Create account</Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="py-20 sm:py-28">
          <p className="text-sm font-medium text-primary">Strategy auto-trading for NSE · BSE · F&amp;O</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Mirror a master trader’s executions into your own broker account.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground text-pretty">
            Connect your broker (Angel One, Upstox, Dhan, Fyers, Kotak Neo, 5paisa, Alice Blue, Groww, Motilal Oswal), choose a strategy, set your allocation and risk limits, and switch auto trading on
            when you are ready. You stay in control — trading never starts on its own.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/register">
                Get started <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">I already have an account</Link>
            </Button>
          </div>
        </section>

        <section className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-card p-6">
              <f.icon className="size-5 text-primary" />
              <h2 className="mt-3 font-semibold">{f.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </section>

        <footer className="py-12 text-xs text-muted-foreground">
          Trading in securities and derivatives involves risk of loss. This platform does not provide investment advice and
          does not claim any regulatory approval. Past performance of a master trader does not guarantee future results.
        </footer>
      </main>
    </div>
  );
}
