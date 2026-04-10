#!/usr/bin/env node
import { program } from 'commander'
import { createInterface } from 'readline'
import { resolve } from 'path'
import process from 'process'
import chalk from 'chalk'
import { getEnabledTools } from './tools.js'
import { query } from './query.js'
import { getContext, buildSystemPrompt } from './context.js'
import { hasPermissionsToUseTool, initConfig, addAllowedTool, getPermissionKey } from './permissions.js'
import { getProvider, type Provider } from './services/backend.js'
import type { Tool, ToolUseContext } from './Tool.js'
import type { UnifiedMessage } from './services/provider.js'

// ─── Terminal helpers ────────────────────────────────────────────────────────

function printAssistantText(text: string) {
  process.stdout.write(chalk.white(text))
}

function printToolStart(toolName: string, input: string) {
  console.log(chalk.cyan(`\n  [${toolName}] `) + chalk.gray(input))
}

function printToolResult(output: string | undefined, isError: boolean) {
  if (!output) return
  const preview = output.slice(0, 300)
  const truncated = output.length > 300 ? chalk.gray(' …') : ''
  const color = isError ? chalk.red : chalk.gray
  console.log(color(`  → ${preview}${truncated}`))
}

function printError(message: string) {
  console.error(chalk.red(`\nError: ${message}`))
}

function printBanner(backendName: string, model: string) {
  console.log()
  console.log(chalk.bold.blue('  AI Coder') + chalk.gray(`  — ${backendName}`) + chalk.dim(` (${model})`))
  console.log(chalk.gray('  Type your request, or /help for commands, /quit to exit'))
  console.log()
}

function printHelp() {
  console.log(chalk.bold('\nAvailable commands:'))
  console.log('  /help          Show this help')
  console.log('  /clear         Clear conversation history')
  console.log('  /tools         List available tools')
  console.log('  /allow <tool>  Allow a tool for this session without prompting')
  console.log('  /quit          Exit')
  console.log()
}

function printSetupHint() {
  console.log(chalk.yellow('\nNo AI backend available.\n'))
  console.log(chalk.bold('Option 1') + chalk.gray(' — Claude (API key required):'))
  console.log(chalk.gray('  export ANTHROPIC_API_KEY=sk-ant-...'))
  console.log()
  console.log(chalk.bold('Option 2') + chalk.gray(' — Ollama (free, runs locally, no key needed):'))
  console.log(chalk.gray('  # Install Ollama'))
  console.log(chalk.gray('  curl -fsSL https://ollama.com/install.sh | sh'))
  console.log(chalk.gray('  # Pull a coding model (~4 GB)'))
  console.log(chalk.gray('  ollama pull qwen2.5-coder:7b'))
  console.log(chalk.gray('  # Ollama auto-starts, then run again:'))
  console.log(chalk.gray('  npx tsx src/index.ts'))
  console.log()
}

// ─── Permission prompt ─────────────────────────────────────────────────────

async function promptForPermission(
  tool: Tool,
  input: Record<string, unknown>,
  rl: ReturnType<typeof createInterface>,
): Promise<'allow' | 'allow-all' | 'deny'> {
  const display = tool.renderInput(input as never)
  console.log(chalk.yellow(`\n  Permission required:`))
  console.log(chalk.yellow(`  Tool: ${chalk.bold(tool.name)}`))
  console.log(chalk.yellow(`  Action: ${display}`))
  process.stdout.write(chalk.gray('  [y] Allow once  [a] Allow always  [n] Deny  → '))

  return new Promise(res => {
    rl.question('', answer => {
      const a = answer.trim().toLowerCase()
      if (a === 'a') res('allow-all')
      else if (a === 'n') res('deny')
      else res('allow') // default: allow once
    })
  })
}

// ─── Session ──────────────────────────────────────────────────────────────────

