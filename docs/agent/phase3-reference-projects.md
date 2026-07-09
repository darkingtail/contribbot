# Phase 3 Reference Projects

## Status

Active Design. This note records the reference set for the first Phase 3
implementation pass.

## Goal

Phase 3 should start with a small, auditable patrol loop, not a generic agent
platform and not an agent team.

Core target:

```text
contribbot patrol owner/repo
```

Core loop:

```text
Observe -> Analyze -> Plan -> Act / Ask -> Learn
```

The useful references are the projects that clarify how to keep this loop small,
inspectable, and safe.

## Recommended Reference Set

### mini-swe-agent

Repository: <https://github.com/SWE-agent/mini-swe-agent>

Use it as the main simplicity reference.

What to borrow:

- keep the agent loop small enough to understand in one sitting;
- treat the language model as the center of the system, not the scaffold;
- keep execution history linear and easy to inspect;
- avoid building a framework before the loop proves useful.

What not to borrow directly:

- its bash-first execution model is useful for coding agents, but contribbot
  already has structured MCP tools;
- patrol should call contribbot tools first, not shell out for everything.

### SWE-agent

Repository: <https://github.com/SWE-agent/SWE-agent>

Use it as the GitHub-task reference.

What to borrow:

- the shape of a task that starts from GitHub context;
- the idea that an agent needs a trajectory, not just one prompt;
- the habit of producing concrete repo changes or task outcomes.

What not to borrow yet:

- full automatic code repair is too large for the first contribbot patrol;
- the first patrol agent should report, propose, and ask before public writes.

### OpenHands

Repository: <https://github.com/OpenHands/OpenHands>

Use it as the product-shape reference.

What to borrow:

- an agent should feel like a workspace around a task, not only a chat box;
- outputs should be durable artifacts: reports, diffs, linked tasks, and logs;
- the user should be able to see what happened and continue from there.

What not to borrow yet:

- contribbot does not need a heavy interactive IDE-style surface for the MVP;
- the first product surface can be a CLI command and a markdown report.

### Open SWE

Repository: <https://github.com/langchain-ai/open-swe>

Use it as the asynchronous engineering-agent reference.

What to borrow:

- task lifecycle design;
- separation between planning, execution, and review;
- the idea that GitHub can be the public coordination surface.

What not to borrow yet:

- async coding-agent infrastructure is a later phase;
- contribbot should first prove single-repo patrol before background workers.

### Hermes Agent

Repository: <https://github.com/NousResearch/hermes-agent>

Use it as the self-evolution and personal-assistant reference.

What to borrow:

- learning from repeated usage;
- turning experience into reusable routines or memory;
- making the assistant improve without requiring the user to restate everything.

How it maps to contribbot:

- personal memory becomes repository memory;
- self-evolution becomes reviewed knowledge proposals;
- learned routines should become repo-level conventions, not hidden behavior.

Important boundary:

- contribbot memory mutation should stay auditable;
- the agent may propose knowledge updates, but maintainers should apply them.

### LangMem and Letta

Repositories:

- <https://github.com/langchain-ai/langmem>
- <https://github.com/letta-ai/letta>

Use them as long-term memory references.

What to borrow:

- memory is not one thing;
- facts, preferences, procedures, and summaries should be treated differently;
- memory update needs a policy, not just a vector store.

What not to borrow yet:

- do not introduce a heavy memory platform before the patrol loop exists;
- the current `knowledge_propose_update` flow is enough for Phase 3A/3B.

### OpenAI Agents SDK and LangGraph

Repositories:

- <https://github.com/openai/openai-agents-python>
- <https://github.com/langchain-ai/langgraph>

Use them as later runtime references.

What to borrow:

- tool boundaries;
- guardrails;
- tracing;
- human-in-the-loop checkpoints;
- explicit workflow state when the patrol loop becomes more complex.

What not to borrow yet:

- do not start Phase 3 by committing to a full orchestration framework;
- hand-write the first patrol loop, then introduce framework support only if the
  loop becomes hard to maintain.

## MVP Decision

Do not build an agent team first.

Build one patrol agent:

```text
packages/mcp       TypeScript tools
packages/agent     Python patrol runtime
```

Mental model:

```text
TypeScript is the hands.
Python is the brain.
```

The first patrol runtime should:

- read repository state through existing contribbot MCP tools;
- write a patrol report;
- propose knowledge updates through the existing auditable knowledge workflow;
- optionally create or update local todos;
- ask before GitHub comments, issues, PRs, or other public writes;
- leave an inspectable trace for every run.

## Non-Goals For The First Pass

- no agent team;
- no scheduler;
- no autonomous GitHub writes;
- no automatic issue closing;
- no automatic PR creation;
- no reward or bounty automation;
- no vector database requirement;
- no hidden memory mutation.

## Next Implementation Step

Create the smallest useful command:

```bash
contribbot patrol owner/repo
```

The first version can be read-heavy:

1. load repo config;
2. gather dashboard, todos, upstream state, CI/security state, and knowledge;
3. generate a markdown patrol report;
4. list recommended actions by risk level;
5. create knowledge proposals for stable findings only after explicit approval.

That is enough to make Phase 3 real without pretending the whole agent platform
already exists.
