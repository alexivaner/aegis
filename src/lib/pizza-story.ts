export type StoryMode = 'pizza' | 'ai';
export type StoryState = { mode: StoryMode; lesson: 0 | 1 | 2; channel: 'first' | 'second'; provider: 'first' | 'second' };
export const initialStory: StoryState = { mode:'pizza', lesson:0, channel:'first', provider:'first' };
export const storyLessons = ['Change the entrance', 'Swap an outside tool', 'Connect it to Aegis'] as const;

export function storyView(state: StoryState) {
  const pizza = state.mode === 'pizza';
  const input = pizza ? ['Website order','Counter order'] : ['Browser interface','Direct API client'];
  const providers = pizza ? ['Card adapter','Wallet adapter'] : ['Local model adapter','Cloud model adapter'];
  const selectedInput = input[state.channel === 'first' ? 0 : 1];
  const selectedProvider = providers[state.provider === 'first' ? 0 : 1];
  return {
    inputOptions:input, providerOptions:providers, selectedInput, selectedProvider,
    coreTitle:pizza ? 'Ordering & pricing rules' : 'Privacy & routing rules',
    coreLines:pizza ? ['Large pizza: $12','Extra cheese: $2','Total: $14'] : ['Check privacy & feasibility','Select only an allowed route','Explain the selection'],
    incomingContract:pizza ? 'Place an order' : 'Request a route',
    outgoingContract:pizza ? 'PaymentProcessor' : 'InferenceProvider',
    inputPayload:pizza ? '1 large pizza + extra cheese' : 'A task + device conditions + permission',
    changed:state.lesson === 0 ? `Entrance: ${selectedInput}.` : state.lesson === 1 ? `Outside implementation: ${selectedProvider}.` : 'The labels now show the corresponding AI boundaries.',
    unchanged:pizza ? 'The same order still totals $14. Changing the entrance or payment connector does not change the pricing rules.' : 'Privacy and eligibility rules stay in the core. Changing a model adapter does not grant it permission to run.',
    contractMeaning:pizza ? 'The core asks for a payment through a contract. A card or wallet connector fulfills that contract.' : 'The runtime defines an inference contract. A local or cloud integration fulfills it; the live policy still decides which is eligible.',
    focus:state.lesson === 0 ? 'incoming' : state.lesson === 1 ? 'outgoing' : 'core',
    limitation:pizza ? 'Fictional learning illustration. No order is placed and no payment is taken.' : 'Architecture illustration only. No model runs, and selecting the cloud adapter here does not change the routing lab or send data.',
  };
}

export const pizzaMapping = [
  ['Website or counter connector','Incoming adapter','Browser/API request handling'],
  ['Place an order','Application entry / use case','Request a routing decision'],
  ['Order and pricing rules','Core business logic','Privacy, eligibility and selection rules'],
  ['PaymentProcessor','Outgoing port / contract','InferenceProvider'],
  ['Card or wallet connector','Outgoing adapter','Local or cloud model integration'],
] as const;

export const roleConnections = [
  ['Telemetry','Supplies the device snapshot through the resource boundary. In the lab these conditions are fictional.'],
  ['Policy engine','Applies the core rules to decide which model candidates are allowed.'],
  ['Scheduler','Applies the selected preference among the candidates that passed policy.'],
  ['Execution backend','A concrete adapter fulfills the inference contract. The routing lab previews this step.'],
] as const;
