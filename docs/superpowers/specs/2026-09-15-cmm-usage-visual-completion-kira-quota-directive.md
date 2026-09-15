# CMM Usage — Visual Completion, Hermes Reference, Xcode Revalidation & Free-Model Quota Intelligence

**Date:** 2026-09-15
**Status:** Execution directive for Codex
**Current redesign status:** Incomplete
**Current visual reference:** six supplied Hermes Desktop screenshots
**Environment update:** Full Xcode has now been installed on the Mac

---

## 0. Continue from the current checkpoint

Resume CMM Usage from the current `feature/cmm-usage` worktree and continue until the redesign is genuinely complete.

Current accepted redesign commits include:

- `5f244ba` — `feat(usage-macos): redesign quota dashboard`
- `efdbdf5` — `feat(usage-macos): redesign usage menu bar`

The current redesign checkpoint is **NOT accepted yet**.

Do not begin Claude, DeepSeek, OpenRouter or any other new provider dogfood phase.

Do not begin unrelated Task 14/15 work.

Do not reset, discard or clean current uncommitted work before inspecting it carefully.

There may be:

- legitimate Task 11 visual-polish work;
- temporary window-ID screenshot instrumentation;
- local `.superpowers/` execution artifacts.

Understand each change before modifying or removing it.

---

# 1. Work continuously until the redesign is actually finished

Do not stop merely because:

- Swift compiles;
- tests pass;
- the API responds;
- screenshots can be captured;
- all expected screens technically exist.

The user expects a **highly polished final native macOS product**.

Continue through:

1. remaining Task 11 implementation;
2. screenshot pass 1;
3. visual review;
4. visual corrections;
5. screenshot pass 2;
6. additional iterations if needed;
7. removal of temporary debug/capture instrumentation;
8. full Task 12 Definition-of-Done/security/test audit.

Stop only when:

- the full Definition of Done is satisfied; or
- a genuine external blocker makes further progress impossible.

Do not voluntarily stop after a partial visual pass merely to ask for routine confirmation.

---

# 2. Xcode is now installed — revalidate the Swift environment

The previous environment only had Command Line Tools and lacked usable XCTest support.

That exception must now be re-evaluated from scratch.

Explicitly inspect and report:

```text
xcode-select -p
xcodebuild -version
swift --version
```

If needed, select the full Xcode developer directory.

Then run:

- `swift test`
- `swift run CMMUsageContractTests`
- release build
- any relevant `xcodebuild` invocation required by the app target

Do not continue carrying the previous "`swift test` unavailable because only CommandLineTools are installed" exception unless it remains genuinely true after verifying the new Xcode installation.

If `swift test` still fails, investigate the actual reason.

---

# 3. Hermes remains the normative interaction reference

The six supplied Hermes screenshots remain normative visual and interaction references.

Use them actively.

If the screenshots are insufficient to understand:

- Accounts;
- API Keys;
- Custom Endpoints;
- Models;
- provider grouping;
- search;
- group toggles;
- model visibility;
- compact model picker;
- `Edit models...`;
- connection states;
- sheets/dialogs;
- spacing;
- density;
- typography;
- dark-mode treatment;
- macOS window proportions;

use available computer-use/browser/desktop inspection capabilities to inspect Hermes directly.

Study the product as needed.

Do not create a pixel-for-pixel clone or copy proprietary artwork.

The target is:

```text
Hermes-level interaction quality
+
CMM-native visual identity
+
richer quota intelligence
+
better operational usefulness
```

CMM Usage should ultimately feel **more visual, more informative and more practical than Hermes**.

---

# 4. Visual quality is a first-class engineering requirement

For every major screen:

1. launch the real native macOS app;
2. populate it with safe representative data;
3. capture a screenshot;
4. compare against Hermes;
5. identify visible weaknesses;
6. fix them;
7. capture again;
8. continue until the result is genuinely polished.

Do not accept the first visually functional implementation.

Be especially critical of:

- excessive cards;
- excessive whitespace;
- weak hierarchy;
- default-looking SwiftUI;
- poor desktop density;
- repeated rounded rectangles;
- empty panes;
- raw backend terminology;
- inconsistent alignment;
- oversized controls;
- weak provider identity;
- poor use of available width;
- visual noise;
- weak quota visualization.

Prefer:

