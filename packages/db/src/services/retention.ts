import type postgres from 'postgres';

export interface RetentionPruneRow {
  table_name: string;
  candidate_count: string;
  deleted_count: string;
}

export interface RetentionPruneResult {
  tables: {
    tableName: string;
    candidateCount: number;
    deletedCount: number;
  }[];
  dryRun: boolean;
}

export async function pruneNonAuditData(
  sql: postgres.Sql,
  dryRun = true,
): Promise<RetentionPruneResult> {
  const rows = await sql.unsafe<RetentionPruneRow[]>(
    `SELECT table_name, candidate_count::text, deleted_count::text
     FROM prune_non_audit_data($1)`,
    [dryRun],
  );

  return {
    tables: rows.map((r) => ({
      tableName: r.table_name,
      candidateCount: Number(r.candidate_count),
      deletedCount: Number(r.deleted_count),
    })),
    dryRun,
  };
}
