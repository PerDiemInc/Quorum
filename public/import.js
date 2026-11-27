import { MAX_IMPORT } from "/engine.js";

const $ = (id) => document.getElementById(id);
const LOCAL_MODELS = ["ollama", "openai-compatible"];
const PRESELECT = 20;
const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");

/**
 * The dialog that imports agent profiles and skills from GitHub or Claude.
 * @param {object} app
 * @param {(tag: string, text?: string, cls?: string) => HTMLElement} app.node
 * @param {(path: string, method?: string, data?: object) => Promise<any>} app.request
 * @param {() => Array<{id: string, name: string, provider: string, skills: any[]}>} app.agents
 * @param {(select: HTMLSelectElement) => void} app.providerChoices
 * @param {(target: string, skills: any[]) => Promise<string>} app.addSkills resolves to the agent's name
 * @param {(profiles: any[], provider: string) => Promise<{added: number, updated: number}>} app.addAgents
 */
export function createImport(app) {
  const { node, request, agents } = app;
  let source = "github";
  /** @type {Record<string, {key: string, kind: string, name: string, detail: string}[] | null>} */
  const lists = { github: null, local: null };
  const selected = { github: new Set(), local: new Set() };
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
  const read = (keys) =>
    source === "local"
      ? request("/api/import/local", "POST", { ids: keys })
      : request("/api/import/github/fetch", "POST", { url: address, paths: keys });

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

  function row(item) {
    const el = node("div", undefined, "import-item"),
      label = node("label", undefined, "check"),
      input = node("input"),
      text = node("div", undefined, "agent-info"),
      preview = node("button", "Preview", "secondary"),
      content = node("pre");
    input.type = "checkbox";
    input.checked = selected[source].has(item.key);
    input.addEventListener("change", () => {
      if (input.checked) selected[source].add(item.key);
      else selected[source].delete(item.key);
      updateChoices();
    });
    text.append(node("strong", item.name), node("small", item.detail));
    label.append(
      input,
      text,
      node("span", item.kind === "agent" ? "Agent" : "Skill", "chip kind-" + item.kind),
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
        status(e.message, true);
      } finally {
        preview.disabled = false;
      }
    });
    el.append(label, preview, content);
    return el;
  }

  function render() {
    const items = shown();
    $("import-list").replaceChildren(...items.map(row));
    if (!items.length)
      $("import-list").append(
        node(
          "p",
          lists[source]?.length
            ? "Nothing matches your search."
            : lists[source]
              ? source === "github"
                ? "No agent profiles or skills were found there."
                : "No Claude agents or skills were found on the computer running Quorum."
              : source === "github"
                ? "Paste a GitHub address and press Fetch."
                : "Looking for Claude agents and skills…",
          "muted",
        ),
      );
    updateChoices();
  }

  async function show(next) {
    source = next;
    for (const name of ["github", "local"])
      $("import-tab-" + name).setAttribute("aria-pressed", String(name === next));
    $("import-github").hidden = next !== "github";
    $("import-search").value = "";
    status();
    render();
    if (next === "local" && !lists.local) {
      try {
        const { items } = await request("/api/import/local");
        lists.local = items.map((i) => ({
          key: i.id,
          kind: i.kind,
          name: i.name,
          detail: [i.source, i.description].filter(Boolean).join(": "),
        }));
      } catch (e) {
        lists.local = [];
        status(e.message, true);
      }
      if (source === "local") render();
    }
  }

  for (const name of ["github", "local"])
    $("import-tab-" + name).addEventListener("click", () => void show(name));
  $("import-search").addEventListener("input", render);
  $("import-close").addEventListener("click", () => $("import-dialog").close());
  $("import-all").addEventListener("click", () => {
    for (const item of shown().slice(0, MAX_IMPORT)) selected[source].add(item.key);
    render();
  });
  $("import-github").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = e.currentTarget.elements.url.value.trim();
    if (!url) {
      status("Paste a GitHub address first.", true);
      return;
    }
    const button = e.currentTarget.querySelector("button");
    button.disabled = true;
    status("Fetching from GitHub…");
    try {
      const result = await request("/api/import/github", "POST", { url });
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
      status(error.message, true);
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
        notes = [];
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
      status(e.message, true);
      updateChoices();
    }
  });

  function fillTargets(target) {
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

  /** @param {string} target the agent that receives skills; blank for the one being created */
  return function open(target) {
    fillTargets(target);
    app.providerChoices($("import-provider"));
    // Files may have changed since the dialog was last open.
    lists.local = null;
    selected.local.clear();
    $("import-dialog").showModal();
    void show(source);
  };
}
