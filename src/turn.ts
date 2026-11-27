import {
  canCreateFiles,
  extractFiles,
  findRepeat,
  latestFiles,
  makePrompt,
  projectFiles,
  splitFiles,
  withFileMarkers,
  withoutRepeatedSentences,
} from "./engine.ts";
import { respond } from "./providers.ts";
import type { Agent, Message, MeetingContext, Prompt } from "./engine.ts";

const ATTEMPTS = 3;

/** A meeting as a turn needs it: what was said so far is required. */
export type TurnMeeting = MeetingContext & { transcript: readonly Message[] };
type Ask = (
  agent: Agent,
  prompt: Prompt,
  signal: AbortSignal | undefined,
  options: { attempt: number },
) => Promise<string>;

/** Ask an agent for its turn, and again if it only repeats what was already said.
 * @returns skipped when it had nothing new
 */
export async function freshTurn(
  agent: Agent,
  meeting: TurnMeeting,
  signal: AbortSignal | undefined,
  ask: Ask = respond,
): Promise<{ text: string } | { skipped: true }> {
  const prompt = makePrompt(agent, meeting);
  const proposed = latestFiles(meeting.transcript, meeting.proposed);
  // What each file holds now; a proposal replaces an attachment of the same path.
  const known = new Map(
    [...projectFiles(meeting.attachments), ...proposed].map((f) => [f.path, comparable(f.content)]),
  );
  let repeated: Message | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const text = withoutRepeatedSentences(
      await ask(
        agent,
        // The files stay known when the retry shows less of the transcript.
        repeated ? nudge(agent, { ...meeting, proposed }, repeated) : prompt,
        signal,
        { attempt },
      ),
    );
    // Demo replies are fixed placeholders, so there is nothing better to ask for.
    if (agent.provider === "demo") return { text };
    const files = canCreateFiles(agent) ? extractFiles(text) : [];
    // A new or changed file is new work, however familiar the summary sounds.
    if (files.some((f) => known.get(f.path) !== comparable(f.content))) return { text };
    repeated =
      findRepeat(text, meeting.transcript) ??
      // Nothing but files that are already there.
      (files.length && !splitFiles(text).prose
        ? (meeting.transcript.findLast((m) => m.speaker !== "Host" && m.speaker !== "Quorum") ?? null)
        : null);
    if (!repeated) return { text };
  }
  return { skipped: true };
}

/** Line endings and trailing space do not make a file different. */
const comparable = (content: string) => content.replace(/\r\n/g, "\n").trimEnd();

/** The same request without the message being copied, and saying why it was refused. */
function nudge(agent: Agent, meeting: TurnMeeting, repeated: Message): Prompt {
  const prompt = makePrompt(agent, {
    ...meeting,
    // A shorter history without the copied message gives a model less to echo.
    transcript: meeting.transcript
      .slice(-12)
      .filter((m) => m.speaker === "Host" || m.text !== repeated.text),
  });
  return {
    ...prompt,
    system:
      prompt.system +
      "\n\nYour last draft was refused because it repeated this earlier message: " +
      JSON.stringify(withFileMarkers(repeated.text).slice(0, 600)) +
      " Do not say that again in any wording. Take a clearly different angle: challenge it, name a risk, give a specific example, propose the next action with an owner, or ask the host one new question.",
  };
}