async function runSession(options: {
  cwd: string
  dangerouslySkipPermissions: boolean
  printMode: boolean
  initialPrompt?: string
}) {
  const { cwd, dangerouslySkipPermissions, printMode, initialPrompt } = options

  // Get backend — exit with helpful message if none available
  let provider: Provider
  try {
    provider = await getProvider()
  } catch (err) {
    if (!printMode) printSetupHint()
    else console.error(String(err))
    process.exit(1)
  }

  initConfig(cwd)

  const [tools, contextStr] = await Promise.all([
    getEnabledTools(),
    getContext(cwd),
  ])
  const systemPrompt = buildSystemPrompt(contextStr)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !printMode,
  })

  const conversationHistory: UnifiedMessage[] = []
  const sessionAllowedTools: string[] = []

  const context: ToolUseContext = {
    abortController: new AbortController(),
    options: {
      dangerouslySkipPermissions,
      allowedTools: sessionAllowedTools,
      cwd,
    },
  }

  // Ctrl+C: abort current request, second Ctrl+C exits
  process.on('SIGINT', () => {
    if (context.abortController.signal.aborted) process.exit(0)
    context.abortController.abort()
    console.log(chalk.yellow('\n  [Interrupted — press Ctrl+C again to exit]'))
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
        sessionAllowedTools.push(getPermissionKey(tool, input))
        return { result: true as const }
      } else {
        return { result: false as const, message: 'Permission denied by user' }
      }
    }
    return result
  }

  async function sendMessage(userText: string) {
    conversationHistory.push({ role: 'user', content: userText })

    // Fresh abort controller for each request
    const reqAbort = new AbortController()
    const reqContext: ToolUseContext = {
      ...context,
      abortController: reqAbort,
    }

    let firstText = true

    for await (const msg of query({
      provider,
      messages: [...conversationHistory],
      tools,
      systemPrompt,
      context: reqContext,
      onMessage: msg => {
        if (msg.type === 'progress') {
          const inputStr = typeof msg.input === 'object'
            ? Object.entries(msg.input)
                .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
                .join(' ')
            : String(msg.input)
          if (msg.output === undefined) {
            printToolStart(msg.toolName, inputStr)
          } else {
            printToolResult(msg.output, msg.isError ?? false)
          }
        }
      },
      onText: delta => {
        if (firstText) {
          process.stdout.write('\n')
          firstText = false
        }
        printAssistantText(delta)
      },
      canUseTool,
    })) {
      if (msg.type === 'assistant') {
        if (!firstText) process.stdout.write('\n')

        // Add to conversation history
        conversationHistory.push({ role: 'assistant', content: msg.content })

        if (printMode) break
      }
    }

    console.log()
  }

  // Slash commands
  function handleCommand(input: string): boolean {
    const parts = input.trim().split(/\s+/)
    switch (parts[0]) {
      case '/help':
        printHelp()
        return true
      case '/clear':
        conversationHistory.length = 0
        console.log(chalk.gray('  Conversation cleared.\n'))
        return true
      case '/tools':
        console.log(chalk.bold('\nAvailable tools:'))
        for (const t of tools) {
          console.log(`  ${chalk.cyan(t.name.padEnd(15))}${chalk.gray(t.description.slice(0, 65))}`)
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
      case '/q':
        console.log(chalk.gray('\n  Goodbye!\n'))
        rl.close()
        process.exit(0)
    }
    return false
  }

  if (!printMode) {
    printBanner(provider.name, provider.model)
  }

  if (initialPrompt) {
    if (!printMode) console.log(chalk.bold.blue('You: ') + initialPrompt)
    await sendMessage(initialPrompt)
    if (printMode) {
      rl.close()
      return
    }
  }

  // Interactive REPL
  const promptUser = () => {
    rl.question(chalk.bold.blue('\nYou: '), async input => {
      const trimmed = input.trim()
      if (!trimmed) { promptUser(); return }
      if (handleCommand(trimmed)) { promptUser(); return }
      await sendMessage(trimmed)
      promptUser()
    })
  }

  promptUser()
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

program
  .name('ai-coder')
  .description('An AI coding assistant — works with Claude (API key) or Ollama (free, local)')
  .version('0.1.0')
  .argument('[prompt]', 'Initial prompt (optional)')
  .option('-p, --print', 'Non-interactive: print response and exit', false)
  .option('--dangerously-skip-permissions', 'Skip all permission prompts (CI use only)', false)
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (prompt: string | undefined, opts: {
    print: boolean
    dangerouslySkipPermissions: boolean
    cwd: string
  }) => {
    try {
      await runSession({
        cwd: resolve(opts.cwd),
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
