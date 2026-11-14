import { type Box, repliesName } from "./offline";

/**
 * Quick replies (ADR-028 Amendment 5): the owner's own answers, in their own words, saved from a reply
 * they typed and offered again as chips on a message. Kept on this phone only, sealed in the offline
 * box per inbox (`repliesName`), and sent nowhere but as the reply the owner taps. Removing the inbox
 * from the phone removes them (`Box.forgetInbox`). They move into the inbox later, to follow the owner
 * from phone to phone.
 */
export interface QuickReply {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/** A phone keeps this many per inbox: past it, the oldest go. */
export const MAX_QUICK_REPLIES = 12;
/** A quick reply is a short answer; a longer one is typed. */
export const MAX_QUICK_REPLY_CHARS = 500;

/** The same words, whatever their spaces and capitals. */
export function sameWords(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

function valid(r: unknown): r is QuickReply {
  const q = r as QuickReply | null;
  return typeof q?.id === "string" && typeof q.text === "string" && q.text.trim() !== "" && typeof q.at === "number";
}

export class QuickReplies {
  /** Changes go one at a time: two saves in a row never write over each other. */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly box: Box,
    readonly alias: string,
  ) {}

  /** The newest first. */
  async list(): Promise<QuickReply[]> {
    const kept = await this.box.get<unknown>(repliesName(this.alias));
    return Array.isArray(kept) ? kept.filter(valid) : [];
  }

  /** Whether these words are saved already. */
  async has(text: string): Promise<boolean> {
    return (await this.list()).some((r) => sameWords(r.text, text));
  }

  /** Saves the owner's words, the newest first; the same words again move to the front. */
  add(text: string, now: number = Date.now()): Promise<QuickReply[]> {
    const words = text.trim();
    return this.change((all) => {
      if (!words || words.length > MAX_QUICK_REPLY_CHARS) return all;
      const rest = all.filter((r) => !sameWords(r.text, words));
      return [{ id: crypto.randomUUID(), text: words, at: now }, ...rest].slice(0, MAX_QUICK_REPLIES);
    });
  }

  remove(id: string): Promise<QuickReply[]> {
    return this.change((all) => all.filter((r) => r.id !== id));
  }

  private change(edit: (all: QuickReply[]) => QuickReply[]): Promise<QuickReply[]> {
    const next = this.turn.then(async () => {
      const all = await this.list();
      const out = edit(all);
      if (out !== all) await this.box.put(repliesName(this.alias), out);
      return out;
    });
    this.turn = next.catch(() => undefined);
    return next;
  }
}
