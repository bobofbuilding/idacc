const TASK_ID_RE = /^(task:)?[A-Za-z0-9_.:-]+$/;

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function idSet(value) {
  const raw = arrayValue(value);
  return [...new Set(raw.map(String).map(s => s.trim()).filter(Boolean))];
}

function issue(issues, code, field, message, severity = 'error') {
  issues.push({ code, field, message, severity });
}

function validateStringIdArray(issues, field, value, { required = false, severity = 'error' } = {}) {
  if (value === undefined) {
    if (required) issue(issues, 'required', field, `${field} is required`, severity);
    return [];
  }
  if (!Array.isArray(value)) {
    issue(issues, 'invalid', field, `${field} must be an array`, severity);
    return [];
  }
  const normalized = value.map((item) => String(item ?? '').trim());
  if (normalized.some((item) => !item)) {
    issue(issues, 'invalid', field, `${field} entries must be non-empty strings`, severity);
  }
  if (required && !normalized.some(Boolean)) {
    issue(issues, 'required', field, `${field} is required`, severity);
  }
  return normalized.filter(Boolean);
}

function validateDispatchContext(payload = {}) {
  const issues = [];
  for (const field of ['task_id', 'agent_id', 'text']) {
    if (!hasValue(payload[field])) issue(issues, 'required', field, `${field} is required`);
  }
  if (hasValue(payload.task_id) && !TASK_ID_RE.test(String(payload.task_id))) {
    issue(issues, 'invalid', 'task_id', 'task_id should be stable and machine-readable');
  }
  if (payload.max_sources !== undefined && (!Number.isFinite(Number(payload.max_sources)) || Number(payload.max_sources) <= 0)) {
    issue(issues, 'invalid', 'max_sources', 'max_sources must be a positive number');
  }
  if (payload.max_chars !== undefined && (!Number.isFinite(Number(payload.max_chars)) || Number(payload.max_chars) <= 0)) {
    issue(issues, 'invalid', 'max_chars', 'max_chars must be a positive number');
  }
  return issues;
}

function validateTaskEnvelope(payload = {}) {
  const issues = [];
  const context = payload.brain_context ?? payload.brainContext ?? {};
  const cited = context.cited ?? {};
  const sourceIds = cited.canonical_source_ids ?? cited.canonicalSourceIds ?? [];
  if (!context || typeof context !== 'object' || Object.keys(context).length === 0) {
    issue(issues, 'missing_context', 'brain_context', 'claimed tasks should preserve the Brain dispatch context');
  }
  if (!arrayValue(sourceIds).length) {
    issue(issues, 'missing_citations', 'brain_context.cited.canonical_source_ids', 'Brain context should include cited source ids', 'warn');
  }
  if (!hasValue(context.timeline_event_id ?? context.timelineEventId)) {
    issue(issues, 'missing_timeline_event', 'brain_context.timeline_event_id', 'Brain context should preserve the source timeline event id', 'warn');
  }
  return issues;
}

function validateEvalFeedback(payload = {}) {
  const issues = [];
  for (const field of ['query_text', 'route', 'agent_id']) {
    if (!hasValue(payload[field])) issue(issues, 'required', field, `${field} is required`);
  }
  const routeIds = idSet(payload.route_ids ?? payload.routeIds ?? [payload.route]);
  if (!routeIds.length) issue(issues, 'required', 'route_ids', 'eval feedback should report the route ids used');
  const requiredSourceIds = idSet(payload.required_source_ids ?? payload.requiredSourceIds);
  const requiredAcceptanceIds = idSet(payload.required_acceptance_ids ?? payload.requiredAcceptanceIds ?? payload.accepted_ids ?? payload.acceptedIds);
  const usedIds = idSet(payload.used_ids ?? payload.usedIds ?? payload.accepted_ids ?? payload.acceptedIds);
  const artifactHash = payload.artifact_hash ?? payload.artifactHash;
  if (!requiredSourceIds.length) {
    issue(issues, 'required', 'required_source_ids', 'eval feedback should include required_source_ids');
  }
  if (!requiredAcceptanceIds.length) {
    issue(issues, 'required', 'required_acceptance_ids', 'eval feedback should include required_acceptance_ids');
  }
  if (!usedIds.length) {
    issue(issues, 'required', 'used_ids', 'eval feedback should include used_ids');
  }
  const routeAckState = payload.route_ack_state ?? payload.routeAckState;
  if (!routeAckState || (typeof routeAckState !== 'string' && typeof routeAckState !== 'object' || Array.isArray(routeAckState))) {
    issue(issues, 'required', 'route_ack_state', 'eval feedback should include route_ack_state');
  } else if (typeof routeAckState === 'string') {
    if (routeIds.length !== 1) {
      issue(issues, 'invalid', 'route_ack_state', 'string route_ack_state only supports a single route id');
    } else if (!routeAckState.trim()) {
      issue(issues, 'invalid', 'route_ack_state', 'route_ack_state must be non-empty');
    }
  } else {
    for (const routeId of routeIds) {
      if (!hasValue(routeAckState?.[routeId])) {
        issue(issues, 'required', `route_ack_state.${routeId}`, `route_ack_state must acknowledge ${routeId}`);
      }
    }
  }
  if (!hasValue(artifactHash)) {
    issue(issues, 'required', 'artifact_hash', 'eval feedback should include artifact_hash');
  }
  const accepted = validateStringIdArray(issues, 'accepted_ids', payload.accepted_ids ?? payload.acceptedIds, { severity: 'warn' });
  const volunteered = validateStringIdArray(issues, 'volunteered_source_ids', payload.volunteered_source_ids ?? payload.volunteeredSourceIds, { severity: 'warn' });
  if (!volunteered.length) {
    issue(issues, 'missing_volunteered_sources', 'volunteered_source_ids', 'eval feedback should report the sources Brain volunteered');
  }
  if (!accepted.length) {
    issue(issues, 'missing_accepted_sources', 'accepted_ids', 'eval feedback should report which sources were actually useful', 'warn');
  }
  return issues;
}

