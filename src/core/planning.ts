import type { PhoneService } from './service.js';
import { errorData, PhoneError } from './errors.js';
import type { TargetSelector } from './targets.js';
import { settleParallel } from './parallel.js';

/** Read-only preparation, shared by SDK and MCP. Batch execution remains a separate primitive. */
export async function resolveTapPlan(
  service: PhoneService,
  targets: { session_id: string; selector?: TargetSelector }[],
  selector: TargetSelector,
  scope = 'local',
) {
  if (
    !targets.length ||
    targets.length > 8 ||
    new Set(targets.map((t) => t.session_id)).size !== targets.length
  )
    throw new PhoneError('INVALID_TARGETS', 'Select 1–8 distinct device sessions.');
  const selected = targets.map((target) => {
    service.requireScope(target.session_id, scope);
    return { ...target, device_id: service.state(target.session_id).device.id };
  });
  const outcomes = await settleParallel(selected, (target) =>
    service.resolve(target.session_id, target.selector ?? selector),
  );
  const results = outcomes.map((outcome, i) =>
    outcome.status === 'fulfilled'
      ? { session_id: selected[i]!.session_id, device_id: selected[i]!.device_id, ...outcome.value }
      : {
          session_id: selected[i]!.session_id,
          device_id: selected[i]!.device_id,
          error: errorData(outcome.reason),
        },
  );
  const ready = results.every((r) => 'action' in r && !!r.action);
  return {
    ready,
    intent: { kind: 'tap', selector },
    results,
    operations: ready
      ? results.flatMap((r) =>
          'action' in r && r.action ? [{ session_id: r.session_id, action: r.action }] : [],
        )
      : [],
    execution:
      'No actions performed. Pass operations to phone_batch only when ready. Each device is revalidated; execution can partially succeed and is not a transaction or synchronized clock.',
  };
}
