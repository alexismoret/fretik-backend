CREATE TYPE "skill_source" AS ENUM('bundled', 'team_uploaded');--> statement-breakpoint
ALTER TYPE "field_definition_type" ADD VALUE 'datetime' BEFORE 'boolean';--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"name" varchar(64) NOT NULL,
	"description" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source" "skill_source" DEFAULT 'bundled'::"skill_source" NOT NULL,
	"team_id" uuid,
	"version" varchar(20) DEFAULT '1.0.0' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_team_name_unique" UNIQUE("team_id","name")
);
--> statement-breakpoint
CREATE TABLE "team_skills" (
	"team_id" uuid,
	"skill_id" uuid,
	"enabled" boolean NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" uuid,
	CONSTRAINT "team_skills_pk" PRIMARY KEY("team_id","skill_id")
);
--> statement-breakpoint
CREATE INDEX "skills_source_idx" ON "skills" ("source");--> statement-breakpoint
CREATE INDEX "team_skills_team_idx" ON "team_skills" ("team_id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_skills" ADD CONSTRAINT "team_skills_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_skills" ADD CONSTRAINT "team_skills_skill_id_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "team_skills" ADD CONSTRAINT "team_skills_updated_by_id_user_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Seed the bundled skills catalogue. These match the on-disk
-- `backend/packages/ai/src/skills/bundled/<name>/` folders one-to-one.
-- `is_default = true` flags the always-on core (file generation +
-- structured doc co-authoring); the two configurable skills default
-- enabled and can be toggled off by a team owner/admin via the
-- settings/skills UI.
INSERT INTO "skills" ("name", "description", "is_default", "source", "version") VALUES
  ('docx', 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of ''Word doc'', ''word document'', ''.docx'', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a ''report'', ''memo'', ''letter'', ''template'', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation.', true, 'bundled', '1.0.0'),
  ('pdf', 'Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.', true, 'bundled', '1.0.0'),
  ('pptx', 'Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions "deck," "slides," "presentation," or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill.', true, 'bundled', '1.0.0'),
  ('xlsx', 'Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like "the xlsx in my downloads") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved.', true, 'bundled', '1.0.0'),
  ('doc-coauthoring', 'Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.', true, 'bundled', '1.0.0'),
  ('data-viz', 'Render data as a chart (PNG via matplotlib) saved to the sandbox and surfaced inline in the chat. Use when a visual answer (trend, comparison, distribution, KPI) carries the message better than a numeric table.', false, 'bundled', '1.0.0'),
  ('tabular-extraction', 'Extract complete, literal, traceable structured data (CSV, JSON array, row set) from one or more sources of any format. Use when the request implies one record per source occurrence or joining several sources into a single structured output. Do not use for prose summaries, single-value lookups, or open-ended Q&A.', false, 'bundled', '1.0.0');