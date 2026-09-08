from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from tests.support.mux_harness import LemmaServer, SessionState, wait_until

CONFIG = r"""
local lemma = require("lemma")
local function register(name, handler, timeout)
  lemma.command.register("test." .. name, {
    description = name, handler = handler, timeout_ms = timeout or 5000,
  })
end
local function rename(ctx, title)
  return ctx:proc({commands={{command="tab.rename", session={id=ctx.session},
                             tab={id=ctx.tab}, title=title}}})
end
register("rename", function(ctx, args)
  assert(#args == 1)
  local result = rename(ctx, args[1])
  assert(result.schema == "lemma.proc-result/v1" and result.ok)
  assert(result.results[1].result.status == "applied")
  local inspected = ctx:proc({commands={{command="pane.inspect", session={id=ctx.session},
                                       pane={id=ctx.pane}}}})
  assert(inspected.ok)
end)
register("sequence", function(ctx)
  local result = ctx:proc({commands={
    {id="created", command="tab.new", session={id=ctx.session}, title="created"},
    {command="tab.rename", session={id=ctx.session}, tab={result="created"}, title="referenced"},
  }})
  assert(result.ok and #result.results == 2)
  assert(rename(ctx, "original").ok)
end)
register("invalid", function(ctx)
  local result = ctx:proc({commands={
    {command="tab.new", session={id=ctx.session}, title="must-not-execute"},
    {command="not.a.native.command"},
  }})
  assert(not result.ok)
  assert(rename(ctx, "rejected").ok)
end)
register("wait", function(ctx)
  local result = ctx:proc({commands={
    {command="tab.rename", session={id=ctx.session}, tab={id=ctx.tab}, title="waiting"},
    {command="pane.wait", session={id=ctx.session}, pane={id=ctx.pane},
     contains="__EXTENSION_RELEASE__", timeout_ms=4000},
    {command="tab.new", session={id=ctx.session}, title="after-wait"},
  }})
  assert(result.ok)
end)
register("captured", function(ctx)
  local result = ctx:proc({commands={
    {command="tab.rename", session={id=ctx.session}, tab={id=ctx.tab}, title="captured-wait"},
    {command="pane.wait", session={id=ctx.session}, pane={id=ctx.pane},
     contains="__EXTENSION_RELEASE__", timeout_ms=4000},
  }})
  assert(result.ok)
  assert(rename(ctx, "captured-finished").ok)
end)
register("stale", function(ctx, args)
  ctx:proc({commands={
    {command="tab.rename", session={id=ctx.session}, tab={id=ctx.tab}, title="stale-wait"},
    {command="pane.wait", session={id=ctx.session}, pane={id=args[1]},
     contains="__EXTENSION_RELEASE__", timeout_ms=4000},
  }})
  local result = ctx:proc({commands={{command="pane.input", session={id=ctx.session},
    pane={id=ctx.pane}, events={{kind="text", text="MUST_NOT_REACH_REPLACEMENT"}}}}})
  assert(not result.ok and result.results[1].result.status == "stale")
  assert(rename(ctx, "stale-rejected").ok)
end)
register("invalid-yield", function() local cycle = {}; cycle.self = cycle; coroutine.yield(cycle) end)
register("crash", function() os.exit(0) end)
register("loop", function() while true do end end)
register("block", function()
  local entered = assert(io.open(os.getenv("HOME") .. "/extension-entered", "w"))
  entered:write("entered")
  entered:close()
  io.open(os.getenv("HOME") .. "/extension-fifo", "r")
end, 1500)
"""


class ExtensionMuxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LemmaServer.from_environment(config_text=CONFIG)
        self.addCleanup(self.server.close)
        self.session = self.server.create_session("extensions")
        self.client = self.session.require_client()

    def invoke(self, command: str) -> None:
        self.client.prefix(":")
        self.client.send(command + "\r")

    def titles(self) -> list[str]:
        result = self.server.require_command(
            "proc", "tab", "list", "--session", self.session.name
        )
        return [
            tab["title"]
            for tab in json.loads(result.output)["results"][0]["result"]["tabs"]
        ]

    def title(self, title: str) -> SessionState:
        return self.server.wait_for_state(
            self.session.name,
            lambda _state: title in self.titles(),
            f"extension command to publish title {title!r}",
        )

    def release(self, pane: str) -> None:
        self.server.require_command(
            "proc",
            "pane",
            "input",
            "--session",
            self.session.name,
            "--pane",
            pane,
            "--paste",
            "printf '__EXTENSION_RELEASE__\\n'",
            "--key",
            "enter",
        )

    def test_completion_literal_arguments_and_coroutine_results(self) -> None:
        self.client.prefix(":")
        self.client.send("test.ren\t")
        self.client.expect_output("test.rename")
        self.client.send("'two words'\r")
        self.title("two words")
        # A second invocation runs after the first coroutine receives its Proc results.
        self.invoke("test.rename '$HOME'")
        self.title("$HOME")
        self.assertNotIn("Error:", self.client.screen_text())

    def test_ordered_backward_references_and_a_second_proc(self) -> None:
        self.invoke("test.sequence")
        state = self.title("original")
        self.assertEqual(state.tabs, 2)
        self.assertIn("referenced", self.titles())

    def test_invalid_proc_does_not_execute_its_valid_prefix(self) -> None:
        self.invoke("test.invalid")
        self.assertEqual(self.title("rejected").tabs, 1)

    def test_waiting_callback_does_not_block_other_callbacks_or_terminal_input(
        self,
    ) -> None:
        pane = self.session.state().focused_pane
        self.invoke("test.wait")
        self.title("waiting")
        self.invoke("test.rename 'still responsive'")
        self.title("still responsive")
        self.client.send("printf '__NATIVE_INPUT_PROGRESS__\\n'\r")
        self.client.expect_output("__NATIVE_INPUT_PROGRESS__")
        self.release(pane)
        self.assertEqual(self.title("after-wait").tabs, 2)

    def test_detach_cancels_remaining_proc_commands_before_reattachment(self) -> None:
        pane = self.session.state().focused_pane
        self.invoke("test.wait")
        self.title("waiting")
        self.session.detach()
        self.release(pane)
        self.client = self.session.attach()
        self.invoke("test.rename 'reattached'")
        self.assertEqual(self.title("reattached").tabs, 1)

    def test_invocation_keeps_original_targets_when_focus_changes(self) -> None:
        pane = self.session.state().focused_pane
        self.invoke("test.captured")
        self.title("captured-wait")
        self.server.require_command(
            "proc", "tab", "new", "--session", self.session.name, "--title", "other"
        )
        self.release(pane)
        state = self.title("captured-finished")
        self.assertIn("other", self.titles())
        self.assertEqual(state.tabs, 2)

    def test_stale_pane_generation_cannot_address_a_replacement(self) -> None:
        original = self.session.state().focused_pane
        self.server.require_command(
            "proc",
            "pane",
            "split",
            "--session",
            self.session.name,
            "--pane",
            original,
            "--right",
            "--focus",
            "preserve",
        )
        gate = next(
            pane.id for pane in self.session.state().pane_states if pane.id != original
        )
        self.invoke(f"test.stale {gate}")
        self.title("stale-wait")
        self.server.require_command(
            "proc", "pane", "kill", "--session", self.session.name, "--pane", original
        )
        self.server.require_command(
            "proc",
            "pane",
            "split",
            "--session",
            self.session.name,
            "--pane",
            gate,
            "--right",
            "--focus",
            "preserve",
        )
        replacement = next(
            pane.id for pane in self.session.state().pane_states if pane.id != gate
        )
        self.assertEqual(original.split(":")[0], replacement.split(":")[0])
        self.assertNotEqual(original, replacement)
        self.release(gate)
        self.title("stale-rejected")

    def test_session_switch_cancels_source_invocation(self) -> None:
        # Force the switch redraw to need ongoing PTY reads on Linux too; Darwin can
        # exhaust its output queue at the default geometry. Polling the destination
        # must keep draining the client that was originally attached to the source.
        self.client.resize(300, 150)
        self.server.wait_for_state(
            self.session.name,
            lambda state: (state.columns, state.rows) == (300, 150),
            "large viewport before switching sessions",
        )
        source = self.session
        pane = source.state().focused_pane
        target = self.server.create_session("destination", attach=False)
        self.invoke("test.wait")
        self.title("waiting")
        self.invoke("switch destination")
        self.server.wait_for_state(
            source.name, lambda state: not state.attached, "source to detach"
        )
        self.release(pane)
        self.session = target
        self.invoke("test.rename destination-ready")
        self.title("destination-ready")
        self.assertEqual(source.state().tabs, 1)

    def test_invalid_yield_is_bounded_and_other_commands_recover(self) -> None:
        self.invoke("test.invalid-yield")
        self.client.expect_output("invalid extension yield")
        self.invoke("test.rename recovered")
        self.title("recovered")

    def test_host_crash_preserves_panes_and_removes_command_discovery(self) -> None:
        self.invoke("test.crash")
        self.client.expect_output("Extension host unavailable")
        self.invoke("test.rename unused")
        self.client.expect_output("Error: Unknown command")
        self.client.send("printf '__AFTER_HOST_CRASH__\\n'\r")
        self.client.expect_output("__AFTER_HOST_CRASH__")
        self.assertEqual(self.session.state().panes, 1)

    def test_instruction_budget_failure_does_not_disable_other_commands(self) -> None:
        self.invoke("test.loop")
        self.client.expect_output("instruction budget exceeded")
        self.invoke("test.rename recovered")
        self.title("recovered")

    def test_detach_does_not_remove_a_blocked_hosts_watchdog(self) -> None:
        os.mkfifo(Path(self.server.environment["HOME"]) / "extension-fifo")
        self.invoke("test.block")
        marker = Path(self.server.environment["HOME"]) / "extension-entered"
        wait_until(
            "blocking callback to start", lambda: True if marker.exists() else None
        )
        self.session.detach()
        self.client = self.session.attach()
        self.invoke("test.rename must-not-run")
        self.client.expect_output("Extension command timed out")
        self.assertNotIn("must-not-run", self.titles())

    def test_blocking_native_callback_isolated_and_terminated_by_deadline(self) -> None:
        os.mkfifo(Path(self.server.environment["HOME"]) / "extension-fifo")
        self.invoke("test.block")
        marker = Path(self.server.environment["HOME"]) / "extension-entered"
        wait_until(
            "blocking callback to start", lambda: True if marker.exists() else None
        )
        self.client.send("printf '__WHILE_HOST_BLOCKED__\\n'\r")
        self.client.expect_output("__WHILE_HOST_BLOCKED__")
        self.client.expect_output("Extension command timed out")
        self.invoke("test.rename unused")
        self.client.expect_output("Error: Unknown command")


if __name__ == "__main__":
    unittest.main()