- compact native rows;
- strong grouping;
- restrained panels;
- meaningful visual summaries;
- elegant quota/progress treatment;
- useful provider identity;
- restrained badges;
- excellent numeric alignment;
- clear empty states;
- progressive disclosure;
- strong keyboard usability.

The known first Overview visual finding remains valid:

> Overview is too card-heavy and vertically loose compared with Hermes.

Correct it deliberately.

Do not “fix” density merely by shrinking fonts.

---

# 5. Required screenshot review surfaces

At minimum review:

- Overview
- Quotas
- Models
- Providers / Accounts
- API Keys
- Custom Endpoints
- Free & Promo
- History
- Costs
- Alerts
- Settings
- menu bar
- model visibility editor
- provider connection sheets/dialogs
- route/model detail surfaces

For every screen compare:

- density;
- vertical rhythm;
- content/sidebar proportions;
- row height;
- use of cards vs lists;
- typography hierarchy;
- spacing;
- borders;
- background treatment;
- provider grouping;
- search;
- toggles;
- empty states;
- information density;
- visual calm.

Task 11 remains open until this loop is complete.

---

# 6. Critical semantic invariant: visibility is route-scoped

Visibility applies to the selectable `AccessRoute`, not globally to `ModelIdentity`.

Normative example:

```text
Claude Sonnet
├── Anthropic / Claude subscription       Visible
├── Google AI Pro / Antigravity           Visible
└── OpenRouter                            Hidden
```

Expected behavior:

- CMMChat shows Anthropic direct.
- CMMChat shows Google AI / Antigravity.
- CMMChat hides only OpenRouter.
- The conceptual Claude model remains globally known.

Critical invariant:

```text
Hide route != hide model everywhere
```

If the product later adds `Hide this model everywhere`, that must be an explicit separate action implemented as route-level visibility changes.

---

# 7. Visibility must never alter accounting

Visibility is presentation only.

Hiding a route MUST NOT:

- disable provider collection;
- stop quota refresh;
- delete quota bindings;
- remove snapshots;
- suppress history;
- suppress cost data;
- alter provider/product totals;
- remove the route from CMM Usage quota views;
- rewrite canonical identities.

Keep these systems separate:

```text
VisibilityStore
→ controls picker/catalog presentation

QuotaBinding
→ defines which quotas affect which routes

QuotaSnapshot
→ current provider quota state

UsageEvent / CostEvent
→ attributable consumption where actually known
```

Therefore:

```text
Visibility != collection != accounting
```

The hidden OpenRouter Claude route must still be reflected in CMM Usage accounting if OpenRouter remains connected/enabled.

---

# 8. Provider-native quota metrics are mandatory

CMM Usage must not assume that quota means money.

A provider may expose quotas as:

- requests;
- input tokens;
- output tokens;
- total tokens;
- credits;
- currency;
- percentage utilization;
- percentage remaining;
- compute units;
- provider-defined units;
- shared pool balances;
- rolling windows;
- calendar windows;
- provider-reported windows;
- time-only constraints.

All of these are valid.

Examples that must render naturally:

```text
61% used
35 credits remaining
800K tokens remaining
42 / 100 requests remaining
$7.31 remaining
14 provider units remaining
```

There is no universal quota unit.

Do not normalize these into fake percentages, fake money, fake credits or fake token values.

A provider that reports only:

```text
27% utilization
```

must remain percentage-based unless an absolute denominator is truly known.

A derived:

```text
73% remaining
```

may be displayed only as clearly derived presentation.

Do not manufacture requests, tokens, credits or monetary limits.

---

# 9. Quotas must preserve real scope

Every quota/balance must preserve its true scope.

Possible scopes include:

- provider-wide;
- account-wide;
- product/subscription;
- shared pool;
- model-specific;
- route-specific;
- API-key-specific;
- member/workspace-specific.

Do not duplicate a shared pool as independent quotas per model.

Example:

```text
OpenRouter shared credits
$7.31 remaining
```

If that constrains many routes, show the pool once and indicate affected routes.

Do not fabricate:

```text
Claude Sonnet: $2.11 used
DeepSeek: $1.73 used
```

unless provider data or trusted router telemetry truly attributes those values.

Distinguish:

```text
quota applies to route
```

from:

```text
consumption is attributable to route
```

These are not equivalent.

---

# 10. Free-model quota intelligence is a core requirement

A `FREE` badge alone is not enough.

