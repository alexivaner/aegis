import { scenarioStories, explainRoute, readableReason, routeFacts, routeSteps, roleNames, controlLabels, conditionValue, type RouteInput, type RoutePreset, type RouteResult } from '../lib/routing-view';

export async function initRoutingLab(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const text = (selector: string, value: string) => { q(selector).textContent = value; };
  const controls = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-route-field]'));
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-preset],[data-route-reset]'));
  controls.forEach(field => { field.disabled = true; });
  buttons.forEach(button => { button.disabled = true; });
  let presets: RoutePreset[], input: RouteInput, result: RouteResult;
  let index = 0, live = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let edit: { description: string; previousRoute: string } | null = null;

  function highlightOwner(owner: number, navigate = false) {
    root.querySelectorAll<HTMLElement>('[data-control-owner]').forEach(group => { group.dataset.active = String(Number(group.dataset.controlOwner) === owner); });
    root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.role) === owner)));
    document.dispatchEvent(new CustomEvent('aegis:meeting-phase', { detail: ['telemetry','policy','scheduler','inference'][owner] }));
    if (navigate && matchMedia('(max-width:850px)').matches) {
      const group = q(`[data-control-owner="${owner}"]`);
      group.querySelector<HTMLElement>('input,select')?.focus({ preventScroll: true });
      group.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  }

  function renderSteps(decision: RouteResult | null) {
    routeSteps(input, decision).forEach((step, stepIndex) => {
      text(`[data-step-status="${stepIndex}"]`, step.status);
      text(`[data-step-input="${stepIndex}"]`, step.input);
      text(`[data-step-output="${stepIndex}"]`, step.output);
      q(`[data-step="${stepIndex}"]`).dataset.state = !decision && stepIndex > 0 ? 'pending' : stepIndex === 3 ? decision?.backend ? 'preview' : 'blocked' : stepIndex > 0 && !decision?.backend ? 'blocked' : 'ready';
    });
  }

  function render(provenance: string) {
    const explanation = explainRoute(result);
    q('[data-route-output]').dataset.backend = result.backend || 'none';
    q('[data-route-output]').removeAttribute('aria-busy');
    text('[data-route-title]', explanation.title); text('[data-route-explanation]', explanation.explanation);
    text('[data-route-execution]', result.backend ? `Execution backend: the ${result.backend} adapter would call its model next. This demo stops before that call.` : 'Execution backend: not reached. No model is selected and nothing is sent.');
    text('[data-route-provenance]', `${provenance} · Fictional conditions · No model call or document is sent.`);
    text('[data-route-json]', JSON.stringify({ input, decision: result }, null, 2));
    for (const kind of ['local', 'cloud']) {
      const id = `${kind}-candidate`;
      const selected = result.backend === kind;
      const allowed = result.policy_evaluation.eligible.includes(id);
      q(`[data-path="${kind}"]`).dataset.selected = String(selected);
      text(`[data-path-state="${kind}"]`, selected ? 'Selected by scheduler' : allowed ? 'Allowed by policy' : 'Rejected by policy');
      const list = q(`[data-path-reasons="${kind}"]`); list.replaceChildren();
      const reasons = result.rejected[id]?.map(readableReason) || [selected ? 'Policy checks passed. The scheduler chose this route.' : `Policy checks passed; the scheduler chose ${result.backend} according to the preference.`];
      for (const reason of reasons) { const item = document.createElement('li'); item.textContent = reason; list.append(item); }
    }
    renderSteps(result);
    text('[data-change-summary]', edit ? `${edit.description}. ${edit.previousRoute === explanation.title ? `Decision stays: ${explanation.title}.` : `Decision: ${edit.previousRoute} → ${explanation.title}.`} All four steps updated.` : `${scenarioStories[index].title}: conditions → policy checks → scheduler choice → execution preview.`);
  }

  function syncFacts() {
    for (const key of ['memory', 'battery', 'cpu', 'latency'] as const) text(`[data-control-value="${key}"]`, conditionValue(key, input[key]));
    const facts = q('[data-route-facts]'); facts.replaceChildren();
    for (const fact of routeFacts(input)) { const chip = document.createElement('span'); chip.textContent = fact; facts.append(chip); }
  }

  function scheduleRoute() {
    const ticket = ++generation;
    if (timer !== undefined) clearTimeout(timer);
    q('[data-route-error]').hidden = true;
    q('[data-route-output]').setAttribute('aria-busy', 'true');
    q('[data-route-output]').dataset.backend = 'pending';
    text('[data-route-title]', 'Checking the routes…');
    text('[data-route-explanation]', 'Telemetry is ready. Python is checking policy and scheduling this task.');
    text('[data-route-execution]', 'Execution backend: waiting for a valid route. No model call takes place.');
    text('[data-route-provenance]', 'Waiting for the current Python decision.');
    text('[data-change-summary]', edit ? `${edit.description}. Rechecking policy and scheduler; execution waits.` : 'Checking this scenario through the four roles…');
    renderSteps(null);
    const snapshot = { ...input };
    timer = setTimeout(() => { timer = undefined; void requestRoute(ticket, snapshot); }, 100);
  }

  async function requestRoute(ticket: number, snapshot: RouteInput) {
    try {
      const response = await fetch('/api/aegis/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Routing service unavailable');
      const next = await response.json() as RouteResult;
      if (ticket !== generation) return;
      result = next; render('Live Python policy and scheduler');
    } catch {
      if (ticket !== generation) return;
      live = false;
      controls.forEach(field => { field.disabled = true; });
      text('[data-route-status]', 'Recorded scenarios · Python API offline');
      q('[data-route-output]').removeAttribute('aria-busy');
      text('[data-route-title]', 'Decision unavailable');
      text('[data-route-explanation]', 'The Python service did not respond. Choose a preset for a recorded result. Start the API and reload to adjust conditions again.');
      text('[data-route-execution]', 'Execution backend: not reached. No current route is claimed and no model was called.');
      text('[data-route-provenance]', 'Service unavailable · Last decision is not applied to the changed conditions.');
      text('[data-change-summary]', 'Telemetry has the new conditions. Policy and scheduler results are unavailable. Execution is not reached.');
      text('[data-route-error]', 'Choose a preset to study a recorded four-step decision.');
      q('[data-route-error]').hidden = false;
    }
  }

  function applyPreset(next: number) {
    index = next; ++generation;
    if (timer !== undefined) clearTimeout(timer);
    input = { preferred_backend: 'local', ...presets[index].input }; result = presets[index].result; edit = null;
    root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.preset) === index)));
    const story = scenarioStories[index];
    text('[data-scenario-title]', story.title); text('[data-scenario-story]', story.story);
    text('[data-scenario-try]', live ? story.try : 'Preset results are recorded from Python. Start the local Python API and reload to adjust individual controls.');
    for (const field of controls) {
      const key = field.dataset.routeField as keyof RouteInput;
      const value = input[key];
      if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = key === 'privacy' ? value !== 'local_only' : Boolean(value); else field.value = String(value);
    }
    syncFacts(); q('[data-route-error]').hidden = true;
    render('Recorded Python policy and scheduler'); highlightOwner(0);
    if (live) scheduleRoute();
  }

  try {
    const response = await fetch('/aegis-data/fixtures.json');
    if (!response.ok) throw new Error('Presets unavailable');
    presets = (await response.json()).routing_presets;
    try { const health = await fetch('/api/aegis/health', { signal: AbortSignal.timeout(2000) }); live = health.ok; } catch { live = false; }
    text('[data-route-status]', live ? 'Live Python routing' : 'Recorded scenarios · Python API offline');
    controls.forEach(field => { field.disabled = !live; }); buttons.forEach(button => { button.disabled = false; });
    root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => applyPreset(Number(button.dataset.preset))));
    q('[data-route-reset]').addEventListener('click', () => applyPreset(index));
    root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach(button => button.addEventListener('click', () => {
      const owner = Number(button.dataset.role); highlightOwner(owner, true);
      text('[data-change-summary]', `${roleNames[owner]} controls are highlighted. Each adjustment flows through all four steps.`);
    }));
    for (const field of controls) field.addEventListener('input', () => {
      if (!live || !field.reportValidity()) return;
      const key = field.dataset.routeField as keyof RouteInput;
      const previous = input[key];
      const value = key === 'privacy' ? (field as HTMLInputElement).checked ? 'remote_permitted' : 'local_only' : field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : ['memory', 'battery', 'cpu', 'latency'].includes(key) ? Number(field.value) : field.value;
      if (previous === value) return;
      edit = { description: `${controlLabels[key]}: ${conditionValue(key, previous)} → ${conditionValue(key, value)}`, previousRoute: explainRoute(result).title };
      Object.assign(input, { [key]: value });
      text('[data-scenario-title]', `${scenarioStories[index].title} · adjusted`);
      text('[data-scenario-story]', 'These are your current example settings. Each role below explains how they shape the route.');
      text('[data-scenario-try]', 'You are exploring custom conditions. Reset this scenario to restore its starting values.');
      highlightOwner(Number(field.dataset.owner)); syncFacts(); scheduleRoute();
    });
    applyPreset(0);
  } catch { text('[data-route-status]', 'First recorded example · interactive presets unavailable'); }
}