function validateInstructionFeedback(payload = {}) {
  const issues = [];
  for (const field of ['task_id', 'agent_id']) {
    if (!hasValue(payload[field])) issue(issues, 'required', field, `${field} is required`);
  }
  const used = arrayValue(payload.used_instruction_ids ?? payload.usedInstructionIds);
  const ignored = arrayValue(payload.ignored_instruction_ids ?? payload.ignoredInstructionIds);
  const harmful = arrayValue(payload.harmful_instruction_ids ?? payload.harmfulInstructionIds);
  if (!used.length && !ignored.length && !harmful.length) {
    issue(issues, 'missing_instruction_outcome', 'used_instruction_ids', 'instruction feedback should classify injected instructions');
  }
  return issues;
}

function validateLearningTaskCompletion(payload = {}) {
  const issues = [];
  if (payload.status !== 'completed') issue(issues, 'invalid_status', 'status', 'learning task completion status must be completed');
  if (!hasValue(payload.assignee)) issue(issues, 'required', 'assignee', 'assignee is required');
  if (!payload.result || typeof payload.result !== 'object') issue(issues, 'required', 'result', 'typed completion result is required');
  return issues;
}

function validateLearnedArtifact(payload = {}) {
  const issues = [];
  const artifact = payload.learned_artifact ?? payload.learnedArtifact ?? payload;
  if (!artifact || typeof artifact !== 'object') {
    issue(issues, 'required', 'learned_artifact', 'learned artifact payload is required');
    return issues;
  }
  if (hasValue(artifact.task_id ?? artifact.taskId) && !TASK_ID_RE.test(String(artifact.task_id ?? artifact.taskId))) {
    issue(issues, 'invalid', 'learned_artifact.task_id', 'task_id should be stable and machine-readable');
  }
  const facts = arrayValue(artifact.facts);
  const skills = arrayValue(artifact.skills);
  const sources = arrayValue(artifact.sources);
  const questions = arrayValue(artifact.follow_up_questions ?? artifact.followUpQuestions);
  const artifactSourceIds = validateStringIdArray(issues, 'learned_artifact.source_ids', artifact.source_ids ?? artifact.sourceIds, { severity: 'warn' });
  if (
    !hasValue(artifact.content) &&
    !hasValue(artifact.summary) &&
    !hasValue(artifact.text) &&
    !facts.length &&
    !skills.length &&
    !sources.length &&
    !questions.length
  ) {
    issue(issues, 'required', 'learned_artifact.content', 'learned artifact should include content, summary, text, sources, facts, skills, or follow_up_questions');
  }

  facts.forEach((fact, index) => {
    const prefix = `learned_artifact.facts[${index}]`;
    if (!fact || typeof fact !== 'object') {
      issue(issues, 'invalid', prefix, 'fact must be an object');
      return;
    }
    for (const field of ['entity_id', 'field', 'value']) {
      const value = field === 'entity_id' ? fact.entity_id ?? fact.entityId : fact[field];
      if (!hasValue(value)) issue(issues, 'required', `${prefix}.${field}`, `${field} is required`);
    }
    if (fact.confidence !== undefined) {
      const confidence = Number(fact.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        issue(issues, 'invalid', `${prefix}.confidence`, 'confidence must be between 0 and 1');
      }
    }
    const factSourceIds = validateStringIdArray(issues, `${prefix}.source_ids`, fact.source_ids ?? fact.sourceIds, { severity: 'warn' });
    if (!factSourceIds.length && !sources.length) {
      issue(issues, 'missing_citation', `${prefix}.source_ids`, 'fact should cite source_ids or provide sources[] fallback', 'warn');
    }
  });

  skills.forEach((skill, index) => {
    const prefix = `learned_artifact.skills[${index}]`;
    if (!skill || typeof skill !== 'object') {
      issue(issues, 'invalid', prefix, 'skill must be an object');
      return;
    }
    if (!hasValue(skill.name) && !hasValue(skill.gap)) {
      issue(issues, 'required', `${prefix}.name`, 'skill name or gap is required');
    }
    if (!hasValue(skill.gap) && !hasValue(skill.evidence) && !hasValue(skill.description)) {
      issue(issues, 'required', `${prefix}.evidence`, 'skill gap, evidence, or description is required');
    }
    const skillSourceIds = validateStringIdArray(issues, `${prefix}.source_ids`, skill.source_ids ?? skill.sourceIds, { severity: 'warn' });
    if (!skillSourceIds.length && !sources.length) {
      issue(issues, 'missing_citation', `${prefix}.source_ids`, 'skill should cite source_ids or provide sources[] fallback', 'warn');
    }
  });

  sources.forEach((source, index) => {
    const prefix = `learned_artifact.sources[${index}]`;
    if (!source || typeof source !== 'object') {
      issue(issues, 'invalid', prefix, 'source must be an object');
      return;
    }
    if (!hasValue(source.content)) issue(issues, 'required', `${prefix}.content`, 'source content is required');
  });

  questions.forEach((question, index) => {
    if (typeof question === 'string') {
      if (!hasValue(question)) issue(issues, 'required', `learned_artifact.follow_up_questions[${index}]`, 'question is required');
      if (!sources.length && !artifactSourceIds.length) {
        issue(issues, 'missing_citation', `learned_artifact.follow_up_questions[${index}]`, 'follow-up question should cite source_ids or provide sources[] fallback', 'warn');
      }
      return;
    }
    if (!question || typeof question !== 'object' || !hasValue(question.question)) {
      issue(issues, 'required', `learned_artifact.follow_up_questions[${index}].question`, 'question is required');
      return;
    }
    const questionSourceIds = validateStringIdArray(issues, `learned_artifact.follow_up_questions[${index}].source_ids`, question.source_ids ?? question.sourceIds, { severity: 'warn' });
    if (!questionSourceIds.length && !sources.length && !artifactSourceIds.length) {
      issue(issues, 'missing_citation', `learned_artifact.follow_up_questions[${index}].source_ids`, 'follow-up question should cite source_ids or provide sources[] fallback', 'warn');
    }
  });

  if (hasValue(artifact.summary) && !artifactSourceIds.length && !sources.length) {
    issue(issues, 'missing_citation', 'learned_artifact.source_ids', 'summary should cite source_ids or provide sources[] fallback', 'warn');
  }

  for (const [field, value] of [
    ['facts', artifact.facts],
    ['skills', artifact.skills],
    ['sources', artifact.sources],
    ['follow_up_questions', artifact.follow_up_questions ?? artifact.followUpQuestions],
  ]) {
    if (value !== undefined && !Array.isArray(value)) {
      issue(issues, 'invalid', `learned_artifact.${field}`, `${field} must be an array`);
    }
  }
  return issues;
}

