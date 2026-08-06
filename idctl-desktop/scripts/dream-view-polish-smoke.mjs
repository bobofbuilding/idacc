import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dream = readFileSync(join(root, 'src', 'renderer', 'views', 'Dream.tsx'), 'utf8');

assert.match(dream, /call<TeamSchedule\[]>\('schedules:allTeams'\)/);
assert.match(dream, /if \(allSchedules\) \{/);
assert.match(dream, /setNightlySchedules\(allSchedules\.filter/);
assert.doesNotMatch(dream, /call<TeamSchedule\[]>\('schedules:allTeams'\)\.catch\(\(\) => \[\]\)/);
assert.match(dream, /nightlySchedules\.map/);
assert.match(dream, /completed reports are reconciled by exact query ID and archived below/i);
assert.match(dream, /Save schedule/);
assert.match(dream, /pauseSchedule/);
assert.match(dream, /resumeSchedule/);
assert.match(dream, /removeSchedule/);
assert.match(dream, /function DreamMarkdown/);
assert.match(dream, /<DreamMarkdown content=\{detail\.content\}/);
assert.match(dream, /scheduleStamp\(confirmedReplacing\) !== scheduleStamp\(replacing\)/);
assert.match(dream, /runs while IDACC is open; resumes after restart/);
assert.doesNotMatch(dream, /<pre className="plan-content"/);
assert.doesNotMatch(dream, /dangerouslySetInnerHTML/);
assert.doesNotMatch(dream, /call<ScheduleEntry\[]>\('schedules'\)/);

process.stdout.write('dream view polish smoke: ok\n');
