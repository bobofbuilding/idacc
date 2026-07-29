export async function handleInstructionRoutes({
  method,
  path,
  req,
  res,
  readBody,
  send,
  recordInstructionFeedback,
} = {}) {
  if (method === 'POST' && path === '/instructions/feedback') {
    const b = await readBody(req);
    const result = recordInstructionFeedback(b);
    if (!result.recorded.length && !result.missing.length) {
      send(res, 400, { error: 'instruction feedback required' });
      return true;
    }
    send(res, 200, {
      ok: true,
      recorded: result.recorded.map(({ source_id, memory_id, outcome, after }) => ({ source_id, memory_id, outcome, counters: after })),
      missing: result.missing,
    });
    return true;
  }
  return false;
}
