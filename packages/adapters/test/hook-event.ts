import type { HookChallenge, HookEvent } from "@surfingdog/core";

/**
 * What a hook's `verify` named, as the event it is. Only a platform that proves an address first
 * (ServiceM8) ever answers with a challenge; from any other, a challenge fails the test here.
 */
export function eventOf<T extends HookEvent | HookChallenge | null | undefined>(answer: T): Exclude<T, HookChallenge> {
  if (answer && "challenge" in answer) throw new Error(`a challenge, not an event: ${JSON.stringify(answer)}`);
  return answer as Exclude<T, HookChallenge>;
}
