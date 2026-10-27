/** Presentation of recorded decisions only. No scheduling or notification policy lives here. */
export type AegisStage = { name: string; status: string; duration_ms: number; output?: unknown; attempts?: unknown; fallback?: unknown };
export type AegisTrace = {
  trace_id: string; task_id: string; event_id: string; scenario_id: string; state: string;
  stages: AegisStage[]; decision: { action: string; reasons: string[]; summary: string; channel: string } | null;
  routing?: { selected: string | null; backend: string | null; rationale: string; policy_evaluation?: { eligible: string[]; rejected: Record<string, string[]> } } | null;
  latency_ms: number; selected_provider: string | null; execution_kind: string; retry_count: number;
  token_count: number | null; error_category: string | null; delivered: boolean;
};

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const output = (trace: AegisTrace, name: string) => record(trace.stages.find(stage => stage.name === name)?.output);
const words = (value: unknown, fallback = 'not recorded') => typeof value === 'string' ? value.replaceAll('_', ' ') : fallback;
const actionLabels: Record<string, string> = { notify: 'show a notification now', defer: 'wait before notifying', suppress: 'do not notify' };
const actionWords = (action: unknown) => actionLabels[String(action)] || 'make no notification decision';
const reasonLabels: Record<string, string> = {
  'Validated intent satisfies the deterministic notification policy': 'The proposal passed the policy checks, so showing this notification is allowed.',
  'Focus policy defers low-priority events regardless of the proposed action': 'Focus mode is on. This event has low priority, so the policy postpones the notification.',
  'Meeting policy defers low-priority events': 'A meeting is in progress. The policy postpones this low-priority notification.',
  'The trusted synthetic event is critical; notify immediately': 'The event itself is marked critical, so the policy allows an immediate alert.',
  'A model cannot promote an ordinary event to a critical action': 'The model tried to treat an ordinary event as critical. The policy postpones it instead.',
  'Confidence is below the conservative decision threshold': 'The proposal did not meet the configured confidence requirement, so the policy postpones it.',
  'Model requested a capability outside the tool allowlist': 'The proposal requested an unsupported capability, so the policy blocks the notification.',
};
const readableReasons = (reasons: string[]) => reasons.map(reason => reasonLabels[reason] || reason).join(' ');

export function backendLabel(kind: string, provider: string | null): string {
  if (kind === 'deterministic_policy') return 'Direct policy check · no model needed';
  if (kind === 'deterministic_mock') return provider === 'safe-mock-fallback' ? 'Backup fixed rules · no AI model' : 'Fixed rules · no AI model';
  if (kind === 'local_model') return 'Local AI model';
  if (kind === 'cloud_model') return 'Cloud AI model';
  return 'No inference executed';
}

export function explainRun(trace: AegisTrace) {
  const device = output(trace, 'context_assembly');
  const event = output(trace, 'event_ingestion');
  const fields: { label: string; value: string }[] = [];
  for (const [key, label, unit] of [['battery', 'Battery', '%'], ['cpu', 'CPU use', '%'], ['memory_utilization', 'Memory use', '%'], ['available_memory_gb', 'Free memory', ' GB']] as const) {
    if (typeof device[key] === 'number') fields.push({ label, value: `${device[key]}${unit}` });
  }
  if (typeof device.network === 'string') fields.push({ label: 'Network', value: words(device.network) });
  if (typeof device.focus_mode === 'boolean') fields.push({ label: 'Focus mode', value: device.focus_mode ? 'On' : 'Off' });
  if (typeof device.meeting_minutes === 'number') fields.push({ label: 'Meeting', value: device.meeting_minutes === 0 ? 'In progress' : `In ${device.meeting_minutes} min` });
  const action = trace.decision?.action;
  const terminal = trace.state === 'failed' || trace.state === 'cancelled' || trace.state === 'duplicate';
  const title = trace.state === 'failed' ? 'Execution failed' : trace.state === 'cancelled' ? 'Execution cancelled' : trace.state === 'duplicate' ? 'Duplicate event skipped' : action ? actionWords(action) : 'No decision recorded';
  const reason = trace.error_category === 'delivery_failure'
    ? 'A notification was approved, but delivery failed. Nothing was delivered.'
    : trace.state === 'cancelled' ? 'The workflow stopped at a cancellation boundary. No notification was delivered.'
    : trace.state === 'duplicate' ? 'This event was already processed. It was not delivered again.'
    : trace.state === 'failed' ? `The workflow could not finish (${words(trace.error_category)}). Nothing was delivered.`
    : trace.decision ? readableReasons(trace.decision.reasons) : 'The trace contains no completed notification decision.';
  return {
    fields,
    input: `A fictional ${words(event.kind, trace.scenario_id)} event${typeof event.severity === 'string' ? ` with ${event.severity} severity` : ''}.`,
    title: title[0].toUpperCase() + title.slice(1),
    message: terminal ? 'No notification preview was delivered for this run.' : trace.decision?.summary || 'No message was generated.',
    reason,
    action: terminal ? trace.state : action || 'none',
    channel: !terminal && action === 'notify' ? `${words(trace.decision?.channel)} notification preview` : 'No notification delivery',
    delivery: trace.delivered ? 'Sent to the simulation only. No real device notification was sent.' : 'Nothing was sent to a real device or external service.',
    backend: backendLabel(trace.execution_kind, trace.selected_provider),
    process: trace.execution_kind === 'deterministic_policy' ? 'The workflow checked the event and applied a direct policy. It did not need an AI model.'
      : trace.selected_provider ? `The workflow chose a backend, checked its proposal, and applied notification policy.${trace.retry_count ? ` ${trace.retry_count} retry was needed.` : ''}`
      : 'The trace shows which checks completed before execution stopped.',
  };
}

