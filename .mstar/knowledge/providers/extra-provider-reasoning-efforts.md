# Reasoning levels on extra-provider models

`applies_when`: DSH shows no thinking-level ("reasoning effort") selector for a model this plugin
installed for an extra provider, or you are adding a provider and need to know what to declare.

## Why the selector disappears

DSH decides that a model reasons from the resolved pi-ai model, and resolves it from the profile entry
plus the *installed* catalog entry for the same id (`dsh-llm-pi-ai` `resolveModelReasoning`):

- an entry with no `reasoningEfforts` inherits `base?.reasoning ?? false`;
- an extra provider is by definition a route the installed catalog does not ship, so `base` is always
  `undefined` and every such row is non-reasoning;
- `getSupportedThinkingLevels` then answers `["off"]` and the picker shows nothing.

So the plugin must write `reasoningEfforts` itself. It generates the declaration from the pinned
`@oh-my-pi/pi-catalog` rows, which already carry `thinking: {mode, efforts, effortMap, requiresEffort}`.

## The acceptance rules (what DSH will take)

`reasoningEfforts` is a dict keyed by `off|minimal|low|medium|high|xhigh|max`:

- at least one non-`off` level;
- every declared non-`off` level names a non-empty wire string;
- only `off` may map to `null` ("supported, send nothing");
- an undeclared level is not offered (`null`), except `off`+`null`, which stays absent.

An empty dict, an empty wire string, or an off-only dict makes the whole route unserviceable — DSH
refuses the profile rather than the model.

## Rule table used by the generator

| Catalog row | Route api | Declaration |
|---|---|---|
| `thinking.mode === "effort"` | `openai-completions`, `openai-responses` | `efforts` ∩ the seven levels, wire = `effortMap[level] ?? level`; add `off: null` unless `requiresEffort === true` |
| `thinking.mode === "anthropic-adaptive"` | `anthropic-messages` | same level set with the **level name** as wire value; never declare `off`; set the row's `compat.forceAdaptiveThinking: true` |
| `thinking.mode === "budget"` | any | none — a budget is expressed through `thinkingBudgets`, which `PiAiCompatProfile` does not offer |
| other / absent / empty ladder | any | none |

`forceAdaptiveThinking` makes DSH's anthropic path send `thinking:{type:"adaptive"}` plus
`output_config:{effort:"<level>"}` (`@earendil-works/pi-ai` `anthropic-messages.js`), which is the
mechanism MiniMax documents for its Anthropic-compatible endpoint. omp's own `effortMap` values of
`"adaptive"` are its tag-only spelling — never wire values here.

## Runtime installation and repair

- `mergeModelCapabilities` runs on the discovery path **and** the seed path; an existing
  `reasoningEfforts` always wins, an existing `compat` is merged field by field.
- The "existing stored profile" adoption branch must **not** merge: it writes only
  `apiKeyEnv`/`headers`, so a merged record would disagree with the profile forever and the startup
  repair (which only touches a record that still equals its profile) could never heal it.
- `repairModelCapabilities` fills a missing `input` / `reasoningEfforts` / adaptive compat for rows the
  index knows, is idempotent, and never rewrites a user-edited list.

## The trap that outlived two reviews

Index lookups must be **own-key only** (`Object.hasOwn`). A plain `index[id]` resolves inherited members
for ids like `constructor`, `toString` or `__proto__`, spreads to `{}`, and writes exactly the empty
declaration DSH refuses. Those ids are legal model ids — gate the lookup, never the id.

## Evidence shape

- index drift gate: regenerate from the installed pin, compare byte-identical, assert a few known rows
  (`ollama-cloud/beam`, `abliteration/abliterated-model-large-v2` mapping `medium→high`, `xhigh→max`,
  `minimax-code-cn/MiniMax-M2.7`, and an undescribed route such as `litellm` absent);
- merge/repair unit cases per rule, plus the prototype-id regression on an indexed and an undescribed
  route;
- a host-level case that a seed-installed route ends with the same declaration as a discovered one.
