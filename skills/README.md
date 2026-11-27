# Included skills

Third-party `SKILL.md` files gathered from the sources listed in Snyk's article
[Top 8 Claude Skills for Entrepreneurs, Startup Founders and Solopreneurs](https://snyk.io/articles/top-8-claude-skills-entrepreneurs-startup-founders-solopreneurs/),
copied on 2026-11-27 without changes. Each folder keeps its source's license and the commit it came from.

| Folder | Source | License | Skills |
|---|---|---|---|
| `coreyhaines31/` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills/tree/2bf95edb4ebd37198ab7fd18b99ba95c2145ec64) | MIT | 53 |
| `wondelai/` | [wondelai/skills](https://github.com/wondelai/skills/tree/c37678106e63ef1c5472d848fb3d8b8c5b33fafe) | MIT | 66 |
| `anthropic/` | [anthropics/skills](https://github.com/anthropics/skills/tree/e4bb5d960d87126ff3b3a8af1a104b7db67560ba) | Apache-2.0 | 2 |
| `alirezarezvani/` | [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills/tree/d3cc4c620288c571a95efc898edc91f522acaa7f) | MIT | 126 |
| `alexdcd/` | [alexdcd/Mafia-Claude-Skills](https://github.com/alexdcd/Mafia-Claude-Skills/tree/d78699ce936947f4042c0496351a0e2beda713f8) | Apache-2.0 | 1 |
| `snyk/` | [snyk/studio-recipes](https://github.com/snyk/studio-recipes/tree/3752dd05a462184dcce44af3c247f287b41e35de) | Apache-2.0 | 1 |

In Quorum, open **Agents → Import from GitHub or Claude → Included skills**.

## What is and is not here

- Only the `SKILL.md` text. Scripts, templates and reference files are not copied, and Quorum agents cannot run tools. Skills that depend on them (for example `pptx`, `skill-creator` and `snyk-fix`, which also needs Snyk's MCP server) give an agent advice, not those abilities.
- From `alirezarezvani/claude-skills`, only the marketing, product, C-level advisor and project management folders.
- `founderjourney/claude-skills` (SaaS financial projections) is missing: the repository was not found.
- `landing-page-mastery` replies in Spanish unless told otherwise.

## Trust

The files were screened for hidden characters, instruction overrides, requests to hide actions from the user, downloads piped to a shell, secret file paths, known data-collection hosts and embedded keys. No problem was found. That is a pattern search, not a line-by-line review: a skill becomes part of an agent's instructions and is sent to its model, so read one before relying on it, especially on Codex agents, which can read local files.

To update a source, copy newer files over its folder, record the new commit in `SOURCE` and review the differences.
