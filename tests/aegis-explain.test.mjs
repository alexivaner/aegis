import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainRun, explainStage } from '../src/lib/aegis-explain.ts';

const fixtures = JSON.parse(readFileSync(new URL('../public/aegis-data/fixtures.json', import.meta.url)));
const trace = (scenario, failure = 'scenario') => fixtures.traces[`${scenario}:${failure}:simulation`];

test('run explanation shows recorded device values and the actual notification message', () => {
  const run = trace('battery');
  const story = explainRun(run);
  assert.equal(story.fields.find(field => field.label === 'Battery').value, '17%');
  assert.equal(story.fields.find(field => field.label === 'Meeting').value, 'In 8 min');
  assert.equal(story.message, run.decision.summary);
  assert.equal(story.title, 'Show a notification now');
  assert.match(story.backend, /no AI model/);
  assert.match(story.delivery, /No real device notification/);
  assert.equal(story.reason, 'The proposal passed the policy checks, so showing this notification is allowed.');
});

test('focus-mode deferral explains that inference and delivery were skipped', () => {
  const run = trace('update');
  assert.equal(explainRun(run).title, 'Wait before notifying');
  assert.match(explainRun(run).backend, /no model needed/);
  assert.match(explainStage(run, 'model_execution').result, /No model call/);
  assert.equal(explainRun(run).channel, 'No notification delivery');
  assert.match(explainRun(run).reason, /Focus mode is on/);
});

test('an approved intent with failed delivery is never presented as a delivered notification', () => {
  const run = trace('battery', 'delivery');
  assert.equal(run.decision.action, 'notify');
  assert.equal(explainRun(run).title, 'Execution failed');
  assert.match(explainRun(run).reason, /delivery failed.*Nothing was delivered/);
  assert.match(explainStage(run, 'notification_dispatch').result, /failed/);
});

test('timeout fallback identifies the backup and preserves provider errors', () => {
  const run = trace('timeout');
  assert.match(explainRun(run).backend, /Backup fixed rules/);
  assert.match(explainStage(run, 'model_execution').result, /first provider failed/);
  assert.equal(run.error_category, 'provider_timeout');
});

test('cancelled and missing steps do not invent a successful outcome or device readings', () => {
  const run = trace('battery', 'cancel');
  assert.equal(explainRun(run).title, 'Execution cancelled');
  assert.match(explainStage(run, 'notification_dispatch').input, /not reached/);
  const early = { ...run, stages: [], decision: null };
  assert.deepEqual(explainRun(early).fields, []);
  assert.match(explainRun(early).message, /No notification preview was delivered/);
});

test('all exported traces have readable step explanations without mutating evidence', () => {
  for (const run of Object.values(fixtures.traces)) {
    const original = JSON.stringify(run);
    for (const stage of run.stages) {
      const story = explainStage(run, stage.name);
      for (const value of Object.values(story)) {
        assert.equal(typeof value, 'string');
        assert.doesNotMatch(value, /undefined|\[object Object\]/);
      }
    }
    explainRun(run);
    assert.equal(JSON.stringify(run), original);
  }
});

test('the view preserves unknown recorded reasons instead of inferring a new policy decision', () => {
  const run = trace('battery');
  const changed = { ...run, decision: { ...run.decision, action: 'suppress', reasons: ['An externally supplied policy explanation.'] } };
  const story = explainRun(changed);
  assert.equal(story.title, 'Do not notify');
  assert.equal(story.reason, 'An externally supplied policy explanation.');
});
