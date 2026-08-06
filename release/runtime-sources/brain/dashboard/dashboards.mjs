// Operator-only HTML dashboard (served from brain :4200/dashboard).
// Plain HTML+JS — no build step, no framework. Polls /fleet-report every 10s.
export const DASHBOARD_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Brain Fleet · Read Only</title>
<style>
  body { font: 13px/1.4 -apple-system, monospace; max-width: 900px; margin: 1em auto; padding: 0 1em; color: #d4d4d4; background: #111; }
  h1 { font-size: 18px; margin: 0 0 0.5em; }
  h2 { font-size: 14px; margin: 1.4em 0 0.4em; color: #88c; }
  table { border-collapse: collapse; width: 100%; margin: 0.3em 0; }
  td, th { padding: 3px 8px; border-bottom: 1px solid #333; text-align: left; }
  .green { color: #5dd55d; } .red { color: #f55; } .yellow { color: #ec9; }
  .small { font-size: 11px; color: #777; }
  pre { background: #1a1a1a; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .pill.ok { background: #2a4; } .pill.bad { background: #a33; }
  .notice { border: 1px solid #4a3; background: #18170f; padding: 7px 9px; border-radius: 4px; margin: 0.7em 0; }
  .notice.bad { border-color: #833; background: #1b1111; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 0.6em 0; }
  .summary-card { border: 1px solid #333; border-radius: 5px; padding: 8px 10px; background: #151515; min-width: 0; }
  .summary-card b { display: block; font-size: 18px; margin: 2px 0; overflow-wrap: anywhere; }
  .detailbox { border: 1px solid #333; border-radius: 5px; background: #151515; padding: 7px 9px; margin: 0.6em 0; }
  .detailbox summary { cursor: pointer; color: #aac; font-weight: 700; }
  .detailbox table { margin-top: 0.4em; }
</style>
</head><body>
<h1>Brain Fleet · Read Only <span class="small" id="ts"></span></h1>
<nav class="small" style="margin-bottom:1em">
  <a href="/dashboard" style="color:#88c;margin-right:1em">Fleet</a>
  <a href="/dashboard/health" style="color:#88c;margin-right:1em">Health</a>
  <a href="/dashboard/skills" style="color:#88c;margin-right:1em">Skills</a>
  <a href="/dashboard/learning" style="color:#88c;margin-right:1em">Learning</a>
  <a href="/dashboard/agents" style="color:#88c;margin-right:1em">Agents</a>
  <a href="/dashboard/graph" style="color:#88c">Graph</a>
</nav>
<div id="content">Loading…</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function tick() {
  try {
    const r = await fetch('/fleet-report', { cache: 'no-store' });
    const d = await r.json();
    document.getElementById('ts').textContent = new Date(d.generatedAt).toLocaleTimeString();
    const c = document.getElementById('content');
    const total = d.fleet.total ?? 0;
    const running = d.fleet.running ?? d.fleet.byStatus.running ?? 0;
    const source = d.fleet.source || 'unknown';
    const drift = d.fleet.cacheDrift || {};
    const warnings = d.fleet.warnings || [];
    const idacc = d.fleet.idaccAuthority || {};
    const sync = d.fleet.sync || idacc.sync || {};
    const skillmesh = d.fleet.providers?.skillmesh || d.fleet.skillmesh || {};
    const authority = d.fleet.authority || (source === 'brain-cache' ? 'cache' : source === 'live-manager-partial' ? 'partial' : source === 'live-manager' ? 'live' : 'unknown');
    const authoritative = d.fleet.authoritative === true;
    const cacheOnly = authority === 'cache' || source === 'brain-cache';
    const partial = authority === 'partial' || source === 'live-manager-partial';
    const activeLabel = d.fleet.activeLabel || (cacheOnly ? 'cached agent records (not live status)' : partial ? 'known agents active (partial manager snapshot)' : 'agents active');
    const fleetCountText = cacheOnly ? total + ' cached agent records' : running + '/' + total;
    const statusAuthority = d.fleet.statusAuthorityLabel || (authoritative ? 'Live manager current-state snapshot' : cacheOnly ? 'Brain cache fallback; cached agent statuses are not live current-state proof' : 'Partial manager snapshot');
    const fleetCls = !authoritative ? 'yellow' : total === 0 ? 'yellow' : running === total ? 'green' : running > total * 0.95 ? 'yellow' : 'red';
    const syncLabel = sync.mode === 'brain-cache-fallback' ? 'cache fallback' : 'live poll';
    const cacheDiagnostic = drift.status === 'drift' && drift.affectsAuthority !== false;
    const rows = obj => Object.entries(obj || {}).sort((a,b)=>b[1]-a[1]).map(([k,v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('');
    const teamRows = Object.entries(d.fleet.byTeam || {})
      .sort((a,b)=>b[1].total-a[1].total)
      .map(([team,v]) => '<tr><td>' + esc(team) + '</td><td>' + esc(cacheOnly ? v.total + ' records' : v.running + '/' + v.total) + '</td><td>' + esc(Object.entries(v.byStatus || {}).map(([k,n]) => k + ':' + n).join(', ')) + '</td></tr>')
      .join('');
    const teamActivityLabel = cacheOnly ? 'Cached status/Records' : partial ? 'Known active/Total' : 'Active/Total';
    const warningHtml = warnings.length || !authoritative
      ? '<div class="notice ' + (cacheOnly ? 'bad' : '') + '"><b>Fleet source:</b> ' + esc(source) +
        ' <span class="small">(' + esc(d.fleet.managerUrl || 'no manager') + ')</span>' +
        '<br><b>Status authority:</b> ' + esc(statusAuthority) +
        (warnings.length ? '<br>' + warnings.map(esc).join('<br>') : '') +
        (cacheDiagnostic ? '<br>Live manager total ' + esc(drift.liveTotal) + ' vs Brain cache ' + esc(drift.cachedTotal) + '.</div>' : '</div>')
      : '';
    const idaccHtml = '<details class="detailbox">' +
      '<summary>IDACC Authority</summary>' +
      '<div class="small" style="margin-top:0.4em">' +
        '<b>Read model:</b> ' + esc(idacc.sourceRoute || 'IDACC manager / Brain fallback') +
        '<br><b>Owner:</b> ' + esc(idacc.owner || 'IDACC manager') + ' · read-only ' + esc(idacc.readOnly === false ? 'no' : 'yes') + ' · cache ' + esc(idacc.cachePolicy || 'no-store') +
        '<br><b>Teams:</b> ' + esc((idacc.teams || d.fleet.teams || []).join(', ') || '-') + ' <span class="small">from ' + esc(idacc.teamSource || d.fleet.teamSource || '-') + '</span>' +
        '<br><b>Auto-sync:</b> ' + esc(syncLabel) + ' · no-store · dashboard refresh ' + esc(sync.dashboardPollMs || 10000) + 'ms' +
        '<br><b>Policy:</b> Brain shows IDACC-synced state and never writes manager, Brain, provider, wallet, or key material from this view.' +
      '</div></details>';
    const skillmeshHtml = '<details class="detailbox">' +
      '<summary>Optional Providers & Identity</summary>' +
      '<table>' +
        '<tr><td>Optional provider addresses</td><td>' + esc(skillmesh.agentsWithSkillmeshAddress ?? 0) + ' agents</td></tr>' +
        '<tr><td>Optional provider key indexes</td><td>' + esc(skillmesh.agentsWithSkillmeshKeyIndex ?? 0) + ' agents · key material redacted</td></tr>' +
        '<tr><td>OWS wallet/address</td><td>' + esc(skillmesh.agentsWithOwsWallet ?? 0) + ' wallet names · ' + esc(skillmesh.agentsWithOwsAddress ?? 0) + ' public addresses</td></tr>' +
        '<tr><td>On-chain identity</td><td>' + esc(skillmesh.agentsWithDomain ?? 0) + ' domains · ' + esc(skillmesh.agentsWithTokenId ?? 0) + ' token IDs</td></tr>' +
        '<tr><td>Advertised skills</td><td>' + esc(skillmesh.advertisedSkillsTotal ?? 0) + ' assignments · ' + esc(skillmesh.uniqueAdvertisedSkills ?? 0) + ' unique</td></tr>' +
        '<tr><td>Redaction</td><td>' + esc(skillmesh.secretPolicy || 'private keys, auth tokens, wallet secrets, and raw manager metadata are not exposed') + '</td></tr>' +
      '</table></details>';
    c.innerHTML = \`
      <h2>Fleet</h2>
      <div class="summary-grid">
        <div class="summary-card"><span class="small">Live fleet</span><b class="\${fleetCls}">\${esc(fleetCountText)}</b><span class="small">\${esc(activeLabel)}</span></div>
        <div class="summary-card"><span class="small">Source</span><b>\${esc(authority)}</b><span class="small">\${esc(statusAuthority)}</span></div>
        <div class="summary-card"><span class="small">IDACC sync</span><b>\${esc(syncLabel)}</b><span class="small">\${esc(d.fleet.teamSource || sync.teamSource || '-')}</span></div>
        <div class="summary-card"><span class="small">Provider identity</span><b>\${esc(skillmesh.agentsWithControllerWallet ?? 0)}</b><span class="small">controller wallet links</span></div>
      </div>
      \${warningHtml}
      \${idaccHtml}
      \${skillmeshHtml}
      \${teamRows ? '<h2>Teams</h2><table><tr><th>Team</th><th>' + teamActivityLabel + '</th><th>Status</th></tr>' + teamRows + '</table>' : ''}
      <table><tr><th>Model</th><th>Count</th></tr>\${rows(d.fleet.byModel)}</table>
      <h2>Brain</h2>
      <div>nodes <b>\${esc(d.brain.nodes)}</b> · edges <b>\${esc(d.brain.edges)}</b> · entities <b>\${esc(d.brain.entities)}</b> · memories <b>\${esc(d.brain.memories)}</b> · timeline <b>\${esc(d.brain.timelineEvents)}</b></div>
      <h2>Last 24h</h2>
      <table>
        <tr><td>Queries</td><td>\${esc(d.last24h.queries.delivered)} delivered, \${esc(d.last24h.queries.failed)} failed</td></tr>
        <tr><td>Skill executions</td><td>\${esc(d.last24h.skillExecutions.total)} (settle rate: \${esc(d.last24h.skillExecutions.settleRate ? (d.last24h.skillExecutions.settleRate * 100).toFixed(0) + '%' : 'n/a')})</td></tr>
        <tr><td>Cloud cost</td><td>$\${esc(d.last24h.cloudCostUsd.toFixed(2))} (projected $\${esc((d.last24h.cloudCostUsd * 30).toFixed(0))}/mo)</td></tr>
        <tr><td>Watchdog alerts</td><td>\${esc(d.last24h.watchdogAlerts)}</td></tr>
      </table>
      \${Object.keys(d.costByAgent).length ? '<h2>Cost by agent (24h)</h2><table><tr><th>Agent</th><th>Queries</th><th>USD</th></tr>' +
        Object.entries(d.costByAgent).sort((a,b)=>b[1].totalUsd-a[1].totalUsd).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v.count)+'</td><td>$'+esc(v.totalUsd.toFixed(4))+'</td></tr>').join('') + '</table>' : ''}
      \${d.recentWatchdogAlerts.length ? '<h2>Recent alerts</h2><pre>' + d.recentWatchdogAlerts.map(a=>'• '+esc(a.subject)+': '+(a.failures||[]).map(esc).join('; ')).join('\\n') + '</pre>' : ''}
    \`;
  } catch (e) {
    document.getElementById('content').innerHTML = '<span class="red">Error loading: ' + esc(e.message) + '</span>';
  }
}
tick(); setInterval(tick, 10000);
</script>
</body></html>`;

// ─── /dashboard/health — Brain health, cycle freshness, approvals, eval trends ─
export const DASHBOARD_HEALTH_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Health · Brain Read Only</title>
<style>
  body { font: 13px/1.4 -apple-system, monospace; max-width: 1100px; margin: 1em auto; padding: 0 1em; color: #d4d4d4; background: #111; }
  h1 { font-size: 18px; margin: 0 0 0.5em; }
  h2 { font-size: 14px; margin: 1.4em 0 0.4em; color: #88c; }
  table { border-collapse: collapse; width: 100%; margin: 0.3em 0; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #333; text-align: left; font-size: 12px; vertical-align: top; }
  th { color: #88c; }
  .small { font-size: 11px; color: #777; }
  .green { color: #5dd55d; } .red { color: #f55; } .yellow { color: #ec9; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
  .metric { border: 1px solid #333; border-radius: 4px; padding: 8px; background: #151515; }
  .metric b { display: block; font-size: 18px; margin-top: 3px; }
  pre { background: #1a1a1a; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  select { background: #1a1a1a; border: 1px solid #444; border-radius: 4px; color: #d4d4d4; font: inherit; padding: 3px 7px; }
  .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0.6em 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .muted { color: #888; }
  .payload-row td { padding: 0 8px 12px; border-bottom: 1px solid #333; }
  .payload-panel { border: 1px solid #333; border-radius: 4px; background: #151515; padding: 10px 12px; }
  .payload-panel h3 { margin: 0 0 7px; font-size: 13px; color: #ddd; }
  .payload-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; margin: 8px 0; }
  .payload-box { border-left: 2px solid #555; padding-left: 8px; min-width: 0; }
  .payload-box b { display: block; color: #aaa; margin-bottom: 2px; }
  .payload-box div { overflow-wrap: anywhere; }
  .payload-list { margin: 6px 0 0; padding-left: 18px; }
  .payload-list li { margin: 3px 0; overflow-wrap: anywhere; }
  .payload-json { margin-top: 8px; }
  .details { max-height: 260px; white-space: pre-wrap; }
  .notice { border: 1px solid #4a3; background: #18170f; padding: 7px 9px; border-radius: 4px; margin: 0.7em 0; }
  .notice.bad { border-color: #833; background: #1b1111; }
</style></head><body>
<h1>Brain Health · Read Only <span class="small" id="ts"></span></h1>
<nav class="small" style="margin-bottom:1em">
  <a href="/dashboard" style="color:#88c;margin-right:1em">Fleet</a>
  <a href="/dashboard/health" style="color:#88c;margin-right:1em"><b>Health</b></a>
  <a href="/dashboard/skills" style="color:#88c;margin-right:1em">Skills</a>
  <a href="/dashboard/learning" style="color:#88c;margin-right:1em">Learning</a>
  <a href="/dashboard/agents" style="color:#88c;margin-right:1em">Agents</a>
  <a href="/dashboard/graph" style="color:#88c">Graph</a>
</nav>
<div id="content">Loading...</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => v == null ? '-' : (v * 100).toFixed(0) + '%';
const age = seconds => seconds == null ? '-' : seconds < 120 ? seconds + 's' : seconds < 7200 ? Math.round(seconds / 60) + 'm' : Math.round(seconds / 3600) + 'h';
const cls = status => status === 'ok' ? 'green' : status === 'warn' || status === 'stale' ? 'yellow' : 'red';
const triagePriority = {
  'fact.contradiction': 1,
  'team.instruction.supersede': 2,
  'entity.alias.fuzzy_merge': 3,
  'memory.retire': 4,
  'skill.proposal.evidence_invalid': 5,
  'skill.publish': 6,
};
const TRIAGE_MAX_AGE_MS = 45000;
let TRIAGE_LOADED_AT = 0;
function metric(label, value, klass = '') {
  return '<div class="metric"><span class="small">' + esc(label) + '</span><b class="' + esc(klass) + '">' + esc(value) + '</b></div>';
}
function fleetAuthority(fleet) {
  const source = String(fleet?.source || 'unknown');
  return fleet?.authority || (source === 'brain-cache' ? 'cache' : source === 'live-manager-partial' ? 'partial' : source === 'live-manager' ? 'live' : 'unknown');
}
function fleetHealthClass(fleet) {
  const authority = fleetAuthority(fleet);
  if (authority === 'cache' || authority === 'unknown') return 'red';
  if (authority === 'partial' || fleet?.authoritative !== true) return 'yellow';
  const total = fleet?.total ?? 0;
  const running = fleet?.running ?? 0;
  if (total === 0) return 'yellow';
  return running === total ? 'green' : running > total * 0.95 ? 'yellow' : 'red';
}
function fleetMetric(fleet) {
  if (!fleet) return '-';
  if (fleetAuthority(fleet) === 'cache') return (fleet.total ?? 0) + ' cached agent records';
  const label = fleet.activeLabel || 'active';
  return (fleet.running ?? 0) + '/' + (fleet.total ?? 0) + ' ' + label;
}
function fleetHealthStrip(fleet) {
  const authority = fleetAuthority(fleet);
  const cacheOnly = authority === 'cache' || fleet?.source === 'brain-cache';
  const warnings = fleet?.warnings || [];
  const drift = fleet?.cacheDrift || {};
  const cacheDiagnostic = drift.status === 'drift' && drift.affectsAuthority !== false;
  const statusAuthority = fleet?.statusAuthorityLabel || (cacheOnly ? 'Brain cache fallback; cached agent statuses are not live current-state proof' : authority === 'partial' ? 'Partial manager snapshot; missing teams are not inferred from cache' : authority === 'live' ? 'Live manager current-state snapshot' : 'Fleet source unavailable');
  const noticeClass = cacheOnly || authority === 'unknown' ? 'notice bad' : 'notice';
  return '<h2>Live Fleet Authority</h2>' +
    '<div class="' + noticeClass + '">' +
      '<b>Fleet:</b> <span class="' + fleetHealthClass(fleet) + '">' + esc(cacheOnly ? (fleet?.total ?? 0) + ' cached records' : (fleet?.running ?? 0) + '/' + (fleet?.total ?? 0)) + '</span> ' + esc(fleet?.activeLabel || (cacheOnly ? 'cached agent records (not live status)' : 'agents active')) +
      '<br><b>Source:</b> ' + esc(fleet?.source || 'unavailable') + ' <span class="small">(' + esc(fleet?.managerUrl || 'no manager') + ')</span>' +
      '<br><b>Status authority:</b> ' + esc(statusAuthority) +
      '<br><b>Teams:</b> ' + esc((fleet?.teams || []).join(', ') || '-') + ' <span class="small">from ' + esc(fleet?.teamSource || '-') + '</span>' +
      (warnings.length ? '<br>' + warnings.map(esc).join('<br>') : '') +
      (cacheDiagnostic ? '<br>Live manager total ' + esc(drift.liveTotal) + ' vs Brain cache ' + esc(drift.cachedTotal) + '.' : '') +
    '</div>';
}
function approvalReason(row) {
  return row?.payload?.suggested_reason || row?.payload?.reason || row?.payload?.human_attention?.reason || row?.governance?.human_attention?.reason || '';
}
function createdSeconds(row) {
  return row?.created_at ? Math.max(0, Math.round(Date.now() / 1000) - Number(row.created_at)) : null;
}
function priorityLabel(kind) {
  if (kind === 'fact.contradiction' || kind === 'team.instruction.supersede' || kind === 'entity.alias.fuzzy_merge') return 'identity/fact risk';
  if (kind === 'memory.retire') return 'memory cleanup';
  if (kind === 'skill.proposal.evidence_invalid') return 'evidence gap';
  if (kind === 'skill.publish') return 'publish gate';
  return 'review';
}
function resolutionPath(kind, row = {}) {
  const payload = row.payload || {};
  if (kind === 'fact.contradiction') return 'Reviewer chooses winning fact; apply marks losing facts disputed/superseded.';
  if (kind === 'team.instruction.supersede') return 'Reviewer confirms replacement instruction; apply supersedes old team-instruction memory.';
  if (kind === 'entity.alias.fuzzy_merge') return 'Reviewer confirms canonical and loser entities; apply records reversible alias merge.';
  if (kind === 'memory.retire') return 'Reviewer confirms stale/noisy memory; apply retires memory with rollback record.';
  if (kind === 'skill.proposal.evidence_invalid') return 'Auto-routes to skill evidence repair; no publish approval is granted.';
  if (kind === 'skill.publish') {
    const lowConfidence = payload.reason === 'template-fallback-low-confidence' || !((payload.evidence_snippets || payload.evidenceSnippets || []).length);
    return lowConfidence
      ? 'Hold for evidence repair or reject duplicate low-confidence proposal; do not publish automatically.'
      : 'Reviewer validates evidence and publish readiness before approval.';
  }
  return 'Review payload, approve/reject, then apply only through a supported guarded route.';
}
function humanKey(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\\b\\w/g, c => c.toUpperCase());
}
function compactJson(value, max = 180) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw == null) return '-';
  return raw.length > max ? raw.slice(0, max - 3) + '...' : raw;
}
function sourceLabel(item) {
  const bits = [];
  if (item?.source) bits.push(item.source);
  if (item?.id || item?.fact_id) bits.push('fact #' + (item.id || item.fact_id));
  if (item?.confidence != null) bits.push('confidence ' + item.confidence);
  if (item?.observed_at) bits.push('seen ' + new Date(Number(item.observed_at) * 1000).toLocaleString());
  return bits.join(' - ');
}
function summarizeValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) return 'empty list';
    if (value.every(v => typeof v === 'string')) return value.join(', ');
    if (value.every(v => v && typeof v === 'object' && ('path' in v || 'summary' in v))) {
      return value.slice(0, 6).map(v => {
        const risk = v.risk ? ' [' + v.risk + ']' : '';
        return (v.path || 'item') + risk + (v.summary ? ': ' + v.summary : '');
      }).join(' | ') + (value.length > 6 ? ' | +' + (value.length - 6) + ' more' : '');
    }
    return value.slice(0, 4).map(v => compactJson(v, 120)).join(' | ') + (value.length > 4 ? ' | +' + (value.length - 4) + ' more' : '');
  }
  if (value && typeof value === 'object') return compactJson(value, 240);
  if (typeof value === 'boolean') return value ? 'yes / true' : 'no / false';
  return String(value ?? '-');
}
function detailBox(label, value) {
  return '<div class="payload-box"><b>' + esc(label) + '</b><div>' + esc(value) + '</div></div>';
}
function listItems(items) {
  const rows = (items || []).filter(Boolean);
  return rows.length ? '<ul class="payload-list">' + rows.map(item => '<li>' + item + '</li>').join('') + '</ul>' : '';
}
function claimSummary(claim, index) {
  const label = sourceLabel(claim) || ('Claim ' + (index + 1));
  return '<b>' + esc(label) + '</b>: ' + esc(summarizeValue(claim?.value));
}
function defaultPayloadSummary(row) {
  const payload = row.payload || {};
  const important = ['action','suggested_action','suggestedAction','reason','suggested_reason','suggestedReason','source_id','sourceId','memory_id','memoryId','skill_id','skillId','target','alias','canonical','field','value'];
  const boxes = important
    .filter(key => payload[key] != null)
    .map(key => detailBox(humanKey(key), summarizeValue(payload[key])))
    .join('');
  const fallback = Object.entries(payload).slice(0, 8).map(([key, value]) =>
    detailBox(humanKey(key), summarizeValue(value))
  ).join('');
  return '<h3>Payload summary</h3>' +
    '<div>This item needs a human decision before Brain treats the queued change as resolved.</div>' +
    '<div class="payload-grid">' + (boxes || fallback || detailBox('Payload', 'No structured payload was provided.')) + '</div>';
}
function contradictionPayloadSummary(row) {
  const p = row.payload || {};
  const claims = p.claims || p.competing_values || [];
  const gov = row.governance || p.governance || {};
  const proposed = p.proposed_resolution || {};
  const repeated = p.consecutive_cycle_count ? 'seen in ' + p.consecutive_cycle_count + ' consecutive cycles' : 'seen repeatedly';
  return '<h3>Plain-language payload summary</h3>' +
    '<div>Brain found conflicting stored facts about <b>' + esc(p.field || 'a field') + '</b> for <b>' + esc(p.entity_id || row.subject || 'this subject') + '</b>. A reviewer should compare the competing values and decide which fact should stay active.</div>' +
    '<div class="payload-grid">' +
      detailBox('What approval means', 'Accept this as a real contradiction needing resolution. Applying later may mark losing facts as disputed or superseded.') +
      detailBox('Why it is in the queue', approvalReason(row) || gov.human_attention?.reason || repeated) +
      detailBox('Review risk', (row.risk_level || row.riskLevel || gov.risk?.level || '-') + (gov.risk?.reversible ? '; reversible' : '')) +
      detailBox('Proposed next step', proposed.required_fields?.length ? 'Choose ' + proposed.required_fields.join(', ') + '; losing facts default to ' + (proposed.default_losing_status || 'disputed') + '.' : 'Choose the source/value that best matches current evidence.') +
    '</div>' +
    '<b>Competing values to inspect</b>' +
    listItems(claims.map(claimSummary)) +
    '<div class="payload-grid">' +
      detailBox('Source fact IDs', (p.source_fact_ids || []).join(', ') || '-') +
      detailBox('Source text units', (p.source_text_unit_ids || []).slice(0, 20).join(', ') + ((p.source_text_unit_ids || []).length > 20 ? ' +' + ((p.source_text_unit_ids || []).length - 20) + ' more' : '') || '-') +
      detailBox('Audit checks', (gov.audit?.checks || p.governance?.audit?.checks || []).join(', ') || '-') +
    '</div>';
}
function memoryRetirePayloadSummary(row) {
  const p = row.payload || {};
  return '<h3>Plain-language payload summary</h3>' +
    '<div>Brain is proposing that an old memory be retired or de-emphasized because feedback suggests it is stale, noisy, or no longer useful.</div>' +
    '<div class="payload-grid">' +
      detailBox('Memory/source', p.source_id || p.sourceId || p.memory_id || p.memoryId || row.subject || '-') +
      detailBox('Reason to review', approvalReason(row) || p.suggested_reason || p.suggestedReason || '-') +
      detailBox('Feedback signal', p.ignored_count != null ? p.ignored_count + ' ignored uses' : summarizeValue(p.feedback || '-')) +
      detailBox('What approval means', 'Accept the retirement recommendation so the memory is less likely to be reused as current guidance.') +
    '</div>';
}
function instructionPayloadSummary(row) {
  const p = row.payload || {};
  return '<h3>Plain-language payload summary</h3>' +
    '<div>Brain is proposing a change to team instructions because an instruction may be outdated, duplicated, too broad, or contradicted by newer guidance.</div>' +
    '<div class="payload-grid">' +
      detailBox('Instruction', p.source_id || p.sourceId || p.instruction_id || p.instructionId || row.subject || '-') +
      detailBox('Suggested action', p.suggested_action || p.suggestedAction || p.action || '-') +
      detailBox('Reason to review', approvalReason(row) || '-') +
      detailBox('What approval means', 'Accept that this instruction lifecycle change is ready for the next apply step.') +
    '</div>' +
    listItems([p.current && '<b>Current:</b> ' + esc(summarizeValue(p.current)), p.replacement && '<b>Replacement:</b> ' + esc(summarizeValue(p.replacement))]);
}
function aliasPayloadSummary(row) {
  const p = row.payload || {};
  return '<h3>Plain-language payload summary</h3>' +
    '<div>Brain found names or aliases that may refer to the same entity. A reviewer should confirm they are truly the same before approving any merge.</div>' +
    '<div class="payload-grid">' +
      detailBox('Primary entity', p.canonical || p.canonical_id || p.canonicalId || row.subject || '-') +
      detailBox('Possible alias', p.alias || p.alias_id || p.aliasId || p.candidate || '-') +
      detailBox('Reason to review', approvalReason(row) || '-') +
      detailBox('What approval means', 'Accept the alias relationship as ready for merge or identity cleanup.') +
    '</div>';
}
function skillEvidencePayloadSummary(row) {
  const p = row.payload || {};
  return '<h3>Plain-language payload summary</h3>' +
    '<div>A proposed skill or skill gap has weak, missing, or invalid evidence. A reviewer should decide whether to hold it, reject it, or repair the citations before publishing.</div>' +
    '<div class="payload-grid">' +
      detailBox('Skill or gap', p.skill_id || p.skillId || p.gap || row.subject || '-') +
      detailBox('Evidence issue', p.issue || p.evidence_issue || p.evidenceIssue || approvalReason(row) || '-') +
      detailBox('Suggested action', p.suggested_action || p.suggestedAction || p.action || 'Review evidence before approving.') +
      detailBox('What approval means', 'Accept this as a real evidence problem that needs correction or batching with similar gaps.') +
    '</div>' +
    listItems((p.invalid_source_ids || p.invalidSourceIds || []).map(id => esc(id)));
}
function renderPayloadSummary(row) {
  let summary;
  if (row.kind === 'fact.contradiction') summary = contradictionPayloadSummary(row);
  else if (row.kind === 'memory.retire') summary = memoryRetirePayloadSummary(row);
  else if (row.kind === 'team.instruction.supersede') summary = instructionPayloadSummary(row);
  else if (row.kind === 'entity.alias.fuzzy_merge') summary = aliasPayloadSummary(row);
  else if (row.kind === 'skill.proposal.evidence_invalid') summary = skillEvidencePayloadSummary(row);
  else summary = defaultPayloadSummary(row);
  return '<tr class="payload-row"><td colspan="9"><div class="payload-panel">' +
    summary +
    '<details class="payload-json"><summary>Raw payload JSON</summary><pre class="details">' + esc(JSON.stringify(row.payload || {}, null, 2)) + '</pre></details>' +
  '</div></td></tr>';
}
async function fetchJson(path, options = {}) {
  const r = await fetch(path, options);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error?.message || body.error || r.statusText);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}
async function freshApproval(id) {
  const d = await fetchJson('/approvals/' + encodeURIComponent(id));
  return d.approval || d.data?.approval || null;
}
function triageSnapshotAgeMs() {
  return TRIAGE_LOADED_AT ? Date.now() - TRIAGE_LOADED_AT : Infinity;
}
async function requireFreshTriageSnapshot() {
  if (triageSnapshotAgeMs() <= TRIAGE_MAX_AGE_MS) return true;
  alert('Approval queue snapshot is stale. Refreshing before any Brain mutation.');
  await load();
  return false;
}
function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(key => {
      out[key] = stableClone(value[key]);
    });
    return out;
  }
  return value ?? null;
}
function approvalSnapshotStamp(row) {
  if (!row) return '';
  return JSON.stringify(stableClone({
    id: row.id,
    status: row.status,
    kind: row.kind,
    subject: row.subject,
    riskLevel: row.risk_level ?? row.riskLevel ?? null,
    requestedBy: row.requested_by ?? row.requestedBy ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    resolvedAt: row.resolved_at ?? row.resolvedAt ?? null,
    payload: row.payload || {},
    resolution: row.resolution || {},
  }));
}
function sameApprovalSnapshot(before, after) {
  return Boolean(before && after && approvalSnapshotStamp(before) === approvalSnapshotStamp(after));
}
async function freshApprovalAfterReview(id, before, expectedStatus) {
  const current = await freshApproval(id);
  if (!current || current.status !== expectedStatus || !sameApprovalSnapshot(before, current)) {
    alert('Approval #' + id + ' changed during review. Current status: ' + (current?.status || 'missing') + '.');
    await load();
    return null;
  }
  return current;
}
function renderApprovalRows(rows, emptyMessage = 'No queue items match this status.') {
  if (!rows.length) return '<p class="small">' + esc(emptyMessage) + '</p>';
  return '<table><tr><th>ID</th><th>Priority</th><th>Kind</th><th>Subject</th><th>Risk</th><th>Age</th><th>Reason</th><th>Resolution path</th><th>Review state</th></tr>' + rows.map(row => {
    const status = row.status || 'pending';
    const reviewState = status === 'pending'
      ? '<span class="yellow">pending IDACC review</span>'
      : status === 'approved'
        ? '<span class="yellow">approved, apply outside this read-only view</span>'
        : '<span class="muted">' + esc(status) + '</span>';
    return '<tr>' +
      '<td class="mono">' + esc(row.id) + '</td>' +
      '<td>' + esc(priorityLabel(row.kind)) + '</td>' +
      '<td>' + esc(row.kind) + '</td>' +
      '<td>' + esc(row.subject) + '</td>' +
      '<td>' + esc(row.risk_level || row.riskLevel || '-') + '</td>' +
      '<td>' + esc(age(createdSeconds(row))) + '</td>' +
      '<td>' + esc(approvalReason(row)) + '</td>' +
      '<td>' + esc(resolutionPath(row.kind, row)) + '</td>' +
      '<td>' + reviewState + '</td>' +
    '</tr>' + renderPayloadSummary(row);
  }).join('') + '</table>';
}
async function load() {
  try {
    const selectedStatus = document.getElementById('triage-status')?.value || 'pending';
    const selectedKind = document.getElementById('triage-kind')?.value || '';
    const [r, fleetResp, approvalsResp, skillReportResp] = await Promise.all([
      fetchJson('/brain/health-view?days=7'),
      fetchJson('/fleet-report').catch(error => ({ fleet: { source: 'unavailable', authority: 'unknown', authoritative: false, total: 0, running: 0, statusAuthorityLabel: 'Fleet report unavailable: ' + (error?.message || error), warnings: ['fleet-report unavailable'] } })),
      fetchJson('/approvals?status=' + encodeURIComponent(selectedStatus) + '&limit=200'),
      fetchJson('/skill-proposals/report').catch(() => ({ gaps: [] })),
    ]);
    TRIAGE_LOADED_AT = Date.now();
    const d = r;
    const h = d.health || {};
    document.getElementById('ts').textContent = new Date(h.generatedAt || Date.now()).toLocaleTimeString();
    const approvalRows = (h.approvals?.byKind || []).map(row =>
      '<tr><td>' + esc(row.kind) + '</td><td>' + esc(row.count) + '</td><td>' + esc(age(row.oldestAgeSeconds)) + '</td><td>' + esc(resolutionPath(row.kind)) + '</td></tr>'
    ).join('');
    const warningRows = (h.learning?.warnings || []).slice(0, 20).map(w =>
      '<tr><td>' + esc(w.kind) + '</td><td><pre>' + esc(JSON.stringify(w)) + '</pre></td></tr>'
    ).join('');
    const evalTrend = h.evalTrends || { current: {}, previous: {}, delta: {} };
    const cycle = h.cycle || {};
    const automation = h.automation || {};
    const maintenance = automation.maintenance || {};
    const maintenanceLast = maintenance.last || {};
    const graphConnectivity = h.brain?.connectivity || {};
    const graphAgentEdges = graphConnectivity.agentTeamEdges || {};
    const graphIsolated = graphConnectivity.isolatedEntities || {};
    const vector = h.brain?.sqliteVec || {};
    const vectorRollout = h.vectorRollout || {};
    const vectorDetail = (vector.available ? '<span class="green">available</span>' : '<span class="yellow">disabled</span>') +
      ' · dim ' + esc(vector.dimensions ?? '-') +
      ' · extension ' + esc(vector.extension || '-') +
      (vector.error ? ' · <span class="yellow">' + esc(vector.error) + '</span>' : '');
    const vectorGuardClass = vectorRollout.rolloutAllowed ? 'green' : (vectorRollout.guard === 'insufficient_samples' ? 'yellow' : 'red');
    const vectorRolloutDetail = '<span class="' + vectorGuardClass + '">' + esc(vectorRollout.rolloutAllowed ? 'pass' : (vectorRollout.guard || 'unknown')) + '</span>' +
      ' · samples ' + esc(vectorRollout.samples ?? 0) +
      ' · recall ' + esc(pct(vectorRollout.vectorAcceptanceRecall)) +
      ' · p95 ' + esc(vectorRollout.vectorLatencyMs?.p95 ?? '-') + 'ms';
    const queueRows = (approvalsResp.approvals || [])
      .filter(row => !selectedKind || row.kind === selectedKind)
      .sort((a, b) => (triagePriority[a.kind] || 99) - (triagePriority[b.kind] || 99) || Number(a.created_at || 0) - Number(b.created_at || 0));
    const queueKinds = Array.from(new Set((approvalsResp.approvals || []).map(row => row.kind))).sort((a, b) => (triagePriority[a] || 99) - (triagePriority[b] || 99) || a.localeCompare(b));
    const gapRows = (skillReportResp.gaps || [])
      .filter(gap => gap.evidenceCoverage === 0 || gap.approvalsPending > 0)
      .sort((a, b) => (b.approvalsPending || 0) - (a.approvalsPending || 0) || (a.evidenceCoverage || 0) - (b.evidenceCoverage || 0))
      .slice(0, 40)
      .map(gap => '<tr><td>' + esc(gap.gap) + '</td><td>' + esc(gap.approvalsPending || 0) + '</td><td>' + esc(gap.held || 0) + '</td><td>' + esc(gap.evidenceCoverage ?? '-') + '</td><td>' + esc(age(gap.lastSeen ? Math.max(0, Math.round(Date.now() / 1000) - Number(gap.lastSeen)) : null)) + '</td></tr>')
      .join('');
    document.getElementById('content').innerHTML =
      '<div class="notice"><b>Read-only Health view.</b> This page reads Brain health, approvals, proposals, and IDACC fleet authority without approving, rejecting, applying, replaying, or mutating Brain state. IDACC Health & Probes runs automatic safe/routable processing and exposes manual preview/process controls.</div>' +
      '<div class="grid">' +
        metric('Brain status', h.status || '-', cls(h.status)) +
        metric('Cycle', cycle.status || '-', cls(cycle.status)) +
        metric('Cycle age', age(cycle.ageSeconds), cycle.status === 'ok' ? 'green' : 'yellow') +
        metric('Review queue', String(h.approvals?.pending ?? 0) + ' pending', (h.approvals?.pending ?? 0) ? 'yellow' : 'green') +
        metric('Contradiction rate', h.contradictions?.ratePerEvalSample == null ? '-' : h.contradictions.ratePerEvalSample, (h.contradictions?.pending ?? 0) ? 'yellow' : '') +
        metric('Eval samples', evalTrend.current?.samples ?? 0, '') +
        metric('Live fleet', fleetMetric(fleetResp.fleet), fleetHealthClass(fleetResp.fleet)) +
      '</div>' +
      fleetHealthStrip(fleetResp.fleet) +
      '<h2>Brain</h2><table><tr><td>Graph</td><td>' + esc(h.brain?.nodes ?? 0) + ' nodes · ' + esc(h.brain?.edges ?? 0) + ' edges · ' + esc(h.brain?.entities ?? 0) + ' entities · ' + esc(h.brain?.facts ?? 0) + ' facts</td></tr>' +
      '<tr><td>Connectivity</td><td>' + (graphAgentEdges.missing ? '<span class="yellow">' + esc(graphAgentEdges.missing) + ' agent/team edge(s) missing</span>' : '<span class="green">agent/team edges ready</span>') +
        ' · ' + esc(graphAgentEdges.connected ?? 0) + '/' + esc(graphAgentEdges.totalAgents ?? 0) + ' connected' +
        ' · review candidates ' + esc(graphIsolated.reviewCandidateTotal ?? 0) +
        (graphConnectivity.latestRepair?.createdAt ? ' · repaired ' + esc(age(Math.max(0, Math.round(Date.now() / 1000) - Number(graphConnectivity.latestRepair.createdAt)))) + ' ago' : '') +
      '</td></tr>' +
      '<tr><td>Memory/timeline</td><td>' + esc(h.brain?.memories ?? 0) + ' memories · ' + esc(h.brain?.timelineEvents ?? 0) + ' timeline events</td></tr>' +
      '<tr><td>Routes</td><td>' + (h.brain?.routeSkew?.skew ? '<span class="red">skew</span>' : '<span class="green">ok</span>') + ' · ' + esc(h.brain?.routeSkew?.routeCount ?? 0) + ' registered</td></tr>' +
      '<tr><td>sqlite-vec</td><td>' + vectorDetail + '</td></tr>' +
      '<tr><td>sqlite-vec rollout gate</td><td>' + vectorRolloutDetail + '</td></tr></table>' +
      '<h2>Cycle Freshness</h2><table><tr><td>Latest cycle</td><td>' + esc(cycle.latestId ?? '-') + ' · ' + esc(age(cycle.ageSeconds)) + ' old · max ' + esc(age(cycle.maxAgeSeconds)) + '</td></tr>' +
      '<tr><td>Auto-processing</td><td>' +
        '<span class="' + (maintenance.latestId ? 'green' : 'yellow') + '">' + esc(maintenance.latestId ? 'active' : 'not seen yet') + '</span>' +
        ' · ' + esc(maintenance.cadence || 'launchd monitor') +
        (maintenance.latestId ? ' · last ' + esc(age(maintenance.ageSeconds)) + ' ago' : '') +
        '<br>routed ' + esc(maintenanceLast.routed_approvals ?? 0) + ' evidence repair item(s)' +
        ' · graph linked ' + esc(maintenanceLast.graph_agents_connected ?? 0) +
        ' · source edges ' + esc(maintenanceLast.graph_source_edges_created ?? 0) +
        ' · graph review ' + esc(maintenanceLast.graph_review_tasks_created ?? 0) +
        ' · graph resolved ' + esc(maintenanceLast.graph_review_tasks_resolved ?? 0) +
        ' · citation repair ' + esc(maintenanceLast.citation_repair_tasks ?? 0) +
        ' · recovered tasks ' + esc(maintenanceLast.recovered_learning_tasks ?? 0) +
        ' · escalated tasks ' + esc(maintenanceLast.escalated_learning_tasks ?? 0) +
        ' · eval repair ' + esc(maintenanceLast.eval_quality_repair_tasks ?? 0) +
        ' · curator applied ' + esc(maintenanceLast.curator_applied ?? 0) +
        ' · cycle ' + (maintenanceLast.cycle_ran ? 'ran' : 'fresh') +
      '</td></tr>' +
      '<tr><td>Guardrails</td><td>safe reversible approvals can auto-apply; evidence-invalid skill proposals route to repair work; low-confidence publish proposals route to repair work; invalid citations become learning tasks; isolated graph nodes route to review tasks; stale learning leases recover or escalate; evidence-backed publish, fuzzy identity, instruction, memory, fact, wallet, and key decisions remain review-gated.</td></tr>' +
      '<tr><td>Warnings</td><td>' + ((cycle.warnings || []).map(esc).join('<br>') || '<span class="green">none</span>') + '</td></tr></table>' +
      '<h2>Contradictions</h2><table><tr><th>Opened in window</th><th>Pending</th><th>Per eval sample</th></tr><tr><td>' + esc(h.contradictions?.opened ?? 0) + '</td><td>' + esc(h.contradictions?.pending ?? 0) + '</td><td>' + esc(h.contradictions?.ratePerEvalSample ?? '-') + '</td></tr></table>' +
      '<h2>Governance Review Summary</h2>' +
      '<p class="small">Approvals and proposals share one governance queue; this dashboard renders the backlog once.</p>' +
      (approvalRows ? '<table><tr><th>Kind</th><th>Count</th><th>Oldest</th><th>Resolution path</th></tr>' + approvalRows + '</table>' : '<p class="small">No pending review items.</p>') +
      '<h2>Approval Triage Queue</h2>' +
      '<div class="toolbar">' +
        '<label>Status <select id="triage-status" onchange="load()">' +
          ['pending','approved','rejected','resolved','cancelled'].map(status => '<option value="' + status + '"' + (status === selectedStatus ? ' selected' : '') + '>' + status + '</option>').join('') +
        '</select></label>' +
        '<label>Kind <select id="triage-kind" onchange="load()"><option value="">priority order</option>' +
          queueKinds.map(kind => '<option value="' + esc(kind) + '"' + (kind === selectedKind ? ' selected' : '') + '>' + esc(kind) + '</option>').join('') +
        '</select></label>' +
        '<span class="small">Review fact/instruction/alias items first; memory retirement second; skill evidence gaps in batches.</span>' +
        '<span class="small">Queue snapshot: ' + new Date(TRIAGE_LOADED_AT).toLocaleTimeString() +
          ' · ' + queueRows.length + ' shown · ' + (approvalsResp.approvals || []).length + ' loaded · actions re-read before and after review.</span>' +
        '<span class="small">IDACC Inbox mirror: pending Brain approvals are synced into IDACC Decisions needed for operator review; Brain remains read-only here.</span>' +
      '</div>' +
      renderApprovalRows(queueRows, selectedKind ? 'No queue items match this kind/status filter.' : 'No queue items match this status.') +
      '<h2>Skill Evidence Gaps</h2>' +
      (gapRows ? '<table><tr><th>Subject</th><th>Pending approvals</th><th>Held</th><th>Evidence coverage</th><th>Last seen</th></tr>' + gapRows + '</table>' : '<p class="small">No skill gaps needing evidence repair.</p>') +
      '<h2>Eval Trends</h2><table><tr><th>Metric</th><th>Current 7d</th><th>Previous 7d</th><th>Delta</th></tr>' +
      '<tr><td>Samples</td><td>' + esc(evalTrend.current?.samples ?? 0) + '</td><td>' + esc(evalTrend.previous?.samples ?? 0) + '</td><td>' + esc(evalTrend.delta?.samples ?? 0) + '</td></tr>' +
      '<tr><td>Acceptance recall</td><td>' + esc(pct(evalTrend.current?.acceptanceRecall)) + '</td><td>' + esc(pct(evalTrend.previous?.acceptanceRecall)) + '</td><td>' + esc(pct(evalTrend.delta?.acceptanceRecall)) + '</td></tr>' +
      '<tr><td>Volunteer precision</td><td>' + esc(pct(evalTrend.current?.volunteeredPrecision)) + '</td><td>' + esc(pct(evalTrend.previous?.volunteeredPrecision)) + '</td><td>' + esc(pct(evalTrend.delta?.volunteeredPrecision)) + '</td></tr>' +
      '<tr><td>Volunteer sample rate</td><td>' + esc(pct(evalTrend.current?.volunteeredSampleRate)) + '</td><td>' + esc(pct(evalTrend.previous?.volunteeredSampleRate)) + '</td><td>' + esc(pct(evalTrend.delta?.volunteeredSampleRate)) + '</td></tr></table>' +
      '<h2>Learning Warnings</h2>' + (warningRows ? '<table><tr><th>Kind</th><th>Payload</th></tr>' + warningRows + '</table>' : '<p class="small">No learning warnings.</p>');
  } catch (e) {
    document.getElementById('content').innerHTML = '<span class="red">Error loading: ' + esc(e.message) + '</span>';
  }
}
load(); setInterval(load, 30000);
</script>
</body></html>`;

// ─── /dashboard/skills — per-skill safety + execution table ───────────────────
export const DASHBOARD_SKILLS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Skills · Brain Read Only</title>
<style>
  body { font: 13px/1.4 -apple-system, monospace; max-width: 1100px; margin: 1em auto; padding: 0 1em; color: #d4d4d4; background: #111; }
  h1 { font-size: 18px; margin: 0 0 0.5em; }
  h2 { font-size: 14px; margin: 1.4em 0 0.4em; color: #88c; }
  table { border-collapse: collapse; width: 100%; margin: 0.3em 0; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #333; text-align: left; font-size: 12px; }
  th { color: #88c; }
  .small { font-size: 11px; color: #777; }
  .safe { color: #5dd55d; } .caution { color: #ec9; } .danger { color: #f55; } .unknown { color: #777; }
  input { background: #1a1a1a; color: #d4d4d4; border: 1px solid #333; padding: 4px 8px; min-width: min(520px, 100%); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 0.75em; }
  .tag { display: inline-block; border: 1px solid #333; border-radius: 3px; padding: 0 4px; margin-right: 3px; color: #aaa; }
  .desc { color: #aaa; max-width: 420px; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 0.75em 0; }
  .metric { border: 1px solid #333; border-radius: 4px; background: #151515; padding: 7px 8px; }
  .metric b { display: block; font-size: 16px; color: #ddd; margin-top: 2px; }
  .notice { border: 1px solid #443; background: #18170f; padding: 7px 9px; border-radius: 4px; margin: 0.7em 0; }
</style></head><body>
<h1>Skills · Read Only <span class="small" id="ts"></span></h1>
<nav class="small" style="margin-bottom:1em">
  <a href="/dashboard" style="color:#88c;margin-right:1em">Fleet</a>
  <a href="/dashboard/health" style="color:#88c;margin-right:1em">Health</a>
  <a href="/dashboard/skills" style="color:#88c;margin-right:1em"><b>Skills</b></a>
  <a href="/dashboard/learning" style="color:#88c;margin-right:1em">Learning</a>
  <a href="/dashboard/agents" style="color:#88c;margin-right:1em">Agents</a>
  <a href="/dashboard/graph" style="color:#88c">Graph</a>
</nav>
<div class="toolbar">
  <input id="filter" type="search" placeholder="search names, domains, descriptions, tags..." oninput="render()" autocomplete="off">
  <span class="small" id="resultCount"></span>
</div>
<div id="content">Loading…</div>
<script>
let SKILLS = [], STATS_BY_ID = new Map(), PROPOSALS = null, INDEX = null, INDEX_META = null;
let INDEX_STATUS = 'loading', INDEX_ERROR = '', INDEX_LOADED_AT = null;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = s => [
  s.data.skillId,
  s.name,
  s.description,
  s.data.domain,
  s.data.chainable ? 'chainable' : '',
  ...(s.data.tags || [])
].join(' ').toLowerCase();

async function load() {
  const params = new URLSearchParams({
    limit: '1000',
    sort: 'popular',
    offset: '0',
  });
  let d;
  try {
    const r = await fetch('/skills/index?' + params.toString(), { cache: 'no-store' });
    if (!r.ok) throw new Error('/skills/index returned ' + r.status);
    d = await r.json();
    INDEX_STATUS = 'fresh';
    INDEX_ERROR = '';
    INDEX_LOADED_AT = Date.now();
  } catch (err) {
    INDEX_STATUS = SKILLS.length ? 'stale' : 'unavailable';
    INDEX_ERROR = String(err?.message || err);
    document.getElementById('ts').textContent = new Date().toLocaleTimeString();
    render();
    return;
  }
  INDEX = d.data || null;
  INDEX_META = d.meta || null;
  SKILLS = (d.data?.nodes || []).map(s => ({
    id: 'skill:' + s.skillId,
    name: s.name,
    description: s.description,
    data: {
      skillId: s.skillId,
      domain: s.domain,
      computeCost: s.computeCost,
      chainable: s.chainable,
      tags: s.tags || [],
      useCount: s.useCount || 0
    }
  }));
  STATS_BY_ID = new Map();
  PROPOSALS = d.data?.proposalSummary ? { totals: d.data.proposalSummary, gaps: d.data.proposalGaps ?? [] } : PROPOSALS;
  // Fetch stats for top 50 skills (limit RPC chatter)
  const top = SKILLS.slice(0, 50);
  await Promise.all(top.map(async (s) => {
    try {
      const sr = await fetch('/graph/nodes/' + encodeURIComponent(s.data.skillId) + '/stats');
      if (sr.ok) STATS_BY_ID.set(s.data.skillId, await sr.json());
    } catch {}
  }));
  try {
    const pr = await fetch('/skill-proposals/report?limit=300');
    PROPOSALS = pr.ok ? await pr.json() : null;
  } catch {
    PROPOSALS = null;
  }
  document.getElementById('ts').textContent = new Date().toLocaleTimeString();
  render();
}

function render() {
  const q = document.getElementById('filter').value.trim().toLowerCase();
  const filtered = SKILLS
    .filter(s => !q || text(s).includes(q));
  const rows = filtered
    .map(s => {
      const statsFetched = STATS_BY_ID.has(s.data.skillId);
      const stats = STATS_BY_ID.get(s.data.skillId) || {};
      const notFetched = '<span class="caution">not fetched</span>';
      const executions = statsFetched ? esc(stats.executions ?? 0) : notFetched;
      const settle = statsFetched ? (stats.settleRate != null ? esc((stats.settleRate*100).toFixed(0)+'%') : '-') : notFetched;
      const avgDur = statsFetched ? (stats.avgDurationMs != null ? esc(stats.avgDurationMs) + 'ms' : '-') : notFetched;
      const tags = (s.data.tags || []).slice(0, 6).map(tag => '<span class="tag">' + esc(tag) + '</span>').join('') || '-';
      return '<tr>' +
        '<td>' + esc(s.data.skillId) + '</td>' +
        '<td><b>' + esc(s.name) + '</b><div class="desc">' + esc(s.description || '') + '</div></td>' +
        '<td>' + esc(s.data.domain || '-') + '</td>' +
        '<td>' + tags + '</td>' +
        '<td>' + (s.data.chainable ? 'yes' : 'no') + '</td>' +
        '<td>' + esc(s.data.computeCost ?? '-') + '</td>' +
        '<td>' + executions + '</td>' +
        '<td>' + settle + '</td>' +
        '<td>' + avgDur + '</td>' +
        '</tr>';
    }).join('');
  const proposalRows = (PROPOSALS?.gaps || []).slice(0, 25).map(g =>
    '<tr>' +
      '<td>' + esc(g.gap) + '</td>' +
      '<td>' + esc(g.demand) + '</td>' +
      '<td>' + esc(g.proposed) + '</td>' +
      '<td>' + esc(g.held) + '</td>' +
      '<td>' + esc(g.rejected) + '</td>' +
      '<td>' + esc(g.published) + '</td>' +
      '<td>' + esc(g.approvalsPending) + '</td>' +
      '<td>' + esc((g.sourceTextUnitIds?.length || 0) + (g.factIds?.length || 0)) + '</td>' +
      '<td>' + esc(g.avgHelpfulness == null ? '-' : g.avgHelpfulness) + '</td>' +
    '</tr>'
  ).join('');
  const proposalSummary = PROPOSALS ? '<h2>Proposal Quality</h2>' +
    '<p class="small">held ' + esc(PROPOSALS.totals.held) +
    ' · proposed ' + esc(PROPOSALS.totals.proposed) +
    ' · rejected ' + esc(PROPOSALS.totals.rejected) +
    ' · published ' + esc(PROPOSALS.totals.published) +
    ' · pending approvals ' + esc(PROPOSALS.totals.approvalsPending) +
    ' · invalid citations ' + esc(PROPOSALS.totals.invalidCitations || 0) +
    ' · repair candidates ' + esc(PROPOSALS.totals.citationRepairCandidates || 0) +
    ' · feedback ' + esc(PROPOSALS.totals.feedbackCount || 0) + '</p>' +
    '<table><tr><th>Gap</th><th>Demand</th><th>Proposed</th><th>Held</th><th>Rejected</th><th>Published</th><th>Pending</th><th>Evidence</th><th>Help</th></tr>' +
    proposalRows + '</table>' : '';
  const summary = INDEX?.summary || {};
  const source = INDEX_META?.source || {};
  const idaccDomain = (INDEX?.facets?.domains || INDEX?.domainSummaries || []).find(f => (f.domain || f.name) === 'idacc-library');
  const idaccTag = (INDEX?.facets?.tags || INDEX?.tagSummaries || []).find(f => (f.tag || f.name) === 'skill-catalog');
  const idaccCount = source.idaccLibraryRows ?? INDEX?.summary?.idaccCatalogSkills ?? idaccDomain?.count ?? idaccTag?.count ?? 0;
  const brainGraphCount = source.brainGraphRows ?? INDEX?.summary?.brainGraphSkills ?? source.graphRows ?? 0;
  const graphOnlyCount = source.graphOnlyRows ?? INDEX?.summary?.graphOnlySkills ?? 0;
  const freshness = INDEX_META?.freshness || {};
  const generated = INDEX_META?.generatedAt ? new Date(INDEX_META.generatedAt).toLocaleString() : 'unknown';
  const loaded = INDEX_LOADED_AT ? new Date(INDEX_LOADED_AT).toLocaleString() : 'never';
  const statusClass = INDEX_STATUS === 'fresh' ? 'safe' : INDEX_STATUS === 'stale' ? 'caution' : 'danger';
  const sourceNotice = '<div class="notice"><b>IDACC-synced skill view:</b> /skills/index · profile ' + esc(INDEX_META?.profile || 'local') +
    ' · dashboard fetch <span class="' + statusClass + '">' + esc(INDEX_STATUS) + '</span>' +
    ' · generated ' + esc(generated) +
    ' · loaded ' + esc(loaded) +
    ' · IDACC catalog skills ' + esc(idaccCount) +
    ' · Brain graph-only ' + esc(graphOnlyCount) +
    '<br><span class="small">Authority: ' + esc(source.authority || 'Brain skill graph') +
    ' · mode ' + esc(source.mode || 'additive graph index') +
    ' · install authority ' + esc(source.installAuthority === false ? 'no' : 'unknown') +
    ' · sync owner ' + esc(source.syncOwner || 'IDACC Capabilities') +
    ' · cache ' + esc(freshness.cacheControl || 'no-store expected') + '</span>' +
    '<br><span class="small">This read-only page lists the same local skill catalog used by IDACC Capabilities when available; Brain graph data is shown as read-only annotations and fallback. IDACC Capabilities remains the local install and delete authority.</span>' +
    '<br><span class="small">Brain skill graph is additive; IDACC local deletes and Brain-only learned nodes remain graph-review items rather than automatic removals.</span>' +
    '<br><span class="small">Optional-provider skill evidence can appear here, but keys, wallet secrets, auth tokens, and raw manager metadata are not exposed by dashboard payloads.</span>' +
    '<br><span class="small">Execution stats are fetched for the first 50 catalog rows only; all other rows show not fetched rather than zero.</span>' +
    (INDEX_ERROR ? '<br><span class="danger">Last refresh error: ' + esc(INDEX_ERROR) + '</span>' : '') +
    '</div>';
  const facetPills = (INDEX?.facets?.tags || INDEX?.tagSummaries || []).slice(0, 8).map(f => '<span class="tag">' + esc(f.tag || f.name) + ' (' + esc(f.count) + ')</span>').join('') || '<span class="small">No tag facets.</span>';
  const domainRows = (INDEX?.facets?.domains || INDEX?.domainSummaries || []).slice(0, 8).map(f =>
    '<tr><td>' + esc(f.domain || f.name) + '</td><td>' + esc(f.count) + '</td><td>' + esc(f.chainable ?? '-') + '</td></tr>'
  ).join('');
  const groupRows = (INDEX?.reuseGroups || []).slice(0, 10).map(g =>
    '<tr>' +
      '<td>' + esc(g.kind) + '</td>' +
      '<td><b>' + esc(g.label) + '</b></td>' +
      '<td>' + esc(g.count) + '</td>' +
      '<td>' + ((g.topSkills || []).slice(0, 3).map(skill => esc(skill.name)).join(', ') || '-') + '</td>' +
    '</tr>'
  ).join('');
  const reuseRows = (INDEX?.reuseSuggestions || []).slice(0, 10).map(s =>
    '<tr><td>' + esc(s.skillId) + '</td><td><b>' + esc(s.name) + '</b></td><td>' + esc(s.domain || '-') + '</td><td>' + (s.chainable ? 'yes' : 'no') + '</td><td>' + ((s.tags || []).slice(0, 4).map(tag => '<span class="tag">' + esc(tag) + '</span>').join('') || '-') + '</td></tr>'
  ).join('');
  document.getElementById('content').innerHTML =
    proposalSummary +
    sourceNotice +
    '<h2>Catalog Overview</h2><div class="metrics">' +
      '<div class="metric"><span class="small">Skills</span><b>' + esc(summary.totalSkills ?? SKILLS.length) + '</b></div>' +
      '<div class="metric"><span class="small">IDACC catalog skills</span><b>' + esc(idaccCount) + '</b></div>' +
      '<div class="metric"><span class="small">Brain graph skills</span><b>' + esc(brainGraphCount) + '</b></div>' +
      '<div class="metric"><span class="small">Chainable</span><b>' + esc(summary.chainable ?? INDEX?.counts?.chainable ?? 0) + '</b></div>' +
      '<div class="metric"><span class="small">Domains</span><b>' + esc(summary.domains ?? 0) + '</b></div>' +
      '<div class="metric"><span class="small">Tags</span><b>' + esc(summary.tags ?? 0) + '</b></div>' +
      '<div class="metric"><span class="small">Avg cost</span><b>' + esc(summary.averageComputeCost ?? '-') + '</b></div>' +
    '</div>' +
    '<h2>Facets</h2><div class="small">Filtered chainable ' + esc(INDEX?.counts?.chainable ?? 0) + ' · non-chainable ' + esc(INDEX?.counts?.nonChainable ?? 0) + ' · matches ' + esc(INDEX?.counts?.total ?? SKILLS.length) + '</div>' +
    '<div class="toolbar" style="margin-top:0.5em">' + facetPills + '</div>' +
    '<table><tr><th>Domain</th><th>Count</th><th>Chainable</th></tr>' + domainRows + '</table>' +
    '<h2>Reuse Groups</h2><table><tr><th>Kind</th><th>Group</th><th>Skills</th><th>Examples</th></tr>' + groupRows + '</table>' +
    '<h2>Reuse Suggestions</h2><table><tr><th>ID</th><th>Name</th><th>Domain</th><th>Chainable</th><th>Tags</th></tr>' + reuseRows + '</table>' +
    '<h2>Catalog</h2><table><tr><th>ID</th><th>Name</th><th>Domain</th><th>Tags</th><th>Chainable</th><th>Cost</th><th>Execs</th><th>Settle</th><th>Avg dur</th></tr>'
    + rows + '</table>'
    + '<p class="small">Showing ' + filtered.length + ' of ' + SKILLS.length + ' skills. Stats fetched for top 50 only; unfetched rows are labeled not fetched. Backed by /skills/index over names, descriptions, domains, and tags.</p>';
  document.getElementById('resultCount').textContent = filtered.length + ' / ' + SKILLS.length + ' skills';
}

load(); setInterval(load, 60000);
</script>
</body></html>`;

// ─── /dashboard/agents — per-agent SLA + cost ─────────────────────────────────
export const DASHBOARD_AGENTS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agents · Brain Read Only</title>
<style>
  body { font: 13px/1.4 -apple-system, monospace; max-width: 1100px; margin: 1em auto; padding: 0 1em; color: #d4d4d4; background: #111; }
  h1 { font-size: 18px; margin: 0 0 0.5em; }
  table { border-collapse: collapse; width: 100%; margin: 0.3em 0; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #333; text-align: left; font-size: 12px; }
  th { color: #88c; }
  .small { font-size: 11px; color: #777; }
  .green { color: #5dd55d; } .red { color: #f55; } .yellow { color: #ec9; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px; margin: 0.75em 0 1em; }
  .card { border: 1px solid #333; border-radius: 6px; background: #151515; padding: 8px 10px; }
  .card h2 { margin: 0 0 6px; font-size: 13px; color: #88c; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style></head><body>
<h1>Agents · Read Only <span class="small" id="ts"></span></h1>
<nav class="small" style="margin-bottom:1em">
  <a href="/dashboard" style="color:#88c;margin-right:1em">Fleet</a>
  <a href="/dashboard/health" style="color:#88c;margin-right:1em">Health</a>
  <a href="/dashboard/skills" style="color:#88c;margin-right:1em">Skills</a>
  <a href="/dashboard/learning" style="color:#88c;margin-right:1em">Learning</a>
  <a href="/dashboard/agents" style="color:#88c;margin-right:1em"><b>Agents</b></a>
  <a href="/dashboard/graph" style="color:#88c">Graph</a>
</nav>
<div id="content">Loading…</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SLA_FETCH_LIMIT = 50;
const short = s => {
  const v = String(s ?? '');
  return v.length > 28 ? v.slice(0, 12) + '...' + v.slice(-10) : v;
};
function ethDisplay(value) {
  const text = String(value ?? '0');
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 0.000001) return n.toExponential(2);
  if (n < 1) return n.toFixed(6).replace(/0+$/, '').replace(/\\.$/, '');
  return n.toFixed(4).replace(/0+$/, '').replace(/\\.$/, '');
}
function controllerForAgent(controllers, agent, hasDuplicateName) {
  const strongIds = new Set([
    agent.id,
    agent.team && agent.name ? agent.team + ':' + agent.name : null,
    agent.team && agent.name ? agent.team + '/' + agent.name : null,
  ].filter(Boolean));
  const bareIds = new Set(['agent:' + agent.name, agent.name].filter(Boolean));
  const linksFor = c => c.agent_links || c.agentLinks || [];
  const strong = controllers.find(c => linksFor(c).some(l => strongIds.has(l.agent_id || l.agentId)));
  if (strong || hasDuplicateName) return strong || null;
  return controllers.find(c => linksFor(c).some(l => bareIds.has(l.agent_id || l.agentId)));
}
function controllerCard(c, unavailable = false) {
  if (!c) {
    return '<div class="card"><h2>Accountable controller</h2><div class="small">' +
      (unavailable ? 'Controller registry unavailable; links are unknown.' : 'No controller linked.') +
    '</div></div>';
  }
  const meta = c.metadata || {};
  const links = c.agent_links || c.agentLinks || [];
  const revocation = meta.revocation_status || meta.revocationStatus || c.status || 'active';
  const agentSafe = meta.agent_safe || meta.agentSafe || meta.safe || '-';
  const runtimeKeys = meta.runtime_keys || meta.runtimeKeys || meta.session_keys || meta.sessionKeys || '-';
  const permissions = meta.app_permissions || meta.appPermissions || meta.api_permissions || meta.apiPermissions || '-';
  return '<div class="card">' +
    '<h2>Accountable controller</h2>' +
    '<table>' +
      '<tr><td>Controller</td><td><b>' + esc(c.label || c.name || c.controller_id) + '</b> <span class="small">(' + esc(c.type) + ')</span></td></tr>' +
      '<tr><td>Scope user_id</td><td class="mono">' + esc(short(c.scope_user_id || c.controller_id)) + '</td></tr>' +
      '<tr><td>Wallet/org</td><td class="mono">' + esc(short(c.primary_wallet || c.name || c.controller_id)) + '</td></tr>' +
      '<tr><td>Agent Safe</td><td class="mono">' + esc(short(agentSafe)) + '</td></tr>' +
      '<tr><td>Runtime/session keys</td><td>' + esc(Array.isArray(runtimeKeys) ? runtimeKeys.join(', ') : runtimeKeys) + '</td></tr>' +
      '<tr><td>App/API permissions</td><td>' + esc(Array.isArray(permissions) ? permissions.join(', ') : permissions) + '</td></tr>' +
      '<tr><td>Revocation</td><td class="' + (revocation === 'active' ? 'green' : 'yellow') + '">' + esc(revocation) + '</td></tr>' +
      '<tr><td>Agent links</td><td>' + links.length + '</td></tr>' +
    '</table>' +
  '</div>';
}
async function load() {
  const [fr, er, cr] = await Promise.all([
    fetch('/fleet-report', { cache: 'no-store' }),
    fetch('/entities?type=agent&limit=200', { cache: 'no-store' }),
    fetch('/controllers?limit=200', { cache: 'no-store' })
  ]);
  const fd = fr.ok ? await fr.json() : { fleet: { source: 'unavailable', agents: [], warnings: ['fleet-report unavailable'] } };
  const d = await er.json();
  const controllersAvailable = cr.ok;
  const cd = controllersAvailable ? await cr.json() : { controllers: [] };
  const cachedAgents = d.entities.map(e => ({...e, team: (typeof e.data === 'string' ? JSON.parse(e.data || '{}') : (e.data || {})).team, data: typeof e.data === 'string' ? JSON.parse(e.data || '{}') : e.data}));
  const liveSource = String(fd.fleet?.source || '');
  const authority = fd.fleet?.authority || (liveSource === 'brain-cache' ? 'cache' : liveSource === 'live-manager-partial' ? 'partial' : liveSource === 'live-manager' ? 'live' : 'unknown');
  const authoritative = fd.fleet?.authoritative === true;
  const cacheOnly = authority === 'cache' || liveSource === 'brain-cache';
  const partial = authority === 'partial' || liveSource === 'live-manager-partial';
  const statusAuthority = fd.fleet?.statusAuthorityLabel || (authoritative ? 'Live manager current-state snapshot' : cacheOnly ? 'Brain cache fallback; cached agent statuses are not live current-state proof' : 'Partial manager snapshot');
  const liveAgents = (fd.fleet?.agents || []).map(a => ({
    id: a.id,
    name: a.name,
    status: a.status,
    team: a.team,
    source: a.source,
    identity: a.identity || {},
    skillmesh: a.skillmesh || {},
    wallet: a.wallet || {},
    controllerWallet: a.controllerWallet || {},
    capabilities: a.capabilities || {},
    credentialRedaction: a.credentialRedaction || {},
    onchain: a.onchain || {},
    data: { model: a.model, runtime: a.runtime, port: a.port, pid: a.pid, team: a.team }
  }));
  const agents = liveSource.startsWith('live-manager') ? liveAgents : cachedAgents;
  const controllers = cd.controllers || [];
  const nameCounts = agents.reduce((map, agent) => map.set(agent.name, (map.get(agent.name) || 0) + 1), new Map());
  const duplicateNames = new Set(Array.from(nameCounts.entries()).filter(([, count]) => count > 1).map(([name]) => name));
  agents.forEach(a => { a.sla = { omitted: true }; });
  // Fetch SLA for the first page only; omitted rows must remain unknown, not zero.
  await Promise.all(agents.slice(0, SLA_FETCH_LIMIT).map(async (a) => {
    try {
      if (duplicateNames.has(a.name)) {
        a.sla = { ambiguous: true };
        return;
      }
      const r = await fetch('/entities/agent:' + encodeURIComponent(a.name) + '/sla');
      a.sla = r.ok ? await r.json() : { unavailable: true };
    } catch { a.sla = { unavailable: true }; }
  }));
  document.getElementById('ts').textContent = new Date().toLocaleTimeString();
  const rows = agents.sort((a, b) => String(a.team || '').localeCompare(String(b.team || '')) || (a.status || '').localeCompare(b.status || '') || a.name.localeCompare(b.name))
    .map(a => {
      const rawStatus = String(a.status || '-');
      const statusNorm = rawStatus.toLowerCase();
      const healthLabel = statusNorm === 'online' || statusNorm === 'ok';
      const cls = cacheOnly || partial ? 'yellow' : statusNorm === 'running' ? 'green' : /^(online|ok|pending|starting|processing)$/.test(statusNorm) ? 'yellow' : 'red';
      const statusText = cacheOnly
        ? 'cached: ' + rawStatus
        : partial
          ? 'known: ' + rawStatus
          : healthLabel
            ? 'health label: ' + rawStatus
            : rawStatus;
      const sla = a.sla || {};
      const duplicateName = duplicateNames.has(a.name);
      const controller = controllerForAgent(controllers, a, duplicateName);
      const controllerCell = !controllersAvailable
        ? '<span class="yellow">unknown</span>'
        : controller
        ? esc(controller.label || controller.name || short(controller.controller_id))
        : duplicateName
          ? '<span class="yellow">ambiguous</span>'
          : '<span class="yellow">unlinked</span>';
      const telemetryCell = value => sla.ambiguous
        ? '<span class="yellow">ambiguous</span>'
        : sla.omitted
          ? '<span class="yellow">not fetched</span>'
          : sla.unavailable
            ? '<span class="yellow">unavailable</span>'
            : value;
      const latencyValue = sla.latencyMs ? esc(sla.latencyMs.p50 ?? '-') + '/' + esc(sla.latencyMs.p95 ?? '-') + 'ms' : '<span class="yellow">unknown</span>';
      const costValue = sla.cost?.totalUsd != null ? '$' + sla.cost.totalUsd.toFixed(4) : '<span class="yellow">unknown</span>';
      const probeValue = sla.watchdogProbeFailures != null ? esc(sla.watchdogProbeFailures) : '<span class="yellow">unknown</span>';
      const latencyCell = telemetryCell(latencyValue);
      const costCell = telemetryCell(costValue);
      const probeCell = telemetryCell(probeValue);
      const controllerWallet = a.controllerWallet || a.onchain?.controllerWallet || {};
      const controllerWalletCell = controllerWallet.address
        ? '<span class="mono">' + esc(short(controllerWallet.address)) + '</span><div class="small">' + esc(controllerWallet.source || 'Identity & Keys') + '</div>'
        : '<span class="yellow">missing</span>';
      const gas = a.onchain?.gasSpend || {};
      const totalGasCell = Number(gas.samples || 0) > 0
        ? '<span class="mono">' + esc(ethDisplay(gas.totalEth)) + ' ETH</span><div class="small">' + esc(gas.samples) + ' event' + (Number(gas.samples) === 1 ? '' : 's') + '</div>'
        : '<span class="yellow">none seen</span>';
      const gas24Cell = Number(gas.last24hSamples || 0) > 0
        ? '<span class="mono">' + esc(ethDisplay(gas.last24hEth)) + ' ETH</span><div class="small">last 24h</div>'
        : '<span class="yellow">0 ETH</span>';
      const providerCell = a.skillmesh?.address
        ? '<span class="mono">' + esc(short(a.skillmesh.address)) + '</span><div class="small">key ' + esc(a.skillmesh.keyIndex ?? '-') + ' · secrets redacted</div>'
        : '<span class="yellow">not reported</span>';
      const skillCell = '<span>' + esc(a.capabilities?.skillCount ?? 0) + '</span>' +
        ((a.capabilities?.skills || []).length ? '<div class="small">' + (a.capabilities.skills || []).slice(0, 3).map(esc).join(', ') + ((a.capabilities.skills || []).length > 3 ? ' +' + ((a.capabilities.skills || []).length - 3) : '') + '</div>' : '');
      return '<tr>' +
        '<td>' + esc(a.team || '-') + '</td>' +
        '<td>' + esc(a.name) + '</td>' +
        '<td>' + controllerCell + '</td>' +
        '<td>' + controllerWalletCell + '</td>' +
        '<td class="' + cls + '">' + esc(statusText) + '</td>' +
        '<td>' + esc(a.data.model || '-') + '</td>' +
        '<td>' + esc(a.data.runtime || '-') + '</td>' +
        '<td>' + totalGasCell + '</td>' +
        '<td>' + gas24Cell + '</td>' +
        '<td>' + providerCell + '</td>' +
        '<td>' + skillCell + '</td>' +
        '<td>' + latencyCell + '</td>' +
        '<td>' + costCell + '</td>' +
        '<td>' + probeCell + '</td>' +
        '</tr>';
    }).join('');
  const warnings = fd.fleet?.warnings || [];
  const slaCovered = Math.min(agents.length, SLA_FETCH_LIMIT);
  const slaOmitted = Math.max(0, agents.length - slaCovered);
  const sourceNote = '<p class="small">Fleet source: ' + esc(fd.fleet?.source || 'unknown') +
    '<br>Read-only source owner: ' + esc(fd.fleet?.idaccAuthority?.owner || 'IDACC manager') + ' · ' + esc(fd.fleet?.idaccAuthority?.sourceRoute || 'manager/fallback snapshot') +
    '<br>Status authority: ' + esc(statusAuthority) +
    '<br>Running proof: only exact status "running" is green; online/ok are health labels, not process-running proof.' +
    '<br>Identity wallet alignment: controller wallet uses the same precedence as IDACC Identity & Keys: ows_address, optional provider wallet address, then address-shaped OWS wallet.' +
    '<br>Gas spend: total and 24h ETH are read-only Brain timeline aggregates matched by agent identity/controller wallet; missing events mean unknown or none recorded, not zero-chain-cost proof.' +
    '<br>Credential policy: ' + esc(fd.fleet?.providers?.skillmesh?.secretPolicy || fd.fleet?.skillmesh?.secretPolicy || 'private keys, auth tokens, wallet secrets, and raw manager metadata are not exposed') +
    (fd.fleet?.cacheDrift?.status === 'drift' ? ' · live ' + esc(fd.fleet.cacheDrift.liveTotal) + ' vs Brain cache ' + esc(fd.fleet.cacheDrift.cachedTotal) : '') +
    (warnings.length ? '<br><span class="yellow">' + warnings.map(esc).join('<br>') + '</span>' : '') +
    (cacheOnly ? '<br><span class="yellow">Cached rows are not live current-state proof. Use IDACC Health or restore manager polling before lifecycle decisions.</span>' : '') +
    (partial ? '<br><span class="yellow">Partial manager rows are incomplete; do not infer missing teams from Brain cache.</span>' : '') +
    (!controllersAvailable ? '<br><span class="yellow">Controller registry unavailable; account links are unknown, not unlinked.</span>' : '') +
    (duplicateNames.size ? '<br><span class="yellow">Same-name agents detected: ' + Array.from(duplicateNames).map(esc).join(', ') + '. SLA and bare controller links are held as ambiguous until scoped telemetry exists.</span>' : '') +
    '</p>';
  const controllerRows = controllersAvailable
    ? controllers.map(c =>
      '<tr>' +
        '<td>' + esc(c.label || c.name || c.controller_id) + '</td>' +
        '<td>' + esc(c.type) + '</td>' +
        '<td class="mono">' + esc(short(c.primary_wallet || c.name || c.controller_id)) + '</td>' +
        '<td class="mono">' + esc(short(c.scope_user_id || c.controller_id)) + '</td>' +
        '<td>' + esc(c.status || '-') + '</td>' +
        '<td>' + ((c.agent_links || c.agentLinks || []).length) + '</td>' +
      '</tr>'
    ).join('')
    : '<tr><td colspan="6"><span class="yellow">Controller registry unavailable; not proof that agents are unlinked.</span></td></tr>';
  document.getElementById('content').innerHTML =
    '<div class="cards">' + (controllers.length ? controllers.slice(0, 3).map(c => controllerCard(c, false)).join('') : controllerCard(null, !controllersAvailable)) + '</div>' +
    '<div class="cards"><div class="card"><h2>Onchain gas spend</h2><table>' +
      '<tr><td>Total ETH</td><td class="mono">' + esc(ethDisplay(fd.fleet?.onchainGas?.totalEth)) + '</td></tr>' +
      '<tr><td>Last 24h ETH</td><td class="mono">' + esc(ethDisplay(fd.fleet?.onchainGas?.last24hEth)) + '</td></tr>' +
      '<tr><td>Matched events</td><td>' + esc(fd.fleet?.onchainGas?.matchedEvents ?? 0) + ' matched · ' + esc(fd.fleet?.onchainGas?.unassignedEvents ?? 0) + ' unassigned</td></tr>' +
      '<tr><td>Source</td><td>' + esc(fd.fleet?.onchainGas?.source || 'Brain timeline onchain/gas events') + '</td></tr>' +
    '</table></div></div>' +
    '<div class="cards"><div class="card"><h2>Optional provider identity</h2><table>' +
      '<tr><td>Addresses</td><td>' + esc(fd.fleet?.providers?.skillmesh?.agentsWithSkillmeshAddress ?? fd.fleet?.skillmesh?.agentsWithSkillmeshAddress ?? 0) + '</td></tr>' +
      '<tr><td>Key indexes</td><td>' + esc(fd.fleet?.providers?.skillmesh?.agentsWithSkillmeshKeyIndex ?? fd.fleet?.skillmesh?.agentsWithSkillmeshKeyIndex ?? 0) + ' · secrets redacted</td></tr>' +
      '<tr><td>Advertised skills</td><td>' + esc(fd.fleet?.providers?.skillmesh?.advertisedSkillsTotal ?? fd.fleet?.skillmesh?.advertisedSkillsTotal ?? 0) + ' assignments · ' + esc(fd.fleet?.providers?.skillmesh?.uniqueAdvertisedSkills ?? fd.fleet?.skillmesh?.uniqueAdvertisedSkills ?? 0) + ' unique</td></tr>' +
      '<tr><td>Public wallets</td><td>' + esc(fd.fleet?.providers?.skillmesh?.agentsWithOwsAddress ?? fd.fleet?.skillmesh?.agentsWithOwsAddress ?? 0) + '</td></tr>' +
      '<tr><td>Controller wallets</td><td>' + esc(fd.fleet?.providers?.skillmesh?.agentsWithControllerWallet ?? fd.fleet?.skillmesh?.agentsWithControllerWallet ?? 0) + ' aligned with Identity & Keys</td></tr>' +
    '</table></div></div>' +
    sourceNote +
    '<table><tr><th>Team</th><th>Agent</th><th>Accountable controller</th><th>Controller wallet</th><th>Status</th><th>Model</th><th>Runtime</th><th>Total gas ETH</th><th>24h gas ETH</th><th>Provider</th><th>Skills</th><th>p50/p95 7d</th><th>Cost 7d</th><th>Probe fails</th></tr>'
    + rows + '</table>'
    + '<p class="small">' + agents.length + ' agents. SLA coverage: fetched ' + slaCovered + '/' + agents.length + '; ' + slaOmitted + ' rows intentionally show not fetched. Treat missing SLA/cost/probe cells as unknown, not healthy.</p>' +
    '<h2 style="font-size:14px;color:#88c;margin-top:1.4em">Controllers</h2>' +
    '<table><tr><th>Controller</th><th>Type</th><th>Wallet/org</th><th>Scope user_id</th><th>Status</th><th>Agent links</th></tr>' + controllerRows + '</table>';
}
load(); setInterval(load, 60000);
</script>
</body></html>`;

// ─── /dashboard/learning — self-learning health and curator queue ────────────
export const DASHBOARD_LEARNING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Learning · Brain Read Only</title>
<style>
  body { font: 13px/1.4 -apple-system, monospace; max-width: 1100px; margin: 1em auto; padding: 0 1em; color: #d4d4d4; background: #111; }
  h1 { font-size: 18px; margin: 0 0 0.5em; }
  h2 { font-size: 14px; margin: 1.4em 0 0.4em; color: #88c; }
  table { border-collapse: collapse; width: 100%; margin: 0.3em 0; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #333; text-align: left; font-size: 12px; vertical-align: top; }
  th { color: #88c; }
  .small { font-size: 11px; color: #777; }
  .green { color: #5dd55d; } .red { color: #f55; } .yellow { color: #ec9; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; margin: 0.75em 0 1em; }
  .card { border: 1px solid #333; border-radius: 6px; background: #151515; padding: 8px 10px; }
  .card h3 { margin: 0 0 4px; font-size: 12px; color: #88c; }
</style></head><body>
<h1>Learning · Read Only <span class="small" id="ts"></span></h1>
<nav class="small" style="margin-bottom:1em">
  <a href="/dashboard" style="color:#88c;margin-right:1em">Fleet</a>
  <a href="/dashboard/health" style="color:#88c;margin-right:1em">Health</a>
  <a href="/dashboard/skills" style="color:#88c;margin-right:1em">Skills</a>
  <a href="/dashboard/learning" style="color:#88c;margin-right:1em"><b>Learning</b></a>
  <a href="/dashboard/agents" style="color:#88c;margin-right:1em">Agents</a>
  <a href="/dashboard/graph" style="color:#88c">Graph</a>
</nav>
<div id="content">Loading…</div>
<script>
const pct = v => v == null ? '-' : (v * 100).toFixed(0) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let PASSIVE_REPORT_LOADED_AT = null;
let EVAL_REPLAY_REVIEW = null;
function clock(value) {
  return value ? value.toLocaleTimeString() : '-';
}
function replayFreshness() {
  return { klass: 'yellow', label: 'Eval replay is not run from this read-only dashboard.' };
}
async function fetchLearningReport() {
  const r = await fetch('/brain/learning-report?days=7', { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error?.message || body.error || r.statusText);
  return body;
}
async function load() {
	  try {
	    const [lr, mr, ar] = await Promise.all([
	      fetchLearningReport(),
	      fetch('/metrics/learning?days=7').then(r => r.json()),
	      fetch('/approvals?status=pending&limit=25').then(r => r.json()),
	    ]);
    PASSIVE_REPORT_LOADED_AT = new Date();
    const report = lr.report || {};
    const metrics = mr.metrics || {};
	    const evals = report.eval || {};
	    EVAL_REPLAY_REVIEW = evals.manualReplay || null;
    const signal = report.signal || {};
    const precision = report.contextPrecision || {};
    const retire = report.memoryRetirement || {};
    const instructionFeedback = report.instructionFeedback || {};
    const fixturePromotion = report.fixturePromotion || {};
    const fixtureLifecycle = report.fixtureLifecycle || { counts: {} };
    const citationRepair = report.citationRepair || {};
    const phaseImprovements = report.phaseImprovements || { counts: {}, byPhase: [], outcomes: [] };
    const trajectoryReflection = report.trajectoryReflection || { rawMemories: 0, heuristicMemories: 0, pendingCompaction: 0, recentHeuristics: [] };
    const nextRecommendations = report.nextRecommendations || [];
    const learningTaskQueue = report.learningTaskQueue || { byStatus: {}, byKind: [], byAssignee: [] };
    const approvals = ar.approvals || [];
    const feedbackWarn = evals.feedbackMissingRate != null && evals.feedbackMissingRate >= 0.25
      ? '<tr><td class="yellow">Feedback missing</td><td class="yellow">' + esc(evals.feedbackMissing ?? 0) + ' events · ' + esc(pct(evals.feedbackMissingRate)) + ' of volunteered completions</td></tr>'
      : '<tr><td>Feedback missing</td><td>' + esc(evals.feedbackMissing ?? 0) + (evals.feedbackMissingRate == null ? '' : ' · ' + esc(pct(evals.feedbackMissingRate))) + '</td></tr>';
    const replayState = replayFreshness();
    const routes = '<tr><td colspan="5" class="small">Route comparison requires a reviewed eval replay outside this read-only dashboard.</td></tr>';
    const sourceRows = rows => (rows || []).map(s =>
      '<tr><td>' + esc(s.source_id) + '</td><td>' + esc(s.kind) + '</td><td>' + esc(s.volunteered) + '</td><td>' + esc(s.used) + '</td><td>' + esc(pct(s.precision)) + '</td><td>' + esc(s.score) + '</td></tr>'
    ).join('');
    const originRows = (precision.origins || []).map(o =>
      '<tr><td>' + esc(o.origin) + '</td><td>' + esc(o.volunteered) + '</td><td>' + esc(o.used) + '</td><td>' + esc(pct(o.precision)) + '</td></tr>'
    ).join('');
    const agentRows = (report.agents || []).map(a =>
      '<tr><td>' + esc(a.agent_id) + '</td><td>' + esc(a.eval_samples) + '</td><td>' + esc(a.volunteered_samples) + '</td><td>' + esc(a.feedback_supplied) + '</td><td>' + esc(a.feedback_missing) + '</td><td>' + esc(pct(a.feedback_missing_rate)) + '</td><td>' + esc(pct(a.citation_feedback_rate)) + '</td><td>' + esc(a.learned_artifacts) + '</td><td>' + esc(pct(a.citation_coverage)) + '</td><td>' + esc(a.uncited_artifacts ?? 0) + '</td></tr>'
    ).join('');
    const uncitedTotal = (report.agents || []).reduce((sum, a) => sum + (a.uncited_artifacts ?? 0), 0);
    const learnedTotal = (report.agents || []).reduce((sum, a) => sum + (a.learned_artifacts ?? 0), 0);
    const uncitedCoverage = (learnedTotal + uncitedTotal)
      ? Math.round((learnedTotal / (learnedTotal + uncitedTotal)) * 100) + '%'
      : '-';
    const uncitedRow = '<tr' + (uncitedTotal ? ' class="yellow"' : '') + '><td>Uncited learned facts</td><td>' + esc(uncitedTotal) + ' uncited · ' + esc(learnedTotal) + ' cited · ' + esc(uncitedCoverage) + ' coverage</td></tr>';
    const vectorBlock = '';
    const contradictions = approvals.filter(a => a.kind === 'fact.contradiction').map(a => {
      const claims = (a.payload?.claims || []).map(c => '#' + esc(c.id) + ' ' + esc(c.field) + '=' + esc(JSON.stringify(c.value))).join('<br>');
      return '<tr><td>' + esc(a.id) + '</td><td>' + esc(a.subject) + '</td><td>' + claims + '</td></tr>';
    }).join('');
    const retireRows = (retire.candidates || []).map(m =>
      '<tr><td>' + esc(m.source_id) + '</td><td>' + esc(m.key || '') + '</td><td>' + esc(m.ignored_count) + '</td><td>' + esc(m.suggestedReason) + '</td></tr>'
    ).join('');
    const instructionRows = (instructionFeedback.candidates || []).map(m =>
      '<tr><td>' + esc(m.source_id) + '</td><td>' + esc(m.key || '') + '</td><td>' + esc(m.suggestedAction || '') + '</td><td>' + esc(m.ignored_count) + '</td><td>' + esc(m.harmful_count) + '</td><td>' + esc(m.scope?.label || '') + '</td><td>' + esc(m.suggestedReason) + '</td></tr>'
    ).join('');
    const instructionScopeRows = (instructionFeedback.scopes || []).map(s =>
      '<tr><td>' + esc(s.source_id) + '</td><td>' + esc(s.key || '') + '</td><td>' + esc(s.scope_label || '') + '</td><td>' + esc(s.feedback_count) + '</td><td>' + esc(s.used_count) + '</td><td>' + esc(s.ignored_count) + '</td><td>' + esc(s.harmful_count) + '</td><td>' + esc(pct(s.precision)) + '</td></tr>'
    ).join('');
    const fixtureRows = (fixturePromotion.candidates || []).map(f =>
      '<tr><td>' + esc(f.eval_query_id) + '</td><td>' + esc(f.route || '') + '</td><td>' + esc(f.query_text || '') + '</td><td>' + esc((f.required_source_ids || []).length) + '</td><td>' + esc((f.required_strings || []).length) + '</td><td>' + esc(f.suggestedReason) + '</td></tr>'
    ).join('');
    const staleFixtureRows = (fixtureLifecycle.stale || []).map(f =>
      '<tr><td>' + esc(f.id) + '</td><td>' + esc(f.route || '') + '</td><td>' + esc(f.query_text || '') + '</td><td>' + esc(f.stale_reason || '') + '</td><td>' + esc((f.evidence?.invalid_source_ids || []).join(', ')) + '</td></tr>'
    ).join('');
    const failingFixtureRows = (fixtureLifecycle.failing || []).map(f =>
      '<tr><td>' + esc(f.id) + '</td><td>' + esc(f.route || '') + '</td><td>' + esc(f.query_text || '') + '</td><td>' + esc(f.failure_count || 0) + '</td></tr>'
    ).join('');
    const citationRepairRows = (citationRepair.candidates || []).map(c =>
      '<tr><td>' + esc(c.gap || '') + '</td><td>' + esc(c.issue || '') + '</td><td>' + esc(c.suggested_action || '') + '</td><td>' + esc(c.count) + '</td><td>' + esc((c.invalid_source_ids || []).join(', ')) + '</td></tr>'
    ).join('');
    const phaseImprovementRows = (phaseImprovements.outcomes || []).slice(0, 10).map(o =>
      '<tr><td>' + esc(o.phase || '') + '</td><td>' + esc(o.outcome || '') + '</td><td>' + esc(o.delta == null ? '-' : o.delta) + '</td><td>' + esc(o.before?.precision == null ? '-' : pct(o.before.precision)) + '</td><td>' + esc(o.after?.precision == null ? '-' : pct(o.after.precision)) + '</td><td>' + esc(o.recommendation || '') + '</td></tr>'
    ).join('');
    const trajectoryRows = (trajectoryReflection.recentHeuristics || []).slice(0, 10).map(row =>
      '<tr><td>' + esc(row.key || '') + '</td><td>' + esc(row.heuristic?.route || '') + '</td><td>' + esc(row.heuristic?.task_id || row.heuristic?.query_id || '') + '</td><td>' + esc(Array.isArray(row.heuristic?.cited_source_ids) ? row.heuristic.cited_source_ids.length : 0) + '</td><td>' + esc((row.heuristic?.outcome_tags || []).join(', ')) + '</td></tr>'
    ).join('');
    const recommendationRows = (nextRecommendations || []).map(item =>
      '<tr><td>' + esc(item.surface || '') + '</td><td>' + esc(item.priority || '') + '</td><td>' + esc(item.action || '') + '</td><td>' + esc(item.phase || item.task_id || '') + '</td></tr>'
    ).join('');
    const learningTaskKindRows = (learningTaskQueue.byKind || []).map(k =>
      '<tr><td>' + esc(k.kind || '') + '</td><td>' + esc(k.total) + '</td><td>' + esc(k.queued || 0) + '</td><td>' + esc(k.assigned || 0) + '</td><td>' + esc(k.in_progress || 0) + '</td><td>' + esc(k.blocked || 0) + '</td><td>' + esc(k.completed || 0) + '</td></tr>'
    ).join('');
    const learningTaskAssigneeRows = (learningTaskQueue.byAssignee || []).map(a =>
      '<tr><td>' + esc(a.assignee || '') + '</td><td>' + esc(a.total) + '</td><td>' + esc(a.queued || 0) + '</td><td>' + esc(a.assigned || 0) + '</td><td>' + esc(a.in_progress || 0) + '</td><td>' + esc(a.blocked || 0) + '</td><td>' + esc(a.completed || 0) + '</td></tr>'
    ).join('');
    const learningApprovals = approvals.filter(a => a.kind !== 'fact.contradiction').map(a =>
      '<tr><td>' + esc(a.id) + '</td><td>' + esc(a.kind) + '</td><td>' + esc(a.subject) + '</td><td>' + esc(a.payload?.suggested_reason || a.payload?.suggestedReason || '') + '</td></tr>'
    ).join('');
    const measuredCard = [
      '<div class="card">',
      '<h3>Measured</h3>',
      '<div>volunteered ' + esc(metrics.counters?.volunteeredSources ?? 0) + ' sources</div>',
      '<div>accepted ' + esc(metrics.counters?.acceptedSources ?? 0) + ' sources</div>',
      '<div>feedback-missing ' + esc(metrics.counters?.feedbackMissing ?? 0) + '</div>',
      '<div>approvals ' + esc(metrics.counters?.approvalsOpened ?? 0) + ' opened · ' + esc(metrics.counters?.approvalsPending ?? 0) + ' pending</div>',
      '<div>rollbacks ' + esc(metrics.counters?.rollbacks ?? 0) + '</div>',
      '<div>route-skew ' + (metrics.routeSkew?.skew ? 'warn' : 'ok') + '</div>',
      '</div>',
    ].join('');
    const inferredCard = [
      '<div class="card">',
      '<h3>Inferred rollups</h3>',
      '<div>source-precision snapshots ' + (report.contextPrecision?.latestSnapshot?.length ?? 0) + ' rows</div>',
      '<div>instruction-scope snapshots ' + (instructionFeedback.scopeSnapshots?.rows?.length ?? 0) + ' rows</div>',
      '<div>durable daily exports available as CSV or JSON</div>',
      '<div><a href="/brain/learning-history?days=7&format=json" style="color:#88c">JSON export</a> · <a href="/brain/learning-history?days=7&format=csv" style="color:#88c">CSV export</a></div>',
      '</div>',
    ].join('');
    const exportCard = [
      '<div class="card">',
      '<h3>Learning history export</h3>',
      '<div class="small">Rows combine daily source-precision and instruction-scope snapshots.</div>',
      '<div style="margin-top:4px"><a href="/brain/learning-history?days=7&format=json" style="color:#88c">Open JSON</a></div>',
      '<div><a href="/brain/learning-history?days=7&format=csv" style="color:#88c">Download CSV</a></div>',
      '</div>',
    ].join('');
	    const replayCard = [
	      '<div class="card">',
	      '<h3>Eval replay</h3>',
	      '<div id="replay-status">read-only observation</div>',
	      '<div class="' + esc(replayState.klass) + '">' + esc(replayState.label) + '</div>',
	      '<div class="small">Reviewed replay sample set: ' + esc(EVAL_REPLAY_REVIEW?.sampleCount ?? 0) + ' samples · stamp ' + (EVAL_REPLAY_REVIEW?.stamp ? 'loaded' : 'missing') + '</div>',
      '<div class="small">No POST actions are exposed here; run reviewed eval/vector actions from IDACC or an operator workflow.</div>',
      '</div>',
    ].join('');
    document.getElementById('ts').textContent = new Date().toLocaleTimeString();
    document.getElementById('content').innerHTML =
      '<div class="small">Measured counters come from live metrics; inferred rollups come from durable daily snapshots. Passive reports refreshed ' + clock(PASSIVE_REPORT_LOADED_AT) + '; this page is read-only.</div>' +
      '<div class="cards">' + measuredCard + inferredCard + exportCard + replayCard + '</div>' +
      '<h2>Seven Day Signal</h2>' +
      '<table><tr><td>Useful/noisy</td><td>' + esc(signal.useful ?? 0) + '/' + esc(signal.noisy ?? 0) + '</td></tr>' +
      '<tr><td>Promoted memories</td><td>' + esc(report.promotedMemories ?? 0) + '</td></tr>' +
      '<tr><td>Repeated contradictions</td><td>' + esc(report.repeatedContradictions ?? 0) + '</td></tr>' +
      '<tr><td>Approvals opened/resolved</td><td>' + esc(report.approvals?.opened ?? 0) + '/' + esc(report.approvals?.resolved ?? 0) + '</td></tr>' +
      '<tr><td>Approvals pending/resolved</td><td>' + esc(report.approvals?.pending ?? 0) + '/' + esc(report.approvals?.resolved ?? 0) + '</td></tr>' +
      '<tr><td>Skills held/proposed/published</td><td>' + esc(report.skills?.held ?? 0) + '/' + esc(report.skills?.proposed ?? 0) + '/' + esc(report.skills?.published ?? 0) + '</td></tr>' +
      '<tr><td>Eval samples</td><td>' + esc(evals.samples ?? 0) + '</td></tr>' +
      '<tr><td>Fixture candidates</td><td>' + esc(fixturePromotion.candidateCount ?? 0) + '</td></tr>' +
      '<tr><td>Fixture lifecycle</td><td>' + esc(fixtureLifecycle.counts?.active ?? 0) + ' active · ' + esc(fixtureLifecycle.counts?.stale ?? 0) + ' stale · ' + esc(fixtureLifecycle.counts?.failed ?? 0) + ' failing · ' + esc(fixtureLifecycle.counts?.retired ?? 0) + ' retired</td></tr>' +
      '<tr><td>Citation repair</td><td>' + esc(citationRepair.candidateCount ?? 0) + ' candidates · ' + esc(citationRepair.createdTaskCount ?? 0) + ' recent tasks</td></tr>' +
      '<tr><td>Phase improvements</td><td>' + esc(phaseImprovements.counts?.total ?? 0) + ' outcomes · ' + esc(phaseImprovements.counts?.improved ?? 0) + ' improved · ' + esc(phaseImprovements.counts?.regressed ?? 0) + ' regressed</td></tr>' +
      '<tr><td>Trajectory reflection</td><td>' + esc(trajectoryReflection.rawMemories ?? 0) + ' raw · ' + esc(trajectoryReflection.heuristicMemories ?? 0) + ' heuristics · ' + esc(trajectoryReflection.pendingCompaction ?? 0) + ' pending compaction</td></tr>' +
      '<tr><td>Learning tasks</td><td>' + esc(learningTaskQueue.open ?? 0) + ' open · ' + esc(learningTaskQueue.staleQueued ?? 0) + ' stale queued · ' + esc(learningTaskQueue.staleAssigned ?? 0) + ' stale assigned · ' + esc(learningTaskQueue.retryCount ?? 0) + ' retries · ' + esc(learningTaskQueue.pendingEscalations ?? 0) + ' escalations</td></tr>' +
      '<tr><td>Instruction feedback</td><td>' + esc(instructionFeedback.events ?? 0) + ' events · ' + esc(instructionFeedback.scopes?.length ?? 0) + ' scopes · ' + esc(instructionFeedback.candidateCount ?? 0) + ' lifecycle candidates</td></tr>' +
      feedbackWarn +
      '<tr><td>Latest precision snapshot</td><td>' + esc(precision.latestSnapshotDay || '-') + '</td></tr>' +
      uncitedRow +
      '<tr><td>Recall / precision</td><td>' + esc(pct(evals.acceptanceRecall)) + ' / ' + esc(pct(evals.volunteeredPrecision)) + '</td></tr></table>' +
      '<h2>Retrieval Routes</h2><div class="small">Route comparison uses the manual eval replay snapshot only. Refresh eval replay before making routing or vector-rollout decisions.</div><table><tr><th>Route</th><th>Samples</th><th>Recall</th><th>Volunteer precision</th><th>Coverage</th></tr>' + routes + '</table>' +
      '<h2>Agent Discipline</h2><table><tr><th>Agent</th><th>Eval</th><th>Volunteered</th><th>Feedback</th><th>Missing</th><th>Missing rate</th><th>Citation rate</th><th>Artifacts</th><th>Citation coverage</th><th>Uncited</th></tr>' + agentRows + '</table>' +
      '<h2>Context Sources</h2>' +
      '<table><tr><th>Origin</th><th>Volunteered</th><th>Used</th><th>Precision</th></tr>' + originRows + '</table>' +
      '<table><tr><th>Useful source</th><th>Kind</th><th>Volunteered</th><th>Used</th><th>Precision</th><th>Score</th></tr>' + sourceRows(precision.useful) + '</table>' +
      '<table><tr><th>Noisy source</th><th>Kind</th><th>Volunteered</th><th>Used</th><th>Precision</th><th>Score</th></tr>' + sourceRows(precision.noisy) + '</table>' +
      vectorBlock +
      '<h2>Memory Retirement Candidates</h2>' + (retireRows ? '<table><tr><th>Source</th><th>Key</th><th>Ignored</th><th>Reason</th></tr>' + retireRows + '</table>' : '<p class="small">No memory retirement candidates.</p>') +
      '<h2>Instruction Scope Precision</h2>' + (instructionScopeRows ? '<table><tr><th>Source</th><th>Key</th><th>Scope</th><th>Feedback</th><th>Used</th><th>Ignored</th><th>Harmful</th><th>Precision</th></tr>' + instructionScopeRows + '</table>' : '<p class="small">No instruction scope feedback.</p>') +
      '<h2>Instruction Lifecycle Candidates</h2>' + (instructionRows ? '<table><tr><th>Source</th><th>Key</th><th>Action</th><th>Ignored</th><th>Harmful</th><th>Scope</th><th>Reason</th></tr>' + instructionRows + '</table>' : '<p class="small">No instruction lifecycle candidates.</p>') +
      '<h2>Fixture Promotion Candidates</h2>' + (fixtureRows ? '<table><tr><th>Eval</th><th>Route</th><th>Query</th><th>Sources</th><th>Strings</th><th>Reason</th></tr>' + fixtureRows + '</table>' : '<p class="small">No fixture promotion candidates.</p>') +
      '<h2>Fixture Lifecycle</h2>' +
      (staleFixtureRows ? '<table><tr><th>ID</th><th>Route</th><th>Query</th><th>Reason</th><th>Invalid sources</th></tr>' + staleFixtureRows + '</table>' : '<p class="small">No stale fixtures.</p>') +
      (failingFixtureRows ? '<table><tr><th>ID</th><th>Route</th><th>Query</th><th>Failures</th></tr>' + failingFixtureRows + '</table>' : '') +
      '<h2>Citation Repair Queue</h2>' + (citationRepairRows ? '<table><tr><th>Gap</th><th>Issue</th><th>Action</th><th>Count</th><th>Sources</th></tr>' + citationRepairRows + '</table>' : '<p class="small">No invalid citation repair candidates.</p>') +
      '<h2>Phase Improvement Outcomes</h2>' + (phaseImprovementRows ? '<table><tr><th>Phase</th><th>Outcome</th><th>Delta</th><th>Before</th><th>After</th><th>Recommendation</th></tr>' + phaseImprovementRows + '</table>' : '<p class="small">No completed phase improvement outcomes.</p>') +
      '<h2>Trajectory Heuristics</h2>' + (trajectoryRows ? '<table><tr><th>Key</th><th>Route</th><th>Task/Query</th><th>Cited</th><th>Tags</th></tr>' + trajectoryRows + '</table>' : '<p class="small">No compacted trajectory heuristics yet.</p>') +
      '<h2>Next Recommendations</h2>' + (recommendationRows ? '<table><tr><th>Surface</th><th>Priority</th><th>Action</th><th>Target</th></tr>' + recommendationRows + '</table>' : '<p class="small">No next-step recommendations.</p>') +
      '<h2>Learning Task Queue</h2>' +
      (learningTaskKindRows ? '<table><tr><th>Kind</th><th>Total</th><th>Queued</th><th>Assigned</th><th>In progress</th><th>Blocked</th><th>Completed</th></tr>' + learningTaskKindRows + '</table>' : '<p class="small">No learning tasks.</p>') +
      (learningTaskAssigneeRows ? '<table><tr><th>Assignee</th><th>Total</th><th>Queued</th><th>Assigned</th><th>In progress</th><th>Blocked</th><th>Completed</th></tr>' + learningTaskAssigneeRows + '</table>' : '') +
      '<h2>Learning Approval Queue</h2>' + (learningApprovals ? '<table><tr><th>ID</th><th>Kind</th><th>Subject</th><th>Reason</th></tr>' + learningApprovals + '</table>' : '<p class="small">No pending memory or skill approvals.</p>') +
      '<h2>Contradiction Queue</h2>' + (contradictions ? '<table><tr><th>ID</th><th>Subject</th><th>Claims</th></tr>' + contradictions + '</table>' : '<p class="small">No pending contradiction approvals.</p>');
  } catch (e) {
    document.getElementById('content').innerHTML = '<span class="red">Error loading: ' + esc(e.message) + '</span>';
  }
}
load(); setInterval(load, 30000);
</script>
</body></html>`;
