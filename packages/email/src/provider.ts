export interface EmailSendRequest {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  idempotencyKey: string;
  templateName: string;
  signal?: AbortSignal;
}

export interface EmailSendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  retryable: boolean;
}

export interface EmailProvider {
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}

export function createFakeEmailProvider(
  options: { shouldFail?: "retryable" | "permanent" | "timeout"; latencyMs?: number; clock?: () => number } = {},
): EmailProvider {
  const clock = options.clock ?? Date.now;
  return {
    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      if (options.latencyMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.latencyMs);
          if (request.signal) {
            if (request.signal.aborted) {
              clearTimeout(timer);
              reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
              return;
            }
            request.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            }, { once: true });
          }
        });
      }
      if (options.shouldFail === "retryable") {
        return { ok: false, error: "fake 429: too many requests", retryable: true };
      }
      if (options.shouldFail === "timeout") {
        return { ok: false, error: "fake timeout", retryable: true };
      }
      if (options.shouldFail === "permanent") {
        return { ok: false, error: "fake 400: bad request", retryable: false };
      }
      return {
        ok: true,
        providerMessageId: "fake-msg-" + request.idempotencyKey + "-" + String(clock()),
        retryable: false,
      };
    },
  };
}

export function isSendResultRetryable(result: EmailSendResult): boolean {
  return !result.ok && result.retryable;
}
