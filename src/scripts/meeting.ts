import { defaultMeetingOptions, evidenceSources, methodLabel, pathLabel, resultHeading, resultMarkdown, type EvidenceItem, type MeetingFixtures, type MeetingOptions, type MeetingPlan, type MeetingResult, type QueueView } from '../lib/meeting-view';

export async function initMeetingLab(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`Missing meeting control: ${selector}`);
    return node;
  };
  const text = (selector: string, value: string) => { q(selector).textContent = value; };
  const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = value; return node;
  };
  const notes = q<HTMLTextAreaElement>('[data-m-notes]');
  const mode = q<HTMLSelectElement>('[data-m-mode]');
  const manual = q<HTMLInputElement>('[data-m-manual]');
  const run = q<HTMLButtonElement>('[data-m-run]');
  let fixtures: MeetingFixtures;
  let live = false, working = true, dirty = false, editing = false;
  let session: string | null = null, activeJob: string | null = null;
  let sampleId = 'design', experimentId = 'baseline', selectedRole = 'telemetry', selectedSourceKey = '';
  let result: MeetingResult, plan: MeetingPlan, queue: QueueView | null = null, pinned: MeetingResult | null = null;
  let planGeneration = 0;

  async function api<T>(path: string, payload?: unknown): Promise<T> {
    const response = await fetch('/api/aegis/meeting/' + path, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(path === 'health' ? 1500 : 45000) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(typeof body.detail === 'string' ? body.detail : `Request unavailable (${response.status})`);
    }
    return response.json() as Promise<T>;
  }
  function options(): MeetingOptions {
    return { mode: mode.value as MeetingOptions['mode'], private: q<HTMLInputElement>('[data-m-private]').checked, network: q<HTMLInputElement>('[data-m-offline]').checked ? 'offline' : 'online', local_available: q<HTMLInputElement>('[data-m-local]').checked, cloud_available: q<HTMLInputElement>('[data-m-cloud]').checked, busy: q<HTMLInputElement>('[data-m-busy]').checked, failure: q<HTMLSelectElement>('[data-m-failure]').value as MeetingOptions['failure'] };
  }
  function setOptions(value: Partial<MeetingOptions>) {
    const next = { ...defaultMeetingOptions, ...value };
    mode.value = next.mode;
    for (const [key, selector] of [['private','private'],['local_available','local'],['cloud_available','cloud'],['busy','busy']] as const) q<HTMLInputElement>(`[data-m-${selector}]`).checked = next[key];
    q<HTMLInputElement>('[data-m-offline]').checked = next.network === 'offline';
    q<HTMLSelectElement>('[data-m-failure]').value = next.failure;
    updateModeHelp();
  }
  function updateModeHelp() {
    text('[data-m-mode-help]', mode.value === 'learning' ? 'Python runs text extraction, policy checks and the queue. Device conditions and local/cloud model profiles are simulated. Learning mode never sends your notes to a model.' : 'A configured model will process these notes. On-device-only policy blocks cloud calls; switching that policy off explicitly permits cloud processing. Device resource inputs remain simulated.');
  }
  function syncControls() {
    for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-m-notes],[data-m-mode],[data-m-private],[data-m-offline],[data-m-local],[data-m-cloud],[data-m-busy],[data-m-failure]')) node.disabled = !live || working || Boolean(activeJob);
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-m-sample],[data-m-experiment]')) button.disabled = working || Boolean(activeJob);
    run.disabled = working || Boolean(activeJob);
    manual.disabled = !live || working;
    const backgroundPending = queue?.items.some(item => item.kind === 'background' && ['queued','paused','running'].includes(item.status));
    q<HTMLButtonElement>('[data-m-background]').disabled = !live || working || Boolean(backgroundPending);
    text('[data-m-background]', backgroundPending ? 'Reference task queued' : 'Add reference indexing');
    q<HTMLButtonElement>('[data-m-step]').disabled = !live || working || !queue?.next_order.length;
    q('[data-m-cancel]').hidden = !activeJob;
    q<HTMLButtonElement>('[data-m-cancel]').disabled = working;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-item-sources],[data-source-id]')) button.disabled = dirty || working;
  }
  function setEditing(value: boolean) {
    editing = value;
    q('[data-m-editor]').hidden = !value;
    q('[data-m-source-view]').hidden = value;
    text('[data-m-edit]', value ? 'Read result evidence' : 'Edit notes');
  }
  function markDirty() {
    dirty = true; q('[data-m-stale]').hidden = false;
    text('[data-m-message]', 'Selected inputs changed. Create a summary to apply them. The previous output is retained for reference.');
    syncControls();
  }
  function renderPlan(value: MeetingPlan) {
    plan = value;
    text('[data-m-plan-title]', pathLabel(value.placement.selected));
    text('[data-m-plan-reason]', value.placement.rationale);
    text('[data-m-plan-privacy]', value.privacy + (value.mode === 'learning' ? ' · Fictional profiles; no external request.' : ' · Configured model candidates.'));
    const rejected = q('[data-m-rejected]'); rejected.replaceChildren();
    for (const [id, reasons] of Object.entries(value.policy.rejected)) {
      const entry = create('div'); entry.append(create('strong','',pathLabel(id)), create('p','',reasons.join(' · '))); rejected.append(entry);
    }
    if (!Object.keys(value.policy.rejected).length) rejected.append(create('p','','No candidate was rejected. The scheduler prefers a permitted local path.'));
    renderRole(selectedRole);
  }
  async function requestPlan() {
    if (!live) return;
    const generation = ++planGeneration;
    try { const value = await api<MeetingPlan>('plan', options()); if (generation === planGeneration) renderPlan(value); }
    catch (error) { if (generation === planGeneration) text('[data-m-message]', `${error instanceof Error ? error.message : 'Planning unavailable'}. Previous plan retained.`); }
  }
  function selectEvidence(ids: string[], item?: EvidenceItem) {
    if (dirty) return;
    setEditing(false);
    const key = [...ids].sort().join(' ');
    selectedSourceKey = selectedSourceKey === key ? '' : key;
    if (!selectedSourceKey) ids = [];
    for (const node of root.querySelectorAll<HTMLButtonElement>('[data-source-id]')) node.setAttribute('aria-pressed', String(ids.includes(node.dataset.sourceId!)));
    for (const node of root.querySelectorAll<HTMLButtonElement>('[data-item-sources]')) {
      const selected = node.dataset.itemSources!.split(' ').some(id => ids.includes(id));
      node.setAttribute('aria-pressed', String(selected)); node.setAttribute('aria-expanded', String(selected));
      const inline = node.querySelector<HTMLElement>('.ml-inline-evidence'); if(inline) inline.hidden = !selected;
    }
    const sources = !ids.length ? [] : item ? evidenceSources(result, item) : result.sentences.filter(source => ids.includes(source.id));
    text('[data-m-evidence]', sources.length ? sources.map(source => `Source ${source.id.slice(1)} · ${source.speaker}: “${source.text}”`).join('\n\n') + (item?.due === null ? '\n\nNo deadline was stated. The result leaves it blank.' : '') : 'No matching source was recorded.');
  }
  function renderSources() {
    const list = q('[data-m-sources]'); list.replaceChildren();
    for (const source of result.sentences) {
      const button = create('button'); button.type = 'button'; button.dataset.sourceId = source.id; button.setAttribute('aria-pressed','false');
      const body = create('span'); body.append(create('strong','',source.speaker), create('span','',source.text));
      button.append(create('span','ml-source-number',source.id.slice(1)), body);
      button.addEventListener('click', () => selectEvidence([source.id])); list.append(button);
    }
  }
  function evidenceButton(item: EvidenceItem) {
    const button = create('button','ml-evidence-item'); button.type = 'button'; button.dataset.itemSources = item.source_ids.join(' '); button.setAttribute('aria-pressed','false');
    button.append(create('span','',item.text), create('small','',`Check source ${item.source_ids.map(id => id.slice(1)).join(', ')} ↖`));
    const inline = create('span','ml-inline-evidence', evidenceSources(result,item).map(source => `${source.speaker}: “${source.text}”`).join('\n'));
    inline.hidden = true; button.append(inline); button.setAttribute('aria-expanded','false');
    button.addEventListener('click', () => selectEvidence(item.source_ids, item));
    return button;
  }
  function renderDocument() {
    for (const key of ['summary','actions','decisions'] as const) {
      const list = q(`[data-m-${key}]`); list.replaceChildren();
      const items = result.document?.[key] || [];
      if (!items.length) { list.append(create('p','ml-empty',key === 'actions' ? 'No explicit commitment was found. The learning extractor does not guess an action.' : key === 'decisions' ? 'No explicit decision was found.' : 'No output for this run.')); continue; }
      for (const item of items) {
        if (key !== 'actions') { list.append(evidenceButton(item)); continue; }
        const card = create('article','ml-action'); card.append(evidenceButton(item));
        const dl = create('dl');
        for (const [label, value] of [['Owner', item.owner], ['Due', item.due]]) { const group = create('div'); group.append(create('dt','',label!), create('dd','',value || 'Not stated')); dl.append(group); }
        const review = create('label','ml-reviewed'); const checkbox = create('input'); checkbox.type = 'checkbox'; review.append(checkbox, create('span','','Reviewed against source'));
        card.append(dl, review); list.append(card);
      }
    }
  }
  function renderPhase(index: number) {
    const step = result.trace[index]; if (!step) return;
    for (const node of root.querySelectorAll<HTMLButtonElement>('[data-m-phase]')) node.setAttribute('aria-pressed', String(Number(node.dataset.mPhase) === index));
    text('[data-m-phase-label]', `STEP ${index + 1} / LAST COMPLETED RUN`);
    text('[data-m-phase-title]', step.title);
    text('[data-m-phase-explanation]', step.explanation);
    text('[data-m-phase-timing]', step.duration_ms === null ? 'Snapshot · no separate timing claimed' : `${step.duration_ms.toFixed(3)} ms · measured Python work`);
    text('[data-m-phase-payload]', JSON.stringify(step.data, null, 2));
    const role = ({ read:'context',telemetry:'telemetry',policy:'policy',scheduler:'scheduler',execution:'inference',validation:'core',outcomes:'telemetry' } as Record<string,string>)[step.id];
    document.dispatchEvent(new CustomEvent('aegis:meeting-phase', { detail: role }));
  }
  function renderPhases() {
    const list = q('[data-m-phases]'); list.replaceChildren();
    result.trace.forEach((step,index) => { const button = create('button','',`${String(index+1).padStart(2,'0')} · ${step.title}`); button.type = 'button'; button.dataset.mPhase = String(index); button.addEventListener('click', () => renderPhase(index)); list.append(button); });
    renderPhase(0);
  }
  function renderComparison() {
    const target = q('[data-m-comparison]'); target.hidden = !pinned; target.replaceChildren(); if (!pinned) return;
    for (const [label, runResult] of [['Saved run',pinned],['Current run',result]] as const) { const card = create('div'); card.append(create('strong','',label),create('p','',`${pathLabel(runResult.actual_backend)} · ${runResult.options.private ? 'on-device only' : 'cloud permitted'} · ${runResult.state}`), create('p','',`${runResult.document?.actions.length || 0} actions · ${methodLabel(runResult)}`)); target.append(card); }
  }
  function renderResult(value: MeetingResult, source: 'live' | 'recorded') {
    result = value; dirty = false; selectedSourceKey = ''; q('[data-m-stale]').hidden = true;
    text('[data-m-result-heading]', resultHeading(value));
    text('[data-m-result-source]', `${source === 'live' ? 'Live Python run' : 'Recorded Python example'} · ${methodLabel(value)}`);
    text('[data-m-path]', `Used: ${pathLabel(value.actual_backend)} · ${value.elapsed_ms.toFixed(3)} ms measured Python work, not a hardware/LLM benchmark.`);
    text('[data-m-count]', `${value.document?.actions.length || 0} actions`);
    q('[data-m-document]').hidden = !value.document;
    const notice = q('[data-m-outcome]'); notice.hidden = value.state === 'complete' && value.attempts.length === 1;
    notice.textContent = value.state !== 'complete' ? value.error || 'No valid output.' : `The first candidate failed. An allowed fallback produced this result: ${pathLabel(value.actual_backend)}. ${value.options.mode === 'learning' ? 'This remains a learning simulation; no cloud request was sent.' : ''}`;
    notice.dataset.state = value.state;
    text('[data-m-evidence]', 'Select a key point, action, decision, or source line to check its evidence.');
    text('[data-m-summary-hint]', value.execution_kind === 'extractive_learning_rules' ? 'Learning mode selects source excerpts. It does not generate an AI-written summary.' : 'AI-written draft. Select the source links and check that each statement is supported.');
    renderSources(); renderDocument(); renderPhases(); renderComparison(); renderRole(selectedRole); setEditing(false);
    text('[data-m-json]', JSON.stringify(value, null, 2));
    if (value.queue) renderQueue(value.queue);
    syncControls();
  }
  function renderQueue(value: QueueView) {
    queue = value;
    const target = q('[data-m-queue-items]'); target.replaceChildren();
    if (!value.items.length) target.append(create('p','ml-empty','No work queued. Add reference indexing, then request a meeting summary.'));
    const pending = value.items.filter(item => ['queued','paused','running'].includes(item.status));
    const terminal = value.items.filter(item => !pending.includes(item));
    const visible = new Set([...pending, ...terminal.slice(-2)]);
    const history = q('[data-m-queue-history]'); history.replaceChildren();
    q('[data-m-history-panel]').hidden = terminal.length <= 2;
    for (const item of terminal.slice(0,-2)) history.append(create('p','ml-small',`${item.label} · ${item.status} · ${item.done}/${item.total} work units`));
    for (const item of value.items.filter(item => visible.has(item))) {
      const card = create('div','ml-queue-item');
      const head = create('div'); head.append(create('strong','',item.label),create('span','',`${item.kind === 'meeting' ? 'Interactive priority' : 'Background priority'}${item.waited ? ` · waited ${item.waited} turn(s)` : ''}`));
      const status = create('span','ml-job-state',`${value.next_order[0] === item.id ? 'Next · ' : ''}${item.status}`);
      const progress = create('progress'); progress.max = item.total; progress.value = item.done; progress.setAttribute('aria-label',`${item.label}: ${item.done} of ${item.total} work units complete`);
      card.append(head,status,progress,create('small','',`${item.done}/${item.total} ${item.kind === 'background' ? 'chunks' : 'jobs'} completed`)); target.append(card);
    }
    text('[data-m-indexed]', value.indexed_words ? `The background task has actually indexed ${value.indexed_words} distinct words from fictional reference text. No continuous background load or GPU scheduling is implied.` : 'The queue runs small Python work units, not GPU tasks.');
    const events = q('[data-m-queue-events]'); events.replaceChildren();
    value.events.slice(-5).forEach(event => events.append(create('li','',event)));
    renderRole(selectedRole); syncControls();
  }
  function renderRole(role: string) {
    if (!plan || !result) return;
    selectedRole = role;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-m-role]')) button.setAttribute('aria-pressed',String(button.dataset.mRole === role));
    const entries: Record<string,[string,string,string]> = {
      telemetry: ['Telemetry observes conditions.','It answers: what resources and network are available? Device conditions are simulated here. Python work durations come from actual execution.',`Selected conditions: CPU ${plan.telemetry.cpu}% · free memory ${plan.telemetry.available_memory_gb} GB · network ${plan.telemetry.network}.`],
      policy: ['Policy sets the boundaries.','It answers: which candidates are allowed? Keeping notes on-device forbids cloud processing, even when a local model is unavailable.',`${plan.privacy}. ${plan.policy.eligible.length} candidate(s) admitted. ${Object.values(plan.policy.rejected).flat().join(' · ') || 'No candidates rejected.'}`],
      scheduler: ['The scheduler chooses where and when.','It places work among policy-admitted candidates. The queue gives interactive meeting requests priority; waiting background work earns a turn through aging.',`Current placement: ${pathLabel(plan.placement.selected)}. ${queue?.next_order.length || 0} queued work item(s). One worker; tasks yield between chunks.`],
      execution: ['The backend produces the draft.','It receives the notes and returns a structured document. Source references are checked before the recap is shown; references do not guarantee that every model paraphrase is correct.',`Last completed run: ${methodLabel(result)}. ${result.document?.actions.length || 0} action(s), ${result.document?.decisions.length || 0} decision(s).`],
    };
    const entry = entries[role] || entries.telemetry;
    text('[data-m-role-context]', role === 'execution' ? 'LAST COMPLETED RUN' : 'CURRENT SELECTED CONDITIONS AND QUEUE');
    text('[data-m-role-title]', entry[0]); text('[data-m-role-explanation]', entry[1]); text('[data-m-role-example]', entry[2]);
  }
  async function advance() {
    const receipt = await api<{job_id: string | null; result: MeetingResult | null; queue: QueueView}>('step',{session_id:session});
    renderQueue(receipt.queue);
    if (receipt.result) {
      if (receipt.job_id === activeJob) activeJob = null;
      receipt.result.queue = receipt.queue;
      renderResult(receipt.result,'live');
      text('[data-m-message]', receipt.result.state === 'complete' ? 'Recap ready. Select an output to inspect its source, or continue the reference task below.' : 'The run stopped without a valid recap. Read the explanation in the output panel.');
    }
    return receipt;
  }
  async function runSummary() {
    if (working || activeJob) return;
    if (!live) { renderResult(fixtures.runs[`${sampleId}:${experimentId}`],'recorded'); text('[data-m-message]','Recorded example loaded. Start the Python service for editable notes and a live work queue.'); return; }
    working = true; syncControls(); text('[data-m-message]','Adding your meeting request to the Python work queue…');
    try {
      const receipt = await api<{job_id:string;queue:QueueView}>('enqueue',{session_id:session,kind:'meeting',notes:notes.value,...options()}); activeJob = receipt.job_id; renderQueue(receipt.queue);
      if (manual.checked) text('[data-m-message]','Meeting queued. Select Run next work turn to see what the scheduler chooses.');
      else {
        text('[data-m-message]','Running the next permitted work item. Model calls may take time; no progress is fabricated.');
        for (let i=0;i<8 && activeJob;i++) await advance();
        if (activeJob) text('[data-m-message]','Meeting remains queued. Continue one work turn at a time below.');
      }
    } catch(error) { text('[data-m-message]',`${error instanceof Error ? error.message : 'Execution unavailable'}. The previous result is retained.`); }
    finally { working = false; syncControls(); }
  }
  async function addBackground() {
    if (!live || working) return;
    working = true; syncControls();
    try { const receipt = await api<{queue:QueueView}>('enqueue',{session_id:session,kind:'background'}); renderQueue(receipt.queue); if (!manual.checked && !activeJob) await advance(); text('[data-m-message]','Reference indexing added. Request a summary to observe priority, or run another work turn.'); }
    catch(error) { text('[data-m-message]',error instanceof Error ? error.message : 'Queue unavailable'); }
    finally { working=false; syncControls(); }
  }
  async function loadExperiment(id: string) {
    const experiment = fixtures.experiments.find(item=>item.id===id); if(!experiment) return;
    experimentId=id; setOptions(experiment.options);
    for(const button of root.querySelectorAll<HTMLButtonElement>('[data-m-experiment]')) button.setAttribute('aria-pressed',String(button.dataset.mExperiment===id));
    text('[data-m-goal]',experiment.goal);
    if (!live) { const record = fixtures.runs[`${sampleId}:${id}`]; renderPlan(record.plan); renderResult(record,'recorded'); return; }
    markDirty(); await requestPlan();
    if(id==='busy' && !queue?.items.some(item=>item.kind==='background' && ['queued','paused'].includes(item.status))) await addBackground();
  }

  try {
    const response = await fetch('/aegis-data/meeting.json'); if(!response.ok) throw new Error('Recorded meeting examples unavailable'); fixtures=await response.json() as MeetingFixtures;
    result=fixtures.runs['design:baseline']; plan=result.plan;
    try {
      const health=await api<{capabilities:{local:boolean;cloud:boolean;local_model:string|null}}>('health');
      session=(await api<{session_id:string}>('session',{})).session_id; live=true;
      const modelOption=mode.querySelector<HTMLOptionElement>('option[value=model]')!;
      modelOption.disabled=!(health.capabilities.local||health.capabilities.cloud);
      modelOption.textContent=modelOption.disabled?'Real AI model · not configured':'Real AI model · configured providers';
    } catch {live=false;}
    text('[data-m-connection]',live?'Live Python workspace':'Recorded examples · Python API offline');
    text('[data-m-queue-mode]',live?'One cooperative Python worker':'Recorded queue example');
    renderPlan(plan); renderResult(result,'recorded');
    if(live) {queue={items:[],next_order:[],events:[],indexed_words:0,scope:'single worker'}; renderQueue(queue); await requestPlan();}
    else text('[data-m-message]','These are recorded Python learning examples. Choose a lesson or meeting sample; start the Python service to edit notes or use the live queue.');
    working=false; syncControls(); root.dataset.enhanced='true';
  } catch(error) {text('[data-m-message]',error instanceof Error?error.message:'Initialization unavailable'); return;}

  run.addEventListener('click',()=>void runSummary());
  q('[data-m-edit]').addEventListener('click',()=>setEditing(!editing));
  notes.addEventListener('input',markDirty);
  for(const field of [mode,q<HTMLInputElement>('[data-m-private]'),q<HTMLInputElement>('[data-m-offline]'),q<HTMLInputElement>('[data-m-local]'),q<HTMLInputElement>('[data-m-cloud]'),q<HTMLInputElement>('[data-m-busy]'),q<HTMLSelectElement>('[data-m-failure]')]) field.addEventListener('change',()=>{markDirty();updateModeHelp();void requestPlan();});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-m-sample]')) button.addEventListener('click',()=>{sampleId=button.dataset.mSample!;notes.value=fixtures.samples.find(sample=>sample.id===sampleId)!.notes; for(const other of root.querySelectorAll('[data-m-sample]')) other.setAttribute('aria-pressed',String(other===button)); if(live){markDirty();setEditing(true);}else{const value=fixtures.runs[`${sampleId}:${experimentId}`];renderPlan(value.plan);renderResult(value,'recorded');}});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-m-experiment]')) button.addEventListener('click',()=>void loadExperiment(button.dataset.mExperiment!));
  q('[data-m-background]').addEventListener('click',()=>void addBackground());
  q('[data-m-step]').addEventListener('click',async()=>{if(working||!live)return;working=true;syncControls();try{await advance();}catch(error){text('[data-m-message]',error instanceof Error?error.message:'Queue unavailable');}finally{working=false;syncControls();}});
  q('[data-m-cancel]').addEventListener('click',async()=>{if(!activeJob||working)return;working=true;syncControls();try{const snapshot=await api<QueueView>('cancel',{session_id:session,job_id:activeJob});activeJob=null;renderQueue(snapshot);text('[data-m-message]','Queued meeting cancelled before its next work turn.');}catch(error){text('[data-m-message]',error instanceof Error?error.message:'Cancellation unavailable');}finally{working=false;syncControls();}});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-m-role]')) button.addEventListener('click',()=>renderRole(button.dataset.mRole!));
  q('[data-m-pin]').addEventListener('click',()=>{pinned=structuredClone(result);renderComparison();});
  q('[data-m-download]').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([resultMarkdown(result)],{type:'text/markdown;charset=utf-8'}));const link=create('a');link.href=url;link.download='meeting-recap.md';link.click();URL.revokeObjectURL(url);});
}
