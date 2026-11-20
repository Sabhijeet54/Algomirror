import type { Metadata } from 'next';

/** No brand name in the tab either. */
export const metadata: Metadata = { title: { absolute: 'Sign in' } };

/** Sign in / sign up: the form alone, centred. No brand panel or name above it. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm sm:p-8">{children}</div>
    </div>
  );
}
