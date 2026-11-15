import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,32rem)]">
      <div className="relative hidden overflow-hidden bg-[#0c0d10] font-[family-name:var(--font-archivo)] lg:block">
        <div className="relative flex h-full flex-col justify-between p-10 text-[#eef0f2]">
          <Link href="/" className="text-lg font-extrabold tracking-tight [font-variation-settings:'wdth'_118]">
            Algo<span className="text-[#a98bff]">Mirror</span>
          </Link>
          <div>
            <p className="max-w-md text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.02em] text-balance">
              The master trades in their own broker app. Your account follows, within the limits you set.
            </p>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-white/70">
              Broker sessions are authorised through the broker&apos;s own login. We never see or store your broker password.
            </p>
          </div>
          <p className="text-xs text-white/60">Trading involves risk. No investment advice is provided.</p>
        </div>
      </div>
      <div className="flex items-center justify-center bg-card px-6 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
