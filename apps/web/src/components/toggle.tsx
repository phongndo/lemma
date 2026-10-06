import type { ToggleProps } from "../ui/contracts.ts";

/** An on/off switch. A disabled one keeps showing its value; explain why in a `data-tip` on a wrapper. */
export function Toggle(props: ToggleProps) {
  return (
    <button
      class="switch"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  );
}
