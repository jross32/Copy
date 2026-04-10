import type { Tool } from './Tool.js'
import { BashTool } from './tools/BashTool.js'
import { FileReadTool } from './tools/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool.js'
import { FileEditTool } from './tools/FileEditTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { LSTool } from './tools/LSTool.js'
import { ThinkTool } from './tools/ThinkTool.js'

export const ALL_TOOLS: Tool[] = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  LSTool,
  ThinkTool,
]

export async function getEnabledTools(): Promise<Tool[]> {
  const enabled = await Promise.all(
    ALL_TOOLS.map(async tool => ({
      tool,
      enabled: await tool.isEnabled(),
    })),
  )
  return enabled.filter(({ enabled }) => enabled).map(({ tool }) => tool)
}
