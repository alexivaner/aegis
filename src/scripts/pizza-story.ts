import { initialStory, storyView, type StoryState } from '../lib/pizza-story';

export function initPizzaStory(root: HTMLElement) {
  let state: StoryState={...initialStory};
  const q=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const text=(selector:string,value:string)=>{q(selector).textContent=value};
  function render() {
    const view=storyView(state);
    for(const [selector,value] of Object.entries({input:view.selectedInput,provider:view.selectedProvider,core:view.coreTitle,entry:view.incomingContract,port:view.outgoingContract,payload:view.inputPayload,change:view.changed,unchanged:view.unchanged,contract:view.contractMeaning,limit:view.limitation}))text(`[data-pizza-${selector}]`,value);
    q('[data-pizza-focus]').dataset.pizzaFocus=view.focus;
    const rules=q('[data-pizza-rules]');rules.replaceChildren();
    for(const line of view.coreLines){const item=document.createElement('li');item.textContent=line;rules.append(item)}
    for(const [selector,values] of [['[data-pizza-channel]',view.inputOptions],['[data-pizza-provider-select]',view.providerOptions]] as const){const select=q<HTMLSelectElement>(selector);for(let index=0;index<2;index++)select.options[index].textContent=values[index]}
    q<HTMLSelectElement>('[data-pizza-channel]').value=state.channel;
    q<HTMLSelectElement>('[data-pizza-provider-select]').value=state.provider;
    root.querySelectorAll<HTMLButtonElement>('[data-pizza-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.pizzaMode===state.mode)));
    root.querySelectorAll<HTMLButtonElement>('[data-pizza-lesson]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.pizzaLesson)===state.lesson)));
    q('[data-pizza-roles]').hidden=state.mode!=='ai';
    document.dispatchEvent(new CustomEvent('aegis:architecture-focus',{detail:view.focus==='incoming'?'http':view.focus==='outgoing'?'inference':'core'}));
  }
  root.querySelectorAll<HTMLButtonElement>('[data-pizza-lesson]').forEach(button=>button.addEventListener('click',()=>{state.lesson=Number(button.dataset.pizzaLesson) as StoryState['lesson'];if(state.lesson===2)state.mode='ai';render()}));
  root.querySelectorAll<HTMLButtonElement>('[data-pizza-mode]').forEach(button=>button.addEventListener('click',()=>{state.mode=button.dataset.pizzaMode as StoryState['mode'];if(state.mode==='pizza'&&state.lesson===2)state.lesson=0;render()}));
  q<HTMLSelectElement>('[data-pizza-channel]').addEventListener('change',event=>{state.channel=(event.target as HTMLSelectElement).value as StoryState['channel'];state.lesson=0;render()});
  q<HTMLSelectElement>('[data-pizza-provider-select]').addEventListener('change',event=>{state.provider=(event.target as HTMLSelectElement).value as StoryState['provider'];state.lesson=1;render()});
  q('[data-pizza-reset]').addEventListener('click',()=>{state={...initialStory};render()});
  const updateHint=()=>{text('[data-pizza-hint]',(root as HTMLDetailsElement).open?'Close the story ↑':'Open the three-step story ↓')};
  root.addEventListener('toggle',updateHint);
  document.querySelectorAll<HTMLAnchorElement>('a[href="#pizza-explainer"]').forEach(link=>link.addEventListener('click',()=>{(root as HTMLDetailsElement).open=true}));
  if(location.hash==='#pizza-explainer')(root as HTMLDetailsElement).open=true;
  updateHint();
  render();
}
