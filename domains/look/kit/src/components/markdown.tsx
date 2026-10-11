import { createEffect, createRoot, getOwner, onCleanup, runWithOwner, useContext } from "solid-js";
import type { JSX, Owner } from "solid-js";
import { copyText } from "@lemma/ui/clipboard";
import { codePlaces, createBlockLexer } from "@lemma/look";
import type { CodeBlock, MarkdownBlock } from "@lemma/look";
import { CodeBlocks } from "@lemma/look";
import type { CodeBlockRenderer, MarkdownProps } from "@lemma/look";
import { CheckIcon, CodeIcon, CopyIcon, ImageIcon, XIcon } from "@lemma/look";
import { SlotsContext } from "@lemma/ui";

/**
 * Builds code blocks as plain DOM, outside Solid's tree, for the markdown
 * that `owner` belongs to. Each icon renders in its own root under it, so it
 * is the icon part's (following a replacement) and is released when its
 * button changes icon or its block is removed.
 */
const codeBlocks = (owner: Owner | null) => {
  const icon = (Icon: () => JSX.Element) =>
    runWithOwner(owner, () =>
      createRoot((release) => {
        const fragment = document.createDocumentFragment();
        const append = (value: unknown): void => {
          if (value instanceof Node) fragment.append(value);
          else if (typeof value === "function") append((value as () => unknown)());
          else if (Array.isArray(value)) value.forEach(append);
        };
        append(Icon());
        return { fragment, release };
      }),
    )!;

  /** A fenced code block: the code as text, a copy button, and whatever the first matching renderer makes of it; `release` frees its icons. */
  const codeBlock = (block: CodeBlock, renderers: readonly CodeBlockRenderer[]): { readonly node: HTMLElement; readonly release: () => void } => {
    const icons = new Map<HTMLButtonElement, () => void>();
    let released = false;

    /** Sets an icon button's icon and the name its tooltip and screen readers give. */
    const label = (element: HTMLButtonElement, name: string, Icon: () => JSX.Element): void => {
      if (released) return;
      icons.get(element)?.();
      const made = icon(Icon);
      icons.set(element, made.release);
      element.setAttribute("aria-label", name);
      element.dataset.tip = name;
      element.replaceChildren(made.fragment);
    };

    const button = (name: string, Icon: () => JSX.Element, className: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = className;
      label(element, name, Icon);
      element.addEventListener("click", () => onClick(element));
      return element;
    };

    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = block.code;
    pre.append(code);
    const tools = document.createElement("div");
    tools.className = "code-tools";
    if (block.lang !== "") {
      const lang = document.createElement("span");
      lang.className = "code-lang";
      lang.textContent = block.lang;
      tools.append(lang);
    }
    tools.append(
      button("Copy code", CopyIcon, "copy-code", (element) => {
        void copyText(block.code).then((ok) => {
          if (ok) label(element, "Copied", CheckIcon);
          else label(element, "Copy failed", XIcon);
          setTimeout(() => label(element, "Copy code", CopyIcon), 1200);
        });
      }),
    );
    wrap.append(pre, tools);

    // The first matching renderer fills the block: in place of the code, or for a preview, beside it behind a toggle.
    const renderer = renderers.find((candidate) => candidate.match(block.lang));
    if (renderer !== undefined) {
      const target = document.createElement("div");
      target.className = renderer.preview ? "code-preview" : "code-render";
      const show = () => {
        if (released || !target.hasChildNodes()) return;
        if (!renderer.preview) return pre.replaceWith(target);
        pre.hidden = true;
        wrap.insertBefore(target, pre);
        // Beside the copy button: the language label stays first, the buttons together after it.
        tools.insertBefore(
          button("Show source", CodeIcon, "code-toggle", (toggle) => {
            const source = !target.hidden;
            target.hidden = source;
            pre.hidden = !source;
            if (source) label(toggle, "Show preview", ImageIcon);
            else label(toggle, "Show source", CodeIcon);
          }),
          tools.querySelector(".copy-code"),
        );
      };
      const fail = (error: unknown) => {
        const note = document.createElement("span");
        note.className = "code-error";
        note.textContent = "Not rendered";
        note.dataset.tip = error instanceof Error ? error.message : String(error);
        tools.prepend(note);
      };
      try {
        const pending = renderer.render(block, target);
        if (pending === undefined) show();
        else pending.then(show, fail);
      } catch (error) {
        fail(error);
      }
    }
    return {
      node: wrap,
      release: () => {
        released = true;
        for (const release of icons.values()) release();
        icons.clear();
      },
    };
  };
  return codeBlock;
};

/** While streaming, code whose fence has not closed is incomplete; afterwards every block is whole. */
const settled = (block: MarkdownBlock): MarkdownBlock => {
  if (block.kind === "code") return block.complete ? block : { ...block, complete: true, key: `c${block.key.slice(1)}` };
  if (block.code.every((code) => code.complete)) return block;
  return { ...block, key: `${block.key}\u0000complete`, code: block.code.map((code) => ({ ...code, complete: true })) };
};

/**
 * The default `markdown` part: sanitized markdown. Fenced code renders
 * through the `markdown.code` slot's renderers and has a copy button. Blocks whose source is
 * unchanged keep their DOM, so a streaming message re-renders only its tail
 * and a selection in earlier text survives. While `streaming`, a code block
 * whose fence has not closed is incomplete; afterwards every block is whole.
 */
export function Markdown(props: MarkdownProps) {
  let el!: HTMLDivElement;
  const slots = useContext(SlotsContext);
  const codeBlock = codeBlocks(getOwner());
  const lex = createBlockLexer();
  let mounted: { readonly key: string; readonly nodes: readonly ChildNode[]; readonly release: () => void }[] = [];
  let renderedWith: readonly CodeBlockRenderer[] = [];
  const unmount = (blocks: typeof mounted) => {
    for (const block of blocks) {
      block.release();
      for (const node of block.nodes) node.remove();
    }
  };
  onCleanup(() => {
    for (const block of mounted) block.release();
  });
  createEffect(() => {
    const renderers = slots()?.list(CodeBlocks) ?? [];
    const streaming = props.streaming === true;
    // A renderer added or removed changes how code looks: render every block again.
    const same = renderers.length === renderedWith.length && renderers.every((renderer, index) => renderer === renderedWith[index]);
    if (!same) renderedWith = renderers;
    const lexed = lex(props.text);
    const blocks = streaming ? lexed : lexed.map(settled);
    let kept = 0;
    if (same) while (kept < mounted.length && kept < blocks.length && mounted[kept]!.key === blocks[kept]!.key) kept++;
    unmount(mounted.splice(kept));
    for (const block of blocks.slice(kept)) {
      if (block.kind === "code") {
        const { node, release } = codeBlock(block, renderers);
        mounted.push({ key: block.key, nodes: [node], release });
        el.append(node);
        continue;
      }
      const template = document.createElement("template");
      template.innerHTML = block.html();
      const releases: (() => void)[] = [];
      for (const [place, index] of codePlaces(template.content)) {
        const code = block.code[index];
        if (code === undefined) continue;
        const { node, release } = codeBlock(code, renderers);
        place.replaceWith(node);
        releases.push(release);
      }
      mounted.push({ key: block.key, nodes: [...template.content.childNodes], release: () => releases.forEach((release) => release()) });
      el.append(template.content);
    }
  });
  return <div ref={el} class={`md ${props.class ?? ""}`} />;
}
