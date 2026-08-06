import * as z from 'zod/v4';

function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: payload.ok === false,
  };
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => textResult(await handler(args)));
}

export const BRAIN_MCP_TOOL_NAMES = [
  'brain_read_node',
  'brain_read_facts',
  'brain_read_timeline_slice',
  'brain_search_context_local',
  'brain_get_safety_report',
  'brain_submit_feedback_missing',
  'brain_create_approval_request',
];

export function registerBrainMcpTools(server, { client }) {
  registerTool(server, 'brain_read_node', {
    title: 'Read Brain Node',
    description: 'Read one graph node by numeric id from the Brain graph.',
    inputSchema: {
      node_id: z.number().int().positive().describe('Numeric graph node id'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, ({ node_id }) => client.get(`/graph/nodes/${node_id}`, undefined, 'brain_read_node'));

  registerTool(server, 'brain_read_facts', {
    title: 'Read Entity Facts',
    description: 'Read active facts and contradictions for one entity id.',
    inputSchema: {
      entity_id: z.string().min(1).describe('Stable entity id'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, ({ entity_id }) => client.get(`/entities/${encodeURIComponent(entity_id)}/facts`, undefined, 'brain_read_facts'));

  registerTool(server, 'brain_read_timeline_slice', {
    title: 'Read Timeline Slice',
    description: 'Read a filtered slice of the Brain timeline.',
    inputSchema: {
      source: z.string().optional().describe('Optional event source filter'),
      type: z.string().optional().describe('Optional event type filter'),
      since: z.number().int().nonnegative().optional().describe('Unix timestamp lower bound'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum events to return'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, ({ source, type, since, limit }) => client.get('/timeline', { source, type, since, limit }, 'brain_read_timeline_slice'));

  registerTool(server, 'brain_search_context_local', {
    title: 'Search Local Context',
    description: 'Run local Brain retrieval over entities, facts, text units, and evidence edges.',
    inputSchema: {
      q: z.string().min(1).describe('Query text'),
      entity_id: z.string().optional().describe('Optional entity scope'),
      limit: z.number().int().min(1).max(20).optional().describe('Max records per class'),
      include_vectors: z.boolean().optional().describe('Enable vector retrieval when configured'),
      vector_limit: z.number().int().min(1).max(20).optional().describe('Max vector hits'),
      vector_max_age_days: z.number().int().min(1).max(3650).optional().describe('Max vector source age in days'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, ({ q, entity_id, limit, include_vectors, vector_limit, vector_max_age_days }) => client.post('/query/local', {
    q,
    entity_id,
    limit,
    include_vectors,
    vector_limit,
    vector_max_age_days,
  }, 'brain_search_context_local'));

  registerTool(server, 'brain_get_safety_report', {
    title: 'Get Safety Report',
    description: 'Read the evidence-backed safety report for one graph node.',
    inputSchema: {
      node_id: z.number().int().positive().describe('Numeric graph node id'),
      tests_passed: z.number().int().nonnegative().optional().describe('Optional extra passing tests to fold into the report'),
      tests_failed: z.number().int().nonnegative().optional().describe('Optional extra failing tests to fold into the report'),
      rating: z.number().min(0).max(5).optional().describe('Optional manual rating signal'),
      critical_flags: z.number().int().nonnegative().optional().describe('Optional manual critical-flag count'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, ({ node_id, tests_passed, tests_failed, rating, critical_flags }) => client.get(`/graph/nodes/${node_id}/safety-report`, {
    tests_passed,
    tests_failed,
    rating,
    critical_flags,
  }, 'brain_get_safety_report'));

  registerTool(server, 'brain_submit_feedback_missing', {
    title: 'Submit Missing Context Feedback',
    description: 'Record that previously volunteered context was insufficient for a task.',
    inputSchema: {
      task_id: z.string().min(1).describe('Task id with existing volunteered context'),
      agent_id: z.string().min(1).describe('Agent reporting the missing context'),
      query_text: z.string().min(1).describe('What context was still needed'),
      query_id: z.string().optional().describe('Optional upstream query id'),
      volunteered_source_ids: z.array(z.string()).optional().describe('Optional explicit source ids'),
      source: z.string().optional().describe('Optional event source label'),
      metadata: z.record(z.string(), z.any()).optional().describe('Optional extra metadata'),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, ({ task_id, agent_id, query_text, query_id, volunteered_source_ids, source, metadata }) => client.post('/context/feedback-missing', {
    task_id,
    agent_id,
    query_text,
    query_id,
    volunteered_source_ids,
    source,
    metadata,
  }, 'brain_submit_feedback_missing'));

  registerTool(server, 'brain_create_approval_request', {
    title: 'Create Approval Request',
    description: 'Create a non-destructive approval request in the Brain queue.',
    inputSchema: {
      kind: z.string().min(1).describe('Approval kind'),
      subject: z.string().optional().describe('Approval subject'),
      payload: z.record(z.string(), z.any()).optional().describe('Approval payload'),
      risk_level: z.enum(['low', 'medium', 'high']).optional().describe('Risk level'),
      requested_by: z.string().optional().describe('Requester id'),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  }, ({ kind, subject, payload, risk_level, requested_by }) => client.post('/approvals', {
    kind,
    subject,
    payload,
    risk_level,
    requested_by,
  }, 'brain_create_approval_request'));
}
