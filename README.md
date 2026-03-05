# Switchboard

A TypeScript implementation of the [Symphony](https://github.com/openai/symphony) specification from OpenAI. Switchboard turns project work into isolated, autonomous implementation runs -- allowing teams to manage work instead of supervising coding agents.

Built with [OpenTUI](https://github.com/anthropics/opentui) and React as the rendering layer, Switchboard provides a composable terminal UI for orchestrating any TUI-compatible coding agent.

## Architecture

Switchboard follows the Symphony spec's layered architecture:

- **Policy Layer** -- repo-defined `WORKFLOW.md` prompt and team-specific rules
- **Configuration Layer** -- typed runtime settings parsed from YAML front matter
- **Coordination Layer** -- orchestrator handling polling, dispatch, concurrency, retries, and reconciliation
- **Execution Layer** -- workspace management and coding-agent subprocess lifecycle
- **Integration Layer** -- issue tracker adapters (Linear)
- **Observability Layer** -- TUI status surface and structured logging

The rendering layer uses OpenTUI with React (`@opentui/react`) to build the terminal interface. This keeps the UI composable and declarative while running entirely in the terminal.

## Composability

Switchboard is designed to work with any TUI coding agent that speaks a compatible app-server protocol over stdio. The agent runner is decoupled from the orchestrator, so swapping in a different coding agent requires only changing the `codex.command` in your workflow configuration.

## Prerequisites

- [Bun](https://bun.sh) runtime

## Getting Started

```sh
# Install dependencies
bun install

# Run the TUI
bun run dev
```

## Configuration

Switchboard reads its configuration from a `WORKFLOW.md` file in the project root. This file contains YAML front matter for runtime settings and a Markdown body used as the prompt template for each issue.

See the [Symphony SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) for the full configuration schema covering tracker settings, polling intervals, workspace hooks, agent concurrency, and more.

## Tech Stack

- **Runtime** -- [Bun](https://bun.sh)
- **Language** -- TypeScript
- **UI** -- [OpenTUI](https://github.com/anthropics/opentui) + React 19
- **Spec** -- [OpenAI Symphony](https://github.com/openai/symphony)

## License

See [LICENSE](LICENSE) for details.
