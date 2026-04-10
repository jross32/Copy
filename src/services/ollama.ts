/**
 * Ollama provider — talks to a locally running Ollama server.
 * Ollama is free, runs 100% locally, no API key required.
 * Install: https://ollama.com
 * Start:   ollama serve
 * Models:  ollama pull qwen2.5-coder:7b
 */

import type { Provider, ProviderEvent, UnifiedMessage, UnifiedTool } from './provider.js'

const OLLAMA_BASE = process.env.OLLAMA_HOST ?? 'http://localhost:11434'

// Prefer coding-optimized models; fall back to general purpose
const PREFERRED_MODELS = [
  'qwen2.5-coder:7b',
  'qwen2.5-coder',
  'qwen2.5-coder:latest',
  'llama3.2',
  'llama3.1',
  'mistral',
  'qwen2.5',
]

// ─── OpenAI-compatible types (Ollama uses this format) ──────────────────────

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_call_id?: string
  name?: string
}

type OllamaToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OllamaTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

type OllamaStreamChunk = {
  id: string
  object: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function listModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    return (data.models ?? []).map(m => m.name)
  } catch {
    return []
  }
}

async function detectModel(): Promise<string | null> {
  const available = await listModels()
  if (available.length === 0) return null
  for (const preferred of PREFERRED_MODELS) {
    if (available.some(m => m === preferred || m.startsWith(preferred.split(':')[0]))) {
      return available.find(m => m === preferred || m.startsWith(preferred.split(':')[0])) ?? null
    }
  }
  // Fall back to first available model
  return available[0] ?? null
}

/** Convert unified messages → Ollama/OpenAI message format */
function toOllamaMessages(messages: UnifiedMessage[]): OllamaMessage[] {
  const result: OllamaMessage[] = []

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    // Multi-part content
    const textParts: string[] = []
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    const toolResults: Array<{ id: string; content: string; is_error?: boolean }> = []

    for (const part of msg.content) {
      if (part.type === 'text') {
        textParts.push(part.text)
      } else if (part.type === 'tool_use') {
        toolUses.push(part)
      } else if (part.type === 'tool_result') {
        toolResults.push({ id: part.tool_use_id, content: part.content, is_error: part.is_error })
      }
    }

    if (toolResults.length > 0) {
      // Tool results go as separate tool messages
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          content: tr.is_error ? `Error: ${tr.content}` : tr.content,
          tool_call_id: tr.id,
        })
      }
    } else if (toolUses.length > 0) {
      // Assistant message with tool calls
      result.push({
        role: 'assistant',
        content: textParts.join('\n'),
        tool_calls: toolUses.map(tu => ({
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      })
    } else {
      result.push({ role: msg.role, content: textParts.join('\n') })
    }
  }

  return result
}

function toOllamaTools(tools: UnifiedTool[]): OllamaTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

// ─── Provider implementation ──────────────────────────────────────────────────

let detectedModel: string | null | undefined = undefined // undefined = not checked yet

export const OllamaProvider: Provider = {
  name: 'Ollama (local, free)',
  model: process.env.OLLAMA_MODEL ?? '',

  async isAvailable(): Promise<boolean> {
    if (detectedModel === undefined) {
      detectedModel = await detectModel()
    }
    if (!this.model && detectedModel) {
      this.model = detectedModel
    }
    return !!this.model
  },

  async *streamQuery(
    messages: UnifiedMessage[],
    tools: UnifiedTool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const model = this.model
    if (!model) throw new Error('No Ollama model available. Run: ollama pull qwen2.5-coder:7b')

    const ollamaMessages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      ...toOllamaMessages(messages),
    ]

    const body = JSON.stringify({
      model,
      messages: ollamaMessages,
      tools: tools.length > 0 ? toOllamaTools(tools) : undefined,
      stream: true,
      options: {
        num_ctx: 8192,
      },
    })

    const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Ollama error ${res.status}: ${text}`)
    }

    if (!res.body) throw new Error('No response body from Ollama')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Track in-progress tool calls by index
    const toolCallState: Map<number, { id: string; name: string; argsJson: string }> = new Map()
    let inputTokens = 0
    let outputTokens = 0
    let stopReason = 'end_turn'
    let hasYieldedToolEnd = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal.aborted) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          let chunk: OllamaStreamChunk
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }

          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens
            outputTokens = chunk.usage.completion_tokens
          }

          for (const choice of chunk.choices) {
            const delta = choice.delta

            if (delta.content) {
              yield { type: 'text_delta', text: delta.content }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                if (!toolCallState.has(idx)) {
                  const id = tc.id ?? `tool_${idx}`
                  const name = tc.function?.name ?? ''
                  toolCallState.set(idx, { id, name, argsJson: '' })
                  if (name) {
                    yield { type: 'tool_start', id, name }
                  }
                }
                const state = toolCallState.get(idx)!
                if (tc.function?.arguments) {
                  state.argsJson += tc.function.arguments
                  yield { type: 'tool_input_delta', id: state.id, partial_json: tc.function.arguments }
                }
                if (tc.function?.name && !state.name) {
                  state.name = tc.function.name
                  yield { type: 'tool_start', id: state.id, name: state.name }
                }
              }
            }

            if (choice.finish_reason) {
              stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn'

              // Emit tool_end for all pending tool calls
              for (const [, state] of toolCallState) {
                yield { type: 'tool_end', id: state.id }
              }
              hasYieldedToolEnd = toolCallState.size > 0
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield { type: 'message_end', stop_reason: stopReason, input_tokens: inputTokens, output_tokens: outputTokens }
  },
}
