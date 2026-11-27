import { findRepeat, makePrompt, withoutRepeatedSentences } from "./engine.ts";
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
  let repeated: Message | false | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const text = withoutRepeatedSentences(
      await ask(
        agent,
        repeated ? nudge(agent, meeting, repeated) : prompt,
        signal,
        { attempt },
      ),
    );
    // Demo replies are fixed placeholders, so there is nothing better to ask for.
    repeated = agent.provider !== "demo" && findRepeat(text, meeting.transcript);
    if (!repeated) return { text };
  }
  return { skipped: true };
}

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
      JSON.stringify(repeated.text.slice(0, 600)) +
      " Do not say that again in any wording. Take a clearly different angle: challenge it, name a risk, give a specific example, propose the next action with an owner, or ask the host one new question.",
  };
}
