export function isAgentLifecycleEvent(topic) {
  return topic === 'agent:started'
    || topic === 'agent:stopped'
    || topic === 'agent:rebuild'
    || topic === 'agent:online'
    || topic === 'agent:offline';
}

export function agentLifecycleStatus(topic) {
  if (topic === 'agent:started' || topic === 'agent:online') return 'online';
  if (topic === 'agent:rebuild') return 'rebuilding';
  return 'offline';
}

export function isTaskCompletionEvent(topic) {
  return topic === 'task:done' || topic === 'task:removed' || topic === 'task:completed';
}

export function isTaskSupervisionEvent(topic) {
  return topic === 'task:refreshed' || topic === 'task:triaged';
}

export function isTaskAttemptEvent(topic) {
  return topic === 'task:attempt-approach';
}

export function isCheckinEvent(topic) {
  return topic === 'checkin:due'
    || topic === 'checkin:created'
    || topic === 'checkin:closed'
    || topic === 'checkin:snoozed'
    || topic === 'checkin:expired';
}

export function isQueryEvent(topic) {
  return topic === 'query:delivered' || topic === 'query:failed' || topic === 'query:expired';
}

export function isQueryControlEvent(topic) {
  return topic === 'query:control-reply-applied';
}

export function isValidatorRecommendationEvent(topic) {
  return topic === 'validator:recommendation-loop';
}
