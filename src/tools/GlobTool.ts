import { glob } from 'glob'
import { resolve, relative } from 'path'
import { stat } from 'fs/promises'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const MAX_RESULTS = 1000

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files against (e.g. "**/*.ts")'),
  path: z
    .string()
    .optional()
    .describe('Directory to search in (defaults to current working directory)'),
})

type Input = z.infer<typeof inputSchema>

export const GlobTool: Tool<Input> = {
  name: 'Glob',
  description:
    'Find files matching a glob pattern. Returns file paths sorted by modification time (most recently modified first).',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match (e.g. "**/*.ts", "src/**/*.tsx")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to current working directory.',
      },
    },
    required: ['pattern'],
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,

  renderInput(input: Input): string {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const searchDir = input.path
      ? resolve(context.options.cwd, input.path)
      : context.options.cwd

    const matches = await glob(input.pattern, {
      cwd: searchDir,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
      maxDepth: 20,
    })

    if (matches.length === 0) {
      return `No files found matching pattern: ${input.pattern}`
    }

    // Sort by modification time (most recent first)
    const withStats = await Promise.all(
      matches.slice(0, MAX_RESULTS).map(async file => {
        try {
          const s = await stat(file)
          return { file, mtime: s.mtimeMs }
        } catch {
          return { file, mtime: 0 }
        }
      }),
    )

    withStats.sort((a, b) => b.mtime - a.mtime)

    const relativePaths = withStats.map(({ file }) =>
      relative(context.options.cwd, file),
    )

    const truncated = matches.length > MAX_RESULTS
    const note = truncated
      ? `\n[Showing first ${MAX_RESULTS} of ${matches.length} matches]`
      : ''

    return relativePaths.join('\n') + note
  },
}
