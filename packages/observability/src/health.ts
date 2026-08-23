export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: Record<string, HealthCheckEntry>;
}

export interface HealthCheckEntry {
  status: 'pass' | 'fail' | 'warn';
  message?: string;
}

export interface DependencyCheck {
  name: string;
  check: () => Promise<boolean>;
  timeout?: number;
}

export function liveCheck(): HealthCheckResult {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: { process: { status: 'pass' } },
  };
}

export async function readyCheck(dependencies: DependencyCheck[]): Promise<HealthCheckResult> {
  const checks: Record<string, HealthCheckEntry> = {};
  let overallStatus: HealthCheckResult['status'] = 'ok';

  for (const dep of dependencies) {
    const timeout = dep.timeout ?? 5000;
    try {
      const result = await withTimeout(dep.check(), timeout);
      if (result) {
        checks[dep.name] = { status: 'pass' };
      } else {
        checks[dep.name] = { status: 'fail' };
        overallStatus = 'unhealthy';
      }
    } catch {
      checks[dep.name] = { status: 'fail' };
      overallStatus = 'unhealthy';
    }
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
  };
}

export function readyCheckResponse(result: HealthCheckResult): { status: string; timestamp: string } {
  return {
    status: result.status === 'ok' ? 'ok' : 'error',
    timestamp: result.timestamp,
  };
}

export async function startupCheck(dependencies: DependencyCheck[]): Promise<HealthCheckResult> {
  return readyCheck(dependencies);
}

export interface WorkerHeartbeat {
  workerId: string;
  lastHeartbeat: string;
  status: 'alive' | 'degraded' | 'lost';
  activeJobs: number;
  uptimeMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => { reject(new Error('Health check timed out')); }, ms);
    }),
  ]);
}
