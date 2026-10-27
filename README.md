# Aegis

An independent AI systems engineering playground. Choose a scenario, adjust eleven conditions, and see why a task should run locally, in the cloud, or remain blocked. The four-step explanation keeps **telemetry → policy engine → scheduler → execution backend** visible.

The optional pizza-shop story explains incoming adapters, core business rules, outgoing contracts, and replaceable implementations. Switch to the AI view to connect the analogy to the runtime. The illustration makes no payment, places no order, and invokes no model.

## Clone or download

```sh
git clone https://github.com/alexivaner/aegis.git
cd aegis
npm ci
npm run dev
```

Or use GitHub **Code → Download ZIP**, extract it, and run the same install/dev commands from the extracted folder. Node.js 22.23.4+ is required. Open the localhost URL printed by Astro.

Without Python, the six recorded Python scenarios and the pizza explainer work immediately. Arbitrary condition edits need the local API:

```sh
uv sync --project ai-runtime
npm run runtime
# In another terminal:
npm run dev
```

Python 3.12+ and uv are required for the API. The unauthenticated service binds to `127.0.0.1:8011`; Astro proxies `/api/aegis`. Keep it on loopback.

## What is real and what is illustrative?

- Python performs policy admission and scheduler selection. The frontend presents the returned evidence.
- Eleven controls cover memory, battery, CPU, network, cloud permission, task requirements, wait budget, local/cloud preference, model availability and local reasoning capability.
- The preference only applies to policy-admitted routes. It cannot override privacy, connectivity, resources or capability.
- Device conditions, model profiles and latency estimates are fictional. They are not hardware measurements.
- The routing lab stops before inference: execution is labeled **Preview only** or **Not reached**. No model runs or document is sent by this lab.
- The retained meeting and notification workflows demonstrate additional bounded execution and adapter contracts; see [runtime documentation](docs/aegis/README.md).

## Test and build

```sh
npm test
npm run aegis:validate
npm run aegis:export
npm run build
```

The exporter consumes the actual pytest JUnit report and regenerates the recorded cases, report and downloadable Python source archive. Run validation before export. The frontend build checks local links and excludes PDF, résumé and private-review assets. No hosting or analytics service is configured.

## Project layout

- `src/components/AegisPage.astro`: reusable complete case-study page.
- `src/components/RoutingLab.astro`: scenario controls and four role explanations.
- `src/components/PizzaExplainer.astro`: optional everyday architecture story.
- `src/lib/`: presentation helpers, independent of routing policy.
- `ai-runtime/`: Python domain, ports, adapters, tests and exporter.
- `public/aegis-data/`: generated recorded results and portable source download.
- `docs/aegis/`: exact limits and engineering decisions.

A portfolio can import `AegisPage.astro` from a pinned Git submodule and copy `public/aegis-data/` into its own static assets. Standalone Aegis has no dependency on portfolio code, résumé files, credentials or company assets.

## Attribution

The pizza teaching approach was inspired by [Kinle Greshka, “Hexagonal architecture explained through a practical example,” Thoughtworks](https://www.thoughtworks.com/insights/blog/architecture/hexagonal-architecture-explained-practical-example). The interactive diagram, wording, runtime and tests here were created for this independent project. No article diagrams or sample repository code were copied.
