import type { SearchFieldProps } from "@lemma/look";
import { SearchIcon } from "@lemma/look";

/**
 * A page's search: an underlined field with an icon, then the page's own
 * controls (a filter menu, a count). Escape with text in it clears it, and
 * goes no further, so it does not also close the page.
 */
export function SearchField(props: SearchFieldProps) {
  return (
    <div class="search-field">
      <label class="search-field-input">
        <SearchIcon />
        <input
          ref={(input) => props.ref?.(input)}
          type="search"
          placeholder={props.placeholder}
          aria-label={props.label}
          autocomplete="off"
          spellcheck={false}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && props.value !== "") {
              event.preventDefault();
              event.stopPropagation();
              props.onInput("");
              return;
            }
            props.onKeyDown?.(event);
          }}
        />
      </label>
      {props.children}
    </div>
  );
}