const VALIDATORS = {
  dispatch_context: validateDispatchContext,
  task_envelope: validateTaskEnvelope,
  eval_feedback: validateEvalFeedback,
  instruction_feedback: validateInstructionFeedback,
  learning_task_completion: validateLearningTaskCompletion,
  learned_artifact: validateLearnedArtifact,
};

export const MANAGER_LEARNING_CONTRACT_TYPES = Object.keys(VALIDATORS);

export function validateManagerLearningContract(body = {}) {
  const strict = Boolean(body.strict);
  const items = Array.isArray(body.items)
    ? body.items
    : MANAGER_LEARNING_CONTRACT_TYPES
        .map(type => ({ type, payload: body[type] ?? body[type.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] }))
        .filter(item => item.payload !== undefined);

  if (!items.length) {
    return {
      ok: false,
      strict,
      checked: 0,
      errors: [{ code: 'empty_contract', field: 'items', message: 'at least one contract item is required', severity: 'error' }],
      warnings: [],
      results: [],
    };
  }

  const results = items.map((item, index) => {
    const type = item.type;
    const validator = VALIDATORS[type];
    if (!validator) {
      return {
        index,
        type,
        ok: false,
        errors: [{ code: 'unknown_type', field: 'type', message: `unknown contract type: ${type}`, severity: 'error' }],
        warnings: [],
      };
    }
    const issues = validator(item.payload ?? {});
    const errors = issues.filter(i => i.severity !== 'warn');
    const warnings = issues.filter(i => i.severity === 'warn');
    return { index, type, ok: errors.length === 0, errors, warnings };
  });

  const errors = results.flatMap(result => result.errors.map(error => ({ ...error, type: result.type, index: result.index })));
  const warnings = results.flatMap(result => result.warnings.map(warning => ({ ...warning, type: result.type, index: result.index })));
  return {
    ok: errors.length === 0,
    strict,
    checked: results.length,
    errors,
    warnings,
    results,
  };
}
