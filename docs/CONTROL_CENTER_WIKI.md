# IDACC Documentation Schema

The in-app Wiki and its JSON manifest have been removed. This file records a Markdown-first schema for repository documentation without coupling app navigation, startup, or releases to documentation state.

## Goals

- Keep documentation out of the packaged app payload.
- Keep release-history notes out of operator documentation.
- Make authoring readable in normal Markdown review tools.
- Keep navigation defined by the renderer and documentation maintained independently.

## Current Layout

- `docs/CONTROL_CENTER_WIKI.md`: schema and authoring contract retained for repository maintainers.
- Optional page docs: `docs/pages/<page>.md` for focused operator documentation.
- `CHANGELOG.md`: release history and shipped behavior.

## Proposed Page Schema

Each Markdown page can use frontmatter for ownership and review metadata, with Markdown for the body.

```md
---
id: work
sourceFiles:
  - idctl-desktop/src/renderer/views/Tasks.tsx
  - idctl-desktop/src/renderer/views/Learn.tsx
purpose: Goals, plans, tasks, Learn intake, schedules, loops, and dreams.
scope: Current operator behavior and safety boundaries only.
---

# Work

Concise operator documentation for the current UI. Historical release notes stay in CHANGELOG.md.
```

## Authoring Rules

- Documentation must not be loaded, polled, or packaged by the desktop app.
- Page docs should list real source files when source ownership is useful.
- Release notes and pass-by-pass implementation logs belong in `CHANGELOG.md`, not in page docs.
