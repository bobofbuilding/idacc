import { learnedArtifactSourceId, prefixedEntityId, querySourceId, scalarId } from './provenance.mjs';

function artifactItemSourceIds(canonicalSourceIds, item, fallbackSourceIds = []) {
  return canonicalSourceIds(
    item?.source_ids
      ?? item?.sourceIds
      ?? item?.citation_source_ids
      ?? item?.citationSourceIds
      ?? fallbackSourceIds,
  );
}

async function postEventTimeline(deps, ev, suffix, body) {
  if (deps.timelinePost) return deps.timelinePost(ev, suffix, body);
  return deps.brainPost('/timeline', body);
}

async function warnCitationIssue(deps, ev, { taskId = '', agentId = '', itemKind, subject = '', issue, sourceIds = [] }) {
  await postEventTimeline(
    deps,
    ev,
    `artifact-citation:${itemKind}:${subject}:${issue}:${sourceIds.join(',')}`,
    {
    source: 'brain-listener',
    type: 'learned-artifact:citation-warning',
    subject: subject || taskId || agentId || '',
    data: {
      task_id: taskId,
      agent_id: agentId,
      item_kind: itemKind,
      issue,
      source_ids: sourceIds,
      event_seq: ev.seq,
    },
    tags: ['brain', 'learned-artifact', 'citation', 'warning'],
    },
  );
}

async function validateArtifactCitations(deps, ev, { taskId = '', agentId = '', itemKind, subject = '', sourceIds = [] }) {
  if (!sourceIds.length) {
    await warnCitationIssue(deps, ev, { taskId, agentId, itemKind, subject, issue: 'missing_citation', sourceIds });
    return [];
  }
  const result = await deps.brainPost('/sources/validate', { source_ids: sourceIds }, { strict: false });
  const invalid = result?.data?.sources?.filter(source => !source.valid) ?? [];
  for (const source of invalid) {
    await warnCitationIssue(deps, ev, {
      taskId,
      agentId,
      itemKind,
      subject,
      issue: `invalid_citation:${source.issues.join(',') || 'invalid'}`,
      sourceIds: [source.source_id],
    });
  }
  return invalid;
}

