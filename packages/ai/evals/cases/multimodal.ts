/**
 * Multimodal eval suite (chantier C5). Native image/video Q&A.
 *
 * These cases are graded on the ANSWER (a `judge` rubric), NEVER on
 * whether the `vision` tool was called. That is deliberate: they back the
 * activation A/B (native vs tool-mediated). Under an inert / non-multimodal
 * profile the agent reaches the same answer via the `vision` tool (the
 * attached-files snapshot hints "use vision tool", `read` on a video routes
 * there); under a multimodal profile the model sees the media natively and
 * may answer directly. Outcome-based assertions stay stable across the flip
 * — that is the whole point. A rubric must NOT forbid calling `vision`: a
 * native model is free to zoom in for a finer look.
 *
 * Fixtures (`evals/fixtures/`, operator-provisioned, gitignored — see
 * `fixtures/README.md`): `marina.jpg` + `diagram.png` already exist;
 * `chart.png` and `clip.mp4` are new. A missing fixture makes the case run
 * file-less and the judge FAIL, surfacing the gap honestly.
 */

import type { EvalSuite } from "../types";

export const multimodalSuite: EvalSuite = {
  name: "multimodal",
  summary: "Native image / video Q&A — graded on the answer, not the tool.",
  cases: [
    {
      id: "mm-image-scene-qa",
      description: "Image scene Q&A — describe what the photo shows",
      prompt:
        "What does the attached image marina.jpg show? Answer in one sentence.",
      tags: ["multimodal", "image"],
      fixtures: ["marina.jpg"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "marina.jpg is an aerial view of a marina / harbour full of moored boats (sailboats) in front of a city. A correct answer reflects that scene (port / marina / boats / harbour). Grade ONLY the answer's accuracy — the model MAY or MAY NOT have called the vision tool; do not penalise either path. An answer describing something unrelated, or an error, is a FAIL.",
        },
      ],
    },
    {
      id: "mm-chart-reading",
      description: "Read a value from a chart image",
      prompt:
        "Look at the attached chart chart.png. Which month had the highest revenue?",
      tags: ["multimodal", "image", "chart"],
      fixtures: ["chart.png"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "chart.png is a simple bar chart of monthly revenue in which the tallest bar is clearly the month of March. A correct answer identifies March as the peak month. Grade only the answer; the vision tool may or may not have been used. A wrong month, a hedge that names no month, or an error is a FAIL.",
        },
      ],
    },
    {
      id: "mm-image-plus-text",
      description: "Mixed turn — image + a typed instruction integrated",
      prompt:
        "I'm captioning a photo for a newsletter. Using the attached image marina.jpg, write one sentence describing the scene, then propose a short title of at most four words.",
      tags: ["multimodal", "image", "mixed"],
      fixtures: ["marina.jpg"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "marina.jpg shows an aerial marina / harbour full of moored boats. A correct answer does BOTH: (1) a one-sentence description reflecting that scene, AND (2) a short title of at most four words that fits a marina/harbour theme. Missing either part, or describing an unrelated scene, is a FAIL. Grade the answer, not the tool used.",
        },
      ],
    },
    {
      id: "mm-video-qa",
      description: "Video Q&A — describe what happens in a short clip",
      prompt:
        "What happens in the attached video clip.mp4? Answer in one sentence.",
      tags: ["multimodal", "video"],
      fixtures: ["clip.mp4"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "clip.mp4 is a short animated (3D) clip from the open movie 'Big Buck Bunny': a peaceful green outdoor / nature scene with trees and a large grey-and-white rabbit (bunny). A correct answer describes an animated outdoor / nature scene AND/OR a rabbit. Grade only the answer; the model may have reached the video natively or via the vision tool — do not penalise either. An error, or a description of unrelated content, is a FAIL.",
        },
      ],
    },
  ],
};
