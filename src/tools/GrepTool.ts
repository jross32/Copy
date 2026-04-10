import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolve } from 'path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 50_000

const inputSchema = z.object({
  pattern: z.string().describe('The regex pattern to search for'),
  path: z.string().optional().describe('File or directory to search in'),
  glob: z.string().optional().describe('File glob pattern to filter (e.g. "*.ts")'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe('Output mode: content (show matching lines), files_with_matches (show file paths), count'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive search'),
  context: z.number().int().min(0).max(20).optional().describe('Lines of context around each match'),
})

type Input = {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  case_insensitive?: boolean
  context?: number
}

async function fallbackGrep(input: Input, context: ToolUseContext): Promise<string> {
  const searchPath = input.path
    ? resolve(context.options.cwd, input.path)
    : context.options.cwd

  const mode = input.output_mode ?? 'files_with_matches'
  const args = ['-r', '--include', input.glob ?? '*']
  if (input.case_insensitive) args.push('-i')
  if (mode === 'files_with_matches') args.push('-l')
  else if (mode === 'count') args.push('-c')
  if (input.context && mode === 'content') args.push('-C', String(input.context))

  args.push(input.pattern, searchPath)

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: context.options.cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    return stdout.trim() || `No matches found for: ${input.pattern}`
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
      return `No matches found for: ${input.pattern}`
    }
    throw err
  }
}

export const GrepTool: Tool<Input> = {
  name: 'Grep',
  description:
    'Search file contents using ripgrep (regex). Fast search across large codebases. Use output_mode "content" to see matching lines, "files_with_matches" for just file paths, "count" for match counts.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in (defaults to cwd)',
      },
      glob: {
        type: 'string',
        description: 'Filter files by glob pattern (e.g. "*.ts", "**/*.tsx")',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'What to output: matching lines, file paths, or counts',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive search',
      },
      context: {
        type: 'number',
        description: 'Number of context lines around each match (0-20)',
      },
    },
    required: ['pattern'],
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,

  renderInput(input: Input): string {
    let s = `"${input.pattern}"`
    if (input.path) s += ` in ${input.path}`
    if (input.glob) s += ` (${input.glob})`
    return s
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const searchPath = input.path
      ? resolve(context.options.cwd, input.path)
      : context.options.cwd

    const args: string[] = []

    // Output mode flags
    const mode = input.output_mode ?? 'files_with_matches'
    if (mode === 'files_with_matches') {
      args.push('-l')
    } else if (mode === 'count') {
      args.push('-c')
    }
    // 'content' mode uses no special flag

    if (input.case_insensitive) args.push('-i')
    if (input.context && mode === 'content') args.push('-C', String(input.context))
    if (input.glob) args.push('--glob', input.glob)

    // Always ignore these directories
    args.push('--glob', '!node_modules', '--glob', '!.git')

    args.push(input.pattern, searchPath)

    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: context.options.cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      })

      if (!stdout.trim()) {
        return `No matches found for: ${input.pattern}`
      }

      if (stdout.length > MAX_OUTPUT) {
        return stdout.slice(0, MAX_OUTPUT) + '\n[output truncated]'
      }

      return stdout.trim()
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code: number | string }).code
        // rg exits with code 1 when no matches found
        if (code === 1) {
          return `No matches found for: ${input.pattern}`
        }
        // rg not installed — fall back to grep
        if (code === 'ENOENT') {
          return fallbackGrep(input, context)
        }
      }
      throw err
    }
  },
}
