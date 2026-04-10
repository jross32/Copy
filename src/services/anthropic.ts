import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool as AnthropicTool, InputJSONDelta } from '@anthropic-ai/sdk/resources/index.js'
import type { Provider, ProviderEvent, UnifiedMessage, UnifiedTool, UnifiedContentPart } from './provider.js'

const DEFAULT_MODEL = 'claude-opus-4-6'
const MAX_TOKENS = 8096
const MAX_RETRIES = 4
const INITIAL_RETRY_MS = 1000

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
    client = new Anthropic({ apiKey })
  }
  return client
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return [408, 429, 500, 502, 503, 504].includes(err.status)
  }
  return false
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || i === MAX_RETRIES) throw err
      await new Promise(r => setTimeout(r, INITIAL_RETRY_MS * Math.pow(2, i)))
    }
  }
  throw lastErr
}

/** Convert unified messages → Anthropic MessageParam format */
function toAnthropicMessages(messages: UnifiedMessage[]): MessageParam[] {
  return messages.map(m => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content } as MessageParam
    }

    const content = m.content.map((part): Anthropic.ContentBlockParam => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text }
      }
      if (part.type === 'tool_use') {
        return { type: 'tool_use', id: part.id, name: part.name, input: part.input }
      }
      if (part.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content: part.content,
          is_error: part.is_error,
        }
      }
      throw new Error(`Unknown content part type: ${(part as UnifiedContentPart).type}`)
    })

    return { role: m.role, content } as MessageParam
  })
}

export const AnthropicProvider: Provider = {
  name: 'Claude (Anthropic)',
  model: process.env.CLAUDE_MODEL ?? DEFAULT_MODEL,

  async isAvailable(): Promise<boolean> {
    return !!process.env.ANTHROPIC_API_KEY
  },

  async *streamQuery(
    messages: UnifiedMessage[],
    tools: UnifiedTool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const apiTools: AnthropicTool[] = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as AnthropicTool['input_schema'],
    }))

    const response = await withRetry(() =>
      getClient().messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: toAnthropicMessages(messages),
        tools: apiTools.length > 0 ? apiTools : undefined,
        stream: true,
      }),
    )

    let inputTokens = 0
    let outputTokens = 0
    let stopReason = 'end_turn'

    for await (const event of response) {
      if (signal.aborted) break

      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          yield { type: 'tool_start', id: event.content_block.id, name: event.content_block.name }
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          // We need the current tool_use block id — Anthropic tracks by index
          // We yield a generic delta; query.ts tracks the current tool
          yield { type: 'tool_input_delta', id: '', partial_json: (event.delta as InputJSONDelta).partial_json }
        }
      } else if (event.type === 'content_block_stop') {
        yield { type: 'tool_end', id: '' }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens
        stopReason = event.delta.stop_reason ?? 'end_turn'
      }
    }

    yield { type: 'message_end', stop_reason: stopReason, input_tokens: inputTokens, output_tokens: outputTokens }
  },
}
