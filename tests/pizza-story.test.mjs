import test from 'node:test';
import assert from 'node:assert/strict';
import { initialStory, storyView, pizzaMapping, roleConnections } from '../src/lib/pizza-story.ts';

test('changing the order entrance preserves the core rules and example total',()=>{
  const first=storyView(initialStory);
  const second=storyView({...initialStory,channel:'second'});
  assert.equal(first.selectedInput,'Website order');
  assert.equal(second.selectedInput,'Counter order');
  assert.deepEqual(first.coreLines,second.coreLines);
  assert.ok(second.coreLines.includes('Total: $14'));
  assert.equal(first.outgoingContract,second.outgoingContract);
});
test('swapping a payment adapter keeps its application-owned contract',()=>{
  const view=storyView({...initialStory,lesson:1,provider:'second'});
  assert.equal(view.selectedProvider,'Wallet adapter');
  assert.equal(view.outgoingContract,'PaymentProcessor');
  assert.match(view.unchanged,/same order still totals \$14/);
  assert.equal(view.focus,'outgoing');
});
test('local and cloud illustrations keep the same inference and privacy boundary',()=>{
  const local=storyView({...initialStory,mode:'ai',lesson:2});
  const cloud=storyView({...initialStory,mode:'ai',provider:'second',lesson:1});
  assert.equal(local.outgoingContract,'InferenceProvider');
  assert.equal(cloud.outgoingContract,'InferenceProvider');
  assert.deepEqual(local.coreLines,cloud.coreLines);
  assert.match(cloud.unchanged,/does not grant it permission/);
  assert.match(cloud.limitation,/No model runs/);
  assert.match(cloud.limitation,/does not change the routing lab/);
});
test('the AI explanation maps all four roles without calling them architecture layers',()=>{
  assert.deepEqual(roleConnections.map(row=>row[0]),['Telemetry','Policy engine','Scheduler','Execution backend']);
  assert.ok(pizzaMapping.some(row=>row[1]==='Outgoing port / contract'&&row[2]==='InferenceProvider'));
  assert.ok(pizzaMapping.some(row=>row[1]==='Core business logic'));
});
test('the default example does not claim a real purchase or mutate shared state',()=>{
  const before=JSON.stringify(initialStory);
  assert.match(storyView(initialStory).limitation,/No order is placed/);
  storyView({...initialStory,mode:'ai',provider:'second'});
  assert.equal(JSON.stringify(initialStory),before);
});
