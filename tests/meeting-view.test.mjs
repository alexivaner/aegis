import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceSources, methodLabel, pathLabel, resultHeading, resultMarkdown } from '../src/lib/meeting-view.ts';
const fixtures=JSON.parse(readFileSync(new URL('../public/aegis-data/meeting.json',import.meta.url)));
const run=fixtures.runs['design:baseline'];

test('each action points to the recorded source, owner and due date',()=>{
  const action=run.document.actions[0];
  const sources=evidenceSources(run,action);
  assert.equal(sources.length,1);
  assert.equal(sources[0].speaker,'Maya');
  assert.ok(sources[0].text.includes(action.due));
  assert.ok(sources[0].text.includes(action.evidence_quote));
});
test('missing deadlines remain visibly unstated in recap export',()=>{
  const value=fixtures.runs['uncertain:baseline'];
  assert.equal(value.document.actions[0].due,null);
  assert.match(resultMarkdown(value),/Due date not stated/);
});
test('learning cloud paths never receive actual AI labels',()=>{
  const value=fixtures.runs['design:cloud'];
  assert.match(pathLabel(value.actual_backend),/learning profile/);
  assert.match(methodLabel(value),/no AI model or cloud request/);
});
test('blocked runs have no fabricated recap in display or export',()=>{
  const value=fixtures.runs['design:blocked'];
  assert.equal(value.document,null);
  assert.match(resultHeading(value),/No summary was created/);
  assert.doesNotMatch(resultMarkdown(value),/## Actions/);
});
test('falling back preserves the actual path and evidence',()=>{
  const value=fixtures.runs['design:fallback'];
  assert.equal(value.actual_backend,'demo-cloud');
  assert.equal(value.attempts.length,3);
  assert.equal(evidenceSources(value,value.document.actions[1])[0].speaker,'Rafi');
});
test('unknown source IDs produce no invented source text',()=>{
  assert.deepEqual(evidenceSources(run,{text:'Unsupported',source_ids:['s999'],evidence_quote:'invented'}),[]);
});
test('all recorded examples preserve evidence while formatting a local recap',()=>{
  for(const value of Object.values(fixtures.runs)){
    const original=JSON.stringify(value);
    const markdown=resultMarkdown(value);
    assert.doesNotMatch(markdown,/undefined|\[object Object\]/);
    if(value.document)for(const item of [...value.document.summary,...value.document.actions,...value.document.decisions])assert.ok(evidenceSources(value,item).length);
    assert.equal(JSON.stringify(value),original);
  }
});
