import { readFile, access } from 'fs/promises'
import { resolve, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const MAX_GIT_STATUS_LINES = 200

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: 5_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Look for CLAUDE.md files in the project hierarchy and return their content
 * as context instructions.
 */
export async function getClaudeFiles(cwd: string): Promise<string> {
  const claudeFiles = [
    join(cwd, 'CLAUDE.md'),
    join(cwd, '.claude', 'CLAUDE.md'),
  ]

  const sections: string[] = []
  for (const filePath of claudeFiles) {
    if (await fileExists(filePath)) {
      try {
        const content = await readFile(filePath, 'utf-8')
        if (content.trim()) {
          sections.push(`## Instructions from ${filePath}\n\n${content}`)
        }
      } catch {
        // skip
      }
    }
  }

  return sections.join('\n\n')
}

/**
 * Read the README.md if present.
 */
export async function getReadme(cwd: string): Promise<string> {
  const readmePaths = ['README.md', 'README.txt', 'readme.md']
  for (const name of readmePaths) {
    const path = join(cwd, name)
    if (await fileExists(path)) {
      try {
        const content = await readFile(path, 'utf-8')
        const truncated = content.slice(0, 3000)
        const note = content.length > 3000 ? '\n... [README truncated]' : ''
        return truncated + note
      } catch {
        return ''
      }
    }
  }
  return ''
}

/**
 * Get current git status, branch info, and recent commits.
 */
export async function getGitStatus(cwd: string): Promise<string> {
  const parts: string[] = []

  const branch = await runCommand('git', ['branch', '--show-current'], cwd)
  if (branch) parts.push(`Current branch: ${branch}`)

  const status = await runCommand('git', ['status', '--short'], cwd)
  if (status) {
    const lines = status.split('\n')
    const shown = lines.slice(0, MAX_GIT_STATUS_LINES)
    const note = lines.length > MAX_GIT_STATUS_LINES
      ? `\n... [${lines.length - MAX_GIT_STATUS_LINES} more changed files]`
      : ''
    parts.push(`Git status:\n${shown.join('\n')}${note}`)
  }

  const log = await runCommand(
    'git',
    ['log', '--oneline', '-10'],
    cwd,
  )
  if (log) parts.push(`Recent commits:\n${log}`)

  return parts.join('\n\n')
}

/**
 * Build an approximate directory structure for context.
 */
export async function getDirectoryStructure(cwd: string): Promise<string> {
  // Use find or ls -la tree-style output
  const result = await runCommand(
    'find',
    ['.', '-maxdepth', '3', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*', '-not', '-path', '*/dist/*'],
    cwd,
  )

  if (!result) return ''

  const lines = result.split('\n').slice(0, 200)
  return lines.join('\n')
}

/**
 * Assemble the full system prompt context for a conversation.
 * This is prepended to every conversation.
 */
export async function getContext(cwd: string): Promise<string> {
  const [claudeFiles, readme, gitStatus, dirStructure] = await Promise.all([
    getClaudeFiles(cwd),
    getReadme(cwd),
    getGitStatus(cwd),
    getDirectoryStructure(cwd),
  ])

  const sections: string[] = []

  if (claudeFiles) {
    sections.push(claudeFiles)
  }

  if (gitStatus) {
    sections.push(`## Git Status\n\n${gitStatus}`)
  }

  if (dirStructure) {
    sections.push(
      `## Project Structure (snapshot at session start)\n\`\`\`\n${dirStructure}\n\`\`\`\nNote: This is a snapshot. Use LS/Glob tools to get current structure.`,
    )
  }

  if (readme) {
    sections.push(`## README\n\n${readme}`)
  }

  return sections.join('\n\n')
}

export function buildSystemPrompt(contextStr: string): string {
  const base = `You are an AI coding assistant. You help developers write, edit, debug, and understand code.

You have access to tools for reading files, editing files, running bash commands, searching codebases, and more.

## Guidelines

- Always read files before editing them
- Make targeted, minimal changes to accomplish the task
- Prefer editing existing files over creating new ones
- Run tests after making changes when a test command is available
- Ask for clarification if the task is ambiguous
- Think through complex problems with the Think tool before acting
- When writing code, follow the existing style and conventions of the project
- Do not add unnecessary features, comments, or abstractions

## Working Directory

Your current working directory is the project root. All file paths are relative to it.
`

  if (contextStr.trim()) {
    return base + '\n\n## Project Context\n\n' + contextStr
  }
  return base
}
