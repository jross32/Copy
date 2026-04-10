import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../Tool.js'

const inputSchema = z.object({
  path: z.string().describe('The path to the file to edit'),
  old_string: z.string().describe('The exact text to replace (must be unique in the file)'),
  new_string: z.string().describe('The replacement text'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences instead of just the first'),
})

type Input = {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export const FileEditTool: Tool<Input> = {
  name: 'Edit',
  description:
    'Edit a file by replacing a specific string with new content. The old_string must match exactly (including whitespace and indentation). If the string appears multiple times, use replace_all:true or provide more surrounding context.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },

  isEnabled: () => true,
  isReadOnly: () => false,
  needsPermissions: () => true,

  renderInput(input: Input): string {
    const lines = input.old_string.split('\n').length
    return `${input.path} (replacing ${lines} line${lines !== 1 ? 's' : ''})`
  },

  async call(input: Input, context: ToolUseContext): Promise<string> {
    const filePath = resolve(context.options.cwd, input.path)
    const content = await readFile(filePath, 'utf-8')

    const occurrences = content.split(input.old_string).length - 1
    if (occurrences === 0) {
      throw new Error(
        `String not found in file: ${filePath}\n` +
          `The old_string must match exactly, including whitespace and indentation.`,
      )
    }

    if (occurrences > 1 && input.replace_all !== true) {
      throw new Error(
        `Found ${occurrences} occurrences of the string in ${filePath}. ` +
          `Use replace_all:true to replace all, or provide more surrounding context to make it unique.`,
      )
    }

    let newContent: string
    if (input.replace_all === true) {
      newContent = content.split(input.old_string).join(input.new_string)
    } else {
      newContent = content.replace(input.old_string, input.new_string)
    }

    await writeFile(filePath, newContent, 'utf-8')

    const replaced = input.replace_all === true ? occurrences : 1
    return `Successfully edited ${filePath} (replaced ${replaced} occurrence${replaced !== 1 ? 's' : ''})`
  },
}
