# AI Coder

An AI coding assistant powered by Claude, reverse-engineered from the claude-code-sourcemap architecture.

## Development

```bash
npm install
npm run dev          # Run with tsx (development)
npm run build        # Compile TypeScript
npm start            # Run compiled version
```

## Usage

```bash
# Interactive REPL
node dist/index.js

# One-shot prompt
node dist/index.js "explain this codebase"

# Print mode (non-interactive, pipe-friendly)
node dist/index.js --print "what does this file do?"

# Custom working directory
node dist/index.js --cwd /path/to/project
```

## Architecture

```
src/
├── index.ts          # CLI entry point, REPL loop, permission prompts
├── Tool.ts           # Tool interface definition
├── tools.ts          # Tool registry
├── query.ts          # Core agentic query loop (sends messages, handles tool use)
├── context.ts        # Project context gathering (git status, CLAUDE.md, README)
├── permissions.ts    # Permission management (ask/save/deny tool use)
├── services/
│   └── claude.ts     # Anthropic API client with retry logic
└── tools/
    ├── BashTool.ts       # Execute shell commands
    ├── FileReadTool.ts   # Read files with line-number output
    ├── FileWriteTool.ts  # Write/create files
    ├── FileEditTool.ts   # Edit files via exact string replacement
    ├── GlobTool.ts       # Find files by glob pattern
    ├── GrepTool.ts       # Search file content via ripgrep/grep
    ├── LSTool.ts         # List directory structure
    └── ThinkTool.ts      # Explicit model reasoning (no side effects)
```

## Key Concepts (from claude-code-sourcemap)

- **Tools**: Each tool implements the `Tool<TInput>` interface with `name`, `description`, `inputSchema`, `apiSchema`, `call()`, and permission methods
- **Query loop**: `query()` in `query.ts` is an async generator that streams Claude responses, handles tool use blocks, runs tools concurrently (up to 5 at once), and feeds results back — continuing until Claude gives a final text response
- **Context**: On startup, `getContext()` reads CLAUDE.md, git status, directory structure, and README to prepend as system prompt context
- **Permissions**: Each tool declares `needsPermissions()`. Write/execute tools prompt the user before running; users can approve once or permanently

## Required Environment Variable

```bash
export ANTHROPIC_API_KEY=your_key_here
```
