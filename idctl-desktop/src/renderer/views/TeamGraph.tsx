import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { runtimeDisplayLabel } from '../../../../idctl/src/settings/runtimeCatalog.ts';

export interface GraphGroup { team: string; agents: Agent[] }
export interface Hier {
  primary: { team: string; agent: string } | null;
  coordinators: Record<string, string>;
  secondaries?: Array<{ team: string; agent: string; leadsTeams: string[] }>;
}
export interface RelayPolicy { team: string; delegates: string[] | null }
export type GraphSelection =
  | { kind: 'team'; team: string }
  | { kind: 'agent'; team: string; agent: Agent };

const NODE_W = 172;
const NODE_H = 46;
const NODE_GAP = 12;
const MEMBER_COL_GAP = 14;
const CLUSTER_W = NODE_W * 2 + MEMBER_COL_GAP + 28;
const CLUSTER_GAP_X = 24;
const CLUSTER_GAP_Y = 32;
const CLUSTER_PAD = 14;
const TEAM_HEADER_H = 28;
const LEAD_TO_MEMBER_GAP = 34;
const PAD = 24;
const MIN_CANVAS_W = 720;

type Point = { x: number; y: number };
type Placed = {
  key: string;
  sel: GraphSelection;
  agent: Agent;
  team: string;
  x: number;
  y: number;
  title: string;
  sub: string;
  role: 'primary' | 'secondary' | 'lead' | 'worker';
};
type TeamBox = {
  team: string;
  x: number;
  y: number;
  width: number;
  height: number;
  running: number;
  total: number;
  note?: string;
  relay?: string;
  primary?: boolean;
};
type Edge = { from: Point; to: Point; kind: 'hierarchy' | 'validation' | 'member' | 'relay' | 'relay-mesh' };
type Layout = {
  nodes: Placed[];
  boxes: TeamBox[];
  edges: Edge[];
  width: number;
  height: number;
  delegationHub?: Point;
  validationHub?: Point;
  relayHub?: Point;
  relayHubCount: number;
};

function up(agent: Agent): boolean {
  return /running|online|ready|healthy/i.test(`${agent.status ?? ''} ${agent.health ?? ''}`);
}
function statusColor(agent: Agent): string {
  if (up(agent)) return 'var(--ok)';
  if (/start|pending|register|build/i.test(agent.status ?? '')) return 'var(--warn)';
  return 'var(--err)';
}
function runtimeShort(runtime?: string): string {
  return runtimeDisplayLabel(runtime ?? '?');
}
function topCenter(node: Placed): Point {
  return { x: node.x + NODE_W / 2, y: node.y };
}
function bottomCenter(node: Placed): Point {
  return { x: node.x + NODE_W / 2, y: node.y + NODE_H };
}
function nodeKey(team: string, agent: string): string {
  return `agent:${team}:${agent}`;
}
function configuredCoordinator(hier: Hier, team: string): string {
  return hier.coordinators[team] || (hier.primary?.team === team ? hier.primary.agent : '');
}
function teamClusterHeight(workerCount: number): number {
  const rows = Math.max(1, Math.ceil(workerCount / 2));
  return TEAM_HEADER_H + NODE_H + LEAD_TO_MEMBER_GAP + rows * NODE_H + Math.max(0, rows - 1) * NODE_GAP + CLUSTER_PAD;
}
function relayLabel(delegates: string[] | null | undefined): string {
  if (delegates === undefined) return 'relay unknown';
  if (delegates === null || delegates.includes('*')) return 'relay any';
  if (delegates.length === 0) return 'relay blocked';
  return `relay ${delegates.length}`;
}
function edgePath(edge: Edge): string {
  if (edge.kind === 'member') {
    const midY = edge.from.y + Math.max(16, (edge.to.y - edge.from.y) / 2);
    return `M ${edge.from.x} ${edge.from.y} C ${edge.from.x} ${midY}, ${edge.to.x} ${midY}, ${edge.to.x} ${edge.to.y}`;
  }
  if (edge.kind === 'relay') {
    const bend = Math.max(44, Math.abs(edge.to.x - edge.from.x) * 0.18);
    const direction = edge.to.x >= edge.from.x ? 1 : -1;
    return `M ${edge.from.x} ${edge.from.y} C ${edge.from.x + bend * direction} ${edge.from.y - 34}, ${edge.to.x - bend * direction} ${edge.to.y - 34}, ${edge.to.x} ${edge.to.y}`;
  }
  const midY = edge.from.y + (edge.to.y - edge.from.y) / 2;
  return `M ${edge.from.x} ${edge.from.y} C ${edge.from.x} ${midY}, ${edge.to.x} ${midY}, ${edge.to.x} ${edge.to.y}`;
}