export async function ingestLearnedArtifact(deps, ev, artifact, fallbackTextUnitIds = []) {
  const {
    brainPost,
    ingestTextUnit,
    postFacts,
    eventSourceId,
    canonicalSourceIds,
  } = deps;
  if (!artifact || typeof artifact !== 'object') return;
  const taskId = prefixedEntityId('task', artifact.task_id ?? artifact.taskId ?? ev.subject ?? ev.seq, `task:${ev.seq}`);
  const eventTopic = String(ev.topic ?? '');
  const eventScopeId = eventTopic.startsWith('query:')
    ? querySourceId(ev.subject ?? ev.seq, `query:${ev.seq}`)
    : taskId;
  const agentId = artifact.agent_id ?? artifact.agentId ?? ev.actor ?? '';
  const artifactSource = learnedArtifactSourceId({
    scopeId: eventScopeId,
    agentId,
    eventSeq: ev.seq,
  });
  const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
  const sourceIds = [...fallbackTextUnitIds];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (!source?.content) continue;
    const result = await ingestTextUnit(ev, {
      sourceKind: source.kind ?? 'learned-artifact',
      sourceId: source.source_id ?? source.sourceId ?? eventSourceId(ev, `artifact-source-${i + 1}`),
      title: source.title ?? `Learned artifact ${taskId || scalarId(ev.subject) || ''}`,
      content: source.content,
      metadata: { task_id: taskId, agent_id: agentId, learned_artifact: true },
    });
    if (result?.textUnitIds) sourceIds.push(...result.textUnitIds);
  }
  const facts = [];
  if (Array.isArray(artifact.facts)) {
    for (const f of artifact.facts) {
      const itemSourceIds = artifactItemSourceIds(canonicalSourceIds, f, sourceIds);
      await validateArtifactCitations(deps, ev, {
        taskId,
        agentId,
        itemKind: 'fact',
        subject: `${scalarId(f.entity_id ?? f.entityId) ?? ''}:${f.field ?? ''}`,
        sourceIds: itemSourceIds,
      });
      facts.push({
        entity_id: scalarId(f.entity_id ?? f.entityId),
        field: f.field,
        value: f.value,
        source: artifactSource,
        confidence: f.confidence ?? 0.7,
        context: { task_id: taskId, agent_id: agentId, event_seq: ev.seq, source_text_unit_ids: sourceIds, source_ids: itemSourceIds },
      });
    }
  }
  if (artifact.summary && taskId) {
    const summarySourceIds = artifactItemSourceIds(canonicalSourceIds, artifact, sourceIds);
    await validateArtifactCitations(deps, ev, {
      taskId,
      agentId,
      itemKind: 'summary',
      subject: taskId,
      sourceIds: summarySourceIds,
    });
    facts.push({
      entity_id: taskId,
      field: 'learned_summary',
      value: artifact.summary,
      source: artifactSource,
      confidence: 0.75,
      context: { agent_id: agentId, event_seq: ev.seq, source_text_unit_ids: sourceIds, source_ids: summarySourceIds },
    });
  }
  await postFacts(facts, deps.eventIdempotencyKey?.(ev, 'facts:learned-artifact'));
  if (Array.isArray(artifact.skills)) {
    for (const [skillIndex, skill] of artifact.skills.entries()) {
      const itemSourceIds = artifactItemSourceIds(canonicalSourceIds, skill, sourceIds);
      await validateArtifactCitations(deps, ev, {
        taskId,
        agentId,
        itemKind: 'skill',
        subject: skill.name ?? 'unknown',
        sourceIds: itemSourceIds,
      });
      await postEventTimeline(deps, ev, `artifact-skill-gap:${skillIndex}`, {
        source: artifactSource,
        type: 'skill:gap',
        subject: skill.name ?? 'unknown',
        data: { task_id: taskId, agent_id: agentId, gap: skill.gap, evidence: skill.evidence, source_text_unit_ids: sourceIds, source_ids: itemSourceIds },
        tags: ['skill', 'gap', 'learned-artifact'],
      });
    }
  }
  const skillUsedIds = Array.isArray(artifact.skill_used_ids) ? artifact.skill_used_ids : Array.isArray(artifact.skillUsedIds) ? artifact.skillUsedIds : [];
  const skillHelpfulness = typeof artifact.skill_helpfulness === 'number' ? artifact.skill_helpfulness : typeof artifact.skillHelpfulness === 'number' ? artifact.skillHelpfulness : null;
  if (skillUsedIds.length || skillHelpfulness != null) {
    await postEventTimeline(deps, ev, 'artifact-skill-feedback', {
      source: artifactSource,
      type: 'skill:feedback',
      subject: taskId || agentId || ev.subject || '',
      data: {
        task_id: taskId,
        agent_id: agentId,
        skill_used_ids: skillUsedIds.map(String),
        helpfulness: skillHelpfulness,
        helpful: skillHelpfulness === null ? undefined : skillHelpfulness > 0,
        source_text_unit_ids: sourceIds,
      },
      tags: ['skill', 'feedback', 'learned-artifact'],
    });
  }
  if (Array.isArray(artifact.follow_up_questions) && artifact.follow_up_questions.length) {
    const questions = artifact.follow_up_questions.map((question) => {
      if (typeof question === 'string') return { question, source_ids: artifactItemSourceIds(canonicalSourceIds, artifact, sourceIds) };
      return { ...question, source_ids: artifactItemSourceIds(canonicalSourceIds, question, sourceIds) };
    });
    for (const question of questions) {
      await validateArtifactCitations(deps, ev, {
        taskId,
        agentId,
        itemKind: 'follow_up_question',
        subject: question.question ?? '',
        sourceIds: question.source_ids,
      });
    }
    await postEventTimeline(deps, ev, 'artifact-follow-up-questions', {
      source: artifactSource,
      type: 'brain:follow-up-questions',
      subject: taskId || agentId || ev.subject || '',
      data: { questions, agent_id: agentId, source_text_unit_ids: sourceIds },
      tags: ['brain', 'questions', 'learned-artifact'],
    });
  }
}