CMM Usage must be able to represent and display the **actual quota topology** of free models.

A provider may simultaneously expose:

- one quota specific to free model A;
- a different quota specific to free model B;
- a provider-wide/general free pool;
- bonus capacity;
- claimable/activatable extra allowance;
- shared quotas across several models;
- different reset windows;
- different native metrics.

The data model and UI must support all of these simultaneously.

---

# 11. Kira-style normative example

Kira is the important design example.

Conceptually, the provider may expose something like:

```text
Kira

Qwen 3.8 Flash Free
FREE
Model-specific limit: X

Qwen 3.7-27B
FREE
Model-specific limit: Y

General free allowance
Shared across applicable models: Z

Bonus / claimed allowance
Additional capacity after authenticated claim
```

Do not hardcode illustrative values.

When implementing the live Kira integration, discover current values from trustworthy sources.

The architecture must support these semantics before every live adapter is complete.

---

# 12. Overlapping free quotas are expected

A single route can be constrained by multiple buckets.

Example:

```text
Qwen 3.8 Flash Free
    ├── model-specific free limit
    ├── Kira general free pool
    └── claimable / claimed bonus pool
```

Another model may have:

```text
Qwen 3.7-27B
    ├── different model-specific limit
    ├── same Kira general pool
    └── same or different bonus entitlement
```

This is exactly why the many-to-many architecture must remain:

```text
AccessRoute ↔ QuotaBucket
```

Do not flatten these into one synthetic percentage or one fake “remaining” number.

---

# 13. Claimable / activatable quota

Add a generic product concept for quota or entitlement that is:

- available to the account;
- not active yet;
- claimable/activatable;
- increased after an authenticated provider action.

Conceptual display:

```text
General free allowance
400 / 500 requests remaining

+500 available
Sign in to claim
```

or:

```text
Free capacity
500 requests/day

Bonus available
Claim additional allowance →
```

The exact action depends on provider behavior.

Important rule:

> Do not automatically perform provider-side claim/activation actions without explicit user authorization.

CMM Usage may:

- detect the available claim;
- explain it;
- show eligibility;
- expose an action;
- perform it only after explicit user action.

Represent:

- current active allowance;
- claimable extra allowance;
- eligibility;
- claim state;
- source;
- validity;
- reset/expiry where known.

---

# 14. Free & Promo must become genuinely useful

`Free & Promo` is not decorative.

It should help the user discover usable AI capacity.

Potential sections:

- New free models
- Free models already available
- Promotions
- Expiring soon
- Exhausted until reset
- Bonus capacity available
- Claimable allowance
- Provider connection required

Conceptual example:

```text
Kira

Qwen 3.8 Flash
FREE
82 / 100 remaining
+500 shared bonus available

Qwen 3.7-27B
FREE
950K tokens remaining

General allowance
420 / 500 remaining
```

The UI must clearly distinguish:

- model-specific quota;
- shared provider quota;
- bonus/claimable quota;
- reset;
- expiry;
- current status.

Make this significantly more useful than a raw list of quota buckets.

---

# 15. Model detail should explain quota hierarchy visually

A model detail may conceptually show:

```text
Qwen 3.8 Flash
Kira
FREE

Limits
─────────────────────────────
Model allowance
82 / 100 remaining
Resets in 4h 18m

General Kira pool
420 / 500 remaining
Shared with 3 models

Bonus allowance
+500 available
Claim →
```

The exact UI can improve on this.

The requirement is that quota relationships are obvious at a glance.

Do not present overlapping quota buckets as an undifferentiated technical list.

---

# 16. Free / Promo / Included / Trial / PAYG remain commercial semantics

Commercial access classification and quota metrics remain separate.

```text
AccessOffer = how/why access is available
QuotaBucket = how much can be used
```

A route marked `FREE` may be constrained by requests, tokens, percentage utilization, credits or another provider-native metric.

Do not make access classification dictate unit semantics.

---

# 17. Real provider evidence hierarchy

When implementing current free-tier or promotional values, investigate the provider rather than guessing.

Preferred evidence:

1. official quota/billing/account metadata;
2. official model/account metadata;
3. official CLI/app state;
4. current official documentation;
5. carefully labeled manual observation.

Free-tier policies can change.

Preserve:

- source;
- confidence;
- freshness;
- observedAt;
- validity/expiry where applicable.

