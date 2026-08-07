import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BTG DevOps — Security Dashboard',
  description: 'Azure and Power Platform security analysis dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Prevent flash of wrong theme on load */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('btg-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
