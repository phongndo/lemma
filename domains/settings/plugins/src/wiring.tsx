import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { RUNTIME_LABEL, capabilityName, pluginWiring } from "@lemma/contracts";
import type { PluginStatus } from "@lemma/contracts";
import { plural } from "@lemma/web/format";
import { Links, PluginLink } from "./inspector.tsx";
import type { Inspector } from "./inspector.tsx";
import type { PluginKind } from "./plugins.ts";

/** One of the five shapes a plugin meets the others in: its list, or what it says when the plugin has none. */
function WiringSection(props: { title: string; shown: boolean; none: string; children: JSX.Element }) {
  return (
    <section>
      <h3>{props.title}</h3>
      <Show when={props.shown} fallback={<p class="muted small">{props.none}</p>}>
        <ul>{props.children}</ul>
      </Show>
    </section>
  );
}

/**
 * How a plugin meets the others, in the five shapes every domain's contract offers: what it adds to registries and
 * slots, the hooks it intercepts, the events it observes, the capabilities it calls, and what it serves (capabilities,
 * and channels to clients).
 */
export function Wiring(props: { inspector: Inspector; kind: PluginKind; plugin: PluginStatus }) {
  const { inspector } = props;
  const wiring = createMemo(() => {
    const service = inspector.services[props.kind];
    return pluginWiring(service.list(), props.plugin, service.runtime());
  });
  return (
    <div class="inspector-wiring">
      <WiringSection title="Adds" shown={wiring().adds.length > 0} none="Nothing to a registry or slot.">
        <For each={wiring().adds}>
          {(registry) => (
            <li>
              <span class="capability">{registry.name}</span>
              <span class="muted"> {registry.keys?.join(", ") ?? plural(registry.items, "item")}</span>
            </li>
          )}
        </For>
      </WiringSection>
      <WiringSection title="Intercepts" shown={wiring().hooks.length > 0 || wiring().parts.length > 0} none="No hook or part.">
        <For each={wiring().parts}>
          {(part) => (
            <li>
              <span class="capability">{part.name}</span>
              <span class="muted"> draws it: {part.keys?.join(", ") ?? plural(part.items, "item")}</span>
            </li>
          )}
        </For>
        <For each={wiring().hooks}>
          {(hook) => (
            <li>
              <span class="capability">{hook.name}</span>
              <span class="muted">
                {" "}
                {hook.phase === undefined ? "" : `${hook.phase} · `}order {hook.order} · {hook.of > 1 ? `${hook.position} of ${hook.of}` : "only handler"}
              </span>
            </li>
          )}
        </For>
      </WiringSection>
      <WiringSection title="Observes" shown={wiring().observes.length > 0} none="No event.">
        <For each={wiring().observes}>{(event) => <li class="capability">{event}</li>}</For>
      </WiringSection>
      <WiringSection title="Calls" shown={wiring().calls.length > 0} none="No capability.">
        <For each={wiring().calls}>
          {(call) => (
            <li>
              <span class="capability" data-tip={call.key}>
                {capabilityName(call.key)}
              </span>
              <span class="muted"> from </span>
              <Show when={call.providers[0]} fallback={<span class="muted">{call.runtime ? RUNTIME_LABEL[props.kind] : "no plugin"}</span>}>
                {(provider) => <PluginLink inspector={inspector} kind={props.kind} id={provider().id} />}
              </Show>
            </li>
          )}
        </For>
      </WiringSection>
      <WiringSection title="Serves" shown={wiring().serves.length > 0 || wiring().channels.length > 0} none="Nothing; other plugins do not call it.">
        <For each={wiring().serves}>
          {(serve) => (
            <li>
              <span class="capability" data-tip={serve.key}>
                {capabilityName(serve.key)}
              </span>
              <span class="muted"> used by </span>
              <Links inspector={inspector} kind={props.kind} ids={serve.users} none="no plugin" />
            </li>
          )}
        </For>
        <Show when={wiring().channels.length > 0}>
          <li>
            <span class="capability">channels</span>
            <span class="muted"> {wiring().channels.join(", ")}</span>
          </li>
        </Show>
      </WiringSection>
    </div>
  );
}
