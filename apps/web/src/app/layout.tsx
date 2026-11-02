import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AlgoMirror', template: '%s · AlgoMirror' },
  description: 'Strategy auto-trading for Indian markets — expert strategies run in your own broker account.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Apply the saved light / dark theme before the first paint (no flash). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('ctp-theme');if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
