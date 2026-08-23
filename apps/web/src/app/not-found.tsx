import { SearchX } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="standalone-state">
      <div className="state-panel">
        <span className="state-icon">
          <SearchX size={22} />
        </span>
        <h1>Page not found</h1>
        <p>This link may be old, expired, or outside your workspace.</p>
        <Link className="primary-button" href="/">
          Return to LeadOps
        </Link>
      </div>
    </main>
  );
}
