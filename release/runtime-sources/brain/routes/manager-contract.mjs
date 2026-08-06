import { validateManagerLearningContract } from '../manager-learning-contract.mjs';
import {
  canonicalContentHash,
  idempotencyErrorBody,
  insertIdempotentTimeline,
  normalizeIdempotencyKey,
} from '../idempotency.mjs';

export async function handleManagerContractRoutes({ method, path, req, res, db, readBody, send }) {
  if (method !== 'POST' || path !== '/manager/learning-contract/validate') return false;

  const body = await readBody(req);
  const result = validateManagerLearningContract(body);
  const status = body.strict && !result.ok ? 400 : 200;

  if (body.record) {
    try {
      const idempotencyKey = normalizeIdempotencyKey(
        body.idempotency_key ?? body.idempotencyKey ?? null,
      );
      insertIdempotentTimeline(db, {
        source: body.source ?? 'manager-contract',
        type: 'manager-learning-contract:validated',
        subject: body.subject ?? body.task_id ?? body.taskId ?? '',
        data: {
          ok: result.ok,
          checked: result.checked,
          errors: result.errors.length,
          warnings: result.warnings.length,
          contract_item_identity: body.contract_item_identity ?? body.contractItemIdentity ?? null,
          request_hash: canonicalContentHash({
            subject: body.subject ?? body.task_id ?? body.taskId ?? '',
            items: body.items ?? [],
            strict: body.strict === true,
          }),
        },
        tags: ['brain', 'manager-contract', result.ok ? 'ok' : 'invalid'],
        idempotencyKey,
      });
    } catch (error) {
      send(res, error.status ?? 500, idempotencyErrorBody(error));
      return true;
    }
  }

  send(res, status, result);
  return true;
}
