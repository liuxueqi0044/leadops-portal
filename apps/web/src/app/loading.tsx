export default function Loading() {
  return (
    <div className="loading-shell" aria-label="Loading workspace">
      <aside />
      <div>
        <header />
        <main>
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-copy" />
          <div className="skeleton-grid">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
          <span className="skeleton skeleton-panel" />
        </main>
      </div>
    </div>
  );
}
