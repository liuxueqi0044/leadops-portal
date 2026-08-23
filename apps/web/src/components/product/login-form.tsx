'use client';

import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, LoaderCircle } from 'lucide-react';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, callbackURL: '/' }),
      });
      if (!response.ok) throw new Error('Check your email and password, then try again.');
      window.location.assign('/');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Sign in failed.');
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span>Work email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          placeholder="you@agency.com"
        />
      </label>
      <label>
        <span>Password</span>
        <span className="password-field">
          <input
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setShowPassword((value) => !value);
            }}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </span>
      </label>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="primary-button login-submit" type="submit" disabled={submitting}>
        {submitting ? <LoaderCircle className="spin" size={17} /> : null}
        {submitting ? 'Signing in…' : 'Sign in'}
        {!submitting ? <ArrowRight size={16} /> : null}
      </button>
    </form>
  );
}
