export const CONTEXT_BUDGET_RETENTION = {
  auditDays: 30,
  maxAuditRecords: 2_000,
  maxAuditBytes: 32 * 1024 * 1024,
  dailyStatsDays: 90,
} as const;
