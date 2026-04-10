import { z } from 'zod'
import type { Tool } from '../Tool.js'

const inputSchema = z.object({
  thought: z.string().describe('Your internal reasoning or analysis'),
})

type Input = z.infer<typeof inputSchema>

/**
 * ThinkTool allows the model to do explicit reasoning that is visible to the user
 * but doesn't produce any side effects. Useful for complex multi-step problems.
 */
export const ThinkTool: Tool<Input> = {
  name: 'Think',
  description:
    'Use this tool to think through complex problems step by step. The thought content is shown to the user but has no side effects. Useful for planning, analyzing tradeoffs, or reasoning before taking action.',
  inputSchema,
  apiSchema: {
    type: 'object',
    properties: {
      thought: {
        type: 'string',
        description: 'Your reasoning or analysis',
      },
    },
    required: ['thought'],
  },

  isEnabled: () => true,
  isReadOnly: () => true,
  needsPermissions: () => false,

  renderInput(input: Input): string {
    const preview = input.thought.slice(0, 80)
    return preview.length < input.thought.length ? preview + '...' : preview
  },

  async call(input: Input): Promise<string> {
    // The thought is already shown to the user via the tool UI
    return `Thought recorded: ${input.thought.slice(0, 100)}...`
  },
}
