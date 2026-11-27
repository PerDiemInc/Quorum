import { mkdir, writeFile } from "node:fs/promises";
import { checkCLI } from "../src/models.ts";

// Store only capability booleans and versions, never login output or credentials.
const [claude, codex] = await Promise.all([
  checkCLI("claude"),
  checkCLI("codex"),
]);
const status = { checkedAt: new Date().toISOString(), claude, codex };
await mkdir(".quorum/host", { recursive: true });
await writeFile(".quorum/host/access.json", JSON.stringify(status), {
  mode: 0o644,
});
console.log(
  "Host capability snapshot saved. Run this again after changing your CLI login.",
);
