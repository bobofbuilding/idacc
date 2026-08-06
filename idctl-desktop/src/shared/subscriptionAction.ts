export type SubscriptionAction = 'signin' | 'install';

export interface SubscriptionActionResult {
  started?: boolean;
  ran?: boolean;
  command?: string;
  error?: string;
}

export type SubscriptionActionResolution =
  | { kind: 'launched'; message: string }
  | { kind: 'manual'; message: string; command: string }
  | { kind: 'error'; message: string };

/**
 * Interpret a subscription action without treating a safe manual-terminal
 * handoff as a failure. Non-macOS hosts intentionally return the reviewed
 * command instead of attempting macOS-only Terminal automation.
 */
export function resolveSubscriptionAction(
  action: SubscriptionAction,
  result: SubscriptionActionResult,
): SubscriptionActionResolution {
  const launched = result.ran === true || result.started === true;
  const command = String(result.command ?? '').trim();
  const actionLabel = action === 'install' ? 'install' : 'sign-in';

  if (launched) {
    return {
      kind: 'launched',
      message: action === 'install'
        ? 'The visible installer was opened. Finish it, then choose Re-check.'
        : 'The account sign-in flow was opened. Finish it, then choose Re-check.',
    };
  }
  if (command) {
    return {
      kind: 'manual',
      command,
      message: `Automatic terminal launch is unavailable. Run this ${actionLabel} command in a terminal`,
    };
  }
  return {
    kind: 'error',
    message: result.error || `The ${actionLabel} action did not start.`,
  };
}
