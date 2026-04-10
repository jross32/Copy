import { readFile, stat } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const MAX_FILE_SIZE = 1_000_000 // 1 MB
const MAX_LINES = 2000

const inputSchema = z.object({
  path: z.string().describe('The path to the file to read'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Line number to start reading from (1-indexed)'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of lines to read'),
})

type Input = z.infer<typeof inputSchema>

export const FileReadTool: Tool<Input> = {
  name: 'Read',
  description:
    'Read the contents of a file from the filesystem. Supports text files. Large files are automatically truncated.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute or relative path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['path'],
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,

  renderInput(input: Input): string {
    let s = input.path
    if (input.offset) s += `:${input.offset}`
    if (input.limit) s += ` (${input.limit} lines)`
    return s
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const filePath = resolve(context.options.cwd, input.path)

    const stats = await stat(filePath)
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`)
    }

    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large to read directly (${stats.size} bytes). Use offset/limit to read specific sections.`,
      )
    }

    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const total = lines.length

    const start = input.offset ? input.offset - 1 : 0
    const end = input.limit ? start + input.limit : Math.min(start + MAX_LINES, total)

    const selectedLines = lines.slice(start, end)
    const numbered = selectedLines
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join('\n')

    const truncated = end < total
    const note = truncated
      ? `\n[Showing lines ${start + 1}-${end} of ${total}. Use offset/limit to see more.]`
      : ''

    return numbered + note
  },
}
