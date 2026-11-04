// Builds a Markdown report of a test cycle from bridge log entries. Used by `bridge report` and the dashboard.
// Input: messages as logged ({ id, ts, type, from, to, thread_id, body, attachments }), oldest first.

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').slice(0, 160);
const time = (ts) => (typeof ts === 'string' ? ts.replace('T', ' ').slice(0, 16) : '');
const who = (f) => (f ? `${f.role}` : '?');
const obj = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

/** One line that says what a message was about. */
export function gist(m) {
  const b = m.body;
  if (b == null) return '';
  if (typeof b === 'string') return cell(b);
  const o = obj(b);
  if (m.type === 'hello') return cell([o.role, o.environment, o.skill_version && `v${o.skill_version}`, o.project?.name].filter(Boolean).join(' · '));
  if (m.type === 'ui_testable_scenarios') return cell(`accepted ${(o.accepted || []).length}, rejected ${(o.rejected || []).length}, added ${(o.added || []).length}`);
  const pick = o.title || o.summary || o.text || o.change_summary || o.feature || o.notes || o.reason;
  const parts = [o.bug_id, o.scenario_id, o.status, pick].filter(Boolean);
  if (Array.isArray(o.scenarios)) parts.push(`${o.scenarios.length} scenario(s)`);
  if (Array.isArray(o.created)) parts.push(`${o.created.length} item(s) created`);
  if (Array.isArray(o.needs)) parts.push(`${o.needs.length} item(s) requested`);
  return cell(parts.join(' · ') || JSON.stringify(b));
}

export function buildReport(messages, { thread = null, version = '', title = null } = {}) {
  const msgs = messages.filter((m) => m.from?.id !== 'bridge' && (!thread || m.thread_id === thread));
  const people = new Map();
  for (const m of messages) if (m.from && m.from.id !== 'bridge') people.set(m.from.id, m.from);

  // Scenarios: the latest definition wins; results come from the latest progress/retest per id.
  const scenarios = new Map();
  for (const m of msgs) {
    const b = obj(m.body);
    if (m.type === 'test_scenarios') for (const s of b.scenarios || []) scenarios.set(s.id, { id: s.id, title: s.title, expected: s.expected, result: null, by: null, bugs: new Set() });
    if (m.type === 'ui_testable_scenarios') {
      for (const s of b.added || []) if (!scenarios.has(s.id)) scenarios.set(s.id, { id: s.id, title: s.title, result: null, bugs: new Set() });
      for (const s of b.rejected || []) { const x = scenarios.get(s.id); if (x) x.result = `not on UI: ${s.reason ?? ''}`; }
    }
  }
  const bugs = new Map();
  const data = [];
  const finals = [];
  for (const m of msgs) {
    const b = obj(m.body);
    if (m.type === 'test_progress' || m.type === 'retest_result') {
      const s = scenarios.get(b.scenario_id) || (b.scenario_id ? scenarios.set(b.scenario_id, { id: b.scenario_id, title: '', bugs: new Set() }).get(b.scenario_id) : null);
      if (s && b.status) { s.result = `${b.status}${m.type === 'retest_result' ? ' (retest)' : ''}`; s.by = who(m.from); }
      if (m.type === 'retest_result') for (const id of b.bug_ids || []) { const g = bugs.get(id); if (g && /pass/i.test(b.status)) g.status = 'fixed, verified'; }
    }
    if (m.type === 'bug_report') {
      const id = b.bug_id || m.id;
      bugs.set(id, { id, scenario: b.scenario_id, severity: b.severity, title: b.title, layer: b.suspected_layer, status: 'open', fix: null });
      scenarios.get(b.scenario_id)?.bugs.add(id);
    }
    if (m.type === 'fix_ready') for (const id of b.bug_ids || []) { const g = bugs.get(id); if (g) { g.status = g.status === 'fixed, verified' ? g.status : 'fixed, awaiting retest'; g.fix = b.change_summary || b.commit; } }
    if (m.type === 'data_response') for (const c of b.created || []) data.push({ scenario: c.scenario_id, kind: c.kind, values: c.values, cleanup: c.cleanup || b.cleanup });
    if (m.type === 'final_report') finals.push({ by: who(m.from), summary: b.summary || gist(m) });
  }

  const out = [];
  out.push(`# ${title || `Test cycle report${thread ? `: ${thread}` : ''}`}`, '');
  out.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by agent-bridge${version ? ` ${version}` : ''}.`);
  if (people.size) out.push(`Participants: ${[...people.values()].map((p) => `**${p.role}** (${p.name})`).join(', ')}.`);
  if (msgs.length) out.push(`Messages: ${msgs.length}, from ${time(msgs[0].ts)} to ${time(msgs[msgs.length - 1].ts)}.`);
  out.push('');

  out.push('## Summary', '');
  if (finals.length) for (const f of finals) out.push(`- **${f.by}**: ${f.summary}`);
  else {
    const failed = [...scenarios.values()].filter((s) => /fail|block/i.test(s.result || '')).length;
    const passed = [...scenarios.values()].filter((s) => /pass/i.test(s.result || '')).length;
    const openBugs = [...bugs.values()].filter((g) => g.status === 'open').length;
    out.push(`- ${scenarios.size} scenario(s): ${passed} passed, ${failed} failed/blocked, ${scenarios.size - passed - failed} without a result.`);
    out.push(`- ${bugs.size} bug(s): ${openBugs} open.`);
  }
  out.push('');

  if (scenarios.size) {
    out.push('## Scenarios', '', '| ID | Scenario | Result | Bugs |', '|---|---|---|---|');
    for (const s of scenarios.values()) out.push(`| ${cell(s.id)} | ${cell(s.title)} | ${cell(s.result || '—')} | ${cell([...s.bugs].join(', ') || '—')} |`);
    out.push('');
  }
  if (bugs.size) {
    out.push('## Bugs', '', '| Bug | Scenario | Severity | Title | Layer | Status | Fix |', '|---|---|---|---|---|---|---|');
    for (const g of bugs.values()) out.push(`| ${cell(g.id)} | ${cell(g.scenario)} | ${cell(g.severity)} | ${cell(g.title)} | ${cell(g.layer)} | ${cell(g.status)} | ${cell(g.fix || '—')} |`);
    out.push('');
  }
  if (data.length) {
    out.push('## Test data created', '', '| Scenario | Kind | Values | Cleanup |', '|---|---|---|---|');
    for (const d of data) out.push(`| ${cell(d.scenario)} | ${cell(d.kind)} | ${cell(d.values && JSON.stringify(d.values))} | ${cell(d.cleanup || '—')} |`);
    out.push('');
  }
  out.push('## Timeline', '');
  for (const m of msgs) {
    const att = (m.attachments || []).length ? ` · 📎 ${(m.attachments || []).map((a) => a.name).join(', ')}` : '';
    const to = m.to === '*' ? 'all' : people.get(m.to)?.role ?? m.to;
    out.push(`- \`${time(m.ts)}\` **${who(m.from)}** → ${cell(to)} ·\`${m.type}\`${m.thread_id && !thread ? ` · #${cell(m.thread_id)}` : ''} · ${gist(m)}${att}`);
  }
  out.push('');
  return out.join('\n');
}
