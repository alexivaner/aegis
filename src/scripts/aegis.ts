import { architecture, pipeline, runtimeConcepts } from '../data/aegis';
import { explainRun, explainStage, type AegisTrace } from '../lib/aegis-explain';

type PolicyEvaluation = { eligible: string[]; rejected: Record<string, string[]> };
type Trace = AegisTrace;
type RouteInput = { battery: number; memory: number; cpu: number; latency: number; network: string; privacy: string; complexity: string; local_reasoning: boolean; local_available: boolean; cloud_available: boolean };
type RouteResult = { selected: string | null; backend: string | null; rationale: string; alternatives: string[]; rejected: Record<string, string[]>; provenance?: string; policy_evaluation?: PolicyEvaluation };
type Preset = { name: string; input: RouteInput; result: RouteResult };
type Fixtures = { scenarios: { id: string; name: string; description: string; device: Record<string, unknown> }[]; traces: Record<string, Trace>; routing_presets: Preset[] };
type Health = { capabilities: { mock: boolean; local: boolean; cloud: boolean; local_model: string | null } };

export async function initAegis(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Aegis control: ${selector}`);
    return element;
  };
  const text = (selector: string, value: string) => { q(selector).textContent = value; };
  const scenario = q<HTMLSelectElement>('[data-scenario]');
  const provider = q<HTMLSelectElement>('[data-provider]');
  const failure = q<HTMLSelectElement>('[data-failure]');
  const transport = q<HTMLSelectElement>('[data-transport]');
  const run = q<HTMLButtonElement>('[data-run]');
  const cancel = q<HTMLButtonElement>('[data-cancel]');
  const play = q<HTMLButtonElement>('[data-play]');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let fixtures: Fixtures;
  let health: Health | null = null;
  let current: Trace | null = null;
  let source: 'live' | 'recorded' = 'recorded';
  let stageIndex = 0;
  let playing = false;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let jobId: string | null = null;
  let cancelRequested = false;
  let currentRoute: RouteResult | null = null;
  let routeGeneration = 0;

  async function api<T>(path: string, payload?: unknown): Promise<T> {
    const response = await fetch('/api/aegis/' + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(path === 'health' ? 1500 : 10000),
    });
    if (!response.ok) throw new Error(`Runtime request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  function inspectComponent(id: string) {
    const node = architecture.find(item => item.id === id);
    if (!node) return;
    root.querySelectorAll<HTMLButtonElement>('[data-component]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.component === id)));
    root.querySelectorAll<SVGPathElement>('[data-edge]').forEach(edge => { edge.dataset.active = String(edge.dataset.edge === id || id === 'ports' && edge.dataset.edge !== 'http' || id === 'core' && edge.dataset.edge === 'http'); });
    text('[data-component-kind]', node.kind);
    text('[data-component-title]', node.label);
    text('[data-component-summary]', node.summary);
    text('[data-component-port]', node.port);
    text('[data-component-file]', node.file);
    text('[data-component-detail]', node.detail);
  }

  function renderConcept(index: number) {
    const concept = runtimeConcepts[index];
    if (!concept || !current) return;
    root.querySelectorAll<HTMLButtonElement>('[data-concept]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.concept) === index)));
    text('[data-concept-role]', concept.role);
    text('[data-concept-title]', concept.title);
    text('[data-concept-description]', concept.description);
    text('[data-concept-limit]', concept.limitation);
    const output = (name: string) => current!.stages.find(stage => stage.name === name)?.output ?? { status: 'not_executed', reason: current!.error_category || 'No output for this stage' };
    const payloads = [
      { resource_snapshot: output('context_assembly'), input_provenance: 'synthetic', measured_execution_ms: current.latency_ms, retries: current.retry_count, token_count: current.token_count, hardware_counters: 'unavailable' },
      { admission: current.routing?.policy_evaluation ?? { status: 'inference_not_required_or_not_reached' }, final_notification_guard: output('policy_enforcement') },
      { placement: current.routing ?? output('backend_selection'), scope: 'single-workload placement, no real-time priority queue' },
      { selected_provider: current.selected_provider, execution_kind: current.execution_kind, model_execution: output('model_execution'), error_category: current.error_category },
    ];
    text('[data-concept-payload]', JSON.stringify(payloads[index], null, 2));
    const story = explainRun(current);
    const plain = [
      `${story.fields.map(field => `${field.label}: ${field.value}`).join(' · ') || 'No device snapshot was recorded.'} These inputs are fictional. The workflow took ${current.latency_ms.toFixed(3)} ms in Python.`,
      current.routing?.policy_evaluation ? `Before inference, policy admitted ${current.routing.policy_evaluation.eligible.length} backend candidate(s). After the proposal, notification policy made the final decision: ${current.decision?.action || 'not reached'}.` : 'Inference admission was skipped or not reached. A direct notification policy can handle some events without a model.',
      current.routing ? `The scheduler chose ${current.routing.selected || 'no eligible backend'}. ${current.routing.rationale}` : 'No backend placement was needed or reached in this run.',
      `${story.backend}. ${explainStage(current, 'model_execution').result}`,
    ];
    text('[data-concept-plain]', plain[index]);
    text('[data-concept-source]', `${source === 'live' ? 'Live' : 'Recorded'} Python trace · ${current.scenario_id} · ${current.trace_id}. Resource inputs are synthetic; Python timings are measured.`);
  }

  const stageNodes = ['events', 'telemetry', 'context', 'core', 'scheduler', 'inference', 'policy', 'policy', 'notification', 'telemetry'];
  function renderStage() {
    if (!current) return;
    const [name, title, description] = pipeline[stageIndex];
    const stage = current.stages.find(item => item.name === name);
    text('[data-stage-label]', `${String(stageIndex + 1).padStart(2, '0')} / ${name.replaceAll('_', ' ').toUpperCase()}`);
    text('[data-stage-title]', title);
    text('[data-stage-description]', description);
    const explanation = explainStage(current, name);
    text('[data-step-input]', explanation.input);
    text('[data-step-output]', explanation.result);
    text('[data-step-meaning]', explanation.meaning);
    text('[data-stage-duration]', stage ? `${stage.duration_ms.toFixed(3)} ms · measured` : 'Not executed');
    text('[data-stage-payload]', JSON.stringify(stage ? { status: stage.status, output: stage.output, attempts: stage.attempts, fallback: stage.fallback } : { status: 'not_executed', reason: current.error_category || 'No stage record' }, null, 2));
    const error = q('[data-stage-error]');
    error.hidden = !(stage?.status === 'failed' || stage?.attempts);
    error.textContent = current.error_category ? `Classified error: ${current.error_category}. Open the technical details to inspect attempts and fallback.` : '';
    root.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach((button, index) => {
      button.setAttribute('aria-current', index === stageIndex ? 'step' : 'false');
      const entry = current!.stages.find(item => item.name === pipeline[index][0]);
      button.dataset.status = entry?.status || 'not_executed';
    });
    q<HTMLButtonElement>('[data-prev]').disabled = stageIndex === 0;
    q<HTMLButtonElement>('[data-next]').disabled = stageIndex === pipeline.length - 1;
    renderConcept([0, 0, 0, 1, 2, 3, 1, 1, 3, 0][stageIndex]);
    inspectComponent(stageNodes[stageIndex]);
  }

  function stopPlayback() {
    playing = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    play.textContent = 'Play steps';
    play.setAttribute('aria-pressed', 'false');
  }

  function schedulePlayback() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!playing || !visible || document.hidden || motion.matches) return;
    timer = setTimeout(() => {
      timer = undefined;
      stageIndex = Math.min(pipeline.length - 1, stageIndex + 1);
      renderStage();
      if (stageIndex === pipeline.length - 1) stopPlayback(); else schedulePlayback();
    }, Number(q<HTMLSelectElement>('[data-speed]').value));
  }

  function renderTrace(trace: Trace, provenance: 'live' | 'recorded') {
    stopPlayback(); current = trace; source = provenance; stageIndex = 0;
    const story = explainRun(trace);
    const kind = story.backend;
    const scenarioName = fixtures.scenarios.find(item => item.id === trace.scenario_id)?.name || trace.scenario_id;
    text('[data-execution-source]', `${provenance === 'live' ? 'Live Python execution' : 'Recorded Python execution'} · ${kind} · ${scenarioName}. Notification delivery is a simulation.`);
    text('[data-story-source]', `Showing: ${scenarioName} · ${provenance === 'live' ? 'Live Python result' : 'Recorded Python result'}`);
    text('[data-story-input]', story.input);
    text('[data-story-process]', story.process);
    text('[data-story-backend]', story.backend);
    text('[data-result-title]', story.title);
    text('[data-result-message]', story.message);
    text('[data-result-reason]', story.reason);
    text('[data-result-channel]', story.channel);
    text('[data-result-delivery]', story.delivery);
    q('[data-result-card]').dataset.action = story.action;
    q('[data-pending-note]').hidden = true;
    const facts = q('[data-input-facts]'); facts.replaceChildren();
    for (const field of story.fields) {
      const item = document.createElement('div');
      const label = document.createElement('dt'); label.textContent = field.label;
      const value = document.createElement('dd'); value.textContent = field.value;
      item.append(label, value); facts.append(item);
    }
    text('[data-trace-id]', trace.trace_id);
    text('[data-latency]', `${trace.latency_ms.toFixed(3)} ms`);
    text('[data-actual-provider]', trace.selected_provider || kind);
    text('[data-retry-tokens]', `${trace.retry_count} / ${trace.token_count ?? 'unavailable'}`);
    text('[data-full-trace]', JSON.stringify(trace, null, 2));
    const terminal = trace.state === 'failed' ? 'Failed' : trace.state === 'cancelled' ? 'Cancelled' : trace.state === 'duplicate' ? 'Duplicate suppressed' : trace.decision?.action || 'No decision';
    text('[data-final-action]', terminal);
    q('[data-final-action]').dataset.action = terminal.toLowerCase();
    text('[data-final-reason]', story.reason);
    text('[data-delivery-result]', story.delivery);
    text('[data-metric-provenance]', `${provenance === 'live' ? 'Live' : 'Recorded'} measured Python execution with synthetic inputs. Playback delays are visual only. Hardware/energy metrics unavailable.`);
    renderStage();
  }

  function updateInput() {
    const item = fixtures.scenarios.find(item => item.id === scenario.value);
    if (!item) return;
    text('[data-scenario-description]', item.description);
    text('[data-input]', JSON.stringify(item.device, null, 2));
  }

  function recordedTrace() {
    return fixtures.traces[`${scenario.value}:${failure.value}:${transport.value}`];
  }

  async function execute() {
    if (!fixtures) return;
    stopPlayback(); run.disabled = true; cancel.disabled = true; cancelRequested = false;
    const settings = [scenario, provider, failure, transport, q<HTMLInputElement>('[data-remote]')];
    settings.forEach(field => { field.disabled = true; });
    text('[data-run-message]', health ? 'Executing the bounded Python workflow…' : 'Loading a recorded Python mock execution.');
    try {
      if (!health) {
        const trace = recordedTrace();
        if (!trace) throw new Error('Recorded combination is unavailable');
        renderTrace(trace, 'recorded');
      } else {
        const job = await api<{ job_id: string }>('jobs', { scenario_id: scenario.value, event_id: crypto.randomUUID(), provider: provider.value, failure: failure.value, transport: transport.value, allow_remote: q<HTMLInputElement>('[data-remote]').checked });
        jobId = job.job_id; cancel.disabled = false; cancel.hidden = false;
        let finished = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = await api<{ state: string; trace?: Trace }>(`jobs/${jobId}`);
          if (result.state === 'complete' && result.trace) { renderTrace(result.trace, 'live'); finished = true; break; }
          await new Promise(resolve => setTimeout(resolve, 160));
        }
        if (!finished) { await api(`jobs/${jobId}/cancel`, {}); throw new Error('Execution wait exceeded the bounded client window; cancellation requested'); }
      }
      text('[data-run-message]', cancelRequested ? 'Cancellation requested. The trace shows whether it reached a cancellation boundary before completion.' : 'Result updated above. Select a step to see its input, output and purpose.');
    } catch (error) {
      text('[data-run-message]', `${error instanceof Error ? error.message : 'Execution unavailable'}. The previous trace is retained; no successful execution is fabricated.`);
    } finally { run.disabled = false; cancel.disabled = true; cancel.hidden = true; jobId = null; settings.forEach(field => { field.disabled = false; }); }
  }

  function renderRoute(result: RouteResult, provenance: string) {
    currentRoute = result;
    text('[data-routing-backend]', result.backend ? `${result.backend[0].toUpperCase()}${result.backend.slice(1)}` : 'Unable to execute');
    q('[data-routing-backend]').dataset.backend = result.backend || 'none';
    text('[data-routing-rationale]', result.rationale);
    text('[data-routing-eligible]', result.policy_evaluation?.eligible.join(', ') || 'None');
    text('[data-routing-alternatives]', result.alternatives.length ? result.alternatives.join(', ') : 'None');
    const rejected = q('[data-routing-rejected]'); rejected.replaceChildren();
    for (const [name, reasons] of Object.entries(result.rejected)) {
      const item = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = name;
      const detail = document.createElement('p'); detail.textContent = reasons.join(' · ');
      item.append(title, detail); rejected.append(item);
    }
    if (!Object.keys(result.rejected).length) rejected.textContent = 'None';
    text('[data-routing-provenance]', provenance);
  }

  function readRouteInput(): RouteInput {
    const fields = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-route]'));
    return Object.fromEntries(fields.map(field => [field.dataset.route, field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : ['battery', 'memory', 'cpu', 'latency'].includes(field.dataset.route!) ? Number(field.value) : field.dataset.route === 'local_reasoning' ? field.value === 'true' : field.value])) as RouteInput;
  }

  function displayResources() {
    const input = readRouteInput();
    text('[data-battery-value]', `${input.battery}%`);
    text('[data-memory-value]', `${input.memory} GB`);
    text('[data-cpu-value]', `${input.cpu}%`);
    text('[data-latency-value]', `${input.latency} ms`);
  }

  function applyPreset(index: number) {
    const preset = fixtures.routing_presets[index];
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-route]').forEach(field => {
      const value = preset.input[field.dataset.route as keyof RouteInput];
      if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = Boolean(value); else field.value = String(value);
    });
    displayResources();
    if (health) void requestRouting();
    else renderRoute(preset.result, 'Recorded result from the actual Python policy. Hypothetical candidate availability; no inference executed.');
  }

  async function requestRouting() {
    if (!health) return;
    const generation = ++routeGeneration;
    try {
      const result = await api<RouteResult>('route', readRouteInput());
      if (generation === routeGeneration) renderRoute(result, result.provenance || 'Live Python policy evaluation');
    } catch { if (generation === routeGeneration) text('[data-routing-provenance]', 'The Python service is unavailable. Previous result retained; no frontend policy is substituted.'); }
  }

  try {
    const response = await fetch('/aegis-data/fixtures.json');
    if (!response.ok) throw new Error('Recorded fixtures unavailable');
    fixtures = await response.json() as Fixtures;
    try { health = await api<Health>('health'); } catch { health = null; }
    if (health) {
      text('[data-runtime-status]', 'Live Python API · synthetic data');
      text('[data-routing-mode]', 'Live Python policy');
      text('[data-routing-help]', 'These controls call the real Python scheduling policy with hypothetical backend profiles. No model executes in this lab.');
      q<HTMLFieldSetElement>('[data-route-fields]').disabled = false;
      const caps = health.capabilities;
      for (const option of provider.options) {
        if (option.value === 'auto') { option.disabled = false; option.textContent = 'Auto / configured providers'; }
        if (option.value === 'local') { option.disabled = !caps.local; option.textContent = caps.local ? `Local AI / Ollama / ${caps.local_model}` : 'Local AI model · not detected'; }
        if (option.value === 'cloud') { option.disabled = !caps.cloud; option.textContent = caps.cloud ? 'Cloud AI model' : 'Cloud AI model · not configured'; }
      }
    }
    renderTrace(fixtures.traces['battery:scenario:simulation'], 'recorded');
    applyPreset(0);
    updateInput();
    run.disabled = false;
    [scenario, provider, failure, transport, q<HTMLInputElement>('[data-remote]')].forEach(field => { field.disabled = false; });
    root.dataset.enhanced = 'true'; root.dataset.mode = 'overview';
  } catch (error) { text('[data-run-message]', error instanceof Error ? error.message : 'Initialization failed'); return; }

  root.querySelectorAll<HTMLButtonElement>('[data-concept]').forEach(button => button.addEventListener('click', () => { const index = Number(button.dataset.concept); renderConcept(index); inspectComponent(runtimeConcepts[index].id); }));
  run.addEventListener('click', () => void execute());
  cancel.addEventListener('click', async () => { if (jobId) { cancelRequested = true; cancel.disabled = true; try { await api(`jobs/${jobId}/cancel`, {}); text('[data-run-message]', 'Cancellation requested at the next safe workflow boundary.'); } catch { text('[data-run-message]', 'Unable to confirm cancellation. Inspect the final trace before assuming it stopped.'); } } });
  for (const field of [scenario, provider, failure, transport, q<HTMLInputElement>('[data-remote]')]) field.addEventListener('change', () => { q('[data-pending-note]').hidden = false; });
  provider.addEventListener('change', () => { text('[data-provider-help]', provider.value === 'mock' ? 'Fixed rules replace an AI model. The same input gives the same proposal. The Python workflow and policy checks still execute.' : 'Use an available configured AI provider when policy permits. The trace identifies the provider that actually ran, including any fixed-rule fallback.'); });
  scenario.addEventListener('change', () => { stopPlayback(); updateInput(); text('[data-run-message]', 'Scenario selected. Run it to create a new trace; the previous trace remains visible.'); });
  root.querySelectorAll<HTMLButtonElement>('[data-depth]').forEach(button => button.addEventListener('click', () => {
    root.dataset.mode = button.dataset.depth;
    root.querySelectorAll<HTMLButtonElement>('[data-depth]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-direction]').forEach(button => button.addEventListener('click', () => {
    root.querySelectorAll<HTMLButtonElement>('[data-direction]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    root.querySelectorAll<SVGPathElement>('[data-runtime]').forEach(path => path.setAttribute('d', button.dataset.direction === 'runtime' ? path.dataset.runtime! : path.dataset.dependency!));
    text('[data-flow-explanation]', button.dataset.direction === 'runtime' ? 'Runtime calls travel through application-owned ports to replaceable adapters.' : 'Source dependencies point toward the core-owned contracts. Adapters import/implement ports; domain rules do not import the adapters.');
  }));
  root.querySelectorAll<HTMLButtonElement>('[data-component]').forEach(button => button.addEventListener('click', () => { stopPlayback(); inspectComponent(button.dataset.component!); }));
  q<HTMLSelectElement>('[data-arch-provider]').addEventListener('change', event => {
    const value = (event.target as HTMLSelectElement).value;
    text('[data-arch-inference]', value === 'local' ? 'Ollama / local model' : value === 'cloud' ? 'Cloud-compatible API' : 'Deterministic mock'); inspectComponent('inference');
  });
  transport.addEventListener('change', () => { text('[data-arch-transport]', transport.value === 'in_memory' ? 'In-memory delivery' : 'Simulation delivery'); inspectComponent('notification'); });
  root.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach(button => button.addEventListener('click', () => { stopPlayback(); stageIndex = Number(button.dataset.stage); renderStage(); }));
  q('[data-prev]').addEventListener('click', () => { stopPlayback(); stageIndex = Math.max(0, stageIndex - 1); renderStage(); });
  q('[data-next]').addEventListener('click', () => { stopPlayback(); stageIndex = Math.min(pipeline.length - 1, stageIndex + 1); renderStage(); });
  q('[data-reset]').addEventListener('click', () => { stopPlayback(); stageIndex = 0; renderStage(); });
  play.addEventListener('click', () => {
    if (playing) { stopPlayback(); return; }
    if (motion.matches) return;
    if (stageIndex === pipeline.length - 1) stageIndex = 0;
    playing = true; play.textContent = 'Pause steps'; play.setAttribute('aria-pressed', 'true'); renderStage(); schedulePlayback();
  });
  q('[data-speed]').addEventListener('change', schedulePlayback);
  document.addEventListener('visibilitychange', schedulePlayback);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedulePlayback(); }, { threshold: 0.1 }).observe(q('#execution'));
  const syncMotion = () => { stopPlayback(); play.hidden = motion.matches; };
  motion.addEventListener('change', syncMotion); syncMotion();
  q('[data-download]').addEventListener('click', () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...current, provenance: source }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `aegis-${current.trace_id}.json`; link.click(); URL.revokeObjectURL(url);
  });
  q<HTMLSelectElement>('[data-routing-preset]').addEventListener('change', event => applyPreset(Number((event.target as HTMLSelectElement).value)));
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-route]').forEach(field => { field.addEventListener('input', displayResources); field.addEventListener('change', () => void requestRouting()); });
  q('[data-pin]').addEventListener('click', () => { if (!currentRoute) return; const comparison = q('[data-comparison]'); comparison.hidden = false; comparison.textContent = `Pinned result: ${currentRoute.backend || 'unable to execute'} — ${currentRoute.rationale}`; });
}
