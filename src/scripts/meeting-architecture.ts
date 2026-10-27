import { architecture } from '../data/aegis';
export function initMeetingArchitecture(root: HTMLElement) {
  const section = root.closest<HTMLElement>('#architecture')!;
  const q = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  function inspect(id: string) {
    const item = architecture.find(node=>node.id===id); if(!item)return;
    for(const button of root.querySelectorAll('[data-component]')) button.setAttribute('aria-pressed',String((button as HTMLElement).dataset.component===id));
    for(const path of root.querySelectorAll<SVGPathElement>('[data-edge]')) path.dataset.active=String(path.dataset.edge===id||id==='ports'&&path.dataset.edge!=='http');
    for(const [selector,value] of [['kind',item.kind],['title',item.label],['summary',item.summary],['port',item.port],['file',item.file],['detail',item.detail]]) q(`[data-component-${selector}]`).textContent=value;
  }
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-component]')) button.addEventListener('click',()=>inspect(button.dataset.component!));
  section.dataset.mode='overview'; section.dataset.enhanced='true';
  for(const button of section.querySelectorAll<HTMLButtonElement>('[data-depth]')) button.addEventListener('click',()=>{section.dataset.mode=button.dataset.depth;for(const other of section.querySelectorAll('[data-depth]'))other.setAttribute('aria-pressed',String(other===button));});
  for(const button of root.querySelectorAll<HTMLButtonElement>('[data-direction]'))button.addEventListener('click',()=>{for(const other of root.querySelectorAll('[data-direction]'))other.setAttribute('aria-pressed',String(other===button));for(const path of root.querySelectorAll<SVGPathElement>('[data-runtime]'))path.setAttribute('d',button.dataset.direction==='runtime'?path.dataset.runtime!:path.dataset.dependency!);q('[data-flow-explanation]').textContent=button.dataset.direction==='runtime'?'Runtime calls travel through application-owned contracts to replaceable implementations.':'Source dependencies point toward the application-owned contracts. Runtime calls and source-code imports describe different relationships.';});
  root.querySelector<HTMLSelectElement>('[data-arch-provider]')?.addEventListener('change',event=>{const value=(event.target as HTMLSelectElement).value;q('[data-arch-inference]').textContent=value==='local'?'Ollama / actual model integration':value==='cloud'?'Cloud-compatible model integration':'Simulated model adapter';inspect('inference');});
  document.addEventListener('aegis:architecture-focus',event=>inspect((event as CustomEvent<string>).detail));
  document.addEventListener('aegis:meeting-phase',event=>inspect((event as CustomEvent<string>).detail));
}
