import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, join } from 'path'
import type { Tool, ToolUseContext, PermissionResult } from './Tool.js'
import { BashTool } from './tools/BashTool.js'
import { FileEditTool } from './tools/FileEditTool.js'
import { FileWriteTool } from './tools/FileWriteTool.js'

// Commands that are always safe and don't need user approval
const ALWAYS_SAFE_COMMANDS = new Set([
  'git status',
  'git diff',
  'git log',
  'git branch',
  'pwd',
  'ls',
  'echo',
  'which',
  'date',
  'env',
  'cat',
])

type ProjectConfig = {
  allowedTools: string[]
}

const CONFIG_DIR = '.ai-coder'
const CONFIG_FILE = 'project.json'

let cachedConfig: ProjectConfig | null = null
let configPath: string | null = null

export function initConfig(cwd: string): void {
  configPath = join(cwd, CONFIG_DIR, CONFIG_FILE)
  cachedConfig = null
}

export async function getProjectConfig(): Promise<ProjectConfig> {
  if (cachedConfig) return cachedConfig

  if (!configPath) {
    return { allowedTools: [] }
  }

  try {
    const raw = await readFile(configPath, 'utf-8')
    cachedConfig = JSON.parse(raw) as ProjectConfig
    return cachedConfig
  } catch {
    cachedConfig = { allowedTools: [] }
    return cachedConfig
  }
}

export async function saveProjectConfig(config: ProjectConfig): Promise<void> {
  if (!configPath) return

  cachedConfig = config
  const dir = resolve(configPath, '..')
  await mkdir(dir, { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export async function addAllowedTool(key: string): Promise<void> {
  const config = await getProjectConfig()
  if (!config.allowedTools.includes(key)) {
    config.allowedTools.push(key)
    config.allowedTools.sort()
    await saveProjectConfig(config)
  }
}

export function isBashCommandAlwaysSafe(command: string): boolean {
  const trimmed = command.trim()
  // Check exact matches
  if (ALWAYS_SAFE_COMMANDS.has(trimmed)) return true
  // Check if it starts with a safe command
  for (const safe of ALWAYS_SAFE_COMMANDS) {
    if (trimmed === safe || trimmed.startsWith(safe + ' ')) return true
  }
  return false
}

export function getPermissionKey(tool: Tool, input: Record<string, unknown>): string {
  if (tool === BashTool) {
    const command = (input.command as string) || ''
    return `Bash(${command.slice(0, 50)})`
  }
  return tool.name
}

/**
 * Check if the given tool + input has permission to run.
 * This checks the allowedTools list from config.
 */
export async function hasPermissionsToUseTool(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<PermissionResult> {
  // If permissions are disabled (e.g. CI mode), allow everything
  if (context.options.dangerouslySkipPermissions) {
    return { result: true }
  }

  // Check if tool itself says it needs permissions
  const needsPerm = tool.needsPermissions(input as never)
  if (!needsPerm) {
    return { result: true }
  }

  // Special case: bash with always-safe commands
  if (tool === BashTool) {
    const command = (input.command as string) || ''
    if (isBashCommandAlwaysSafe(command)) {
      return { result: true }
    }
  }

  // Check stored permissions
  const config = await getProjectConfig()
  const allowedTools = config.allowedTools

  // Check if tool is blanket-allowed
  if (allowedTools.includes(tool.name)) {
    return { result: true }
  }

  // Check session-level allowed tools from context
  if (context.options.allowedTools.includes(tool.name)) {
    return { result: true }
  }

  const key = getPermissionKey(tool, input)
  if (allowedTools.includes(key) || context.options.allowedTools.includes(key)) {
    return { result: true }
  }

  return {
    result: false,
    message: `Permission required to use ${tool.name}: ${tool.renderInput(input as never)}`,
  }
}
