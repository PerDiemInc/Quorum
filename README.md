# Quorum

**Your AI team. One conversation. One goal.**

A standalone local-first meeting prototype. Create specialist agents with their own instructions, multiple Markdown skills and model configuration, invite them to a goal-oriented meeting, and let them discuss until you accept the outcome.

## Quick start

Requirements: Node.js 24+ (built-in SQLite). No Docker, database server or npm dependencies.

```bash
git clone https://github.com/PerDiemInc/Quorum.git
cd Quorum
npm start
```

Open http://127.0.0.1:4710. Choose the two built-in **demo** agents to exercise the meeting loop without an AI provider. Demo responses are placeholders, not real reasoning. For real discussions, create agents with the model providers below.

1. Create agents with instructions and multiple SKILL.md files.
2. Create a meeting with a goal, optional agenda and selected agents.
3. Start the discussion. Each participant sees recent shared context and responds in turn.
4. Change any participant's provider/model while the meeting is running. The next turn uses the new choice.
5. Pause, add feedback by typing or recording your voice, then continue. The turn limit pauses the loop rather than accepting the outcome.
6. Accept the outcome when you are satisfied. History is stored locally in .quorum/quorum.sqlite.

## Models

- **Ollama:** start Ollama, pull a model (e.g. `ollama pull qwen3:8b`) and create an agent with provider Ollama and that model name. Default endpoint: http://127.0.0.1:11434.
- **Hugging Face / local models:** serve a downloaded compatible model through llama.cpp, LM Studio, vLLM or another OpenAI-compatible chat server. Set `QUORUM_OPENAI_URL=http://127.0.0.1:8080/v1` and use its model identifier.
- **Claude Code / Codex:** install and authenticate the respective CLI yourself, then start with `npm run start:cli` (the same as `QUORUM_ENABLE_CLI=1 npm start`). Use a supported model name such as `sonnet`, or leave blank for the CLI default. These clients usually use cloud inference, not offline inference. Claude runs in safe mode (no CLAUDE.md, skills, plugins or hooks of yours) with an empty tool list, an empty MCP configuration and no saved sessions; the agent's instructions and skills become its system prompt. Codex uses its read-only sandbox. These settings are not a complete isolation boundary: managed policy, CLI settings, integrations and read access may still apply. Enable only for trusted agents and skills.
  - The header shows **Claude ready**, **Claude disabled** (restart with `npm run start:cli`) or **Claude unavailable** (not installed or not signed in; run `claude auth login`).
  - Set `CLAUDE_BIN` if `claude` is not on the server's PATH. Safe mode needs a recent Claude Code release; run `claude update` if the option is rejected.
- **Other endpoints:** an OpenAI-compatible provider can use a deliberately configured remote URL and optional `QUORUM_OPENAI_KEY`. This sends conversation and assigned instructions to that service.

## Voice meetings

Quorum uses **whisper.cpp** for local speech-to-text and optionally **Kokoro** for speech output.

On macOS install dependencies:

```bash
brew install ffmpeg whisper-cpp
```

Download a compatible whisper.cpp GGML model from the whisper.cpp model repository (e.g. ggml-base.bin or ggml-small.bin for multilingual recognition). Start Quorum with an absolute model path:

```bash
WHISPER_MODEL="$HOME/models/ggml-base.bin" npm start
```

If the binary is not named whisper-cli in your installation, set WHISPER_BIN to its path. FFMPEG_BIN can also be overridden.

Click **Record voice** (microphone permission required), speak, stop the recording, review the local transcription, send it and continue the meeting. Recordings automatically stop after 60 seconds; temporary audio is deleted after transcription. This is push-to-talk, not continuous voice activity detection.

Each message has a play button that reads it aloud (press again to stop). Playing a message pauses the discussion if **Speak replies** is on.

For distinct agent voices, run an OpenAI-compatible Kokoro speech server separately, set `KOKORO_URL=http://127.0.0.1:8880/v1`, and specify a supported voice in each agent (e.g. af_heart). Enable **Speak replies**. Without Kokoro, Quorum uses available local browser speech voices only; availability varies by browser.

## Development

```bash
npm run check
npm test
npm run dev
```

The initial implementation is plain browser JavaScript and Node.js with a single local SQLite state store, HTTP requests, sequential autonomous turns and a per-run turn budget. Only the human can accept a meeting. Pause aborts the active request; model changes are applied between turns. Use a single dashboard tab to avoid competing state snapshots.

This prototype does not yet include token streaming, automatic voice interruptions, VAD, speaker selection, tool execution via MCP, private agent memory, native desktop packaging, or automated meeting summaries. Skills are instructions only. Real provider and microphone compatibility require manual testing on the target machine. Never expose the local server to the public internet.

MIT licensed.
