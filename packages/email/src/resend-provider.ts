import type { EmailProvider, EmailSendRequest, EmailSendResult } from './provider.js';

export interface ResendEmailProviderOptions {
  apiKey: string;
  from: string;
  timeoutMs?: number;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.resend.com';

export function createResendEmailProvider(options: ResendEmailProviderOptions): EmailProvider {
  if (!options.apiKey || typeof options.apiKey !== 'string' || options.apiKey === 're_placeholder') {
    throw new Error('Resend API key is required and must not be a placeholder');
  }

  if (!options.from || typeof options.from !== 'string') {
    throw new Error('Resend verified "from" address is required');
  }

  const timeoutMs = options.timeoutMs ?? 30000;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      if (request.signal?.aborted) {
        return { ok: false, error: 'Request aborted by caller', retryable: false };
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const composedSignal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;

      try {
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        };

        if (request.idempotencyKey) {
          headers['Idempotency-Key'] = request.idempotencyKey;
        }

        const body: Record<string, unknown> = {
          from: options.from,
          to: [request.to],
          subject: request.subject,
          html: request.htmlBody,
          text: request.textBody,
        };

        const response = await fetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: composedSignal,
        });

        if (response.ok) {
          const data = (await response.json()) as { id?: string };
          return {
            ok: true,
            providerMessageId: data.id,
            retryable: false,
          };
        }

        if (response.status === 429) {
          return {
            ok: false,
            error: 'Resend rate limited (429)',
            retryable: true,
          };
        }

        if (response.status >= 500) {
          return {
            ok: false,
            error: `Resend server error (${String(response.status)})`,
            retryable: true,
          };
        }

        return {
          ok: false,
          error: `Resend client error (${String(response.status)})`,
          retryable: false,
        };
      } catch (error) {
        if (request.signal?.aborted) {
          return {
            ok: false,
            error: 'Request aborted by caller',
            retryable: false,
          };
        }

        if (timeoutSignal.aborted) {
          return {
            ok: false,
            error: 'Request timed out',
            retryable: true,
          };
        }

        const message = error instanceof Error ? error.message : 'Unknown error';

        if (
          message.includes('ECONNREFUSED') ||
          message.includes('ECONNRESET') ||
          message.includes('ETIMEDOUT') ||
          message.includes('fetch failed')
        ) {
          return { ok: false, error: message, retryable: true };
        }

        return { ok: false, error: message, retryable: false };
      }
    },
  };
}
