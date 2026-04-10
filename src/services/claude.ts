import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  Tool as AnthropicTool,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/index.js'

const MODEL = 'claude-opus-4-6'
const MAX_TOKENS = 8096
const MAX_RETRIES = 4
const INITIAL_RETRY_DELAY_MS = 1000

let client: Anthropic | null = null

export function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is not set.\n' +
          'Get your API key from https://console.anthropic.com/',
      )
    }
    client = new Anthropic({ apiKey })
  }
  return client
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status)
  }
  return false
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isRetryableError(err) || attempt === MAX_RETRIES) {
        throw err
      }
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

export type StreamEvent = MessageStreamEvent

export async function* streamMessage(
  messages: MessageParam[],
  tools: AnthropicTool[],
  systemPrompt: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const response = await withRetry(() =>
    getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
    }),
  )

  for await (const event of response) {
    if (signal.aborted) {
      break
    }
    yield event
  }
}

export async function verifyApiKey(): Promise<boolean> {
  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })
    return response.content.length > 0
  } catch {
    return false
  }
}
