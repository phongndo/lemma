from __future__ import annotations

import os
import random
import unittest

from tests.support.mux_harness import (
    LemmaServer,
    Pane,
    process_exists,
    wait_for_process_exit,
    wait_until,
)


class MuxStateMachineStressTest(unittest.TestCase):
    def test_deterministic_real_mux_operations_preserve_ownership(self) -> None:
        seed = int(os.environ.get("LEMMA_STRESS_SEED", "1369964835"), 0)
        operation_count = int(os.environ.get("LEMMA_STRESS_OPERATIONS", "64"), 0)
        randomizer = random.Random(seed)
        operations: list[str] = []
        server = LemmaServer.from_environment()
        self.addCleanup(server.close)
        session = server.create_session("state_machine")
        first = session.pane()
        panes: dict[int, Pane] = {first.process: first}
        all_processes = {first.process}

        try:
            for index in range(operation_count):
                choices = ["focus", "input", "resize", "detach"]
                if len(panes) < 8:
                    choices.extend(("split-right", "split-down"))
                if len(panes) > 1:
                    choices.extend(("close", "swap"))
                operation = randomizer.choice(choices)

                if operation.startswith("split"):
                    source = randomizer.choice(list(panes.values()))
                    created = (
                        source.split_right()
                        if operation == "split-right"
                        else source.split_down()
                    )
                    panes[created.process] = created
                    all_processes.add(created.process)
                    operations.append(
                        f"{index}: {operation} {source.process}->{created.process}"
                    )
                elif operation == "close":
                    closed = randomizer.choice(list(panes.values()))
                    closed.close()
                    panes.pop(closed.process)
                    operations.append(f"{index}: close {closed.process}")
                elif operation == "focus":
                    target = randomizer.choice(list(panes.values()))
                    target.focus()
                    operations.append(f"{index}: focus {target.process}")
                elif operation == "swap":
                    target = randomizer.choice(list(panes.values()))
                    target.focus()
                    direction = randomizer.choice("HJKL")
                    session.require_client().prefix(direction)
                    operations.append(f"{index}: swap {target.process} {direction}")
                elif operation == "resize":
                    columns, rows = randomizer.choice(((80, 24), (100, 30), (120, 40)))
                    session.require_client().resize(columns, rows)
                    server.wait_for_state(
                        session.name,
                        lambda state, c=columns, r=rows: (
                            state.columns == c and state.rows == r
                        ),
                        f"state-machine resize {columns}x{rows}",
                    )
                    operations.append(f"{index}: resize {columns}x{rows}")
                elif operation == "detach":
                    session.detach()
                    for process in panes:
                        if not process_exists(process):
                            raise AssertionError(f"pane {process} died while detached")
                    session.attach()
                    operations.append(f"{index}: detach/reattach")
                else:
                    operations.append(f"{index}: input")

                state = session.state()
                if state.panes != len(panes):
                    raise AssertionError(
                        f"listing has {state.panes} panes, model has {len(panes)}"
                    )
                if state.focused_pid not in panes:
                    raise AssertionError(f"focused pid {state.focused_pid} is not live")
                for process in panes:
                    if not process_exists(process):
                        raise AssertionError(f"modeled live pane {process} exited")
                # Tiny panes can scroll a transient marker out before the daemon presents a frame.
                # Use a durable shell-side acknowledgement while keeping the outer client flowing.
                acknowledgement = server.root / f"a{index}"
                client = session.require_client()
                client.send(f': >"$TMPDIR/a{index}"\r')

                def acknowledged() -> bool | None:
                    client.drain(0.002)
                    return True if acknowledgement.exists() else None

                wait_until(
                    f"state-machine input acknowledgement {index}",
                    acknowledged,
                    diagnostics=lambda: server.diagnostics(session.name),
                )

            session.detach()
            session.destroy()
            for process in all_processes:
                wait_for_process_exit(process, diagnostics=server.diagnostics)
        except BaseException as error:
            detail = (
                f"seed={seed} operation_count={operation_count}\n"
                f"operations:\n"
                + "\n".join(operations)
                + "\n\n"
                + server.diagnostics(session.name)
            )
            raise AssertionError(detail) from error


if __name__ == "__main__":
    unittest.main()
