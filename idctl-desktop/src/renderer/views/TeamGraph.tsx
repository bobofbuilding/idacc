import { memo, useMemo } from 'react';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { runtimeDisplayLabel } from '../../../../idctl/src/settings/runtimeCatalog.ts';

export interface GraphGroup { team: string; agents: Agent[] }
export interface Hier { primary: { team: string; agent: string } | null; coordinators: Record<string, string> }
export type GraphSelection =
  | { kind: 'team'; team: string }
  | { kind: 'agent'; team: string; agent: Agent };

const NODE_W = 168;
const NODE_H = 46;
const COL_GAP = 30;
const LEVEL_GAP = 50;
const ROW_GAP = 16;
const PAD = 20;
const TITLE_H = 26;

type Placed = {
  key: string;
  sel: GraphSelection;
  agent: Agent;
  x: number;
  y: number;
  title: string;
  sub: string;
  role: 'primary' | 'lead' | 'worker';
};

type Layout = {
  primaryTeam?: string;
  teams: GraphGroup[];
  nodes: Placed[];
  edges: { x1: number; y1: number; x2: number; y2: number }[];
  hierArcs: { from: { team: string; x: number; y: number }; to: { team: string; x: number; y: number } }[];
  width: number;
  height: number;
};

/** Is this agent live? Mirrors the Health view's isUp(). */
function up(a: Agent): boolean {
  return /running|online|ready|healthy/i.test(`${a.status ?? ''} ${a.health ?? ''}`);
}
function statusColor(a: Agent): string {
  if (up(a)) return 'var(--ok)';
  if (/start|pending|register|build/i.test(a.status ?? '')) return 'var(--warn)';
  return 'var(--err)';
}
function runtimeShort(r?: string): string {
  return runtimeDisplayLabel(r ?? '?');
}

/**
 * Live, interactive visual of the fleet's structure: one column per team, the
 * team's lead on top (⭑ when it's the primary cross-team coordinator) and its
 * workers below. Click any node (or a team title) to select it — the parent opens
 * an inline editor for goals, instructions, runtime, and routing. Pure layout.
 */
