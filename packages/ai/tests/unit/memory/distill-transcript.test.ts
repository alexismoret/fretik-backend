import { describe, expect, test } from "bun:test";
import {
  renderTranscript,
  type TranscriptLine,
} from "../../../src/services/memory/distill-conversation";

/**
 * What the distiller is allowed to see of a conversation.
 *
 * This is the sizing that decided, in production, that a run which had
 * succeeded had not: every message was clipped to 500 characters, an
 * assistant's 4 561-character report was cut mid-sentence, and the episode
 * recorded the cut as unfinished work — *"les tâches `generer-fichiers` et
 * `upload-ftp` restent à exécuter"*, on a run that had uploaded five files and
 * had them acknowledged. Measured over 30 days: the clip bit on 95 % of
 * workflow messages and the distiller was given 17.6 % of a run's narration,
 * while using 9 % of the budget it was already allowed.
 *
 * Three properties, and each one is a defect that shipped or nearly shipped:
 *  - a message that fits is kept WHOLE (the 500-character clip is gone);
 *  - a message too big for the whole budget is CLIPPED, never skipped — the
 *    previous walk stopped at the first line that did not fit, which with the
 *    per-message clip removed returns an empty transcript for exactly the
 *    heaviest conversations;
 *  - a clipped message keeps its END as well as its beginning, because an
 *    assistant's report puts the deliverables and the anomalies last.
 */

const line = (role: "user" | "assistant", text: string): TranscriptLine => ({
  role,
  text,
});

/** Distinct, non-repeating filler: a real tokenizer and a real clip both
 *  behave differently on `"x".repeat(n)`. */
const bulk = (chars: number, marker: string): string => {
  let out = `${marker} `;
  let i = 0;
  while (out.length < chars) {
    out += `ligne ${String(i)} du rapprochement, écart reporté au registre. `;
    i += 1;
  }
  return out.slice(0, chars);
};

describe("renderTranscript", () => {
  test("a message that fits is carried whole, not clipped to 500", () => {
    // The exact shape of the EDI Fatton run: two rows, one of them a long
    // report. Both fit the budget, so both must arrive intact.
    const report = bulk(4_561, "RECAP");
    const out = renderTranscript([
      line("user", bulk(2_393, "STEERING")),
      line("assistant", report),
    ]);
    expect(out).toContain(report);
    expect(out).not.toContain("[…]");
  });

  test("the conclusion at the very end of a long message survives", () => {
    // The half the old head-only clip always lost, and the half that carries
    // what a memory is for.
    const report = `${bulk(4_000, "RECAP")} ANOMALIE: cinq fichiers régénérés avant envoi.`;
    const out = renderTranscript([line("assistant", report)]);
    expect(out).toContain("ANOMALIE: cinq fichiers régénérés avant envoi.");
  });

  test("oldest messages drop first, and the one on the edge is clipped", () => {
    // Four messages of 30 000 against a 60 000 budget: the newest arrives
    // whole, the one straddling the edge arrives clipped, and everything older
    // is gone. Recency wins, and the boundary costs content rather than a
    // whole message.
    const out = renderTranscript([
      line("user", bulk(30_000, "OLDEST")),
      line("assistant", bulk(30_000, "OLDER")),
      line("user", bulk(30_000, "EDGE")),
      line("assistant", bulk(30_000, "NEWEST")),
    ]);
    expect(out.includes("NEWEST")).toBe(true);
    expect(out.includes("EDGE")).toBe(true);
    expect(out.includes("[…]")).toBe(true);
    expect(out.includes("OLDER")).toBe(false);
    expect(out.includes("OLDEST")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(60_000);
  });

  test("a newest message bigger than the whole budget still yields a transcript", () => {
    // The regression the clip used to mask. Removing the per-message cap
    // without this leaves the walk stopping at the first line that does not
    // fit — an EMPTY transcript, for the conversations with the most to say.
    // The largest single message measured in production is 567 864 characters.
    const monster = `DEBUT ${bulk(567_000, "HUGE")} FIN-DU-RAPPORT`;
    const out = renderTranscript([
      line("user", "Reprends le dossier."),
      line("assistant", monster),
    ]);
    expect(out.length).toBeGreaterThan(1_000);
    expect(out).toContain("[…]");
    // Both ends kept: the request at the top, the verdict at the bottom.
    expect(out).toContain("DEBUT");
    expect(out).toContain("FIN-DU-RAPPORT");
    expect(out.length).toBeLessThanOrEqual(60_000);
  });

  test("an empty conversation renders nothing rather than throwing", () => {
    expect(renderTranscript([])).toBe("");
  });

  test("every line is labelled with its speaker", () => {
    const out = renderTranscript([
      line("user", "Génère les fichiers EDI."),
      line("assistant", "Cinq fichiers déposés, 5/5 acquittés."),
    ]);
    expect(out).toBe(
      "User: Génère les fichiers EDI.\n\nAssistant: Cinq fichiers déposés, 5/5 acquittés.",
    );
  });
});
