/**
 * Bundle entry for the omp GitLab Duo proxy transport.
 *
 * The provider bootstraps a direct-access token on GitLab's REST API and then
 * delegates to one of the three generic wire transports (Anthropic Messages, the
 * OpenAI Responses API or Chat Completions) through GitLab's AI gateway. That
 * delegation is why this entry reuses the factory-droid build substitutions: the
 * three transports come from `providers/register-builtins`, whose import edge
 * pulls the whole builtin provider registry, and `providers/anthropic` reaches the
 * 12.4 MB model catalog. `scripts/build-omp.mjs` keeps one substitution plugin
 * (lean registry + lean stream facade + lean env-key map) and applies it to both
 * entries, each scoped to that entry's own graph.
 *
 * @module dsh-llm-omp-transports/omp-entry-gitlab-duo
 */
import { streamGitLabDuo } from '@oh-my-pi/pi-ai/providers/gitlab-duo'

export { streamGitLabDuo }
