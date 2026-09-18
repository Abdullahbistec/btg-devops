/** Route-level loading UI (Next.js App Router convention), shown while a
 * route segment's code is being fetched/rendered during navigation. Every
 * page here is a client component that fetches its own data in useEffect
 * after mount, so this does NOT cover that in-page fetch — each page still
 * needs (and mostly already has) its own in-page loading state for that.
 * This only covers the gap between clicking a nav link and that client
 * component mounting, which was previously a blank screen. */
export default function Loading() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <div
        style={{
          width: 28, height: 28, borderRadius: '50%',
          border: '3px solid var(--border)', borderTopColor: 'var(--accent)',
          animation: 'btg-spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes btg-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