export const TeamGraph = memo(function TeamGraph({
  groups,
  hier,
  leadOf,
  selectedKey,
  onSelect,
}: {
  groups: GraphGroup[];
  hier: Hier;
  /** Resolve a team's lead/coordinator agent name from its roster. */
  leadOf: (team: string, agents: Agent[]) => string | undefined;
  selectedKey: string | null;
  onSelect: (sel: GraphSelection) => void;
}) {
  const layout = useMemo<Layout | null>(() => {
    // Primary team's column first — the org's top lead reads left-to-right, then the rest.
    // Keep empty/offline teams visible so HR can inspect structure even before agents run.
    const primaryTeam = hier.primary?.team;
    const teams = [...groups]
      .sort((a, b) => (a.team === primaryTeam ? -1 : b.team === primaryTeam ? 1 : a.team.localeCompare(b.team)));
    if (teams.length === 0) return null;

    // Headroom above the lead row for the cross-team hierarchy arcs (primary → each team lead).
    const HIER_HEADROOM = hier.primary && teams.length > 1 ? 34 : 0;
    const leadY = PAD + TITLE_H + HIER_HEADROOM;
    const workerY0 = leadY + NODE_H + LEVEL_GAP;
    const primaryKey = hier.primary ? `agent:${hier.primary.team}:${hier.primary.agent}` : null;

    const nodes: Placed[] = [];
    const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const leadCenters: { team: string; x: number; y: number }[] = []; // for the hierarchy arcs

    let maxWorkers = 0;
    teams.forEach((g, i) => {
      const colX = PAD + i * (NODE_W + COL_GAP);
      const cx = colX + NODE_W / 2;
      const leadName = leadOf(g.team, g.agents);
      const lead = g.agents.find((a) => a.name === leadName) ?? g.agents[0];
      if (!lead) return;
      const leadKey = `agent:${g.team}:${lead.name}`;
      const isPrimary = leadKey === primaryKey;
      leadCenters.push({ team: g.team, x: cx, y: leadY });
      const liveWorkers = g.agents.filter((a) => a.name !== lead.name && up(a)).length;
      nodes.push({
        key: leadKey, sel: { kind: 'agent', team: g.team, agent: lead }, agent: lead,
        x: colX, y: leadY, title: lead.name,
        sub: `${isPrimary ? 'primary · ' : ''}lead · ${liveWorkers}/${g.agents.length - 1} live`,
        role: isPrimary ? 'primary' : 'lead',
      });
      const workers = g.agents.filter((a) => a.name !== lead.name);
      maxWorkers = Math.max(maxWorkers, workers.length);
      workers.forEach((w, j) => {
        const wy = workerY0 + j * (NODE_H + ROW_GAP);
        nodes.push({
          key: `agent:${g.team}:${w.name}`, sel: { kind: 'agent', team: g.team, agent: w }, agent: w,
          x: colX, y: wy, title: w.name, sub: `${up(w) ? '● ' : '○ '}${runtimeShort(w.runtime)}`, role: 'worker',
        });
        edges.push({ x1: cx, y1: leadY + NODE_H, x2: cx, y2: wy });
      });
    });
    // Cross-team hierarchy: the primary lead coordinates every other team's lead.
    const primaryCenter = primaryTeam ? leadCenters.find((c) => c.team === primaryTeam) : undefined;
    const hierArcs = primaryCenter
      ? leadCenters.filter((c) => c.team !== primaryTeam).map((c) => ({ from: primaryCenter, to: c }))
      : [];

    const width = PAD * 2 + teams.length * NODE_W + (teams.length - 1) * COL_GAP;
    const height = (maxWorkers > 0 ? workerY0 + maxWorkers * (NODE_H + ROW_GAP) - ROW_GAP : leadY + NODE_H) + PAD;

    return { primaryTeam, teams, nodes, edges, hierArcs, width, height };
  }, [groups, hier, leadOf]);

  if (!layout) {
    return <div className="muted center pad">No teams yet — build a team to see its structure here.</div>;
  }
  const { primaryTeam, teams, nodes, edges, hierArcs, width, height } = layout;

  function nodeFill(n: Placed): string {
    if (n.key === selectedKey) return 'var(--bg-3)';
    return n.role === 'worker' ? 'var(--bg)' : 'var(--bg-2)';
  }

  return (
    <div style={{ overflow: 'auto', maxHeight: '60vh', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--bg)' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', minWidth: '100%' }}>
        {/* cross-team hierarchy: the ⭑ primary lead coordinates every other team's lead */}
        {hierArcs.map((a, i) => {
          const peakY = PAD + TITLE_H - 4;
          return (
            <path key={`h${i}`} d={`M ${a.from.x} ${a.from.y} C ${a.from.x} ${peakY}, ${a.to.x} ${peakY}, ${a.to.x} ${a.to.y}`}
              fill="none" stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="3 3" opacity={0.55} />
          );
        })}
        {/* team titles (clickable → select team) — live running/total */}
        {teams.map((g, i) => {
          const colX = PAD + i * (NODE_W + COL_GAP);
          const isSel = selectedKey === `team:${g.team}`;
          const running = g.agents.filter(up).length;
          return (
            <text
              key={`t:${g.team}`} x={colX + NODE_W / 2} y={PAD + 14}
              textAnchor="middle" style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, fill: isSel ? 'var(--accent)' : 'var(--muted)' }}
              onClick={() => onSelect({ kind: 'team', team: g.team })}
            >
              {g.team === primaryTeam ? '⭑ ' : ''}{g.team} · {running}/{g.agents.length}
            </text>
          );
        })}
        {/* lead → worker edges */}
        {edges.map((e, i) => (
          <path key={`e${i}`} d={`M ${e.x1} ${e.y1} C ${e.x1} ${(e.y1 + e.y2) / 2}, ${e.x2} ${(e.y1 + e.y2) / 2}, ${e.x2} ${e.y2}`}
            fill="none" stroke="var(--line)" strokeWidth={1.5} />
        ))}
        {/* nodes */}
        {nodes.map((n) => {
          const sel = n.key === selectedKey;
          return (
            <g key={n.key} style={{ cursor: 'pointer' }} onClick={() => onSelect(n.sel)}>
              <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={9}
                fill={nodeFill(n)} stroke={sel ? 'var(--accent)' : 'var(--line)'} strokeWidth={sel ? 2 : 1} />
              <circle cx={n.x + 14} cy={n.y + NODE_H / 2} r={4} fill={statusColor(n.agent)} />
              <text x={n.x + 26} y={n.y + 19} style={{ fontSize: 13, fontWeight: n.role === 'worker' ? 500 : 700, fill: 'var(--text)' }}>
                {n.role === 'primary' ? '⭑ ' : ''}{n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title}
              </text>
              <text x={n.x + 26} y={n.y + 34} style={{ fontSize: 10, fill: 'var(--muted)' }}>
                {n.sub.length > 22 ? n.sub.slice(0, 21) + '…' : n.sub}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
});
