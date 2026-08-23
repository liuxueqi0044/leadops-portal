import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createResendEmailProvider } from './resend-provider.js';

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function mockFetchResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('Resend Email Provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const validOptions = {
    apiKey: 're_test_123',
    from: 'sender@test.com',
  };

  function makeRequest(overrides?: Partial<Parameters<ReturnType<typeof createResendEmailProvider>['send']>[0]>) {
    const provider = createResendEmailProvider(validOptions);
    return provider.send({
      to: 'to@test.com',
      subject: 'Test Subject',
      htmlBody: '<p>Hello</p>',
      textBody: 'Hello',
      idempotencyKey: 'idem-1',
      templateName: 'welcome',
      ...overrides,
    });
  }

  it('throws on missing or placeholder API key', () => {
    expect(() => createResendEmailProvider({ apiKey: '', from: 'a@b.com' })).toThrow('API key');
    expect(() => createResendEmailProvider({ apiKey: 're_placeholder', from: 'a@b.com' })).toThrow('API key');
    expect(() =>
      createResendEmailProvider({ apiKey: undefined as unknown as string, from: 'a@b.com' }),
    ).toThrow('API key');
  });

  it('throws on missing from address', () => {
    expect(() => createResendEmailProvider({ apiKey: 're_test', from: '' })).toThrow('"from" address');
  });

  it('sends email successfully and returns provider message id', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(200, { id: 'msg_abc_123' }));

    const result = await makeRequest();

    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toBe('msg_abc_123');
    expect(result.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined providerMessageId when Resend response has no id', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(200, {}));

    const result = await makeRequest();

    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toBeUndefined();
  });

  it('sends Idempotency-Key as HTTP header, not in JSON body', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(200, { id: 'msg_1' }));

    await makeRequest({ idempotencyKey: 'idem-header-test' });

    const calls = fetchMock.mock.calls as [string, FetchInit][];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const callArgs = calls[0]!;
    const init = callArgs[1];
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('idem-header-test');
    expect(headers.Authorization).toBe('Bearer re_test_123');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'headers')).toBe(false);
    expect(body.from).toBe('sender@test.com');
    expect(body.to).toEqual(['to@test.com']);
    expect(body.subject).toBe('Test Subject');
    expect(body.html).toBe('<p>Hello</p>');
    expect(body.text).toBe('Hello');
  });

  it('handles 429 rate limit as retryable', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(429, {}));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('429');
    expect(result.retryable).toBe(true);
  });

  it('handles 5xx server error as retryable', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(502, {}));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('502');
    expect(result.retryable).toBe(true);
  });

  it('handles 503 server error as retryable', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(503, {}));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
    expect(result.retryable).toBe(true);
  });

  it('handles 4xx (non-429) client error as permanent, not retryable', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(400, {}));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('400');
    expect(result.retryable).toBe(false);
  });

  it('handles 404 client error as permanent', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(404, {}));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
    expect(result.retryable).toBe(false);
  });

  it('handles internal timeout as retryable', async () => {
    fetchMock.mockImplementation((_url: string, init: FetchInit | undefined) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'Aborted'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new Error('Aborted'));
          }, { once: true });
        }
      });
    });

    const provider = createResendEmailProvider({ ...validOptions, timeoutMs: 50 });
    const result = await provider.send({
      to: 'to@test.com',
      subject: 'Test',
      htmlBody: '<p>H</p>',
      textBody: 'H',
      idempotencyKey: 'timeout-test',
      templateName: 'test',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request timed out');
    expect(result.retryable).toBe(true);
  });

  it('handles caller abort before send as not retryable', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await makeRequest({ signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request aborted by caller');
    expect(result.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles caller abort during send as not retryable', async () => {
    const controller = new AbortController();

    fetchMock.mockImplementation((_url: string, init: FetchInit | undefined) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new Error('Aborted'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new Error('Aborted'));
          }, { once: true });
        }
      });
    });

    const provider = createResendEmailProvider({ ...validOptions, timeoutMs: 10000 });
    const sendPromise = provider.send({
      to: 'to@test.com',
      subject: 'Test',
      htmlBody: '<p>H</p>',
      textBody: 'H',
      idempotencyKey: 'abort-test',
      templateName: 'test',
      signal: controller.signal,
    });

    await new Promise<void>((r) => { setTimeout(r, 10); });
    controller.abort();

    const result = await sendPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request aborted by caller');
    expect(result.retryable).toBe(false);
  });

  it('distinguishes caller abort from timeout when both signals could fire', async () => {
    const controller = new AbortController();

    fetchMock.mockImplementation((_url: string, init: FetchInit | undefined) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new Error('Aborted'));
            return;
          }
          signal.addEventListener('abort', () => {
            reject(new Error('Aborted'));
          }, { once: true });
        }
      });
    });

    const provider = createResendEmailProvider({ ...validOptions, timeoutMs: 5000 });
    const sendPromise = provider.send({
      to: 'to@test.com',
      subject: 'Test',
      htmlBody: '<p>H</p>',
      textBody: 'H',
      idempotencyKey: 'both-test',
      templateName: 'test',
      signal: controller.signal,
    });

    await new Promise<void>((r) => { setTimeout(r, 10); });
    controller.abort();

    const result = await sendPromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Request aborted by caller');
    expect(result.retryable).toBe(false);
  });

  it('handles network error as retryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('fetch failed');
    expect(result.retryable).toBe(true);
  });

  it('handles ECONNREFUSED as retryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.retryable).toBe(true);
  });

  it('handles unknown error as not retryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Something unexpected'));

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Something unexpected');
    expect(result.retryable).toBe(false);
  });

  it('handles non-Error thrown value', async () => {
    fetchMock.mockRejectedValueOnce('raw string error');

    const result = await makeRequest();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unknown error');
    expect(result.retryable).toBe(false);
  });

  it('uses custom baseUrl when provided', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(200, { id: 'msg_1' }));

    const provider = createResendEmailProvider({
      ...validOptions,
      baseUrl: 'https://api.resend.example.com',
    });
    await provider.send({
      to: 'to@test.com',
      subject: 'S',
      htmlBody: 'H',
      textBody: 'T',
      idempotencyKey: 'key',
      templateName: 'test',
    });

    const calls = fetchMock.mock.calls as [string, FetchInit][];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const callArgs = calls[0]!;
    expect(callArgs[0]).toBe('https://api.resend.example.com/emails');
  });
});
