import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';

import { generateWebhookSecret, verifyWebhookSignature } from '@leadops/events';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deliverApprovalCallback,
  SafeUrlValidator,
  UnsafeUrlError,
  type CallbackPayload,
} from './approval-callback.js';

interface ReceivedRequest {
  body: string;
  headers: IncomingHttpHeaders;
  host: string | undefined;
}

const servers: Server[] = [];

async function listen(
  handler: RequestListener,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
  return { server, port: address.port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

const payload: CallbackPayload = {
  eventType: 'approval.completed',
  approvalId: '00000000-0000-0000-0000-000000000501',
  decision: 'approved',
  decidedBy: 'user-1',
  decidedAt: '2026-08-09T00:00:00.000Z',
  version: 2,
};

describe('SafeUrlValidator', () => {
  const validator = new SafeUrlValidator();

  it('accepts only standard-port HTTPS callback URLs', () => {
    expect(validator.validateUrlString('https://example.com/callback').hostname).toBe(
      'example.com',
    );
    expect(() => validator.validateUrlString('http://example.com/callback')).toThrow(
      UnsafeUrlError,
    );
    expect(() => validator.validateUrlString('https://user:pass@example.com/')).toThrow(
      UnsafeUrlError,
    );
    expect(() => validator.validateUrlString('https://example.com:8443/')).toThrow(
      UnsafeUrlError,
    );
  });

  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ])('rejects non-public address %s', (address) => {
    expect(validator.isSafeIp(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'accepts public address %s',
    (address) => {
      expect(validator.isSafeIp(address)).toBe(true);
    },
  );

  it('rejects a hostname when any A or AAAA result is private', async () => {
    const mixed = new SafeUrlValidator(false, () => Promise.resolve([
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]));
    await expect(mixed.validateDnsAndResolve('callback.example')).rejects.toThrow(
      /non-public/,
    );
  });
});

describe('deliverApprovalCallback', () => {
  it('binds the request to the validated address and emits a verifiable HMAC signature', async () => {
    let received: ReceivedRequest | undefined;
    const { port } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = {
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers,
          host: request.headers.host,
        };
        response.writeHead(204).end();
      });
    });
    let lookupCalls = 0;
    const secret = generateWebhookSecret().prefixSecret;
    const result = await deliverApprovalCallback(
      payload,
      `http://callback.localhost:${String(port)}/result`,
      secret,
      'approval-completed-test-2',
      'delivery-1',
      {
        allowLocalhost: true,
        lookup: () => {
          lookupCalls++;
          return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
        },
        now: () => new Date('2026-08-09T00:00:00.000Z'),
      },
    );

    expect(result).toEqual({ success: true, statusCode: 204, retryable: false });
    expect(lookupCalls).toBe(1);
    expect(received?.host).toBe(`callback.localhost:${String(port)}`);
    const headers = received?.headers;
    if (!headers || !received) throw new Error('callback fixture did not receive a request');
    expect(
      verifyWebhookSignature(
        Buffer.from(received.body),
        {
          'webhook-id': String(headers['webhook-id']),
          'webhook-timestamp': String(headers['webhook-timestamp']),
          'webhook-signature': String(headers['webhook-signature']),
        },
        [secret],
        Number.POSITIVE_INFINITY,
      ),
    ).toEqual({ valid: true });
    expect(JSON.parse(received.body)).toEqual(payload);
  });

  it('does not follow redirects', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
    });
    const result = await deliverApprovalCallback(
      payload,
      `http://127.0.0.1:${String(port)}/redirect`,
      generateWebhookSecret().prefixSecret,
      'redirect-test',
      'delivery-redirect',
      { allowLocalhost: true },
    );
    expect(result).toMatchObject({ success: false, statusCode: 302, retryable: false });
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
  ])('classifies HTTP %i retryable=%s', async (status, retryable) => {
    const { port } = await listen((_request, response) => response.writeHead(status).end());
    const result = await deliverApprovalCallback(
      payload,
      `http://127.0.0.1:${String(port)}/status`,
      generateWebhookSecret().prefixSecret,
      `status-${String(status)}`,
      `delivery-${String(status)}`,
      { allowLocalhost: true },
    );
    expect(result).toMatchObject({ success: false, statusCode: status, retryable });
  });

  it('times out without following a second connection path', async () => {
    const { port } = await listen(() => undefined);
    const result = await deliverApprovalCallback(
      payload,
      `http://127.0.0.1:${String(port)}/timeout`,
      generateWebhookSecret().prefixSecret,
      'timeout-test',
      'delivery-timeout',
      { allowLocalhost: true, timeoutMs: 25 },
    );
    expect(result).toMatchObject({ success: false, retryable: true, error: 'callback timed out' });
  });
});
