// Parses the QUESTION: convention (packages/agents/src/prompts.ts documents
// it to the agent, parallel to the existing VERDICT: convention reviewers
// use) out of a completed run's result text. An agent that is genuinely
// blocked ends its entire turn with this instead of a low-confidence guess
// or a reported failure, so the orchestrator can pause the card visibly
// rather than counting it as a failed attempt.
export function extractQuestion(resultText: string): string | null {
  const match = /QUESTION:/i.exec(resultText);
  if (!match) return null;
  const question = resultText.slice(match.index + match[0].length).trim();
  return question.length > 0 ? question : null;
}
