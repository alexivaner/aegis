/** Explain Python decisions. Routing rules remain in the Python domain. */
export type RouteInput = { battery: number; memory: number; cpu: number; network: 'online' | 'unstable' | 'offline'; privacy: 'local_only' | 'public' | 'remote_permitted'; latency: number; complexity: 'light' | 'complex'; local_available: boolean; local_reasoning: boolean; cloud_available: boolean; preferred_backend?: 'local' | 'cloud' };
export type RouteResult = { selected: string | null; backend: string | null; rationale: string; alternatives: string[]; rejected: Record<string, string[]>; policy_evaluation: { eligible: string[]; rejected: Record<string, string[]> }; provenance?: string };
export type RoutePreset = { name: string; input: RouteInput; result: RouteResult };
export const scenarioStories = [
  { title: 'Keep it private', story: 'A private task must stay on your device. There is enough memory to run it here.', try: 'Permit cloud processing. Local is still preferred when both routes work.' },
  { title: 'Not enough memory', story: 'Your device has only 2 GB free. Cloud processing is permitted for this task.', try: 'Raise free memory to 4 GB. The local route becomes available.' },
  { title: 'No internet', story: 'The network is offline. A capable local model is still available.', try: 'Permit cloud processing. Being offline still prevents the cloud route.' },
  { title: 'Privacy comes first', story: 'There is not enough memory locally, and this task is not allowed to leave the device.', try: 'Raise memory to 4 GB, or explicitly permit the cloud. Watch the blocked route recover.' },
  { title: 'A more demanding task', story: 'This task needs a reasoning capability that the basic local model does not have. Cloud use is permitted.', try: 'Under Execution backend, give the local model reasoning capability.' },
  { title: 'A capable local model', story: 'The task is demanding, but this local model has the capability and enough memory.', try: 'Lower memory below 4 GB. A capable model still needs enough resources.' },
] as const;

export function readableReason(reason: string): string {
  const labels: Record<string, string> = {
    'Remote processing is not permitted': 'This task must stay on your device.',
    'Backend is unavailable': 'This model is not available.',
    'Missing required capabilities': 'This model cannot handle the required task capability.',
    'Network is unavailable': 'There is no internet connection.',
    'Insufficient available memory': 'The local model needs 4 GB of free memory in this example.',
    'Battery reserve is below the local inference threshold': 'The battery is below the 10% reserve used in this example.',
    'CPU budget is exhausted': 'The processor is too busy in this example (95% or more).',
    'Estimated latency exceeds the target': 'This model is estimated to take longer than the allowed wait.',
    'Unstable network cannot meet this conservative latency budget': 'The connection is too unstable for the allowed wait.',
  };
  return labels[reason] || reason;
}

export function explainRoute(result: RouteResult) {
  const local = (result.rejected['local-candidate'] || []).map(readableReason);
  const cloud = (result.rejected['cloud-candidate'] || []).map(readableReason);
  const title = result.backend === 'local' ? 'Run locally' : result.backend === 'cloud' ? 'Use the cloud' : 'Cannot run safely';
  const explanation = result.backend === 'local'
    ? 'Your device meets the task requirements. The scheduler selected local from the allowed routes, so the task would stay here.'
    : result.backend === 'cloud'
      ? result.policy_evaluation.eligible.includes('local-candidate')
        ? 'Both routes meet the requirements. Your cloud-first preference selects cloud processing.'
        : `${local.join(' ')} Cloud processing is permitted and meets the task requirements.`
      : 'Neither route meets all the requirements. The system stops instead of overriding your privacy or resource limits.';
  return { title, explanation, local, cloud };
}

export function routeFacts(input: RouteInput): string[] {
  return [input.privacy === 'local_only' ? 'On-device only' : 'Cloud permitted', `${input.memory} GB free`, input.network === 'offline' ? 'No internet' : input.network === 'unstable' ? 'Unstable internet' : 'Internet available', input.complexity === 'complex' ? 'Reasoning required' : 'Basic task'];
}

