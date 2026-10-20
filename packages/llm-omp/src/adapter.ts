/**
 * Adapter for the omp-owned `cursor` route.
 *
 * The route speaks Cursor's own agent protocol (`agent.v1.AgentService/Run`
 * over HTTP/2) through the omp build artifact in `lib/omp/cursor.mjs`; the
 * projection from DSH's `GenerateOptions` onto that transport lands with the
 * streaming task, which is why `stream()` refuses here instead of pretending
 * to answer.
 *
 * @module @dsh-keys-manager/llm-omp/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Display metadata for every route this adapter owns. */
const DISPLAY_NAME = 'Cursor'

export class OmpCursorAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: DISPLAY_NAME }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('llm-omp: the cursor stream is not wired yet')
  }
}
