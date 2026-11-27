import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";

// The token stays in ignored local files, never in browser responses or Git.
await mkdir(".quorum/bridge", { recursive: true, mode: 0o700 });
let token;
try {
  token = (await readFile(".quorum/bridge/token", "utf8")).trim();
} catch {
  token = randomBytes(32).toString("hex");
  await writeFile(".quorum/bridge/token", token, { mode: 0o600 });
}
let env = "";
try {
  env = await readFile(".env", "utf8");
} catch {
  /* New local configuration. */
}
const settings = {
  QUORUM_CLI_BRIDGE_URL: "http://host.docker.internal:4712",
  QUORUM_CLI_BRIDGE_TOKEN: token,
};
for (const [key, value] of Object.entries(settings)) {
  const pattern = new RegExp("^" + key + "=.*$", "m");
  env = pattern.test(env)
    ? env.replace(pattern, key + "=" + value)
    : env.trimEnd() + "\n" + key + "=" + value + "\n";
}
await writeFile(".env", env, { mode: 0o600 });
await chmod(".env", 0o600);
console.log(
  "CLI bridge configured. Start npm run bridge on the Mac, then recreate the Quorum container.",
);
