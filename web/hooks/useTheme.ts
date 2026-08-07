'use client';
import { useEffect, useState } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const stored = (localStorage.getItem('btg-theme') as 'dark' | 'light' | null) ?? 'dark';
    setTheme(stored);
    document.documentElement.dataset.theme = stored;
  }, []);

  function toggle() {
    const next: 'dark' | 'light' = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('btg-theme', next);
    document.documentElement.dataset.theme = next;
  }

  return { theme, toggle };
}
