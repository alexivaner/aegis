import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainRoute, routeFacts, readableReason, routeSteps } from '../src/lib/routing-view.ts';
const { routing_presets: presets } = JSON.parse(readFileSync(new URL('../public/aegis-data/fixtures.json', import.meta.url)));

test('all six recorded Python routes receive consistent plain-language decisions', () => {
  assert.deepEqual(presets.map(preset => preset.result.backend), ['local', 'cloud', 'local', null, 'cloud', 'local']);
  for (const preset of presets) {
    const before = JSON.stringify(preset);
    const view = explainRoute(preset.result);
    assert.equal(view.title, preset.result.backend === 'local' ? 'Run locally' : preset.result.backend === 'cloud' ? 'Use the cloud' : 'Cannot run safely');
    assert.equal(JSON.stringify(preset), before);
  }
});
test('cloud explanation retains the reason local could not run', () => {
  assert.match(explainRoute(presets[1].result).explanation, /4 GB/);
  assert.match(explainRoute(presets[4].result).explanation, /capability/);
});
test('blocked explanation preserves both independent restrictions', () => {
  const view = explainRoute(presets[3].result);
  assert.match(view.local.join(' '), /4 GB/);
  assert.match(view.cloud.join(' '), /stay on your device/);
  assert.match(view.explanation, /stops/);
});
test('presentation keeps unknown backend reasons and distinguishes permission from connectivity', () => {
  assert.equal(readableReason('A newly introduced reason'), 'A newly introduced reason');
  const facts = routeFacts({ ...presets[0].input, privacy: 'remote_permitted', network: 'offline' });
  assert.ok(facts.includes('Cloud permitted'));
  assert.ok(facts.includes('No internet'));
});

test('every preset exposes all four roles and never presents execution as completed', () => {
  for (const preset of presets) {
    const steps = routeSteps(preset.input, preset.result);
    assert.deepEqual(steps.map(step => step.title), ['Telemetry', 'Policy engine', 'Scheduler', 'Execution backend']);
    assert.match(steps[0].input, new RegExp(`CPU ${preset.input.cpu}%`));
    assert.match(steps[0].output, /fictional/);
    assert.equal(steps[3].status, preset.result.backend ? 'Preview only' : 'Not reached');
    assert.match(steps[3].output, /[Nn]o model runs/);
    for (const reasons of Object.values(preset.result.policy_evaluation.rejected)) {
      for (const reason of reasons) assert.ok(steps[1].output.includes(readableReason(reason)));
    }
  }
});

test('cloud-first selection explains preference when both routes passed policy', () => {
  const result = { ...presets[0].result, backend: 'cloud', selected: 'cloud-candidate', rejected: {}, alternatives: ['local-candidate'], policy_evaluation: { eligible: ['local-candidate','cloud-candidate'], rejected: {} } };
  const steps = routeSteps({ ...presets[0].input, privacy: 'remote_permitted', preferred_backend: 'cloud' }, result);
  assert.match(explainRoute(result).explanation, /Both routes meet/);
  assert.doesNotMatch(explainRoute(result).explanation, /not eligible|cannot handle/);
  assert.match(steps[2].input, /cloud first/);
  assert.match(steps[2].output, /Select cloud/);
});

test('pending conditions do not inherit an old selection or successful execution', () => {
  const steps = routeSteps({ ...presets[0].input, cpu: 99 }, null);
  assert.match(steps[0].input, /CPU 99%/);
  assert.equal(steps[1].status, 'Waiting for Python');
  assert.equal(steps[2].status, 'Waiting for policy');
  assert.equal(steps[3].status, 'Waiting for selection');
  assert.doesNotMatch(steps[2].output, /Select local|Select cloud/);
  assert.match(steps[3].output, /No model call/);
});
