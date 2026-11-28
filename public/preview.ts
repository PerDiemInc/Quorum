import { previewFiles } from "/engine.js";
import type { ProjectFile } from "/engine.js";

/** What design previews need from the page. */
export interface PreviewApp {
  node: <Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    text?: string,
    cls?: string,
  ) => HTMLElementTagNameMap[Tag];
  button: (text: string, fn: () => void, variant?: string) => HTMLButtonElement;
  request: <T>(path: string, method?: string, data?: object) => Promise<T>;
}
type Width = "desktop" | "phone";
const $ = (id: string) => document.getElementById(id)!;

/**
 * Live previews of proposed HTML and SVG files. The server holds the files in memory and
 * serves them with scripts off and the network blocked; the frame here allows nothing.
 * Nothing is saved to disk.
 */
export function createPreviews({ node, button, request }: PreviewApp) {
  /** Put a frame showing the page into the holder, unless it is no longer wanted. */
  async function show(
    holder: Element,
    files: ProjectFile[],
    page: string,
    wanted: () => boolean = () => true,
  ) {
    try {
      const { id } = await request<{ id: string }>("/api/draft", "POST", { files });
      if (!wanted()) return;
      const frame = node("iframe");
      // An empty list allows nothing: no scripts, forms, popups or access to the app.
      // It must be set before the frame is given an address.
      frame.setAttribute("sandbox", "");
      frame.title = "Preview of " + page;
      frame.loading = "lazy";
      frame.referrerPolicy = "no-referrer";
      frame.src = "/draft/" + id + "/" + page.split("/").map(encodeURIComponent).join("/");
      holder.replaceChildren(frame);
    } catch (error) {
      if (wanted())
        holder.replaceChildren(node("p", "No preview. " + (error as Error).message, "muted small"));
    }
  }

  // A preview is fetched once it scrolls into view, so a long meeting asks for few at a time.
  const waiting = new WeakMap<Element, () => void>();
  const watcher = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      watcher.unobserve(target);
      waiting.get(target)?.();
    }
  });

  // ---- Full size ----

  // Frames asked for before the dialog was closed or reused are dropped.
  let round = 0;
  function setWidth(width: Width) {
    for (const choice of ["desktop", "phone"] as const) {
      const tab = $("preview-" + choice);
      tab.dataset.selected = String(choice === width);
      tab.setAttribute("aria-pressed", String(choice === width));
    }
    $("preview-full").classList.toggle("phone", width === "phone");
  }
  function openFull(files: ProjectFile[], page: string) {
    const mine = ++round;
    $("preview-title").textContent = page;
    setWidth("desktop");
    $("preview-full").replaceChildren(node("p", "Loading preview…", "muted small"));
    ($("preview-dialog") as HTMLDialogElement).showModal();
    void show($("preview-full"), files, page, () => mine === round);
  }
  for (const width of ["desktop", "phone"] as const)
    $("preview-" + width).addEventListener("click", () => setWidth(width));
  $("preview-close").addEventListener("click", () => ($("preview-dialog") as HTMLDialogElement).close());
  $("preview-dialog").addEventListener("close", () => {
    round++;
    $("preview-full").replaceChildren();
  });

  /** A live preview of one page, styled by the stylesheets among the files. */
  return function preview(files: readonly ProjectFile[], page: ProjectFile): HTMLElement {
    const needed = previewFiles(files, page),
      el = node("figure", undefined, "preview"),
      caption = node("figcaption"),
      full = button("Open full size", () => openFull(needed, page.path), "tertiary"),
      holder = node("div", undefined, "preview__frame");
    full.setAttribute("aria-label", "Open full size: " + page.path);
    caption.append(node("span", "Preview · " + page.path), full);
    holder.append(node("p", "Loading preview…", "muted small"));
    el.append(caption, holder);
    waiting.set(holder, () => void show(holder, needed, page.path));
    watcher.observe(holder);
    return el;
  };
}
