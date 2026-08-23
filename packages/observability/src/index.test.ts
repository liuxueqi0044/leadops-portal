import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, serializeSafeError } from './index.js';

function createCapture(): { destination: Writable; read(): string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  return { destination, read: () => chunks.join('') };
}

describe('createLogger', () => {
  it('redacts root, header, and nested credential secrets in real output', () => {
    const capture = createCapture();
    const logger = createLogger({
      service: 'redaction-test',
      instanceId: 'test-instance',
      destination: capture.destination,
    });

    logger.info({
      DATABASE_URL: 'postgresql://admin:database-secret@localhost/private',
      headers: {
        authorization: 'Bearer authorization-secret',
        cookie: 'session=cookie-secret',
        accept: 'application/json',
      },
      credentials: {
        username: 'kept-username',
        password: 'credential-secret',
      },
    });

    const output = capture.read();
    expect(output).not.toContain('database-secret');
    expect(output).not.toContain('authorization-secret');
    expect(output).not.toContain('cookie-secret');
    expect(output).not.toContain('credential-secret');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('application/json');
  });

  it('redacts nested payload and body fields', () => {
    const capture = createCapture();
    const logger = createLogger({
      service: 'redaction-test',
      instanceId: 'test-instance',
      destination: capture.destination,
    });

    logger.info({
      payload: { token: 'my-secret-token', data: 'visible' },
      body: { apiKey: 'key-12345', name: 'John' },
    });

    const output = capture.read();
    expect(output).not.toContain('my-secret-token');
    expect(output).not.toContain('key-12345');
  });

  it('redacts span attributes with sensitive keys', () => {
    const capture = createCapture();
    const logger = createLogger({
      service: 'redaction-test',
      instanceId: 'test-instance',
      destination: capture.destination,
    });

    logger.info({
      span: {
        attributes: {
          'http.url': 'https://example.com',
          secret: 'secret-token-abc',
          prompt: 'some long prompt text',
          response: 'some response text',
        },
      },
    });

    const output = capture.read();
    expect(output).not.toContain('secret-token-abc');
    expect(output).not.toContain('some long prompt text');
    expect(output).not.toContain('some response text');
    expect(output).toContain('https://example.com');
  });

  it('redacts email body and subject in logs', () => {
    const capture = createCapture();
    const logger = createLogger({
      service: 'redaction-test',
      instanceId: 'test-instance',
      destination: capture.destination,
    });

    logger.info({
      subject: 'Approval needed',
      emailBody: '<h1>Approval needed</h1><p>Secret: abc123</p>',
      htmlBody: '<div>Confidential</div>',
      textBody: 'Plain text confidential',
      templateName: 'approval-request',
    });

    const output = capture.read();
    expect(output).not.toContain('Approval needed');
    expect(output).not.toContain('abc123');
    expect(output).toContain('approval-request');
  });

  it('redacts encryption key and API key fields', () => {
    const capture = createCapture();
    const logger = createLogger({
      service: 'redaction-test',
      instanceId: 'test-instance',
      destination: capture.destination,
    });

    logger.info({
      encryptionKey: 'abcdef1234567890',
      ENCRYPTION_KEY: 'fedcba0987654321',
      API_KEY: 'api-key-secret',
      host: 'localhost',
    });

    const output = capture.read();
    expect(output).not.toContain('abcdef1234567890');
    expect(output).not.toContain('fedcba0987654321');
    expect(output).not.toContain('api-key-secret');
    expect(output).toContain('localhost');
  });
});

describe('serializeSafeError', () => {
  it('does not expose an Error message', () => {
    const secret = 'postgresql://admin:password@localhost/private';
    const result = serializeSafeError(new Error(secret));

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual({
      name: 'Error',
      message: 'Internal operation failed',
    });
  });

  it('does not expose a string rejection', () => {
    const result = serializeSafeError('token=super-secret');

    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(result.message).toBe('Internal operation failed');
  });

  it('preserves only a safe machine error code', () => {
    const error = Object.assign(new Error('password=hunter2'), {
      code: 'ECONNREFUSED',
    });

    expect(serializeSafeError(error)).toEqual({
      name: 'Error',
      message: 'Internal operation failed',
      code: 'ECONNREFUSED',
    });
  });

  it('drops an unsafe error code', () => {
    const error = Object.assign(new Error('failed'), {
      code: 'TOKEN=my-secret',
    });

    expect(serializeSafeError(error)).toEqual({
      name: 'Error',
      message: 'Internal operation failed',
    });
  });

  it('redacts nested error details', () => {
    const error = new Error('API key: sk-1234567890abcdef');

    expect(serializeSafeError(error)).toEqual({
      name: 'Error',
      message: 'Internal operation failed',
    });
  });
});
