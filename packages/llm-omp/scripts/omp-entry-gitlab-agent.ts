/**
 * Bundle entry for the omp GitLab Duo **agent** transport (Duo Workflow).
 *
 * The route runs GitLab's server-side workflow loop over one WebSocket; tools
 * stay client-side, so the artifact is the workflow transport alone. It builds
 * with the existing shims unmodified — `Bun.env` and `Bun.hash` are already
 * covered by `bun-global.ts` — and exports only the stream function.
 *
 * @module dsh-llm-omp-transports/omp-entry-gitlab-agent
 */
import { streamGitLabDuoWorkflow } from '@oh-my-pi/pi-ai/providers/gitlab-duo-workflow'

export { streamGitLabDuoWorkflow }
