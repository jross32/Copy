#!/usr/bin/env node
import { program } from 'commander'
import { createInterface } from 'readline'
import { resolve } from 'path'
import process from 'process'
import chalk from 'chalk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.js'
import { getEnabledTools } from './tools.js'
import { query } from './query.js'
import { getContext, buildSystemPrompt } from './context.js'
import { hasPermissionsToUseTool, initConfig, addAllowedTool, getPermissionKey } from './permissions.js'
import type { Tool, ToolUseContext } from './Tool.js'

// ─── Terminal helpers ────────────────────────────────────────────────────────

function clearLine() {
  process.stdout.write('\r\x1b[K')
}

function printAssistantText(text: string) {
  process.stdout.write(chalk.white(text))
}

function printToolStart(toolName: string, input: string) {
  console.log(chalk.cyan(`\n  [${toolName}] ${chalk.gray(input)}`))
}

function printToolResult(toolName: string, output: string | undefined, isError: boolean) {
  if (!output) return
  const preview = output.slice(0, 300)
  const truncated = output.length > 300 ? chalk.gray(' …') : ''
  const color = isError ? chalk.red : chalk.gray
  console.log(color(`  → ${preview}${truncated}`))
}

function printError(message: string) {
  console.error(chalk.red(`\nError: ${message}`))
}

function printBanner() {
  console.log(chalk.bold.blue('\n  AI Coder  ') + chalk.gray('powered by Claude\n'))
  console.log(chalk.gray('  Type your request, or /help for commands, /quit to exit\n'))
}

function printHelp() {
  console.log(chalk.bold('\nAvailable commands:'))
  console.log('  /help          Show this help message')
  console.log('  /clear         Clear conversation history')
  console.log('  /tools         List available tools')
  console.log('  /allow <tool>  Permanently allow a tool without prompting')
  console.log('  /quit          Exit')
  console.log()
}

// ─── Permission prompt ────────────────────────────────────────────────────────

async function promptForPermission(
  tool: Tool,
  input: Record<string, unknown>,
  rl: ReturnType<typeof createInterface>,
): Promise<'allow' | 'allow-all' | 'deny'> {
  const display = tool.renderInput(input as never)
  console.log(chalk.yellow(`\n  Permission required:`))
  console.log(chalk.yellow(`  Tool: ${chalk.bold(tool.name)}`))
  console.log(chalk.yellow(`  Action: ${display}`))
  console.log(chalk.gray('  [y] Allow once  [a] Allow always  [n] Deny  → '), '')

  return new Promise(resolve => {
    rl.question('', answer => {
      const a = answer.trim().toLowerCase()
      if (a === 'a') resolve('allow-all')
      else if (a === 'y' || a === '') resolve('allow')
      else resolve('deny')
    })
  })
}

// ─── Main session ─────────────────────────────────────────────────────────────

