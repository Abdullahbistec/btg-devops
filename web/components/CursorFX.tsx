'use client';
import { useEffect, useRef } from 'react';

/**
 * Site-wide ambient background: an animated particle network. Mounted once
 * in the root layout so it applies to every page.
 *
 * Deliberately reads --accent from CSS instead of hardcoding a color, so it
 * matches whichever theme (dark/light) is active rather than fighting
 * globals.css's own theme system.
 */
export default function CursorFX() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#00C2FF';
    const lineRGB = hexToRGB(accent);

    let w = 0, h = 0, dpr = 1;
    let nodes: { x: number; y: number; vx: number; vy: number; r: number }[] = [];
    let rafId = 0;

    const CONF = { density: 9000, maxNodes: 100, linkDist: 150, speed: 0.25 };

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas!.width = innerWidth * dpr;
      h = canvas!.height = innerHeight * dpr;
      canvas!.style.width = innerWidth + 'px';
      canvas!.style.height = innerHeight + 'px';
      const n = Math.min(CONF.maxNodes, Math.floor((innerWidth * innerHeight) / CONF.density));
      nodes = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * CONF.speed * dpr,
        vy: (Math.random() - 0.5) * CONF.speed * dpr,
        r: (Math.random() * 1.6 + 0.8) * dpr,
      }));
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      const link = CONF.linkDist * dpr;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < link) {
            const alpha = (1 - d / link) * 0.35;
            ctx!.strokeStyle = `rgba(${lineRGB},${alpha.toFixed(3)})`;
            ctx!.lineWidth = dpr * 0.6;
            ctx!.beginPath(); ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y); ctx!.stroke();
          }
        }
      }
      ctx!.fillStyle = `rgba(${lineRGB},0.8)`;
      for (const p of nodes) { ctx!.beginPath(); ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx!.fill(); }
    }

    function frame() {
      for (const p of nodes) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
      draw();
      rafId = requestAnimationFrame(frame);
    }

    resize();
    addEventListener('resize', resize);
    if (reduceMotion) draw(); else rafId = requestAnimationFrame(frame);

    return () => {
      removeEventListener('resize', resize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <canvas ref={canvasRef} aria-hidden="true" style={{
      position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none',
    }} />
  );
}

function hexToRGB(hex: string): string {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `${(bigint >> 16) & 255},${(bigint >> 8) & 255},${bigint & 255}`;
}
