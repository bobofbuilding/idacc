// SPDX-License-Identifier: MIT

type DashboardEventLike = {
  topic?: unknown;
  data?: Record<string, unknown> | null;
};

const FAILURE_VALUE = /^(?:failed|failure|error|blocked|denied|timeout|timed-out)$/i;

function eventIsFailure(event: DashboardEventLike, topic: string): boolean {
  const data = event.data ?? {};
  const status = typeof data.status === 'string' ? data.status : '';
  const error = typeof data.error === 'string' ? data.error.trim() : '';
  return /:(?:failed|failure|error|blocked|denied|timeout)$/i.test(topic)
    || data.ok === false
    || Boolean(error)
    || FAILURE_VALUE.test(status);
}

/** Keep successful control/config audit traffic durable without letting it
 * displace task, query, agent, and communication activity in the Dashboard. */
export function isDashboardRelevantEvent(event: DashboardEventLike): boolean {
  const topic = typeof event.topic === 'string' ? event.topic : '';
  if (!topic.startsWith('control:') && !topic.startsWith('config:')) return true;
  return eventIsFailure(event, topic);
}
