# Quorum specialist team

Reviewed selected listings at Skills Directory on November 26, 2026. This is a focused role review, not an audit of the entire directory or the bundled code in every listing. Directory security grades are third-party claims, not a guarantee.

The team contains original, concise Quorum meeting instructions informed by these references. It does **not** vendor entire third-party skill packages or execute their scripts. Some source packages assume external tools, workspace files, orchestration, or licenses that do not fit this meeting app. Those assumptions are not carried into the role prompts. The source links and review date are visible in each agent's skill text.

| Agent | Skills | Reviewed reference |
|---|---|---|
| Developer | Architecture & implementation; Code quality & security | [Senior Fullstack](https://www.skillsdirectory.com/skills/bhaktofmahakal-senior-fullstack) |
| Product Manager | Discovery & prioritization; Requirements & success metrics | [Product Manager](https://www.skillsdirectory.com/skills/tronghieu-product-manager) |
| Project Manager | Delivery planning; Risk & stakeholder coordination | [Project Manager](https://www.skillsdirectory.com/skills/tronghieu-project-manager) |
| Designer | User research & journeys; Interaction & accessible design | [UX Researcher Designer](https://www.skillsdirectory.com/skills/borghei-ux-researcher-designer) |
| QA | Risk-based test strategy; Defect triage & release evidence | [QA Testing Strategy](https://www.skillsdirectory.com/skills/vasilyu1983-qa-testing-strategy) |
| Customer Support | Triage & troubleshooting; Response & escalation | [Customer Support Ops](https://www.skillsdirectory.com/skills/neversight-customer-support-ops) |
| Business Developer | Opportunity & partner evaluation; Partnership experiments | [Strategic Alliances](https://www.skillsdirectory.com/skills/cbrock84-strategic-alliances) |
| Sales | Evidence-based qualification; Discovery & next steps | [Deal Qualification](https://www.skillsdirectory.com/skills/prosyo-ai-deal-qualification) |
| Marketing | Positioning & messaging; Campaign & measurement | [Marketing Strategy](https://www.skillsdirectory.com/skills/manojbajaj95-marketing-strategy) |
| CISO | Threat & business risk; Security program & incident readiness | [C-level agents directory listing](https://www.skillsdirectory.com/skills/bestagentkits-c-level-agents), [dedicated CISO Advisor primary source](https://github.com/alirezarezvani/claude-skills/tree/main/c-level-advisor/skills/ciso-advisor) |

## Use

Choose **Agents → Add specialist team (10 roles)**. This is idempotent: existing named roles, customizations, archived roles, and previous meetings remain intact. Each new role uses Ollama with an [automatically chosen model](../README.md#automatic-model-selection); install a capable one in Settings or with `docker compose exec ollama ollama pull qwen2.5:3b`. The smaller `qwen2.5:0.5b` remains the smoke-test model. Model size is not a guarantee of expertise; evaluate important recommendations against evidence.

Example meeting: “Decide the smallest safe launch for a self-service onboarding flow.” Invite Product Manager, Developer, Designer, QA and CISO. Add Project Manager for scheduling, and the commercial roles when acquisition, sales or support is part of the decision. You do not have to invite every role to every meeting.

Use each participant's provider/model controls to switch to authenticated Claude Code or Codex through the optional host bridge, or to another installed local model. Roles cannot claim tool execution: this prototype's CLI adapters disable Claude tools and run Codex in a read-only sandbox, and API providers receive only the meeting context and assigned instructions.
