"""Embed upstream Hermes AIAgent; exchange app tool calls over private stdio.

Hermes owns model calls, reasoning, retries and its tool loop. This adapter only
registers Marbles tools and forwards their execution to the app's Node process.
"""
import contextlib
import json
import logging
import os
import re
import sys
import threading
import uuid

PROTOCOL = "marbles-hermes-v1"
wire_out = sys.stdout
rpc_lock = threading.Lock()


def emit(message):
    wire_out.write(json.dumps({"protocol": PROTOCOL, **message}) + "\n")
    wire_out.flush()


def main():
    # Keep upstream startup/tool output off the protocol channel.
    with contextlib.redirect_stdout(sys.stderr):
        logging.disable(logging.WARNING)
        from run_agent import AIAgent
        from tools.registry import registry
        from toolsets import create_custom_toolset

        if "--check" in sys.argv:
            emit({"type": "checked", "runtime": "Hermes", "module": AIAgent.__module__})
            return

        payload = json.loads(sys.stdin.readline())
        definitions = payload.get("tools", [])
        agent_holder = {}

        def handler(name):
            def call(args, **_kwargs):
                # Hermes may execute independent tools on worker threads. A
                # lock serializes the pipe while Hermes retains loop ownership.
                with rpc_lock:
                    call_id = str(uuid.uuid4())
                    emit({"type": "tool", "id": call_id, "name": name, "input": args})
                    response = json.loads(sys.stdin.readline())
                    if response.get("id") != call_id:
                        raise RuntimeError("Mismatched Marbles tool receipt")
                    if response.get("terminal"):
                        agent_holder["agent"].interrupt(tool_reason="marbles_action_complete")
                    if response.get("error"):
                        return json.dumps({"error": response["error"]})
                    result = response.get("result")
                    return result if isinstance(result, str) else json.dumps(result)
            return call

        names = []
        for tool in definitions:
            name = tool["name"]
            names.append(name)
            registry.register(name=name, toolset="marbles", check_fn=lambda: True,
                schema={"name": name, "description": tool["description"], "parameters": tool["input_schema"]},
                handler=handler(name), execution_timeout=45)
        create_custom_toolset("marbles", "Marbles app coordination tools", tools=names)

        agent = AIAgent(model=payload["model"], provider="anthropic", api_mode="anthropic_messages",
            api_key=os.environ["ANTHROPIC_API_KEY"], base_url="https://api.anthropic.com",
            enabled_toolsets=["marbles"], max_iterations=payload.get("maxIterations", 8), max_tokens=payload.get("maxTokens", 6000),
            # Adaptive thinking: the model decides how much to reason before it acts.
            # Effort is the dial (low / medium / high); thinking shares max_tokens.
            reasoning_config={"enabled": True, "effort": payload.get("effort", "medium")}, run_budget_seconds=payload.get("budgetSeconds", 55),
            quiet_mode=True, verbose_logging=False, save_trajectories=False,
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            cwd=payload.get("cwd"))
        agent_holder["agent"] = agent
        actual = {(tool.get("function") or {}).get("name") for tool in agent.tools}
        if actual != set(names):
            raise RuntimeError(f"Hermes tool surface mismatch: missing={sorted(set(names) - actual)}, extra={sorted(actual - set(names))}")
        emit({"type": "ready", "runtime": "Hermes", "module": AIAgent.__module__, "model": payload["model"], "tools": sorted(actual)})
        try:
            result = agent.run_conversation(payload["query"], system_message=payload["system"],
                conversation_history=payload.get("history") or None)
            emit({"type": "result", "reply": result.get("final_response", ""), "completed": bool(result.get("completed")),
                  "interrupted": bool(result.get("interrupted")), "apiCalls": result.get("api_calls", 0)})
        finally:
            cleanup = getattr(agent, "close", None)
            if callable(cleanup):
                cleanup()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Provider exceptions can include headers/request data. Do not print them.
        detail = str(error)
        key = os.environ.get("ANTHROPIC_API_KEY")
        if key:
            detail = detail.replace(key, "[redacted]")
        detail = re.sub(r"sk-[\w-]+|Bearer\s+\S+", "[redacted]", detail)
        emit({"type": "error", "errorType": type(error).__name__, "message": f"Hermes runtime failed ({type(error).__name__}): {detail[:300]}"})
        sys.exit(1)
