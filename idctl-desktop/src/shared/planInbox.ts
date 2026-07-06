export type PlanInboxResolution = 'resume' | 'pause';

export function planInboxResolutionForOption(option: string): PlanInboxResolution {
  const value = String(option || '').toLowerCase();
  if (/\b(hold|pause|paused|manual|manually|handle it|skip|stop|defer|later)\b/.test(value)) return 'pause';
  return 'resume';
}

export function planInboxStatusForOption(option: string): 'PENDING' | 'PAUSED' {
  return planInboxResolutionForOption(option) === 'resume' ? 'PENDING' : 'PAUSED';
}
