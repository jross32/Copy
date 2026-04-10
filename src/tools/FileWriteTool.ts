import { writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const inputSchema = z.object({
  path: z.string().describe('The path to the file to write'),
  content: z.string().describe('The content to write to the file'),
})

type Input = z.infer<typeof inputSchema>

export const FileWriteTool: Tool<Input> = {
  name: 'Write',
  description:
    'Write content to a file. Creates the file and any parent directories if they do not exist. OVERWRITES existing files.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The absolute or relative path to write the file',
      },
      content: {
        type: 'string',
        description: 'The full content to write to the file',
      },
    },
    required: ['path', 'content'],
  },

  isEnabled: () => true,
  isReadOnly: () => false,
  needsPermissions: () => true,

  renderInput(input: Input): string {
    const lines = input.content.split('\n').length
    return `${input.path} (${lines} lines)`
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const filePath = resolve(context.options.cwd, input.path)
    const dir = dirname(filePath)

    await mkdir(dir, { recursive: true })
    await writeFile(filePath, input.content, 'utf-8')

    const lines = input.content.split('\n').length
    return `Successfully wrote ${lines} lines to ${filePath}`
  },
}
