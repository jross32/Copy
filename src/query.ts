import type { Tool, ToolUseContext, PermissionResult } from './Tool.js'
import type { Provider, UnifiedMessage, UnifiedTool, UnifiedContentPart } from './services/provider.js'

const MAX_TOOL_CONCURRENCY = 5

// ─── Message types ────────────────────────────────────────────────────────────

export type AssistantMessage = {
  type: 'assistant'
  content: UnifiedContentPart[]
  cost: number
  durationMs: number
  stopReason: string
}

export type UserMessage = {
  type: 'user'
  content: string
}

export type ProgressMessage = {
  type: 'progress'
  toolName: string
  input: Record<string, unknown>
  output?: string
  isError?: boolean
}

export type Message = AssistantMessage | UserMessage | ProgressMessage

// ─── Tool execution ───────────────────────────────────────────────────────────

type PendingToolUse = {
  id: string
  name: string
  input: Record<string, unknown>
}

type ToolResultPart = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

async function runTool(
  toolUse: PendingToolUse,
  tools: Tool[],
  context: ToolUseContext,
  onProgress: (msg: ProgressMessage) => void,
  canUseTool: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionResult>,
): Promise<ToolResultPart> {
  const tool = tools.find(t => t.name === toolUse.name)

  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true,
    }
  }

  // Validate input against schema
  const parsed = tool.inputSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Invalid input for ${tool.name}: ${parsed.error.message}`,
      is_error: true,
    }
  }

  // Check permissions
  const permission = await canUseTool(tool, toolUse.input)
  if (!permission.result) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: permission.message,
      is_error: true,
    }
  }

  onProgress({ type: 'progress', toolName: tool.name, input: toolUse.input })

  try {
    const output = await tool.call(parsed.data, context)
    onProgress({ type: 'progress', toolName: tool.name, input: toolUse.input, output })
    return { type: 'tool_result', tool_use_id: toolUse.id, content: output }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress({ type: 'progress', toolName: tool.name, input: toolUse.input, output: msg, isError: true })
    return { type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${msg}`, is_error: true }
  }
}

async function runToolsConcurrently(
  toolUses: PendingToolUse[],
  tools: Tool[],
  context: ToolUseContext,
  onProgress: (msg: ProgressMessage) => void,
  canUseTool: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionResult>,
): Promise<ToolResultPart[]> {
  const results: ToolResultPart[] = []
  for (let i = 0; i < toolUses.length; i += MAX_TOOL_CONCURRENCY) {
    const chunk = toolUses.slice(i, i + MAX_TOOL_CONCURRENCY)
    const chunkResults = await Promise.all(
      chunk.map(tu => runTool(tu, tools, context, onProgress, canUseTool)),
    )
    results.push(...chunkResults)
  }
  return results
}

// ─── Main query loop ──────────────────────────────────────────────────────────

export type QueryOptions = {
  provider: Provider
  messages: UnifiedMessage[]
  tools: Tool[]
  systemPrompt: string
  context: ToolUseContext
  onMessage: (msg: AssistantMessage | ProgressMessage) => void
  onText?: (delta: string) => void
  canUseTool: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionResult>
}

function toolToUnified(tool: Tool): UnifiedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.apiSchema as UnifiedTool['input_schema'],
  }
}

/**
 * Core agentic loop. Streams the provider response, collects tool calls,
 * runs tools, feeds results back, and repeats until a final text response.
 */
export async function* query(opts: QueryOptions): AsyncGenerator<Message> {
  const { provider, messages, tools, systemPrompt, context, onMessage, onText, canUseTool } = opts

  const unifiedTools = tools.map(toolToUnified)
  const conversationHistory: UnifiedMessage[] = [...messages]

  while (true) {
    if (context.abortController.signal.aborted) break

    // ── Stream one turn ──
    const contentParts: UnifiedContentPart[] = []
    let currentText = ''
    let currentTool: { id: string; name: string; argsJson: string } | null = null
    const finishedTools: PendingToolUse[] = []
    const startTime = Date.now()
    let inputTokens = 0
    let outputTokens = 0
    let stopReason = 'end_turn'

    const stream = provider.streamQuery(
      conversationHistory,
      unifiedTools,
      systemPrompt,
      context.abortController.signal,
    )

    for await (const event of stream) {
      if (context.abortController.signal.aborted) break

      if (event.type === 'text_delta') {
        currentText += event.text
        onText?.(event.text)
      } else if (event.type === 'tool_start') {
        // Flush any accumulated text
        if (currentText) {
          contentParts.push({ type: 'text', text: currentText })
          currentText = ''
        }
        currentTool = { id: event.id, name: event.name, argsJson: '' }
      } else if (event.type === 'tool_input_delta') {
        if (currentTool) {
          // Some providers emit id on deltas, some don't — use currentTool
          currentTool.argsJson += event.partial_json
        }
      } else if (event.type === 'tool_end') {
        if (currentTool) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(currentTool.argsJson || '{}')
          } catch {
            // ignore JSON parse error
          }
          contentParts.push({
            type: 'tool_use',
            id: currentTool.id,
            name: currentTool.name,
            input,
          })
          finishedTools.push({ id: currentTool.id, name: currentTool.name, input })
          currentTool = null
        }
      } else if (event.type === 'message_end') {
        inputTokens = event.input_tokens
        outputTokens = event.output_tokens
        stopReason = event.stop_reason
      }
    }

    // Flush remaining text
    if (currentText) {
      contentParts.push({ type: 'text', text: currentText })
    }
    // Flush any tool that didn't get a tool_end (some providers omit it)
    if (currentTool) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(currentTool.argsJson || '{}')
      } catch { /**/ }
      contentParts.push({ type: 'tool_use', id: currentTool.id, name: currentTool.name, input })
      finishedTools.push({ id: currentTool.id, name: currentTool.name, input })
    }

    const durationMs = Date.now() - startTime
    // Rough cost: only meaningful for Claude; Ollama is free
    const cost = (inputTokens * 15 + outputTokens * 75) / 1_000_000

    const assistantMsg: AssistantMessage = {
      type: 'assistant',
      content: contentParts,
      cost,
      durationMs,
      stopReason,
    }

    onMessage(assistantMsg)
    yield assistantMsg

    // Add assistant turn to history
    conversationHistory.push({ role: 'assistant', content: contentParts })

    // No tool calls → done
    if (finishedTools.length === 0) break

    // ── Run tools ──
    const toolResults = await runToolsConcurrently(
      finishedTools,
      tools,
      context,
      msg => onMessage(msg),
      canUseTool,
    )

    // Add tool results to history
    conversationHistory.push({
      role: 'user',
      content: toolResults,
    })
  }
}
