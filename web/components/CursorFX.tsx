'use client';
import { useEffect, useRef } from 'react';

/**
 * Site-wide ambient background: an animated particle network plus a custom
 * cursor (slow-lagging ring + fast gold core). Mounted once in the root
 * layout so it applies to every page.
 *
 * Deliberately reads --accent/--warn from CSS instead of hardcoding colors,
 * so it matches whichever theme (dark/light) is active rather than fighting
 * globals.css's own theme system. The native cursor is only hidden after
 * the effect successfully mounts (via a class on <html>), so a JS failure
 * degrades to "cursor visible," never "cursor invisible."
 */
export default function CursorFX() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue('--accent').trim() || '#00C2FF';
    const gold = style.getPropertyValue('--warn').trim() || '#FFA502';
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

    // ---------- cursor tracker ----------
    const ring = ringRef.current, dot = dotRef.current;
    const canHover = matchMedia('(hover:hover)').matches;
    let cleanupCursor = () => {};

    if (ring && dot && canHover) {
      document.documentElement.classList.add('cursorfx-active');
      let mx = innerWidth / 2, my = innerHeight / 2;
      let rx = mx, ry = my, dx = mx, dy = my;
      let shown = false, pressed = false, cursorRaf = 0;

      const onMove = (e: MouseEvent) => {
        mx = e.clientX; my = e.clientY;
        if (!shown) { ring.style.opacity = '1'; dot.style.opacity = '1'; shown = true; }
      };
      const onOut = (e: MouseEvent) => {
        if (!e.relatedTarget) { ring.style.opacity = '0'; dot.style.opacity = '0'; shown = false; }
      };
      const onDown = () => { pressed = true; };
      const onUp = () => { pressed = false; };

      addEventListener('mousemove', onMove);
      addEventListener('mouseout', onOut);
      addEventListener('mousedown', onDown);
      addEventListener('mouseup', onUp);

      const kr = reduceMotion ? 1 : 0.12;
      const kd = reduceMotion ? 1 : 0.35;
      const cursorTick = () => {
        rx += (mx - rx) * kr; ry += (my - ry) * kr;
        dx += (mx - dx) * kd; dy += (my - dy) * kd;
        ring.style.transform = `translate(${rx}px,${ry}px) scale(${pressed ? 0.72 : 1})`;
        dot.style.transform = `translate(${dx}px,${dy}px)`;
        cursorRaf = requestAnimationFrame(cursorTick);
      };
      cursorTick();

      cleanupCursor = () => {
        document.documentElement.classList.remove('cursorfx-active');
        removeEventListener('mousemove', onMove);
        removeEventListener('mouseout', onOut);
        removeEventListener('mousedown', onDown);
        removeEventListener('mouseup', onUp);
        cancelAnimationFrame(cursorRaf);
      };
    }

    return () => {
      removeEventListener('resize', resize);
      cancelAnimationFrame(rafId);
      cleanupCursor();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden="true" style={{
        position: 'fixed', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none',
      }} />
      <div ref={ringRef} aria-hidden="true" style={{
        position: 'fixed', top: 0, left: 0, zIndex: 999998, pointerEvents: 'none',
        width: 54, height: 54, margin: '-27px 0 0 -27px', borderRadius: '50%',
        border: '1.5px solid var(--accent)',
        boxShadow: '0 0 22px 4px color-mix(in srgb, var(--accent) 35%, transparent), inset 0 0 14px color-mix(in srgb, var(--accent) 25%, transparent)',
        opacity: 0, transition: 'opacity .25s ease', willChange: 'transform',
      }} />
      <div ref={dotRef} aria-hidden="true" style={{
        position: 'fixed', top: 0, left: 0, zIndex: 999999, pointerEvents: 'none',
        width: 9, height: 9, margin: '-4.5px 0 0 -4.5px', borderRadius: '50%',
        background: 'var(--warn)', boxShadow: '0 0 12px 2px color-mix(in srgb, var(--warn) 70%, transparent)',
        opacity: 0, transition: 'opacity .25s ease', willChange: 'transform',
      }} />
    </>
  );
}

function hexToRGB(hex: string): string {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `${(bigint >> 16) & 255},${(bigint >> 8) & 255},${bigint & 255}`;
}
