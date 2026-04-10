import { readdir, stat } from 'fs/promises'
import { resolve, join, relative } from 'path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const MAX_ENTRIES = 500

const inputSchema = z.object({
  path: z.string().optional().describe('Directory path to list (defaults to cwd)'),
  ignore: z.array(z.string()).optional().describe('Patterns to ignore'),
})

type Input = z.infer<typeof inputSchema>

const DEFAULT_IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.DS_Store'])

async function listDir(
  dir: string,
  ignore: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<string[]> {
  if (depth > maxDepth) return []

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const results: string[] = []
  for (const entry of entries) {
    if (ignore.has(entry)) continue

    const fullPath = join(dir, entry)
    try {
      const s = await stat(fullPath)
      if (s.isDirectory()) {
        results.push(fullPath + '/')
        const children = await listDir(fullPath, ignore, depth + 1, maxDepth)
        results.push(...children)
      } else {
        results.push(fullPath)
      }
    } catch {
      // skip
    }
  }
  return results
}

export const LSTool: Tool<Input> = {
  name: 'LS',
  description:
    'List files and directories. Shows directory structure. Automatically ignores node_modules, .git, and other common generated directories.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory to list (defaults to current working directory)',
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional directory/file names to ignore',
      },
    },
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,

  renderInput(input: Input): string {
    return input.path ?? '.'
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const dir = input.path
      ? resolve(context.options.cwd, input.path)
      : context.options.cwd

    const ignore = new Set([
      ...DEFAULT_IGNORE,
      ...(input.ignore ?? []),
    ])

    const files = await listDir(dir, ignore, 0, 4)

    if (files.length === 0) {
      return `(empty directory)`
    }

    const truncated = files.length > MAX_ENTRIES
    const shown = files.slice(0, MAX_ENTRIES)
    const relativePaths = shown.map(f => relative(context.options.cwd, f))

    const note = truncated ? `\n[Showing ${MAX_ENTRIES} of ${files.length} entries]` : ''

    return relativePaths.join('\n') + note
  },
}
