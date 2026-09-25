import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { instrumentModel } from "../../lib/model-instrumentation";
import { cheapModelIdForTeam } from "../../lib/model-registry/team-model";
import { cheapProviderFor } from "../../lib/models";
import { openrouter } from "../../lib/openrouter";

/**
 * One sentence saying what a Drive folder is for, written from what is
 * already inside it.
 *
 * The Drive filer has to choose between "Clients" and "Contracts" for a
 * document nobody gave a destination, and a folder NAME rarely settles that.
 * A description would — except almost nobody writes one, which is exactly why
 * the filer had nothing to go on. So it is derived, from the extraction
 * summaries already sitting in `document_properties`: no file is re-read, and
 * the whole pass is one cheap call per folder per night.
 *
 * Written for a MACHINE to compare against a document, not for a person to
 * admire. Sixty of these ride one filing decision inside a 32k window, so
 * every clause that says nothing costs a candidate its place.
 */

const SYSTEM_PROMPT = [
  "You describe what a folder in a document workspace is FOR, from summaries of the documents inside it.",
  "",
  "Your description is read by an automated filing step deciding where a new document belongs, so write for that: name the kind of documents this folder holds and what they have in common.",
  "",
  "Rules:",
  "- One or two sentences. No preamble, no 'This folder contains', no markdown.",
  "- Name the document KINDS and the pattern (who they involve, what period, what stage), never individual documents, names, amounts or dates.",
  "- If the documents have no pattern in common, say so plainly — a folder that is a catch-all must read as one, or the filer will trust it.",
  "- Write in the language the documents are written in.",
].join("\n");

const modelCache = new Map<string, ReturnType<typeof instrumentModel>>();
const descriptionModelFor = (
  modelId: string,
): ReturnType<typeof instrumentModel> => {
  const cached = modelCache.get(modelId);
  if (cached) return cached;
  const model = instrumentModel(
    openrouter().chat(modelId, {
      reasoning: { effort: "low" },
      provider: cheapProviderFor(modelId),
    }),
  );
  modelCache.set(modelId, model);
  return model;
};

export const generateFolderDescription = async (params: {
  teamId: string;
  folderName: string;
  folderPath: string;
  summaries: string[];
  maxChars: number;
}): Promise<string> => {
  const prompt = [
    `Folder: ${params.folderName}`,
    `Path: ${params.folderPath}`,
    "",
    "Summaries of documents inside it:",
    ...params.summaries.map((s, i) => `${(i + 1).toString()}. ${s}`),
    "",
    `Describe what this folder is for, in at most ${params.maxChars.toString()} characters.`,
  ].join("\n");

  const { text } = await generateText({
    model: descriptionModelFor(await cheapModelIdForTeam(params.teamId)),
    instructions: SYSTEM_PROMPT,
    prompt,
    temperature: 0.2,
    // Roughly the character cap in tokens, with room to finish a sentence —
    // the caller truncates, and a description cut mid-word reads as broken
    // rather than brief.
    maxOutputTokens: 160,
    abortSignal: AbortSignal.timeout(30_000),
    telemetry: telemetryFor("folder-description"),
  });
  return text.trim();
};
