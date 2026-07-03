# IDACC Wiki Schema

This file is the Markdown-first replacement plan for the old oversized `CONTROL_CENTER_WIKI.json`. The JSON file remains as a small app manifest for sidebar navigation, source-file ownership, and release drift checks. Long-form operator documentation should move here or into sibling Markdown pages.

## Goals

- Keep the app payload small and cheap to parse.
- Keep release-history notes out of the live UI manifest.
- Make authoring readable in normal Markdown review tools.
- Preserve a tiny machine-readable manifest for navigation and source ownership.

## Current Split

- `docs/CONTROL_CENTER_WIKI.json`: compact manifest read by the desktop app.
- `docs/CONTROL_CENTER_WIKI.md`: schema and authoring contract.
- Future page docs: `docs/wiki/<page>.md` once the renderer can load Markdown pages directly.

## Proposed Page Schema

Each Markdown page should use frontmatter for the fields the app needs and Markdown for the body.

```md
---
id: work
route: tasks
component: Tasks
nav:
  label: Work
  icon: "☑"
  order: 40
  visible: true
sourceFiles:
  - idctl-desktop/src/renderer/views/Tasks.tsx
  - idctl-desktop/src/renderer/views/Learn.tsx
purpose: Goals, plans, tasks, Learn intake, schedules, loops, and dreams.
scope: Current operator behavior and safety boundaries only.
---

# Work

Concise operator documentation for the current UI. Historical release notes stay in CHANGELOG.md.
```

## Migration Rules

- The JSON manifest must stay valid until the app loader supports Markdown frontmatter.
- Every implemented app route must keep one manifest entry.
- Every page must list real source files so `scripts/check-wiki.mjs` can keep docs and page code changes coupled.
- Release notes and pass-by-pass implementation logs belong in `CHANGELOG.md`, not in page docs.

## Next Implementation Step

Teach `idctl-desktop/src/main/wiki.ts` to prefer Markdown pages under `docs/wiki/`, parse frontmatter, and synthesize the same `ControlCenterWiki` object the renderer already understands. After that, the JSON manifest can shrink further or become generated output.
