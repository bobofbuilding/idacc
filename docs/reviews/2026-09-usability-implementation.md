# September usability implementation

This contribution applies the page review to the current application source. It changes presentation and navigation while retaining existing Manager contracts and action review guards.

## Navigation and daily work

- Home prioritizes decision links, work status, projects, and chat. Team coordination is expandable; activity defaults to recent history, with responsive stacking and last-refresh information.
- Inbox separates blockers, approvals, and messages, with search and retry states. Reply acknowledgement precedes review updates and dismissal. Retrying a failed review update does not resend an already acknowledged reply. Brain approval and application remain distinct.
- Work contains Tasks, Goals, and Plans. Active tasks are the default; one creation entry offers direct tasks or guided work. Recovery metrics and permanent deletion are secondary controls.
- Teams replaces HR Manager, defaults to its directory, and provides roster search and organization rules. Health keeps model and technical controls optional.
- Knowledge contains the library and Reflection. Sources have Processing, Needs attention, and Library views and one priority control. Completed processing only counts as ready when the current knowledge sync contract is satisfied.
- Automations combines a schedule overview and latest recorded deliveries, scheduled checks, workflows, and reflections. Calendar workflows and reflections share day/time controls; interval checks preserve custom values, including 12 hours.
- Tools uses familiar connection, skill, and plugin language and keeps diagnostics expandable. Computer Control uses explicit session and emergency-stop labels.
- Projects use a single Add entry and place repository operations under Files & Git. Commit-and-push is labeled by its full effect.
- Settings has searchable categories. Identity is optional advanced setup, with detailed evidence expandable. Setup instructions emphasize provider, starter team, and a first task.
- Keyboard prompts queue reliably, maintain focus, and handle cancellation and input-method composition. Notifications have accessible status and dismissal labels.

## Correctness checks

Regression cases cover accidental plan-number interpretation, exact Work tab aliases, current knowledge sync completeness, unavailable state, custom intervals, and failed Inbox delivery/review updates. The isolated preview uses synthetic data and rejects every unimplemented operation; it never connects to a Manager.

Local verification: type checking, development bundle, rendered command/drawer and Inbox tests, usability regression checks, health classification, onboarding, identity lifecycle, goal/plan separation, and reflection checks. The contribution also runs the normal multi-platform CI and production release pipeline.

## Scope boundaries

The external Brain dashboard pages were not part of the visual inspection; their existing launch/review requirements are retained. The automation overview presents each schedule's latest recorded delivery, not a newly invented full execution history or a guarantee of task completion. Interval self-checks retain their existing execution semantics, separate from calendar schedules. Changes to backend authority, storage lifecycles, and unsupported archival or bulk approval behavior are outside this UI contribution.
