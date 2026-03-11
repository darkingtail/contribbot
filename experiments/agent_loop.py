"""
Minimal agent loop experiment: Python calls LLM CLI as backend.

Supports two backends:
- gemini: `gemini -p "" -o json` (stdin pipe)
- claude: `claude -p --output-format json` (stdin pipe)

Goal: verify that we can build an agent loop where:
1. Python sends a prompt with tool definitions to LLM CLI
2. LLM decides which tool to call
3. Python executes the tool and feeds results back
4. Loop until done
"""

import json
import subprocess
import sys
import tempfile
import os


# ── Fake tools (simulating contribbot core) ──────────────

TOOLS = {
    "get_time": {
        "description": "Get current date and time",
        "params": {},
        "fn": lambda _: __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    },
    "list_repos": {
        "description": "List tracked open-source projects",
        "params": {},
        "fn": lambda _: json.dumps(["antdv-next/antdv-next", "vuejs/core", "vitejs/vite"]),
    },
    "get_todo_count": {
        "description": "Get number of open todos for a repo",
        "params": {"repo": "string"},
        "fn": lambda args: json.dumps({"repo": args.get("repo", "unknown"), "open": 5, "done": 12}),
    },
}


def build_system_prompt():
    tool_desc = []
    for name, tool in TOOLS.items():
        params_str = json.dumps(tool["params"]) if tool["params"] else "none"
        tool_desc.append(f"- {name}: {tool['description']} (params: {params_str})")

    return f"""You are an open-source contribution assistant.
You have access to these tools:
{chr(10).join(tool_desc)}

To call a tool, respond with EXACTLY this JSON format (nothing else):
{{"tool": "tool_name", "args": {{"param": "value"}}}}

To give a final answer (no more tool calls), respond with:
{{"answer": "your final answer"}}

Always respond with valid JSON only. No markdown, no explanation outside JSON."""


# ── LLM Backends ──────────────────────────────────────────


def call_gemini(prompt):
    """Call gemini CLI in headless mode, return response text."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(prompt)
        tmp_path = f.name

    try:
        result = subprocess.run(
            f'type "{tmp_path}" | gemini -p "" -o json',
            capture_output=True,
            text=True,
            timeout=60,
            shell=True,
        )
        if result.returncode != 0:
            print(f"gemini error: {result.stderr}", file=sys.stderr)
            return None

        data = json.loads(result.stdout)
        return data.get("response", "")
    finally:
        os.unlink(tmp_path)


def call_claude(prompt):
    """Call claude CLI in print mode, return response text."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(prompt)
        tmp_path = f.name

    try:
        result = subprocess.run(
            f'type "{tmp_path}" | claude -p --output-format json --model haiku --no-session-persistence',
            capture_output=True,
            text=True,
            timeout=120,
            shell=True,
        )
        if result.returncode != 0:
            print(f"claude error: {result.stderr}", file=sys.stderr)
            return None

        data = json.loads(result.stdout)
        # claude JSON output has a "result" field with the text
        return data.get("result", "")
    except json.JSONDecodeError:
        # Fallback: might be plain text
        return result.stdout.strip()
    finally:
        os.unlink(tmp_path)


BACKENDS = {
    "gemini": call_gemini,
    "claude": call_claude,
}


def extract_json(text):
    """Extract JSON from response text (handles markdown code blocks)."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.startswith("```")]
        text = "\n".join(lines).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def agent_loop(user_task, backend="gemini", max_turns=5):
    """Run the agent loop: prompt → LLM → tool call → repeat."""
    if backend not in BACKENDS:
        print(f"Unknown backend: {backend}. Available: {', '.join(BACKENDS.keys())}")
        return None

    call_llm = BACKENDS[backend]
    system = build_system_prompt()
    history = []

    prompt = f"{system}\n\nUser task: {user_task}"
    print(f"\n{'='*50}")
    print(f"Task: {user_task}")
    print(f"Backend: {backend}")
    print(f"{'='*50}\n")

    for turn in range(max_turns):
        print(f"--- Turn {turn + 1} ---")

        if history:
            prompt = f"{system}\n\nUser task: {user_task}\n\nPrevious tool calls:\n"
            for h in history:
                prompt += f"- Called {h['tool']}({h['args']}) → {h['result']}\n"
            prompt += "\nWhat's next? Respond with a tool call or final answer."

        print(f"Calling {backend}...")
        response = call_llm(prompt)
        if not response:
            print("No response from LLM")
            break

        print(f"Response: {response[:200]}")

        parsed = extract_json(response)
        if not parsed:
            print(f"Could not parse JSON, raw: {response}")
            break

        if "answer" in parsed:
            print(f"\n{'='*50}")
            print(f"Final Answer: {parsed['answer']}")
            print(f"{'='*50}")
            return parsed["answer"]

        if "tool" in parsed:
            tool_name = parsed["tool"]
            tool_args = parsed.get("args", {})
            print(f"Tool call: {tool_name}({tool_args})")

            if tool_name not in TOOLS:
                print(f"Unknown tool: {tool_name}")
                history.append({"tool": tool_name, "args": tool_args, "result": f"Error: unknown tool '{tool_name}'"})
                continue

            result = TOOLS[tool_name]["fn"](tool_args)
            print(f"Result: {result}")
            history.append({"tool": tool_name, "args": tool_args, "result": result})
        else:
            print(f"Unexpected response format: {parsed}")
            break

    print("Max turns reached")
    return None


if __name__ == "__main__":
    # Usage: python agent_loop.py [backend] [task]
    # Defaults: backend=gemini, task=中文测试任务
    backend = sys.argv[1] if len(sys.argv) > 1 else "gemini"
    task = sys.argv[2] if len(sys.argv) > 2 else "现在几点了？然后告诉我 antdv-next/antdv-next 有多少待办"
    agent_loop(task, backend=backend)
