import { For, Show, createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type { PermissionChoice, PermissionRequest } from "@lemma/agent/acp";
import type { ComposerTakeover } from "@lemma/threads";
import { AlertIcon } from "@lemma/look";
import { changeLines } from "./diff.ts";

/** What a request is about, as its heading names it. */
const LABELS: Readonly<Record<string, string>> = {
  execute: "Command approval",
  edit: "File change approval",
  delete: "File deletion approval",
  move: "File move approval",
  read: "File read approval",
  fetch: "Web access approval",
};
export const labelOf = (request: PermissionRequest): string => LABELS[request.kind ?? ""] ?? "Permission request";

const choiceOf = (request: PermissionRequest, ...kinds: PermissionChoice["kind"][]) =>
  kinds.map((kind) => request.choices.find((choice) => choice.kind === kind)).find((choice) => choice !== undefined);

/** What the request does: its command, its changes, the files it touches, or its raw input. */
function RequestDetail(props: { request: PermissionRequest }) {
  return (
    <>
      <Show when={props.request.command}>
        {(command) => (
          <pre class="approval-detail" aria-label="Command" tabIndex={0}>
            <span class="approval-prompt">$ </span>
            {command()}
          </pre>
        )}
      </Show>
      <For each={props.request.diffs}>
        {(diff) => (
          <div class="approval-diff" aria-label={`Change to ${diff.path}`}>
            <div class="approval-path">{diff.path}</div>
            <pre class="approval-detail" tabIndex={0}>
              <For each={changeLines(diff.oldText, diff.newText)}>
                {(line) => (
                  <span class="approval-line" data-kind={line.kind}>
                    {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : line.kind === "skipped" ? "⋯ " : "  "}
                    {line.text}
                    {"\n"}
                  </span>
                )}
              </For>
            </pre>
          </div>
        )}
      </For>
      <Show when={props.request.command === undefined && props.request.diffs.length === 0 && props.request.paths.length > 0}>
        <pre class="approval-detail">{props.request.paths.join("\n")}</pre>
      </Show>
      <Show when={props.request.input}>{(input) => <pre class="approval-detail">{input()}</pre>}</Show>
    </>
  );
}

/**
 * The open thread's permission requests, in place of the composer, as a coding agent asks them: what it wants to do
 * (the command, the changes), Approve as the send button, and Decline and the agent's other choices beside it. The
 * person keeps the box while they have a prompt of their own unsent, and is told the agent waits.
 */
export function approvalTakeover(deps: {
  readonly requests: Accessor<readonly PermissionRequest[]>;
  readonly activeId: Accessor<string | undefined>;
  readonly respond: (request: PermissionRequest, choice: PermissionChoice) => void;
}): ComposerTakeover {
  const mine = createMemo(() => deps.requests().filter((request) => request.sessionId === deps.activeId()));
  const current = () => mine()[0];
  const answer = (...kinds: PermissionChoice["kind"][]) => {
    const request = current();
    const choice = request === undefined ? undefined : choiceOf(request, ...kinds);
    if (request !== undefined && choice !== undefined) deps.respond(request, choice);
  };
  return {
    sessionId: () => current()?.sessionId,
    key: () => current()?.id ?? "",
    banner: () => (
      <Show when={current()} keyed>
        {(request) => (
          <div class="approval" role="group" aria-label={labelOf(request)}>
            <div class="approval-head">
              <AlertIcon />
              <span class="approval-label">{labelOf(request)}</span>
              <span class="approval-agent">{request.agentTitle}</span>
              <Show when={mine().length > 1}>
                <span class="approval-count">1/{mine().length}</span>
              </Show>
            </div>
            {/* An agent that names a command by itself says it once. */}
            <Show when={request.title !== request.command}>
              <div class="approval-title">{request.title}</div>
            </Show>
            <RequestDetail request={request} />
            <div class="approval-actions">
              <Show when={choiceOf(request, "reject_once", "reject_always")}>
                {(choice) => (
                  <button type="button" class="button small" onClick={() => deps.respond(request, choice())}>
                    Decline
                  </button>
                )}
              </Show>
              <Show when={choiceOf(request, "allow_always")}>
                {(choice) => (
                  <button
                    type="button"
                    class="button small"
                    title="The agent stops asking for calls like this one"
                    onClick={() => deps.respond(request, choice())}
                  >
                    {choice().name}
                  </button>
                )}
              </Show>
              <Show when={choiceOf(request, "reject_always") !== undefined && choiceOf(request, "reject_once") !== undefined}>
                <button type="button" class="button small" onClick={() => answer("reject_always")}>
                  {choiceOf(request, "reject_always")!.name}
                </button>
              </Show>
              <span class="approval-hint">Enter approves</span>
            </div>
          </div>
        )}
      </Show>
    ),
    waiting: (props) => (
      <Show when={current()}>
        {(request) => (
          <div class="approval-waiting" role="status">
            <AlertIcon />
            <span>
              {request().agentTitle} is waiting for approval: {request().title}
            </span>
            <span class="spacer" />
            <button type="button" class="button small" onClick={() => props.take()}>
              Review
            </button>
          </div>
        )}
      </Show>
    ),
    text: () => "",
    setText: () => {},
    placeholder: () => "Approve or decline to let the agent go on",
    readOnly: () => true,
    submit: () => answer("allow_once", "allow_always"),
    submitLabel: () => "Approve",
    canSubmit: () => {
      const request = current();
      return request !== undefined && choiceOf(request, "allow_once", "allow_always") !== undefined;
    },
  };
}