export const roleNames = ['Telemetry', 'Policy engine', 'Scheduler', 'Execution backend'] as const;
export type RouteStep = { title: string; question: string; input: string; output: string; status: string };
const routeName = (id: string) => id === 'local-candidate' ? 'local' : id === 'cloud-candidate' ? 'cloud' : id;

/** Display a real admission/placement result; never compute eligibility here. */
export function routeSteps(input: RouteInput, result: RouteResult | null): RouteStep[] {
  const eligible = result?.policy_evaluation.eligible.map(routeName) || [];
  const preference = input.preferred_backend || 'local';
  const rejections = Object.entries(result?.policy_evaluation.rejected || {})
    .map(([id, reasons]) => `${routeName(id)}: ${reasons.map(readableReason).join(' ')}`);
  return [
    { title: roleNames[0], question: 'What is happening?', status: 'Example snapshot',
      input: `Battery ${input.battery}% · CPU ${input.cpu}% · ${input.memory} GB free · network ${input.network}.`,
      output: 'Pass these supplied conditions to the policy engine. These are fictional values, not measurements of your computer.' },
    { title: roleNames[1], question: 'Which routes are allowed?', status: result ? eligible.length ? 'Checked' : 'No eligible route' : 'Waiting for Python',
      input: `${input.privacy === 'local_only' ? 'On-device only' : 'Cloud permitted'} · ${input.complexity === 'complex' ? 'reasoning required' : 'basic task'} · wait budget ${input.latency} ms. Check conditions against available model profiles.`,
      output: result ? `Allowed: ${eligible.join(' and ') || 'none'}. ${rejections.join(' ') || 'Both model profiles pass the checks.'}` : 'Python must return eligibility and rejection reasons before a route can be selected.' },
    { title: roleNames[2], question: 'Which allowed route wins?', status: result ? result.backend ? `Selected ${result.backend}` : 'Blocked' : 'Waiting for policy',
      input: `Preference: ${preference} first. Candidates must pass the policy checks first.`,
      output: result ? result.backend ? `${eligible.length > 1 ? 'Both routes are eligible; apply the preference.' : 'Only one route is eligible; the preference cannot override policy.'} Select ${result.backend}.` : 'No eligible route. Return no selection; do not override the restrictions.' : 'Wait for the admitted candidates. No current selection is claimed.' },
    { title: roleNames[3], question: 'What would run next?', status: result ? result.backend ? 'Preview only' : 'Not reached' : 'Waiting for selection',
      input: result?.backend ? `Selected ${result.backend} model adapter. Local available: ${input.local_available ? 'yes' : 'no'}; cloud available: ${input.cloud_available ? 'yes' : 'no'}.` : 'No model has been selected for execution.',
      output: result ? result.backend ? `The ${result.backend} adapter would call its model. This routing demo stops before that call: no model runs and no document is sent.` : 'No backend receives the task. No model runs and nothing is sent.' : 'No model call takes place while the route is being checked.' },
  ];
}

export const controlLabels: Record<keyof RouteInput, string> = {
  battery: 'Battery', cpu: 'CPU in use', memory: 'Free memory', network: 'Network quality',
  privacy: 'Cloud permission', latency: 'Allowed wait', complexity: 'Task type',
  local_available: 'Local model availability', cloud_available: 'Cloud model availability',
  local_reasoning: 'Local reasoning capability', preferred_backend: 'Scheduler preference',
};
export function conditionValue(key: keyof RouteInput, value: string | number | boolean | undefined): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (key === 'battery' || key === 'cpu') return `${value}%`;
  if (key === 'memory') return `${value} GB`;
  if (key === 'latency') return `${value} ms`;
  if (key === 'privacy') return value === 'local_only' ? 'on-device only' : 'cloud permitted';
  if (key === 'complexity') return value === 'complex' ? 'needs reasoning' : 'basic';
  return String(value || 'local');
}
