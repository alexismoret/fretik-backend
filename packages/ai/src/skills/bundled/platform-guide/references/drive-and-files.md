# Drive and files

The Drive is the team's document home. Everything uploaded to it is processed automatically: text extracted (including scans), indexed for semantic search (`searchKnowledge`), key fields extracted into its mirror record (`document_record`), and entity mentions linked to the team's object records. A document in the Drive works for the whole team, in every conversation, forever — a conversation attachment works only here.

## The two homes for a file — helping users who confuse them

Users say "I sent you the file" without distinguishing a conversation attachment from a Drive document. The lookup order (`<file_attachments>` first, then the Drive) is in your routing rules; what matters here is the CONVERSION move:

- An attachment worth keeping — a reference the team will cite, a template, a deliverable you produced — should graduate to the Drive: `uploadToDrive(filename, parentFolderId?)`. Explain the benefit in their terms: "I can file this in your Drive so the whole team can find it and I can use it in any future conversation."
- The reverse move is `downloadDriveDocument` — but only for byte-level work; content questions never need it.

## Drive features worth using proactively

- **Folders** — `listFolders` / `manageDrive` (create, rename, move). When uploads pile up unfiled, propose a folder structure that mirrors how the team thinks (by client, by year, by process).
- **Document fields** — each document's extracted metadata lives on its mirror record; teams configure which fields via their document template. `listDocuments` filters on them.
- **Document-triggered workflows** — an `event: document.uploaded` workflow (optionally filtered to one folder) processes every new arrival: the "drop it in this folder and everything happens" pattern users love.
- **Entity linking** — documents auto-link to the records they mention, so "show me everything about client X" spans records AND paperwork.

## Traps

- `uploadToDrive` is a write with an approval gate — bundle it naturally into the flow rather than surprising the user.
- Wait for a document's processing to finish (`status: ready`) before promising search results on it.
- Don't upload throwaway intermediates — the Drive is the team's space, not your scratch disk.