A free promotion must not remain permanently marked free after it expires.

---

# 18. Menu bar and Quotas must remain semantically faithful

The menu bar can be compact, but must preserve native units.

Examples:

```text
Command Code · GOAT
Monthly          35 credits

Claude
Weekly           61% used

Google AI Pro
Claude pool      800K tokens left

OpenRouter
Shared pool      $7.31 left
```

Do not synthesize a fake universal health percentage.

Do not hide unknown reset state.

Do not collapse shared pools into model-specific values.

---

# 19. Computer Use is allowed for design verification

Use computer-use capabilities if available and useful for:

- inspecting Hermes live;
- checking model-picker behavior;
- reviewing Accounts;
- reviewing API Keys;
- reviewing Custom Endpoints;
- reviewing model visibility;
- reviewing provider grouping;
- validating visual density and spacing.

Use it as a visual/product reference tool.

Do not use it to copy proprietary assets or implementation code.

---

# 20. Temporary screenshot instrumentation

The current temporary window-ID instrumentation in `MainWindowView.swift` exists only to enable isolated screenshot capture.

Keep it only while required.

Before the visual-polish commit:

- remove it;
- verify no debug/capture-only behavior remains;
- inspect the final diff;
- confirm no demo-only identifiers leaked into production behavior.

---

# 21. Isolated visual fixture

Continue using an isolated demo fixture/runtime for screenshot work where appropriate.

Do not touch the user's personal provider state merely to produce design screenshots.

Representative fixtures must be public-safe.

Do not commit:

- personal quotas;
- account IDs;
- secrets;
- local auth material;
- private paths;
- real usage snapshots tied to identity.

---

# 22. Task 11 completion criteria

Task 11 is complete only after:

- Pass 1 screenshot set exists;
- visual weaknesses are explicitly identified;
- correction pass is implemented;
- Pass 2 screenshot set exists;
- Pass 2 is compared against Hermes and Pass 1;
- further iterations are performed if still visibly weaker;
- temporary screenshot instrumentation is removed;
- relevant Swift/backend verification passes;
- the final tracked diff is coherent and clean.

Suggested commit only after genuine acceptance:

```text
feat(usage-macos): polish native usage experience
```

Do not force that exact subject if another is more accurate.

---

# 23. Task 12 final audit

Only after Task 11 is committed, perform the full redesign audit.

Explicitly audit:

- safe catalog DTOs;
- no credential/reference leakage;
- read vs mutation authorization;
- route-scoped visibility;
- hidden-route accounting;
- provider-native units;
- overlapping quotas;
- shared pools;
- claimable allowance semantics;
- supported-but-unconnected ProviderDirectory;
- model disappearance/reappearance;
- Free/Promo lifecycle;
- CMMChat catalog reuse;
- macOS empty states;
- provider failure isolation;
- menu-bar correctness;
- screenshot parity;
- public-safe fixtures;
- accessibility;
- full Xcode/Swift verification.

Do not weaken the DoD to fit current implementation state.

---

# 24. Final report

At completion report:

1. final HEAD;
2. all new commits;
3. Xcode/developer-directory status;
4. `swift test` result;
5. contract test result;
6. release/Xcode build result;
7. Task 11 screenshot sets reviewed;
8. main visual changes between Pass 1 and Pass 2;
9. remaining visible differences from Hermes, if any;
10. CMM-specific visual improvements over Hermes;
11. quota-unit verification;
12. route-scoped visibility verification;
13. hidden-route accounting verification;
14. overlapping/shared/claimable quota verification;
15. security/privacy audit;
16. spec DoD checklist;
17. clean tracked worktree state;
18. explicit verdict:
   - `READY`
   - `READY WITH DEFERRED EXTERNAL ITEM`
   - `NOT READY`

Do not resume the next provider-dogfood phase until this redesign checkpoint has been reviewed.

---

# 25. Final execution mandate

The expected outcome is not:

> “The feature exists.”

The expected outcome is:

> **CMM Usage looks and behaves like a finished native macOS product, reaches or exceeds the interaction quality of the supplied Hermes references, and adds clearly superior quota intelligence, free-model discovery, overlapping quota visualization and provider-native accounting.**

Continue working through implementation, testing, visual inspection and refinement until that standard is actually met.

Do not stop at “functional”.

Do not stop at “tests pass”.

Do not stop at “similar enough”.

Finish the product.
