export async function validateManagerContractEvent({
  brainPost,
  timelinePost,
  eventIdempotencyKey,
}, ev, { subject = '', items = [] } = {}) {
  if (!items.length) return null;
  const itemTypes = items.map((item, index) => `${index}:${String(item?.type ?? 'unknown')}`);
  const itemIdentity = itemTypes.join('|');
  const result = await brainPost('/manager/learning-contract/validate', {
    source: 'brain-listener',
    record: true,
    subject,
    items,
    contract_item_identity: itemIdentity,
    ...(eventIdempotencyKey
      ? { idempotency_key: eventIdempotencyKey(ev, `manager-contract-validation:${itemIdentity}`) }
      : {}),
  });
  const data = result?.data ?? null;
  if (data && !data.ok) {
    const timelineBody = {
      source: 'brain-listener',
      type: 'manager-learning-contract:violation',
      subject,
      data: {
        event_seq: ev.seq,
        event_topic: ev.topic,
        actor: ev.actor,
        subject,
        errors: data.errors,
        warnings: data.warnings,
        contract_item_identity: itemIdentity,
        contract_item_types: itemTypes,
      },
      tags: ['brain', 'manager-contract', 'invalid'],
    };
    if (timelinePost) {
      await timelinePost(
        ev,
        `manager-learning-contract-violation:${itemIdentity}`,
        timelineBody,
      );
    } else {
      await brainPost('/timeline', timelineBody);
    }
    await brainPost('/learning-tasks', {
      kind: 'manager.contract.violation',
      subject,
      priority: 6,
      source: 'brain-listener',
      payload: {
        event_seq: ev.seq,
        event_topic: ev.topic,
        actor: ev.actor,
        errors: data.errors,
        warnings: data.warnings,
        contract_items: items.map(item => item.type),
        contract_item_identity: itemIdentity,
      },
      ...(eventIdempotencyKey
        ? { idempotency_key: eventIdempotencyKey(ev, `manager-contract-learning-task:${itemIdentity}`) }
        : {}),
    });
  }
  return data;
}
