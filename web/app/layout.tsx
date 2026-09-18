import type { Metadata } from 'next';
import './globals.css';
import CursorFX from '@/components/CursorFX';

export const metadata: Metadata = {
  title: 'BTG DevOps — Security Dashboard',
  description: 'Azure and Power Platform security analysis dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is scoped to this one element on purpose: the
    // inline script below deliberately sets data-theme on <html> before
    // React hydrates, to avoid a flash of the wrong theme. That means the
    // server-rendered markup (no data-theme — the server has no access to
    // localStorage) and the live DOM at hydration time (script already ran)
    // genuinely differ by design, not by bug. React only skips its mismatch
    // check for attributes on the element this prop is set on, so it still
    // catches a real hydration bug anywhere else in the tree.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Prevent flash of wrong theme on load */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('btg-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}` }} />
      </head>
      <body>
        <CursorFX />
        {children}
      </body>
    </html>
  );
}
