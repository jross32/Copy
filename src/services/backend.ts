/**
 * Auto-selects the best available AI backend:
 *   1. Claude (Anthropic) — if ANTHROPIC_API_KEY is set
 *   2. Ollama             — if a local Ollama server is running
 *
 * Override with: AI_BACKEND=anthropic|ollama
 */

import { AnthropicProvider } from './anthropic.js'
import { OllamaProvider } from './ollama.js'
import type { Provider } from './provider.js'

const PROVIDERS: Provider[] = [AnthropicProvider, OllamaProvider]

let selectedProvider: Provider | null = null

export async function getProvider(): Promise<Provider> {
  if (selectedProvider) return selectedProvider

  const override = process.env.AI_BACKEND?.toLowerCase()

  if (override) {
    const forced = PROVIDERS.find(p => p.name.toLowerCase().startsWith(override))
    if (forced) {
      const ok = await forced.isAvailable()
      if (!ok) {
        throw new Error(
          `Requested backend "${override}" is not available.\n` +
            getSetupHint(forced),
        )
      }
      selectedProvider = forced
      return forced
    }
    throw new Error(`Unknown AI_BACKEND="${override}". Valid values: anthropic, ollama`)
  }

  // Auto-detect: try each in order
  for (const provider of PROVIDERS) {
    if (await provider.isAvailable()) {
      selectedProvider = provider
      return provider
    }
  }

  throw new Error(
    `No AI backend available.\n\n` +
      `Option 1 — Use Claude (requires API key):\n` +
      `  export ANTHROPIC_API_KEY=sk-ant-...\n\n` +
      `Option 2 — Use Ollama (free, local, no key required):\n` +
      `  # Install Ollama\n` +
      `  curl -fsSL https://ollama.com/install.sh | sh\n` +
      `  # Pull a coding model\n` +
      `  ollama pull qwen2.5-coder:7b\n` +
      `  # Start the server (runs in background automatically)\n` +
      `  ollama serve\n` +
      `  # Then run ai-coder again`,
  )
}

export function getSetupHint(provider: Provider): string {
  if (provider === AnthropicProvider) {
    return `Set your API key:\n  export ANTHROPIC_API_KEY=sk-ant-...`
  }
  if (provider === OllamaProvider) {
    return (
      `Install and start Ollama:\n` +
      `  curl -fsSL https://ollama.com/install.sh | sh\n` +
      `  ollama pull qwen2.5-coder:7b\n` +
      `  ollama serve`
    )
  }
  return ''
}

export type { Provider }
