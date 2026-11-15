import localFont from 'next/font/local';

/** Archivo variable (width 62–125, weight 100–900), self-hosted. Display face for the public pages. */
export const archivo = localFont({
  src: [{ path: '../fonts/archivo-100_900-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-archivo',
  display: 'swap',
});
