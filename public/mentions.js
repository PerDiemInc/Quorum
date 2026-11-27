import { mentionAt, suggestMentions } from "/engine.js";

/**
 * "@" autocomplete for a text box: arrows choose, Enter or Tab insert, Escape closes.
 * @param {object} options
 * @param {HTMLTextAreaElement} options.input
 * @param {HTMLElement} options.list the element that shows the suggestions
 * @param {() => Array<{name: string}>} options.people who can be tagged right now
 * @param {(person: any) => HTMLElement[]} options.show the contents of one suggestion
 */
export function createMentions({ input, list, people, show }) {
  let matches = [],
    active = 0,
    tag = null;
  const close = () => {
    matches = [];
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  function highlight(index) {
    active = (index + matches.length) % matches.length;
    [...list.children].forEach((item, i) => {
      item.setAttribute("aria-selected", String(i === active));
      item.toggleAttribute("data-focused", i === active);
    });
    input.setAttribute("aria-activedescendant", list.children[active].id);
    list.children[active].scrollIntoView({ block: "nearest" });
  }
  function choose(person) {
    const before = input.value.slice(0, tag.start),
      after = input.value.slice(input.selectionStart).replace(/^ /, "");
    const inserted = "@" + person.name + " ";
    input.value = before + inserted + after;
    const caret = before.length + inserted.length;
    close();
    input.focus();
    input.setSelectionRange(caret, caret);
  }
  function update() {
    tag = input.selectionStart === input.selectionEnd
      ? mentionAt(input.value, input.selectionStart)
      : null;
    matches = tag ? suggestMentions(tag.query, people()) : [];
    if (!matches.length) return close();
    list.replaceChildren(
      ...matches.map((person, i) => {
        const item = document.createElement("li");
        item.id = list.id + "-" + i;
        item.className = "list-box-item";
        item.setAttribute("role", "option");
        item.append(...show(person));
        // Keep focus in the text box while choosing with a pointer.
        item.addEventListener("pointerdown", (e) => e.preventDefault());
        item.addEventListener("click", () => choose(person));
        return item;
      }),
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(0);
  }
  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("blur", close);
  input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) update();
  });
  input.addEventListener("keydown", (e) => {
    if (!matches.length || e.isComposing) return;
    if (e.key === "ArrowDown") highlight(active + 1);
    else if (e.key === "ArrowUp") highlight(active - 1);
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey)
      choose(matches[active]);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  });
  return {
    close,
    /** Put a tag at the cursor, as when a name is clicked elsewhere on the page. */
    insert(person) {
      const at = input.selectionStart ?? input.value.length;
      const space = at && !/\s$/.test(input.value.slice(0, at)) ? " " : "";
      tag = { start: at + space.length, query: "" };
      input.value = input.value.slice(0, at) + space + input.value.slice(at);
      input.setSelectionRange(tag.start, tag.start);
      choose(person);
    },
  };
}
