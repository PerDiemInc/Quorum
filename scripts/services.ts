// Start the model services for a natively run Quorum, adding voices when the image exists.
import { spawnSync } from "node:child_process";

const voiceImage = process.env.KOKORO_IMAGE ?? "ai-models:cpu";
const hasVoices =
  spawnSync("docker", ["image", "inspect", voiceImage], { stdio: "ignore" })
    .status === 0;
const result = spawnSync(
  "docker",
  [
    "compose", "-f", "compose.yaml", "-f", "compose.native.yaml",
    "--profile", "speech", "--profile", "hf",
    "up", "-d", "ollama", "inference", "whisper",
    ...(hasVoices ? ["kokoro"] : []),
  ],
  { stdio: "inherit" },
);
if (!hasVoices)
  console.log(
    "Natural voices were not started: no " + voiceImage +
      " image. Quorum will use your browser's voices.",
  );
process.exit(result.status ?? 1);
