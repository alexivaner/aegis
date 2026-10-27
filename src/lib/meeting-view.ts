export type MeetingOptions = { mode: 'learning' | 'model'; private: boolean; network: 'online' | 'offline'; local_available: boolean; cloud_available: boolean; busy: boolean; failure: 'none' | 'timeout' | 'invalid_output' };
export type Sentence = { id: string; speaker: string; text: string };
export type EvidenceItem = { text: string; source_ids: string[]; evidence_quote: string; owner?: string | null; due?: string | null };
export type MeetingDocument = { summary: EvidenceItem[]; actions: EvidenceItem[]; decisions: EvidenceItem[] };
export type MeetingPlan = { telemetry: Record<string, unknown>; policy: { eligible: string[]; rejected: Record<string, string[]> }; placement: { selected: string | null; backend: string | null; rationale: string; alternatives: string[] }; mode: string; provenance: string; privacy: string };
export type QueueItem = { id: string; kind: string; label: string; priority: number; total: number; done: number; waited: number; status: string };
export type QueueView = { items: QueueItem[]; next_order: string[]; events: string[]; indexed_words: number; scope: string };
export type MeetingResult = { trace_id: string; state: string; sentences: Sentence[]; options: MeetingOptions; plan: MeetingPlan; document: MeetingDocument | null; trace: { id: string; title: string; explanation: string; data: unknown; duration_ms: number | null }[]; actual_backend: string | null; execution_kind: string; error: string | null; attempts: { provider: string; attempt: number; status: string; duration_ms: number }[]; elapsed_ms: number; note: string; queue?: QueueView; source?: string };
export type Sample = { id: string; title: string; notes: string };
export type Experiment = { id: string; title: string; goal: string; options: Partial<MeetingOptions> };
export type MeetingFixtures = { samples: Sample[]; experiments: Experiment[]; runs: Record<string, MeetingResult> };
export const defaultMeetingOptions: MeetingOptions = { mode: 'learning', private: true, network: 'online', local_available: true, cloud_available: true, busy: false, failure: 'none' };

export function pathLabel(id: string | null): string {
  if (id === 'demo-local') return 'On-device learning profile';
  if (id === 'demo-cloud') return 'Cloud learning profile';
  if (id === 'ollama-local') return 'Local model / Ollama';
  if (id === 'cloud-compatible') return 'Configured cloud model';
  return id || 'No permitted backend';
}
export function methodLabel(result: Pick<MeetingResult, 'execution_kind'>): string {
  if (result.execution_kind === 'extractive_learning_rules') return 'Text extraction rules · no AI model or cloud request';
  if (result.execution_kind === 'actual_local_model') return 'Actual local AI model';
  if (result.execution_kind === 'actual_cloud_model') return 'Actual cloud AI model';
  return 'No inference executed';
}
export function evidenceSources(result: MeetingResult, item: EvidenceItem): Sentence[] {
  return result.sentences.filter(sentence => item.source_ids.includes(sentence.id));
}
export function resultHeading(result: MeetingResult): string {
  if (result.state === 'blocked') return 'The notes stayed private. No summary was created.';
  if (result.state === 'failed') return 'This run could not produce a valid summary.';
  return 'Your meeting recap';
}
export function resultMarkdown(result: MeetingResult): string {
  const doc = result.document;
  const title = '# Meeting recap\n\n' + methodLabel(result) + '\n\n';
  if (!doc) return title + (result.error || 'No result') + '\n';
  return title + '## Key points\n\n' + doc.summary.map(item => '- ' + item.text).join('\n') + '\n\n## Actions\n\n' + doc.actions.map(item => `- ${item.text} — ${item.owner || 'Owner not stated'} — ${item.due || 'Due date not stated'}`).join('\n') + '\n\n## Decisions\n\n' + doc.decisions.map(item => '- ' + item.text).join('\n') + '\n\nReview against the original notes. No external task or message was created.\n';
}