async function runSession(options: {
  cwd: string
  dangerouslySkipPermissions: boolean
  printMode: boolean
  initialPrompt?: string
}) {
  const { cwd, dangerouslySkipPermissions, printMode, initialPrompt } = options

  initConfig(cwd)

  const tools = await getEnabledTools()
  const contextStr = await getContext(cwd)
  const systemPrompt = buildSystemPrompt(contextStr)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !printMode,
  })

  const conversationHistory: MessageParam[] = []
  // Session-level allowed tools (for this run only)
  const sessionAllowedTools: string[] = []

  const context: ToolUseContext = {
    abortController: new AbortController(),
    options: {
      dangerouslySkipPermissions,
      allowedTools: sessionAllowedTools,
      cwd,
    },
  }

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    if (context.abortController.signal.aborted) {
      process.exit(0)
    }
    context.abortController.abort()
    console.log(chalk.yellow('\n  [Interrupted]'))
  })

  const canUseTool = async (tool: Tool, input: Record<string, unknown>) => {
    const result = await hasPermissionsToUseTool(tool, input, context)
    if (!result.result && !printMode) {
      const answer = await promptForPermission(tool, input, rl)
      if (answer === 'allow-all') {
        const key = getPermissionKey(tool, input)
        await addAllowedTool(key)
        sessionAllowedTools.push(key)
        return { result: true as const }
      } else if (answer === 'allow') {
        const key = getPermissionKey(tool, input)
        sessionAllowedTools.push(key)
        return { result: true as const }
      } else {
        return { result: false as const, message: 'Permission denied by user' }
      }
    }
    return result
  }

  async function sendMessage(userText: string) {
    conversationHistory.push({
      role: 'user',
      content: userText,
    })

    let firstText = true

    for await (const msg of query({
      messages: [...conversationHistory],
      tools,
      systemPrompt,
      context: {
        ...context,
        abortController: new AbortController(),
      },
      onMessage: (msg) => {
        if (msg.type === 'progress') {
          printToolStart(msg.toolName, JSON.stringify(msg.input).slice(0, 100))
          if (msg.output !== undefined) {
            printToolResult(msg.toolName, msg.output, false)
          }
        }
      },
      onText: (delta) => {
        if (firstText) {
          process.stdout.write('\n')
          firstText = false
        }
        printAssistantText(delta)
      },
      canUseTool,
    })) {
      if (msg.type === 'assistant') {
        // Collect full assistant response for history
        const textContent = msg.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('')

        if (textContent && !firstText) {
          process.stdout.write('\n')
        }

        // Add to history
        conversationHistory.push({
          role: 'assistant',
          content: msg.content,
        })

        if (printMode) {
          // In print mode, just output the text and exit
          break
        }
      }
    }

    console.log()
  }

  // Handle slash commands
  function handleCommand(input: string): boolean {
    const parts = input.trim().split(/\s+/)
    const cmd = parts[0]

    switch (cmd) {
      case '/help':
        printHelp()
        return true
      case '/clear':
        conversationHistory.length = 0
        console.log(chalk.gray('  Conversation cleared.\n'))
        return true
      case '/tools':
        console.log(chalk.bold('\nAvailable tools:'))
        for (const tool of tools) {
          console.log(`  ${chalk.cyan(tool.name.padEnd(15))} ${chalk.gray(tool.description.slice(0, 60))}`)
        }
        console.log()
        return true
      case '/allow':
        if (parts[1]) {
          sessionAllowedTools.push(parts[1])
          console.log(chalk.green(`  Allowed ${parts[1]} for this session.\n`))
        }
        return true
      case '/quit':
      case '/exit':
        console.log(chalk.gray('\n  Goodbye!\n'))
        rl.close()
        process.exit(0)
    }
    return false
  }

  if (!printMode) {
    printBanner()
  }

  if (initialPrompt) {
    if (!printMode) {
      console.log(chalk.bold.blue('You: ') + initialPrompt)
    }
    await sendMessage(initialPrompt)
    if (printMode) {
      rl.close()
      return
    }
  }

  // Interactive REPL loop
  const promptUser = () => {
    rl.question(chalk.bold.blue('\nYou: '), async (input) => {
      const trimmed = input.trim()
      if (!trimmed) {
        promptUser()
        return
      }

      if (handleCommand(trimmed)) {
        promptUser()
        return
      }

      await sendMessage(trimmed)
      promptUser()
    })
  }

  promptUser()
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

program
  .name('ai-coder')
  .description('An AI coding assistant powered by Claude')
  .version('0.1.0')
  .argument('[prompt]', 'Initial prompt to send (optional)')
  .option('-p, --print', 'Print mode: output response and exit (non-interactive)', false)
  .option(
    '--dangerously-skip-permissions',
    'Skip all permission prompts (for CI/CD environments only)',
    false,
  )
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (prompt: string | undefined, opts: {
    print: boolean
    dangerouslySkipPermissions: boolean
    cwd: string
  }) => {
    const cwd = resolve(opts.cwd)

    try {
      await runSession({
        cwd,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
        printMode: opts.print,
        initialPrompt: prompt,
      })
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

program.parse()
