import { healthCheck, getDefaultDatabase } from '@leadops/db/client';
import { NextResponse } from 'next/server';

export async function GET(): Promise<NextResponse> {
  try {
    const dbOk = await healthCheck(getDefaultDatabase().db);

    if (dbOk) {
      return NextResponse.json(
        { status: 'ok', timestamp: new Date().toISOString() },
        { status: 200 },
      );
    }

    return NextResponse.json(
      { status: 'degraded', timestamp: new Date().toISOString() },
      { status: 503 },
    );
  } catch {
    return NextResponse.json(
      { status: 'degraded', timestamp: new Date().toISOString() },
      { status: 503 },
    );
  }
}
