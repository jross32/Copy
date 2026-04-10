import { execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_LENGTH = 30_000

// Commands that are never allowed regardless of permissions
const BANNED_COMMANDS = new Set([
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'dd if=/dev/zero',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'wget -O- | bash',
  'curl | bash',
])

const inputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe('Timeout in milliseconds (max 600000)'),
})

type Input = z.infer<typeof inputSchema>

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const half = Math.floor(maxLen / 2)
  return (
    text.slice(0, half) +
    `\n... [output truncated, ${text.length - maxLen} chars omitted] ...\n` +
    text.slice(text.length - half)
  )
}

export const BashTool: Tool<Input> = {
  name: 'Bash',
  description:
    'Execute a bash command in the shell. Use for running scripts, installing packages, running tests, checking system state, etc.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default 30000, max 600000)',
      },
    },
    required: ['command'],
  },

  isEnabled: () => true,
  isReadOnly: () => false,

  needsPermissions(input: Input): boolean {
    // Safe read-only commands don't need permission
    const safeCommands = ['ls', 'cat', 'echo', 'pwd', 'git status', 'git log', 'git diff', 'which', 'date', 'env']
    const cmd = input.command.trim()
    return !safeCommands.some(safe => cmd === safe || cmd.startsWith(safe + ' '))
  },

  renderInput(input: Input): string {
    return input.command
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const { command, timeout = 30_000 } = input
    const { cwd } = context.options

    // Check banned commands
    for (const banned of BANNED_COMMANDS) {
      if (command.includes(banned)) {
        throw new Error(`Command blocked for safety: contains "${banned}"`)
      }
    }

    if (context.abortController.signal.aborted) {
      throw new Error('Aborted')
    }

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        signal: context.abortController.signal,
      })

      const out = stdout ? truncate(stdout, MAX_OUTPUT_LENGTH) : ''
      const err = stderr ? truncate(stderr, MAX_OUTPUT_LENGTH) : ''

      let result = ''
      if (out) result += out
      if (err) result += (result ? '\n[stderr]\n' : '') + err
      return result || '(no output)'
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const execErr = err as { code?: number; stdout?: string; stderr?: string; message?: string }
        const out = execErr.stdout ? truncate(execErr.stdout, MAX_OUTPUT_LENGTH) : ''
        const errOut = execErr.stderr ? truncate(execErr.stderr, MAX_OUTPUT_LENGTH) : ''
        const parts: string[] = []
        if (out) parts.push(out)
        if (errOut) parts.push(`[stderr]\n${errOut}`)
        if (parts.length === 0 && execErr.message) parts.push(execErr.message)
        return parts.join('\n') || `Command failed with code ${execErr.code}`
      }
      throw err
    }
  },
}
