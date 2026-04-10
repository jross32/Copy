import type {
  MessageParam,
  ToolUseBlock,
  ContentBlock,
  Tool as AnthropicTool,
  InputJSONDelta,
} from '@anthropic-ai/sdk/resources/index.js'
import { streamMessage } from './services/claude.js'
import type { Tool, ToolUseContext } from './Tool.js'
import type { PermissionResult } from './Tool.js'

const MAX_TOOL_CONCURRENCY = 5

export type AssistantMessage = {
  type: 'assistant'
  content: ContentBlock[]
  cost: number
  durationMs: number
  error?: boolean
}

export type UserMessage = {
  type: 'user'
  content: string
  toolResults?: ToolResultMessage[]
}

export type ToolResultMessage = {
  toolUseId: string
  toolName: string
  content: string
  isError: boolean
}

export type ProgressMessage = {
  type: 'progress'
  toolName: string
  input: Record<string, unknown>
  output?: string
}

export type Message = AssistantMessage | UserMessage | ProgressMessage

function toolToApiSchema(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.apiSchema as AnthropicTool['input_schema'],
  }
}

async function runTool(
  toolUse: ToolUseBlock,
  tools: Tool[],
  context: ToolUseContext,
  onProgress: (msg: ProgressMessage) => void,
  canUseTool: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionResult>,
): Promise<ToolResultMessage> {
  const tool = tools.find(t => t.name === toolUse.name)
  const input = toolUse.input as Record<string, unknown>

  if (!tool) {
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      content: `Unknown tool: ${toolUse.name}`,
      isError: true,
    }
  }

  // Validate input
  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      toolUseId: toolUse.id,
      toolName: tool.name,
      content: `Invalid input: ${parsed.error.message}`,
      isError: true,
    }
  }

  // Check permissions
  const permission = await canUseTool(tool, input)
  if (!permission.result) {
    return {
      toolUseId: toolUse.id,
      toolName: tool.name,
      content: permission.message,
      isError: true,
    }
  }

  onProgress({
    type: 'progress',
    toolName: tool.name,
    input,
  })

  try {
    const output = await tool.call(parsed.data, context)
    onProgress({
      type: 'progress',
      toolName: tool.name,
      input,
      output,
    })
    return {
      toolUseId: toolUse.id,
      toolName: tool.name,
      content: output,
      isError: false,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      toolUseId: toolUse.id,
      toolName: tool.name,
      content: `Error: ${message}`,
      isError: true,
    }
  }
}

async function runToolsConcurrently(
  toolUses: ToolUseBlock[],
  tools: Tool[],
  context: ToolUseContext,
  onProgress: (msg: ProgressMessage) => void,
  canUseTool: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionResult>,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = []
  const chunks: ToolUseBlock[][] = []

  for (let i = 0; i < toolUses.length; i += MAX_TOOL_CONCURRENCY) {
    chunks.push(toolUses.slice(i, i + MAX_TOOL_CONCURRENCY))
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(tu => runTool(tu, tools, context, onProgress, canUseTool)),
    )
    results.push(...chunkResults)
  }

  return results
}

export type QueryOptions = {
  messages: MessageParam[]
  tools: Tool[]
  systemPrompt: string
  context: ToolUseContext
  onMessage: (msg: AssistantMessage | ProgressMessage) => void
  onText?: (delta: string) => void
  canUseTool: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionResult>
}

/**
 * Core agentic query loop. Sends messages to Claude, handles tool use,
 * and continues until Claude produces a final text response.
 */
export async function* query(opts: QueryOptions): AsyncGenerator<Message> {
  const {
    messages,
    tools,
    systemPrompt,
    context,
    onMessage,
    onText,
    canUseTool,
  } = opts

  const apiTools = tools.map(toolToApiSchema)
  const conversationMessages = [...messages]

  let continueLoop = true

  while (continueLoop) {
    if (context.abortController.signal.aborted) break

    // Collect the full response from the stream
    const contentBlocks: ContentBlock[] = []
    let currentTextBlock: { type: 'text'; text: string } | null = null
    let currentToolUse: {
      id: string
      name: string
      inputJson: string
    } | null = null
    let inputTokens = 0
    let outputTokens = 0
    const startTime = Date.now()

    const stream = streamMessage(
      conversationMessages,
      apiTools,
      systemPrompt,
      context.abortController.signal,
    )

    for await (const event of stream) {
      if (context.abortController.signal.aborted) break

      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text') {
          currentTextBlock = { type: 'text', text: '' }
        } else if (event.content_block.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          }
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta' && currentTextBlock) {
          currentTextBlock.text += event.delta.text
          onText?.(event.delta.text)
        } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
          currentToolUse.inputJson += (event.delta as InputJSONDelta).partial_json
        }
      } else if (event.type === 'content_block_stop') {
        if (currentTextBlock) {
          contentBlocks.push({ type: 'text', text: currentTextBlock.text, citations: [] } as unknown as ContentBlock)
          currentTextBlock = null
        } else if (currentToolUse) {
          let parsedInput: Record<string, unknown> = {}
          try {
            parsedInput = JSON.parse(currentToolUse.inputJson || '{}')
          } catch {
            // ignore parse error
          }
          contentBlocks.push({
            type: 'tool_use',
            id: currentToolUse.id,
            name: currentToolUse.name,
            input: parsedInput,
          })
          currentToolUse = null
        }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens
      }
    }

    const durationMs = Date.now() - startTime
    // Rough cost estimate: Opus 4.6 pricing
    const cost = (inputTokens * 15 + outputTokens * 75) / 1_000_000

    const assistantMsg: AssistantMessage = {
      type: 'assistant',
      content: contentBlocks,
      cost,
      durationMs,
    }
    onMessage(assistantMsg)
    yield assistantMsg

    // Add assistant response to conversation
    conversationMessages.push({
      role: 'assistant',
      content: contentBlocks,
    })

    // Find tool use blocks
    const toolUses = contentBlocks.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      // No tool calls — conversation is done
      continueLoop = false
      break
    }

    // Run tools and collect results
    const toolResults = await runToolsConcurrently(
      toolUses,
      tools,
      context,
      msg => {
        onMessage(msg)
        // Note: we don't yield progress from here but onMessage handles it
      },
      canUseTool,
    )

    // Add tool results to conversation
    conversationMessages.push({
      role: 'user',
      content: toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      })),
    })
  }
}
