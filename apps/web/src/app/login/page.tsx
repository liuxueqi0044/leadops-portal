import Link from 'next/link';
import { Activity, CheckCircle2, LockKeyhole, Workflow } from 'lucide-react';
import { LoginForm } from '@/components/product/login-form';

export default function LoginPage() {
  return (
    <main id="main-content" className="auth-page">
      <section className="auth-story">
        <Link className="brand auth-brand" href="/">
          <span className="brand-mark">
            <Activity size={18} />
          </span>
          <span className="brand-wordmark">LeadOps</span>
        </Link>
        <div className="auth-story-copy">
          <span className="auth-eyebrow">Lead operations, under control</span>
          <h1>
            Know what happened.
            <br />
            Decide what happens next.
          </h1>
          <p>
            A calm control room for qualified leads, human approvals and reliable automation
            outcomes.
          </p>
          <ul>
            <li>
              <CheckCircle2 size={17} />
              Business results, not workflow noise
            </li>
            <li>
              <LockKeyhole size={17} />
              Client boundaries enforced at every layer
            </li>
            <li>
              <Workflow size={17} />
              Safe retries when external systems fail
            </li>
          </ul>
        </div>
        <small>AI recommends. Humans decide. Automations execute.</small>
      </section>
      <section className="auth-form-panel">
        <div className="auth-form-wrap">
          <span className="auth-form-mark">
            <Activity size={20} />
          </span>
          <h2>Welcome back</h2>
          <p>Sign in to your agency workspace.</p>
          <LoginForm />
          <div className="auth-help">
            Need access? Ask your agency owner or client administrator for an invitation.
          </div>
        </div>
      </section>
    </main>
  );
}
