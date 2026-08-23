import type postgres from 'postgres';
import type { Logger } from 'pino';
import { pruneNonAuditData } from '@leadops/db';

export async function handleRetentionPrune(
  sql: postgres.Sql,
  logger: Logger,
  payload: { dryRun?: boolean },
): Promise<void> {
  const dryRun = payload.dryRun !== false;

  logger.info(
    { event: 'retention.start', dryRun },
    'Retention prune started',
  );

  const result = await pruneNonAuditData(sql, dryRun);

  let totalCandidates = 0;
  let totalDeleted = 0;

  for (const table of result.tables) {
    totalCandidates += table.candidateCount;
    totalDeleted += table.deletedCount;
    logger.info(
      {
        event: 'retention.table_result',
        tableName: table.tableName,
        candidateCount: table.candidateCount,
        deletedCount: table.deletedCount,
        dryRun,
      },
      `Retention: ${table.tableName} — candidates=${String(table.candidateCount)}, deleted=${String(table.deletedCount)}`,
    );
  }

  logger.info(
    {
      event: 'retention.complete',
      dryRun,
      tablesExamined: result.tables.length,
      totalCandidates,
      totalDeleted,
    },
    `Retention prune complete: ${String(result.tables.length)} tables, ${String(totalCandidates)} candidates, ${String(totalDeleted)} deleted`,
  );
}