/**
 * Responsive top-down organization chart. The configured fleet primary delegates
 * objectives directly to team coordinators, coordinators delegate to their workers,
 * and completed work returns through protected validators to the primary. Persisted
 * cross-team messaging policies remain available as a separate selected-team trace.
 */
export const TeamGraph = memo(function TeamGraph({
  groups,
  hier,
  relays = [],
  leadOf,
  selectedKey,
  onSelect,
}: {
  groups: GraphGroup[];
  hier: Hier;
  relays?: RelayPolicy[];
  leadOf: (team: string, agents: Agent[]) => string | undefined;
  selectedKey: string | null;
  onSelect: (selection: GraphSelection) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(1200);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setFrameWidth((current) => {
      const next = Math.max(MIN_CANVAS_W, Math.floor(frame.clientWidth || current));
      return Math.abs(next - current) > 2 ? next : current;
    });
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(frame);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const topologyKey = useMemo(() => JSON.stringify({
    teams: groups.map((group) => [group.team, group.agents.map((agent) => agent.name).sort()]).sort(),
    primary: hier.primary,
    coordinators: Object.entries(hier.coordinators).sort(),
    secondaries: (hier.secondaries ?? []).map((row) => [row.team, row.agent, [...row.leadsTeams].sort()]).sort(),
  }), [groups, hier]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const reset = () => frame.scrollTo({ top: 0, left: 0 });
    reset();
    const frameId = window.requestAnimationFrame(reset);
    return () => window.cancelAnimationFrame(frameId);
  }, [frameWidth, topologyKey]);

  const layout = useMemo<Layout | null>(() => {
    if (!groups.length) return null;
    const width = Math.max(MIN_CANVAS_W, frameWidth);
    const groupByTeam = new Map(groups.map((group) => [group.team, group]));
    const requestedPrimaryTeam = hier.primary?.team || groups.find((group) => group.team === 'default')?.team || groups[0].team;
    const primaryGroup = groupByTeam.get(requestedPrimaryTeam) ?? groups[0];
    const configuredPrimaryName = hier.primary?.team === primaryGroup.team ? hier.primary.agent : configuredCoordinator(hier, primaryGroup.team);
    const inferredPrimaryName = configuredPrimaryName || leadOf(primaryGroup.team, primaryGroup.agents);
    const primary = primaryGroup.agents.find((agent) => agent.name === inferredPrimaryName) ?? primaryGroup.agents[0];
    const secondaryKeys = new Set((hier.secondaries ?? []).map((row) => nodeKey(row.team, row.agent)));
    const relayByTeam = new Map(relays.map((policy) => [policy.team, policy.delegates]));
    const nodes: Placed[] = [];
    const boxes: TeamBox[] = [];
    const edges: Edge[] = [];
    const nodeByKey = new Map<string, Placed>();
    const leadByTeam = new Map<string, Placed>();

    const rootY = 42;
    let leadershipBottom = rootY;
    if (primary) {
      const primaryIsConfigured = Boolean(configuredPrimaryName && primary.name === configuredPrimaryName);
      const root: Placed = {
        key: nodeKey(primaryGroup.team, primary.name),
        sel: { kind: 'agent', team: primaryGroup.team, agent: primary },
        agent: primary,
        team: primaryGroup.team,
        x: width / 2 - NODE_W / 2,
        y: rootY,
        title: primary.name,
        sub: `${primaryIsConfigured ? 'fleet primary' : 'inferred primary'} · ${up(primary) ? 'live' : primary.status || 'offline'}`,
        role: 'primary',
      };
      nodes.push(root);
      nodeByKey.set(root.key, root);
      leadByTeam.set(primaryGroup.team, root);

      const rootMembers = primaryGroup.agents.filter((agent) => agent.name !== primary.name);
      const maxRootCols = Math.max(1, Math.floor((width - PAD * 4) / (NODE_W + NODE_GAP)));
      const rootCols = Math.max(1, Math.min(rootMembers.length || 1, maxRootCols));
      const rootRows = Math.ceil(rootMembers.length / rootCols);
      const membersY = rootY + NODE_H + 58;
      rootMembers.forEach((agent, index) => {
        const row = Math.floor(index / rootCols);
        const col = index % rootCols;
        const countInRow = Math.min(rootCols, rootMembers.length - row * rootCols);
        const rowWidth = countInRow * NODE_W + Math.max(0, countInRow - 1) * NODE_GAP;
        const x = width / 2 - rowWidth / 2 + col * (NODE_W + NODE_GAP);
        const key = nodeKey(primaryGroup.team, agent.name);
        const isSecondary = secondaryKeys.has(key);
        const placed: Placed = {
          key,
          sel: { kind: 'agent', team: primaryGroup.team, agent },
          agent,
          team: primaryGroup.team,
          x,
          y: membersY + row * (NODE_H + NODE_GAP),
          title: agent.name,
          sub: isSecondary
            ? `validator · ${(hier.secondaries ?? []).find((entry) => nodeKey(entry.team, entry.agent) === key)?.leadsTeams.length ?? 0} teams`
            : `${up(agent) ? 'live' : 'offline'} · ${runtimeShort(agent.runtime)}`,
          role: isSecondary ? 'secondary' : 'worker',
        };
        nodes.push(placed);
        nodeByKey.set(key, placed);
        if (!isSecondary) edges.push({ from: bottomCenter(root), to: topCenter(placed), kind: 'member' });
      });
      leadershipBottom = rootMembers.length
        ? membersY + rootRows * NODE_H + Math.max(0, rootRows - 1) * NODE_GAP
        : rootY + NODE_H;
      boxes.push({
        team: primaryGroup.team,
        x: PAD,
        y: 12,
        width: width - PAD * 2,
        height: leadershipBottom + 18,
        running: primaryGroup.agents.filter(up).length,
        total: primaryGroup.agents.length,
        primary: true,
        relay: relayLabel(relayByTeam.get(primaryGroup.team)),
        note: configuredPrimaryName && !primaryGroup.agents.some((agent) => agent.name === configuredPrimaryName)
          ? `${configuredPrimaryName} missing`
          : undefined,
      });
    } else {
      boxes.push({
        team: primaryGroup.team,
        x: PAD,
        y: 12,
        width: width - PAD * 2,
        height: 74,
        running: 0,
        total: 0,
        primary: true,
        relay: relayLabel(relayByTeam.get(primaryGroup.team)),
        note: 'primary not assigned',
      });
      leadershipBottom = 86;
    }

    const teamGroups = groups
      .filter((group) => group.team !== primaryGroup.team)
      .sort((a, b) => a.team.localeCompare(b.team));
    const columns = Math.max(1, Math.min(4, Math.floor((width - PAD * 2 + CLUSTER_GAP_X) / (CLUSTER_W + CLUSTER_GAP_X))));
    const gridWidth = columns * CLUSTER_W + Math.max(0, columns - 1) * CLUSTER_GAP_X;
    const gridX = Math.max(PAD, (width - gridWidth) / 2);
    const gridY = leadershipBottom + 112;
    const rowHeights: number[] = [];
    teamGroups.forEach((group, index) => {
      const configuredName = configuredCoordinator(hier, group.team);
      const leadName = configuredName || leadOf(group.team, group.agents) || '';
      const lead = group.agents.find((agent) => agent.name === leadName);
      const workerCount = group.agents.filter((agent) => !lead || agent.name !== lead.name).length;
      const row = Math.floor(index / columns);
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, teamClusterHeight(workerCount));
    });
    const rowOffsets: number[] = [];
    rowHeights.forEach((height, row) => {
      rowOffsets[row] = row === 0 ? gridY : rowOffsets[row - 1] + rowHeights[row - 1] + CLUSTER_GAP_Y;
    });

    teamGroups.forEach((group, index) => {
      const row = Math.floor(index / columns);
      const col = index % columns;
      const boxX = gridX + col * (CLUSTER_W + CLUSTER_GAP_X);
      const boxY = rowOffsets[row];
      const configuredName = configuredCoordinator(hier, group.team);
      const fallbackName = leadOf(group.team, group.agents) || '';
      const leadName = configuredName || fallbackName;
      const lead = group.agents.find((agent) => agent.name === leadName);
      const workers = group.agents.filter((agent) => !lead || agent.name !== lead.name);
      const note = configuredName && !lead
        ? `${configuredName} missing`
        : !configuredName
          ? lead ? `${lead.name} inferred` : 'coordinator unassigned'
          : undefined;
      boxes.push({
        team: group.team,
        x: boxX,
        y: boxY,
        width: CLUSTER_W,
        height: teamClusterHeight(workers.length),
        running: group.agents.filter(up).length,
        total: group.agents.length,
        relay: relayLabel(relayByTeam.get(group.team)),
        note,
      });
      let placedLead: Placed | undefined;
      if (lead) {
        placedLead = {
          key: nodeKey(group.team, lead.name),
          sel: { kind: 'agent', team: group.team, agent: lead },
          agent: lead,
          team: group.team,
          x: boxX + CLUSTER_W / 2 - NODE_W / 2,
          y: boxY + TEAM_HEADER_H + 8,
          title: lead.name,
          sub: `${configuredName ? 'team coordinator' : 'inferred coordinator'} · ${up(lead) ? 'live' : lead.status || 'offline'}`,
          role: 'lead',
        };
        nodes.push(placedLead);
        nodeByKey.set(placedLead.key, placedLead);
        leadByTeam.set(group.team, placedLead);
      }
      const workerY = boxY + TEAM_HEADER_H + 8 + NODE_H + LEAD_TO_MEMBER_GAP;
      workers.forEach((agent, workerIndex) => {
        const workerRow = Math.floor(workerIndex / 2);
        const workerCol = workerIndex % 2;
        const key = nodeKey(group.team, agent.name);
        const isSecondary = secondaryKeys.has(key);
        const placed: Placed = {
          key,
          sel: { kind: 'agent', team: group.team, agent },
          agent,
          team: group.team,
          x: boxX + CLUSTER_PAD + workerCol * (NODE_W + MEMBER_COL_GAP),
          y: workerY + workerRow * (NODE_H + NODE_GAP),
          title: agent.name,
          sub: isSecondary ? 'secondary lead' : `${up(agent) ? 'live' : 'offline'} · ${runtimeShort(agent.runtime)}`,
          role: isSecondary ? 'secondary' : 'worker',
        };
        nodes.push(placed);
        nodeByKey.set(key, placed);
        if (placedLead) edges.push({ from: bottomCenter(placedLead), to: topCenter(placed), kind: 'member' });
      });
    });

    const primaryNode = primary ? nodeByKey.get(nodeKey(primaryGroup.team, primary.name)) : undefined;
    const delegationHub: Point = { x: width / 2 - 120, y: leadershipBottom + 68 };
    const validationHub: Point = { x: width / 2 + 120, y: leadershipBottom + 68 };
    const validatorsByKey = new Map<string, Placed>();
    const routedTeamLeads: Placed[] = [];
    for (const group of teamGroups) {
      const teamLead = leadByTeam.get(group.team);
      if (!teamLead || !primaryNode) continue;
      routedTeamLeads.push(teamLead);
      const validators = (hier.secondaries ?? [])
        .filter((secondary) => secondary.leadsTeams.includes(group.team))
        .map((secondary) => nodeByKey.get(nodeKey(secondary.team, secondary.agent)))
        .filter((node): node is Placed => Boolean(node));
      if (validators.length) edges.push({ from: topCenter(teamLead), to: validationHub, kind: 'validation' });
      validators.forEach((validator) => {
        validatorsByKey.set(validator.key, validator);
      });
    }
    if (primaryNode && routedTeamLeads.length) {
      edges.push({ from: bottomCenter(primaryNode), to: delegationHub, kind: 'hierarchy' });
      routedTeamLeads.forEach((teamLead) => {
        edges.push({ from: delegationHub, to: topCenter(teamLead), kind: 'hierarchy' });
      });
    }
    validatorsByKey.forEach((validator) => {
      edges.push({ from: validationHub, to: bottomCenter(validator), kind: 'validation' });
      if (primaryNode) edges.push({ from: topCenter(validator), to: bottomCenter(primaryNode), kind: 'validation' });
    });

    const relayHub: Point = { x: width / 2, y: leadershipBottom + 68 };
    const relayHubCount = relays.filter((policy) => policy.delegates === null || policy.delegates.includes('*') || policy.delegates.length > 0).length;
    const selectedTeam = selectedKey?.startsWith('team:')
      ? selectedKey.slice('team:'.length)
      : selectedKey?.startsWith('agent:')
        ? selectedKey.slice('agent:'.length).split(':')[0]
        : '';
    for (const policy of relays.filter((entry) => entry.team === selectedTeam)) {
      const source = leadByTeam.get(policy.team);
      if (!source || Array.isArray(policy.delegates) && policy.delegates.length === 0) continue;
      if (policy.delegates === null || policy.delegates.includes('*')) {
        edges.push({ from: topCenter(source), to: relayHub, kind: 'relay-mesh' });
        continue;
      }
      for (const targetTeam of policy.delegates) {
        const target = leadByTeam.get(targetTeam);
        if (!target || target.key === source.key) continue;
        edges.push({ from: topCenter(source), to: topCenter(target), kind: 'relay' });
      }
    }

    const teamGridBottom = teamGroups.length
      ? rowOffsets[rowOffsets.length - 1] + rowHeights[rowHeights.length - 1]
      : leadershipBottom;
    return {
      nodes,
      boxes,
      edges,
      width,
      height: teamGridBottom + PAD,
      delegationHub: routedTeamLeads.length ? delegationHub : undefined,
      validationHub: validatorsByKey.size ? validationHub : undefined,
      relayHub: relayHubCount ? relayHub : undefined,
      relayHubCount,
    };
  }, [frameWidth, groups, hier, leadOf, relays, selectedKey]);

  if (!layout) return <div className="muted center pad">No teams yet — build a team to see its structure here.</div>;

  function nodeFill(node: Placed): string {
    if (node.key === selectedKey) return 'var(--bg-3)';
    return node.role === 'worker' ? 'var(--bg)' : 'var(--bg-2)';
  }

  return (
    <div ref={frameRef} style={{ position: 'relative', overflow: 'auto', overflowAnchor: 'none', maxHeight: '68vh', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--bg)' }}>
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ display: 'block', minWidth: '100%' }}>
        <defs>
          <marker id="team-graph-report-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
          </marker>
          <marker id="team-graph-relay-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ok)" />
          </marker>
        </defs>

        {layout.boxes.map((box) => {
          const selected = selectedKey === `team:${box.team}`;
          return (
            <g key={`box:${box.team}`}>
              <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={6}
                fill={box.primary ? 'var(--bg-2)' : 'transparent'} stroke={selected ? 'var(--accent)' : 'var(--line)'} strokeWidth={selected ? 2 : 1} opacity={box.primary ? 0.72 : 1} />
              <text x={box.x + 12} y={box.y + 19} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, fill: selected ? 'var(--accent)' : 'var(--muted)' }}
                onClick={() => onSelect({ kind: 'team', team: box.team })}>
                {box.primary ? '★ ' : ''}{box.team} · {box.running}/{box.total}
              </text>
              <text x={box.x + box.width - 12} y={box.y + 19} textAnchor="end" style={{ fontSize: 10, fill: box.note ? 'var(--warn)' : box.relay === 'relay blocked' ? 'var(--err)' : 'var(--muted)' }}>
                {box.note || box.relay}
              </text>
            </g>
          );
        })}

        {layout.edges.filter((edge) => edge.kind === 'hierarchy' || edge.kind === 'validation' || edge.kind === 'member').map((edge, index) => {
          const validation = edge.kind === 'validation';
          return <path key={`org:${index}`} d={edgePath(edge)} fill="none"
            stroke={validation ? 'var(--ok)' : 'var(--accent)'}
            strokeWidth={edge.kind === 'member' ? 1.2 : 1.5}
            strokeDasharray={validation ? '4 3' : undefined}
            markerEnd={validation ? 'url(#team-graph-relay-arrow)' : 'url(#team-graph-report-arrow)'}
            opacity={edge.kind === 'member' ? 0.75 : 0.62} />;
        })}

        {layout.edges.filter((edge) => edge.kind === 'relay' || edge.kind === 'relay-mesh').map((edge, index) => (
          <path key={`relay:${index}`} d={edgePath(edge)} fill="none" stroke="var(--ok)" strokeWidth={1.15}
            strokeDasharray={edge.kind === 'relay-mesh' ? '2 5' : '5 4'} markerEnd="url(#team-graph-relay-arrow)" opacity={0.48} />
        ))}
        {layout.relayHub ? (
          <g>
            <rect x={layout.relayHub.x - 52} y={layout.relayHub.y - 13} width={104} height={26} rx={6} fill="var(--bg-2)" stroke="var(--ok)" opacity={0.94} />
            <text x={layout.relayHub.x} y={layout.relayHub.y + 4} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: 'var(--ok)' }}>
              relay routes · {layout.relayHubCount}
            </text>
          </g>
        ) : null}
        {layout.delegationHub ? (
          <g>
            <rect x={layout.delegationHub.x - 48} y={layout.delegationHub.y - 13} width={96} height={26} rx={6} fill="var(--bg-2)" stroke="var(--accent)" opacity={0.96} />
            <text x={layout.delegationHub.x} y={layout.delegationHub.y + 4} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: 'var(--accent)' }}>
              objectives
            </text>
          </g>
        ) : null}
        {layout.validationHub ? (
          <g>
            <rect x={layout.validationHub.x - 54} y={layout.validationHub.y - 13} width={108} height={26} rx={6} fill="var(--bg-2)" stroke="var(--ok)" opacity={0.96} />
            <text x={layout.validationHub.x} y={layout.validationHub.y + 4} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: 'var(--ok)' }}>
              completed work
            </text>
          </g>
        ) : null}

        {layout.nodes.map((node) => {
          const selected = node.key === selectedKey;
          return (
            <g key={node.key} style={{ cursor: 'pointer' }} onClick={() => onSelect(node.sel)}>
              <rect x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={6}
                fill={nodeFill(node)} stroke={selected ? 'var(--accent)' : node.role === 'primary' ? 'var(--accent)' : 'var(--line)'} strokeWidth={selected ? 2 : 1} />
              <circle cx={node.x + 14} cy={node.y + NODE_H / 2} r={4} fill={statusColor(node.agent)} />
              <text x={node.x + 26} y={node.y + 19} style={{ fontSize: 13, fontWeight: node.role === 'worker' ? 500 : 700, fill: 'var(--text)' }}>
                {node.role === 'primary' ? '★ ' : node.role === 'secondary' ? '◆ ' : ''}{node.title.length > 18 ? `${node.title.slice(0, 17)}…` : node.title}
              </text>
              <text x={node.x + 26} y={node.y + 34} style={{ fontSize: 10, fill: 'var(--muted)' }}>
                {node.sub.length > 25 ? `${node.sub.slice(0, 24)}…` : node.sub}
              </text>
            </g>
          );
        })}

        <g transform={`translate(${PAD}, ${layout.height - 12})`}>
          <text x={0} y={0} style={{ fontSize: 10, fill: 'var(--accent)' }}>blue arrow · objective delegation</text>
          <text x={180} y={0} style={{ fontSize: 10, fill: 'var(--ok)' }}>green dashed arrow · completed work / validated return</text>
          <text x={480} y={0} style={{ fontSize: 10, fill: 'var(--ok)' }}>green dotted · selected relay policy</text>
        </g>
      </svg>
    </div>
  );
});