export function explainStage(trace: AegisTrace, name: string) {
  const stage = trace.stages.find(item => item.name === name);
  if (!stage) return { input: 'This part of the workflow was not reached.', result: `No output. The run ended in state: ${words(trace.state)}.`, meaning: 'An unexecuted step is not a successful step.' };
  if (stage.status === 'failed') return { input: 'The data from the preceding completed step.', result: `This step failed (${words(trace.error_category)}).`, meaning: 'The final result shows the failure; the system does not report successful delivery.' };
  const value = record(stage.output);
  const device = output(trace, 'context_assembly');
  const event = output(trace, 'event_ingestion');
  const inference = output(trace, 'model_execution');
  const intent = output(trace, 'output_validation');
  const decision = trace.decision;
  const summaries: Record<string, { input: string; result: string; meaning: string }> = {
    event_ingestion: { input: `A fictional ${words(event.kind, trace.scenario_id)} event${event.severity ? ` marked ${words(event.severity)} severity` : ''}.`, result: 'The event was accepted and assigned an identity so duplicate requests can be detected.', meaning: 'This is a device/application event, not a chat prompt or an uploaded document.' },
    context_assembly: { input: 'The accepted event and its supplied device snapshot.', result: explainRun(trace).fields.map(field => `${field.label}: ${field.value}`).join(' · ') || 'No resource values were recorded.', meaning: 'These are fictional device conditions. They are not readings from your computer.' },
    context_retrieval: { input: `The ${words(event.kind, trace.scenario_id)} event and recent event history.`, result: `Selected ${Array.isArray(value.selected) ? value.selected.length : 0} recent event(s) of the same kind.`, meaning: 'The runtime adds limited recent context. This is simple recency matching, not semantic search.' },
    agent_planning: { input: `Event severity: ${words(event.severity)}. Focus mode: ${device.focus_mode ? 'on' : 'off'}. Retrieved context is also available.`, result: value.needs_inference === false ? 'Use a direct policy check; skip model inference.' : 'Ask an inference backend for a structured notification proposal.', meaning: 'The workflow decides whether it needs inference before choosing a provider.' },
    backend_selection: { input: 'Device conditions, privacy permission and available backend capabilities.', result: value.skipped ? 'No backend selection was needed for this direct policy check.' : trace.routing?.selected ? `Policy permitted ${trace.routing.policy_evaluation?.eligible.length ?? 'the recorded'} candidate(s). The scheduler selected ${trace.routing.selected}.` : 'No backend was selected.', meaning: trace.routing?.rationale || 'Policy determines what is allowed; the scheduler chooses among those candidates.' },
    model_execution: { input: value.skipped ? 'A plan that does not require model inference.' : `The assembled context and selected backend: ${trace.routing?.selected || 'not recorded'}.`, result: value.skipped ? 'No model call. The direct policy path prepared a proposal.' : `${backendLabel(trace.execution_kind, trace.selected_provider)} returned a proposal to ${actionWords(record(inference.raw_intent).proposed_action)}.${stage.fallback ? ' The first provider failed; a backup produced this result.' : ''}`, meaning: 'A proposal still needs schema validation and policy approval. It is not permission to send a notification.' },
    output_validation: { input: 'The structured proposal from inference or the direct policy path.', result: `Accepted the proposal to ${actionWords(value.proposed_action)} with ${words(value.priority)} priority.`, meaning: 'Only supported actions, channels and correctly shaped fields may proceed.' },
    policy_enforcement: { input: `A validated proposal to ${actionWords(intent.proposed_action)}, plus event severity and user preferences.`, result: decision ? `Final decision: ${actionWords(decision.action)}. ${readableReasons(decision.reasons)}` : 'No final decision was recorded.', meaning: 'Application policy has the final say, even when a real model is used.' },
    notification_dispatch: { input: decision ? `The approved decision: ${actionWords(decision.action)}.` : 'No approved decision.', result: value.delivered_to_simulation === true ? `Stored a notification preview in the simulated ${words(decision?.channel)} channel.` : 'No notification was dispatched; the decision was deferred or suppressed.', meaning: 'Both delivery adapters are simulations. No real OS notification or email is sent.' },
    telemetry_recording: { input: 'The completed decision and workflow outcomes.', result: value.decision_recorded ? 'Saved the decision. The trace records stage timings, provider, errors and retry count.' : 'No saved-decision output was recorded.', meaning: 'The displayed timings come from Python execution. Playback speed only changes how you review the trace.' },
  };
  return summaries[name] || { input: 'Recorded stage input.', result: 'See the technical payload for this stage.', meaning: 'This view explains the trace and does not rerun business rules.' };
}
