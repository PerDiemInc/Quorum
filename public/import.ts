import { MAX_IMPORT } from "/engine.js";
import type { Agent, Provider, Skill } from "/engine.js";

/** A skill as the server reads it. */
export interface ImportedSkill extends Skill {
  kind: "skill";
  truncated: boolean;
  instructions?: never;
}
/** An agent profile as the server reads it. */
export interface ImportedProfile {
  kind: "agent";
  name: string;
  instructions: string;
  model: string;
  skills: Skill[];
  source: string;
  truncated: boolean;
  text?: never;
}
interface ReadResult {
  items: Array<ImportedSkill | ImportedProfile>;
  skipped: string[];
}
type Kind = "agent" | "skill";
/** What the included and local lists answer with. */
interface ScannedList {
  items: Array<{ id: string; kind: Kind; name: string; description: string; source: string }>;
}
interface GitHubList {
  repo: string;
  truncated: boolean;
  items: Array<{ path: string; kind: Kind; name: string }>;
}
interface ListedItem {
  key: string;
  kind: Kind;
  name: string;
  detail: string;
}
/** What the dialog needs from the page. */
export interface ImportApp {
  node: <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    text?: string,
    cls?: string,
  ) => HTMLElementTagNameMap[Tag];
  checkbox: (input: HTMLInputElement, ...children: Node[]) => HTMLElement;
  setSelected: (el: HTMLElement, selected: boolean) => void;
  chip: (text: string, tone?: string) => HTMLElement;
  request: <T>(path: string, method?: string, data?: object) => Promise<T>;
  agents: () => Array<Pick<Agent, "id" | "name" | "provider" | "skills">>;
  providerChoices: (select: HTMLSelectElement) => void;
  /** Resolves to the agent's name. */
  addSkills: (target: string, skills: ImportedSkill[]) => Promise<string>;
  addAgents: (
    profiles: ImportedProfile[],
    provider: string,
  ) => Promise<{ added: number; updated: number }>;
}

/** The elements in index.html that are used as more than an HTMLElement. */
interface Elements {
  "import-add": HTMLButtonElement;
  "import-dialog": HTMLDialogElement;
  "import-github": HTMLFormElement & {
    readonly elements: HTMLFormControlsCollection & { url: HTMLInputElement };
  };
  "import-provider": HTMLSelectElement;
  "import-search": HTMLInputElement;
  "import-target": HTMLSelectElement;
}
const $ = <Id extends string>(id: Id) =>
  document.getElementById(id) as Id extends keyof Elements ? Elements[Id] : HTMLElement;
const LOCAL_MODELS: ReadonlyArray<Provider | undefined> = ["ollama", "openai-compatible"];
const PRESELECT = 20;
const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");

