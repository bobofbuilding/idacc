// Keep the renderer editor and the profile-backed store on one explicit bound.
// The limit protects scheduled prompts and saved profile files from unbounded
// imported/manual payloads; callers must reject rather than silently truncate.
export const MAX_LOOP_STEPS = 20;
