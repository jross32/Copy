import type { MessageParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.js'
import type { ZodSchema } from 'zod'

export type ToolInput = Record<string, unknown>

export type ToolOutput = {
  type: 'text'
  text: string
}

export type ToolUseContext = {
  abortController: AbortController
  options: {
    dangerouslySkipPermissions: boolean
    allowedTools: string[]
    cwd: string
  }
}

export type PermissionResult =
  | { result: true }
  | { result: false; message: string }

export interface Tool<TInput extends ToolInput = ToolInput> {
  /** Unique name used in API calls */
  name: string
  /** Human-readable description shown in the tool list */
  description: string
  /** Zod schema for validating input */
  inputSchema: ZodSchema<TInput>
  /** JSON schema passed to the Anthropic API */
  apiSchema: object

  /** Whether this tool is currently available */
  isEnabled(): boolean | Promise<boolean>

  /** Whether this tool only reads (doesn't write) */
  isReadOnly(): boolean

  /** Whether this specific input requires user permission */
  needsPermissions(input: TInput): boolean

  /** Execute the tool, returning text output */
  call(input: TInput, context: ToolUseContext): Promise<string>

  /** Format the input for display to the user */
  renderInput(input: TInput): string
}