/** The dialog that imports agent profiles and skills from GitHub or Claude. */
export function createImport(app: ImportApp) {
  const { node, checkbox, setSelected, chip, request, agents } = app;
  const SOURCES = ["library", "github", "local"] as const;
  type Source = (typeof SOURCES)[number];
  let source: Source = "github";
  const lists: Record<Source, ListedItem[] | null> = {
    library: null,
    github: null,
    local: null,
  };
  const selected: Record<Source, Set<string>> = {
    library: new Set(),
    github: new Set(),
    local: new Set(),
  };
  let address = "";

  const status = (message = "", failed = false) => {
    $("import-status").textContent = message;
    $("import-status").classList.toggle("failed", failed);
  };
  const chosen = () =>
    (lists[source] ?? []).filter((item) => selected[source].has(item.key));
  const shown = () => {
    const query = $("import-search").value.trim().toLowerCase();
    return (lists[source] ?? []).filter((item) =>
      (item.name + " " + item.detail).toLowerCase().includes(query),
    );
  };
  const read = (keys: string[]) =>
    source === "github"
      ? request<ReadResult>("/api/import/github/fetch", "POST", { url: address, paths: keys })
      : request<ReadResult>("/api/import/" + source, "POST", { ids: keys });

  function updateChoices() {
    const items = chosen();
    const profiles = items.filter((i) => i.kind === "agent").length;
    const skills = items.length - profiles;
    $("import-provider-field").hidden = !profiles;
    $("import-target-field").hidden = !skills;
    $("import-add").disabled = !items.length;
    $("import-add").textContent = items.length
      ? "Add " +
        [profiles && plural(profiles, "agent"), skills && plural(skills, "skill")]
          .filter(Boolean)
          .join(" and ")
      : "Add";
    const total = lists[source]?.length ?? 0;
    $("import-count").textContent = total
      ? items.length + " of " + total + " selected"
      : "";
    $("import-all").hidden = !shown().length;
  }

  function row(item: ListedItem) {
    const el = node("div", undefined, "import-item"),
      input = node("input"),
      text = node("span", undefined, "info"),
      preview = node("button", "Preview", "button button--ghost button--sm"),
      content = node("pre");
    input.checked = selected[source].has(item.key);
    input.addEventListener("change", () => {
      if (input.checked) selected[source].add(item.key);
      else selected[source].delete(item.key);
      updateChoices();
    });
    text.append(node("strong", item.name), node("small", item.detail, "clamp"));
    const label = checkbox(
      input,
      text,
      chip(item.kind === "agent" ? "Agent" : "Skill", item.kind === "agent" ? "accent" : ""),
    );
    preview.type = "button";
    preview.setAttribute("aria-label", "Preview " + item.name);
    content.hidden = true;
    content.tabIndex = 0;
    preview.addEventListener("click", async () => {
      if (!content.hidden) {
        content.hidden = true;
        preview.textContent = "Preview";
        return;
      }
      preview.disabled = true;
      try {
        const [found] = (await read([item.key])).items;
        content.textContent = found
          ? (found.instructions ?? found.text)
          : "This file has no agent name, so it cannot be imported.";
        content.hidden = false;
        preview.textContent = "Hide";
      } catch (e) {
        status((e as Error).message, true);
      } finally {
        preview.disabled = false;
      }
    });
    el.append(label, preview, content);
    return el;
  }

  const EMPTY = {
    library: ["Looking for included skills…", "No included skills were found."],
    github: ["Paste a GitHub address and press Fetch.", "No agent profiles or skills were found there."],
    local: [
      "Looking for Claude agents and skills…",
      "No Claude agents or skills were found on the computer running Quorum.",
    ],
  };
  function render() {
    const items = shown();
    $("import-list").replaceChildren(...items.map(row));
    if (!items.length)
      $("import-list").append(
        node(
          "p",
          lists[source]?.length
            ? "Nothing matches your search."
            : EMPTY[source][lists[source] ? 1 : 0],
          "muted",
        ),
      );
    updateChoices();
  }

  async function show(next: Source) {
    source = next;
    for (const name of SOURCES) setSelected($("import-tab-" + name), name === next);
    $("import-github").hidden = next !== "github";
    $("import-search").value = "";
    status();
    render();
    if (next !== "github" && !lists[next]) {
      try {
        const { items } = await request<ScannedList>("/api/import/" + next);
        lists[next] = items.map((i) => ({
          key: i.id,
          kind: i.kind,
          name: i.name,
          detail: [i.source, i.description].filter(Boolean).join(": "),
        }));
      } catch (e) {
        lists[next] = [];
        status((e as Error).message, true);
      }
      if (source === next) render();
    }
  }

  for (const name of SOURCES)
    $("import-tab-" + name).addEventListener("click", () => void show(name));
  $("import-search").addEventListener("input", render);
  $("import-close").addEventListener("click", () => $("import-dialog").close());
  $("import-all").addEventListener("click", () => {
    for (const item of shown().slice(0, MAX_IMPORT)) selected[source].add(item.key);
    render();
  });
  $("import-github").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = (e.currentTarget as Elements["import-github"]).elements.url.value.trim();
    if (!url) {
      status("Paste a GitHub address first.", true);
      return;
    }
    const button = (e.currentTarget as HTMLFormElement).querySelector("button")!;
    button.disabled = true;
    status("Fetching from GitHub…");
    try {
      const result = await request<GitHubList>("/api/import/github", "POST", { url });
      address = url;
      lists.github = result.items.map((i) => ({
        key: i.path,
        kind: i.kind,
        name: i.name,
        detail: i.path,
      }));
      const agentPaths = result.items
        .filter((i) => i.kind === "agent")
        .map((i) => i.path);
      const profiles = agentPaths.length;
      // A team-sized set starts selected, ready to add in one step. Big collections do not.
      selected.github = new Set(
        result.items.length === 1
          ? [result.items[0].path]
          : profiles <= PRESELECT
            ? agentPaths
            : [],
      );
      status(
        "Found " +
          plural(profiles, "agent profile") +
          " and " +
          plural(result.items.length - profiles, "skill") +
          " in " +
          result.repo +
          (result.truncated ? ". The list is shortened; link to a folder." : ".") +
          (profiles > PRESELECT ? " Search or link to a folder, then select the ones you want." : ""),
      );
      render();
    } catch (error) {
      lists.github = null;
      selected.github.clear();
      render();
      status((error as Error).message, true);
    } finally {
      button.disabled = false;
    }
  });
  $("import-add").addEventListener("click", async () => {
    const keys = chosen().map((i) => i.key),
      target = $("import-target").value;
    if (keys.length > MAX_IMPORT) {
      status("Choose at most " + MAX_IMPORT + " at a time.", true);
      return;
    }
    $("import-add").disabled = true;
    status("Adding…");
    try {
      const { items, skipped } = await read(keys);
      const profiles = items.filter((i) => i.kind === "agent"),
        skills = items.filter((i) => i.kind === "skill"),
        notes: string[] = [];
      // Skills go first: if they do not fit, nothing has been added yet.
      if (skills.length) {
        const name = await app.addSkills(target, skills);
        notes.push("Added " + plural(skills.length, "skill") + " to " + name + ".");
        const agent = agents().find((a) => a.id === target);
        const size = (agent?.skills ?? []).reduce((sum, s) => sum + s.text.length, 0);
        if (size > 12000 && LOCAL_MODELS.includes(agent?.provider))
          notes.push("A small local model may not read all of these instructions.");
      }
      if (profiles.length) {
        const { added, updated } = await app.addAgents(profiles, $("import-provider").value);
        if (added) notes.push("Added " + plural(added, "agent") + ".");
        if (updated) notes.push("Updated " + plural(updated, "agent") + ".");
      }
      if (skipped.length)
        notes.push("Skipped, not agent profiles: " + skipped.join(", ") + ".");
      if (items.some((i) => i.truncated)) notes.push("Long text was shortened.");
      selected[source].clear();
      fillTargets(target);
      render();
      status(notes.join(" "), !items.length);
    } catch (e) {
      status((e as Error).message, true);
      updateChoices();
    }
  });

  function fillTargets(target: string) {
    const options = [{ id: "", name: "The new agent you are creating" }, ...agents()];
    $("import-target").replaceChildren(
      ...options.map((a) => {
        const option = node("option", a.name);
        option.value = a.id;
        return option;
      }),
    );
    $("import-target").value = target;
  }

  /**
   * `target` is the agent that receives skills; blank for the one being created.
   * `from` is the tab to start on.
   */
  return function open(target: string, from: Source) {
    fillTargets(target);
    app.providerChoices($("import-provider"));
    // Files may have changed since the dialog was last open.
    lists.local = null;
    selected.local.clear();
    $("import-dialog").showModal();
    void show(from);
  };
}
