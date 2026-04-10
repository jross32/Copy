/**
 * Unified provider interface — implemented by both the Anthropic and Ollama backends.
 * query.ts talks exclusively through this interface so backends are swappable.
 */

export type UnifiedMessage =
  | { role: 'user'; content: string | UnifiedContentPart[] }
  | { role: 'assistant'; content: string | UnifiedContentPart[] }

export type UnifiedContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type UnifiedTool = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** Events emitted by the streaming provider */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partial_json: string }
  | { type: 'tool_end'; id: string }
  | { type: 'message_end'; stop_reason: 'end_turn' | 'tool_use' | 'stop' | string; input_tokens: number; output_tokens: number }

export interface Provider {
  /** Display name shown to the user */
  name: string
  /** Model identifier being used */
  model: string
  /** Check if this provider is available (API key set, server running, etc.) */
  isAvailable(): Promise<boolean>
  /** Stream a query, yielding events */
  streamQuery(
    messages: UnifiedMessage[],
    tools: UnifiedTool[],
    systemPrompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent>
}
