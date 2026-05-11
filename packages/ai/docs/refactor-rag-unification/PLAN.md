# Refonte architecture chatbot — RAG unification

> Plan multi-sessions pour pivoter la mémoire/skills/context vers un vector store unifié, aligné industrie 2026 (ChatGPT Enterprise / Anthropic context engineering / Cohere best practices). Architecture **modèle-agnostique**, MiniMax M2.7 first.

---

## 0. Comment utiliser ce plan

Chaque session est **autonome** : un agent fresh peut l'exécuter sans contexte des autres sessions, en suivant le **bloc Pre-flight obligatoire**.

**Workflow par session** :

1. Lire `progress.json` pour l'état courant et les déviations des sessions précédentes
2. Exécuter le **Pre-flight** (recherche web + re-analyse code)
3. Implémenter les **Tasks** dans l'ordre
4. Vérifier via le bloc **Verification**
5. Mettre à jour `progress.json`

**Règle d'or** : si une décision contredit ce que dit ce plan, documenter dans `progress.json.sessions[X].deviations` avec justification.

**Sources industrie de référence** (revue à chaque session) :

- [Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Cohere Rerank docs](https://docs.cohere.com/docs/reranking-with-cohere)
- [Claude Projects — Help Center](https://support.claude.com/en/articles/9517075)
- [ChatGPT Enterprise Company knowledge](https://help.openai.com/en/articles/12628342)
- [pgvector — HNSW with filtering (Crunchy Data)](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- [Multi-tenant vector search (MongoDB)](https://www.mongodb.com/docs/atlas/atlas-vector-search/multi-tenant-architecture/)

---

## 1. Vue d'ensemble

### Problème

Le chatbot Fretik a 4 systèmes parallèles de connaissance (RAG documents, memory tool, skills bundles, chatbot context files) avec des conventions différentes. Le memory tool — calqué sur Anthropic `memory_20250818` — ne s'active pas avec MiniMax M2.7 (constaté : 0/2 utilisations sur tests Alliance Logistics).

### Solution

**Vector store unifié** (`ai_vectors`) avec un enum `source_type` (`documents | memories | skills | context`). Une seule entrée de retrieval (`searchKnowledge`), un seul pipeline de vectorize, des CRUD tools dédiés conservés pour les écritures.

### Pattern industrie

- **ChatGPT Enterprise / OpenAI** : tout le knowledge transite par RAG, pre-computed summaries injectés en system prompt ([source](https://help.openai.com/en/articles/12628342))
- **Claude Projects** : RAG activé automatiquement quand le knowledge base dépasse le contexte ([source](https://support.claude.com/en/articles/9517075))
- **Cohere Rerank** : pas de boost métadata natif — pattern recommandé = **threshold post-rerank + pre-filter** ([source](https://docs.cohere.com/docs/reranking-with-cohere))
- **Source priority** : émerge naturellement de la qualité des embeddings, pas de multiplicateurs explicites ([source](https://medium.com/logspace/beyond-basic-rag-retrieval-weighting-86deb741f5cc))

### Sessions

| #   | Session                                                  | Effort | Préreq   |
| --- | -------------------------------------------------------- | ------ | -------- |
| S1  | Schéma `ai_vectors` + migration `data_vectors`           | ½j     | —        |
| S2  | Vectorize memories + cascade hooks                       | 1j     | S1       |
| S3  | Vectorize skills                                         | ½j     | S1       |
| S4  | Vectorize context files                                  | ½j     | S1       |
| S5  | `searchKnowledge` filter étendu + source-aware prefix    | ½j     | S2,S3,S4 |
| S6  | Memory tool cleanup + retirer manifest memory du prompt  | ½j     | S5       |
| S7  | Audit system prompt + tool descriptions + skills catalog | ½j     | S6       |
| S8  | Tests E2E + observability + métriques                    | ½j     | S7       |

**Total : 4 jours.**

### Gains attendus

| Domaine                                   | Avant    | Après attendu        |
| ----------------------------------------- | -------- | -------------------- |
| Memory utilization (cas pertinents)       | 0%       | ~80%                 |
| Précision globale (memory-relevant convs) | baseline | +5 à +10%            |
| System prompt static prefix tokens        | ~3K      | ~1.5-2K (-30 à -50%) |
| Tool descriptions tokens                  | ~3.5K    | ~2.1K (-40%)         |
| Skills discoverability                    | ~50%     | ~75%                 |

### Hors scope

- Compaction system (déjà state-of-the-art)
- `stepCountIs(30)` (confirmé garder)
- Progressive Disclosure `searchTools` (confirmé garder)
- Sandbox E2B (excellent)
- RAG hybride documents (state-of-the-art, juste étendu)
- Streaming/resumable (pattern officiel Vercel AI SDK 5/6)

---

## 2. Bloc Pre-flight (à inclure au début de chaque session)

> **OBLIGATOIRE — ne pas sauter.** Le but est d'éviter de re-tomber dans le pattern Claude par défaut, et de capturer toute dérive.

### Étape 1 : Lire l'état courant

```
1. Read progress.json
2. Note current_session, last_updated, et toutes les deviations des sessions précédentes
3. Si une session précédente a un blocker non résolu → traiter en priorité
```

### Étape 2 : Recherche web (3 sources minimum)

Pour le domaine de la session, chercher comment ChatGPT / Claude / Anthropic / acteur major 2026 le gère.

Exemples de queries selon la session :

- S1 (schéma vector store) : "vector database multi-tenant single collection separate per type 2026"
- S2 (memory vectorize) : "ChatGPT memory architecture user-scoped team-scoped retrieval 2026"
- S3 (skills) : "Claude Code skills progressive loading SKILL.md vector search 2026"
- S4 (context files) : "Claude Projects knowledge base files RAG vs full context"
- S5 (search filter) : "RAG multiple sources unified search tool filter 2026"
- S6 (cleanup memory tool) : "RAG vs memory tool agent design redundancy 2026"
- S7 (prompt size) : "Claude system prompt length tokens optimization 2026"
- S8 (observability) : "RAG metrics retrieval quality production monitoring 2026"

Ajouter les URLs trouvées dans `progress.json.sessions[X].research_done`. Si une recherche contredit le plan, documenter dans `deviations`.

### Étape 3 : Re-analyse code

Lancer un Explore agent ou Read direct sur les fichiers pertinents pour vérifier :

1. Aucune dérive depuis la session précédente (renames inattendus, suppressions)
2. Les hooks/triggers attendus existent toujours
3. Les types/schémas correspondent à ce que ce plan suppose

Si dérive détectée → documenter dans `deviations` ET adapter les Tasks de la session.

### Étape 4 : Confirmer la portée

Avant de coder, lister les fichiers attendus et estimer l'effort. Si > 50% au-dessus de l'estimation initiale, **stopper** et documenter dans `blockers`.

---

## 3. Sessions

### Session S1 — Schéma `ai_vectors` + migration `data_vectors`

**Effort** : ½j
**Préreq** : aucun
**Sortie** : table renommée + colonnes ajoutées + types TS mis à jour

#### Pre-flight

- Recherche : "vector database multi-tenant single collection separate per type 2026"
- Re-analyse : `backend/packages/shared/src/db/schema/data-vectors.ts`, `drizzle.config.ts`, `relations.ts`

#### Tasks

1. **Renommer `data_vectors` → `ai_vectors`**
   - Drizzle `pgTable("ai_vectors", ...)` au lieu de `data_vectors`
   - Renommer le fichier `schema/data-vectors.ts` → `schema/ai-vectors.ts`
   - Mettre à jour `schema/index.ts` (re-export)
   - Mettre à jour `relations.ts`
   - Trouver tous les imports `dataVectors` via `grep -r "dataVectors"` et les renommer en `aiVectors`

2. **Étendre l'enum `source_type`**
   - Ajouter `'memories' | 'skills' | 'context'` aux valeurs autorisées
   - Garder `'documents'` et `'extractions'` pour la compatibilité ascendante (extractions seront retirées par le user dans un cleanup ultérieur)

3. **Ajouter colonne `user_id` nullable**
   - Type : `uuid` (FK to `users.id` → ON DELETE CASCADE)
   - Default : NULL (= team-scope)
   - Quand UUID = user-scope (memories user, context user)

4. **Ajouter index partiel optimisé**

   ```sql
   CREATE INDEX ai_vectors_team_user_partial
     ON ai_vectors (team_id, user_id)
     WHERE source_type IN ('memories', 'context');
   ```

5. **Générer la migration Drizzle**

   ```bash
   cd backend/packages/shared && bun run db:generate
   ```

   Vérifier que la migration produit bien `ALTER TABLE RENAME` + `ALTER TABLE ADD COLUMN` (pas DROP/CREATE).

6. **Mettre à jour le subpath export**
   - `package.json` exports : `./db/schema/ai-vectors` au lieu de `./db/schema/data-vectors`

#### Files modified

- `backend/packages/shared/src/db/schema/data-vectors.ts` → renommer en `ai-vectors.ts`
- `backend/packages/shared/src/db/schema/index.ts`
- `backend/packages/shared/src/db/relations.ts`
- `backend/packages/shared/package.json` (exports)
- `backend/packages/shared/drizzle/<new-migration>.sql`
- Tous les imports dans `backend/packages/ai/`, `backend/packages/api/`, `backend/packages/worker/`

#### Verification

- `bun run check` dans `backend/packages/shared` (typecheck + lint + format)
- `bun run check` dans `backend/packages/ai`
- `bun run db:migrate` (apply migration)
- Inspecter en SQL : `\d ai_vectors` doit montrer `user_id` colonne et l'index partiel
- Vérifier qu'aucune row n'a été perdue : `SELECT COUNT(*) FROM ai_vectors;` = même count que `data_vectors` avant

#### Update progress.json

- Sessions[S1].status = "completed"
- Sessions[S1].research_done = [3 URLs minimum]
- Sessions[S1].deviations = [...]
- global_metrics.system_prompt_tokens_before = (mesurer avant changement)

---

### Session S2 — Vectorize memories + cascade hooks

**Effort** : 1j
**Préreq** : S1
**Sortie** : memories vectorisées au write path + cascade delete

#### Pre-flight

- Recherche : "ChatGPT memory architecture user-scoped team-scoped retrieval 2026"
- Re-analyse : `backend/packages/ai/src/tools/memory.ts`, `backend/packages/shared/src/services/ai-memory/`

#### Tasks

1. **Créer `services/vectorize/memories.ts`**
   - Function `vectorizeMemory({ memoryId, scope, content, userId, teamId, organizationId, path })`
   - Réutilise `chunker.ts` (markdown-aware) avec `MEMORY_TARGET_TOKENS` (~256 — memories sont courtes)
   - Réutilise `contextual-enrichment.ts` mais avec **source-aware prefix** : `[TEAM_MEMORY] {path}` ou `[USER_MEMORY] {path}` injecté avant le contenu
   - Appelle `upsert.ts` avec `sourceType: 'memories'`, `sourceId: memoryId`, `userId: userId | null`

2. **Hook write path**
   - Dans `backend/packages/shared/src/services/ai-memory/create.ts` : après INSERT, fire-and-forget `vectorizeMemory(...)`
   - Dans `overwrite.ts` : DELETE old vectors → `vectorizeMemory(...)`
   - Dans `delete.ts` : DELETE FROM ai_vectors WHERE source_type='memories' AND source_id=memoryId
   - Dans `rename.ts` : re-vectorize (path apparait dans le contextual prefix)

3. **Backfill script** : indexer les memories existantes une fois
   - `bun run scripts/backfill-memory-vectors.ts` (one-shot)
   - Idempotent (DELETE + INSERT par memoryId)

4. **Tests unitaires**
   - vectorize une memory team → row insérée avec `user_id IS NULL`
   - vectorize une memory user → row insérée avec `user_id = X`
   - delete memory → cascade vector delete
   - rename memory → re-vectorize OK

#### Files modified

- `backend/packages/ai/src/services/vectorize/memories.ts` (nouveau)
- `backend/packages/ai/src/services/vectorize/contextual-enrichment.ts` (ajouter param `sourceType` au prefix builder)
- `backend/packages/shared/src/services/ai-memory/create.ts`
- `backend/packages/shared/src/services/ai-memory/overwrite.ts`
- `backend/packages/shared/src/services/ai-memory/delete.ts`
- `backend/packages/shared/src/services/ai-memory/rename.ts`
- `backend/packages/ai/scripts/backfill-memory-vectors.ts` (nouveau, one-shot)

#### Verification

- `bun run check` packages affectés
- Tests : `bun test backend/packages/ai/src/services/vectorize/memories.test.ts`
- E2E : créer une memory via le tool, vérifier en SQL `SELECT * FROM ai_vectors WHERE source_type='memories'`
- E2E Alliance Logistics : `searchKnowledge(question="format CSV TARIF_AFFRETEMENT")` doit retourner un chunk de la memory dans le top-5

#### Update progress.json

---

### Session S3 — Vectorize skills

**Effort** : ½j → revisé à ¾j (inclut migration schéma)
**Préreq** : S1
**Sortie** : skills SKILL.md + references/\*.md indexés dans `ai_vectors`, scope global proprement supporté

#### Décisions architecturales clarifiées (cf. deviation_log entry "skills_global_scope")

- **Pas de table `ai_skills` créée maintenant.** Skills restent en filesystem bundled (versionnés avec le code, multi-fichiers dont du Python helper). Une table arrivera plus tard si/quand des skills dynamiques per-team apparaissent ; ce sera additif et ne nécessitera **aucune migration de `ai_vectors`** (juste `team_id = X` au lieu de NULL).
- **Skills globaux = `team_id IS NULL` + `organization_id IS NULL`.** Pas de NIL UUID sentinel (casserait la FK, sémantique cachée).
- **Migration S1-bis intégrée à S3** : on relaxe `team_id` et `organization_id` à nullable, avec CHECK constraint pour empêcher les états incohérents.
- **Source_id stable via lookup** : `Bun.randomUUIDv7()` minté à la première vectorisation, persisté implicitement dans `ai_vectors` (pas de table de registre). Re-vectorisations subséquentes ré-utilisent le même `source_id` retrouvé via `metadata.skill_name`. Garde l'invariant idempotent `DELETE WHERE (source_type, source_id)` du service `upsert.ts` existant.
- **Vectoriser SKILL.md + references/\*.md ; PAS scripts/\*.py.** Le code est consommé par l'agent via `load_skill()` au runtime, pas pour retrieval.

#### Pre-flight

- **Recherche obligatoire** (3 sources min) : "Claude Code skills progressive loading SKILL.md vector search 2026", "global vs tenant scope vector store hybrid", "Postgres CHECK constraint multi-column nullability pattern".
- **Re-analyse code** :
  - `backend/packages/shared/src/db/schema/ai-vectors.ts` — confirmer que `team_id` et `organization_id` sont **toujours** NOT NULL après S1+S2 (ils le sont)
  - `backend/packages/ai/src/skills/bundled/` — lister les 9 skills, identifier pour chaque la liste exacte des `.md` files (SKILL.md + references/\*) à vectoriser
  - `backend/packages/ai/src/skills/materialize.ts` — point d'extension pour le hook boot
  - `backend/packages/ai/src/services/vectorize/{index,upsert}.ts` — confirmer la signature `VectorizeSourceInput` post-S2 (notamment le champ `userId`) pour passer `null` proprement sur les skills
  - `backend/packages/ai/src/services/vectorize/index.ts` :: `buildMemorySemanticHeader` — réutiliser le pattern pour `buildSkillSemanticHeader`
- **Confirmer existence** de `Bun.randomUUIDv7()` dans la version Bun installée (devrait être disponible depuis Bun 1.1.30+).

#### Tasks

1. **Migration `ai_vectors` : autoriser le scope global**

   ```sql
   -- Make scope columns nullable (NULL = global)
   ALTER TABLE ai_vectors ALTER COLUMN team_id DROP NOT NULL;
   ALTER TABLE ai_vectors ALTER COLUMN organization_id DROP NOT NULL;

   -- Coherence: either both NULL (global) or both set (tenant-scoped)
   ALTER TABLE ai_vectors ADD CONSTRAINT ai_vectors_scope_consistency
     CHECK (
       (team_id IS NULL AND organization_id IS NULL)
       OR (team_id IS NOT NULL AND organization_id IS NOT NULL)
     );

   -- Hot-path index for global rows (skills today, possibly future global content)
   CREATE INDEX idx_ai_vectors_global
     ON ai_vectors (source_type)
     WHERE team_id IS NULL;
   ```

   Côté Drizzle schéma TypeScript : retirer `.notNull()` sur `teamId` et `organizationId`, ajouter le CHECK via `pgTable(..., (t) => [check('ai_vectors_scope_consistency', sql`...`)])`. Régénérer la migration.

   ⚠ **Attention enum / partial index gotcha** : ce sera la 2e migration sur `ai_vectors`. La 1ère (S1) a réécrit l'enum à cause d'un index partiel référençant des nouvelles valeurs. Cette migration-ci ne touche pas à l'enum, devrait être directe. Si problème → split en 2 fichiers de migration séparés.

2. **Créer `backend/packages/ai/src/services/vectorize/skills.ts`**

   Signature :

   ```typescript
   export async function vectorizeSkill(input: {
     name: string; // "xlsx", "pdf", etc.
     files: Array<{
       relativePath: string; // "SKILL.md" or "references/csv-format.md"
       content: string; // markdown content
     }>;
     description: string; // from SKILL.md frontmatter
     contentHash: string; // SHA-256 of all file contents combined
   }): Promise<{ sourceId: string; chunkCount: number; created: boolean }>;
   ```

   Logique :
   - **Lookup existant** : `SELECT DISTINCT source_id FROM ai_vectors WHERE source_type='skills' AND metadata->>'skill_name' = $name LIMIT 1`
   - Si trouvé : reuse ce `source_id`. Si content_hash en metadata identique → skip (no-op idempotent). Sinon DELETE+INSERT.
   - Si pas trouvé : `const sourceId = Bun.randomUUIDv7()`. INSERT.
   - Pour chaque fichier `.md`, chunker + contextual enrichment + embedder, avec metadata par chunk :
     ```typescript
     {
       skill_name: "xlsx",
       skill_file: "SKILL.md",        // ou "references/csv-format.md"
       skill_description: "...",       // frontmatter description
       content_hash: "abc123...",      // SHA-256 du fichier source
       version_indexed_at: "2026-..."
     }
     ```
   - **Source-aware contextual prefix** (réutiliser pattern S2 `buildMemorySemanticHeader`) : `[SKILL:{name}/{file}] {description}` injecté en tête de chaque chunk avant embedding.
   - `team_id: null`, `organization_id: null`, `user_id: null`.
   - Réutiliser le service `upsert.ts` existant. Étendre `VectorizeSourceInput` ou ajouter une discriminated branch `'skills'` au handler `/internal/vectorize`.

3. **Hook boot/deploy dans `backend/packages/ai/src/skills/materialize.ts`**

   Au boot du service AI, après `loadSkillCatalog()`, fire-and-forget :
   - Pour chaque skill bundled, calculer `contentHash` (SHA-256 sur SKILL.md + références concaténés).
   - Appeler `vectorizeSkill(...)` — la fonction est idempotente via le content_hash check.
   - Fire-and-forget (void-prefixed), pattern aligné S2. Erreurs logged, never thrown.

4. **Cleanup retired skills**

   Au même hook boot, après vectorisation des skills présents :
   - `SELECT DISTINCT metadata->>'skill_name' AS name FROM ai_vectors WHERE source_type='skills'` → liste des skills indexés
   - Diff avec la liste des skills bundled actuels
   - Pour chaque skill retiré : `DELETE FROM ai_vectors WHERE source_type='skills' AND metadata->>'skill_name' = $oldName`

5. **Tests d'intégration** dans `backend/packages/ai/tests/services/vectorize/skills.test.ts`
   - Vectorize un skill bundled fictif (fixture) → rows insérées avec `team_id IS NULL`, `organization_id IS NULL`, `user_id IS NULL`
   - Re-vectorize même skill avec content identique → no-op (content_hash match)
   - Re-vectorize même skill avec content modifié → DELETE+INSERT, mêmes `source_id`, chunks différents
   - Vectorize 2 skills distincts → 2 `source_id` distincts (Bun.randomUUIDv7 minté pour chacun)
   - CHECK constraint : tenter d'insérer une row `team_id=X, organization_id=NULL` → erreur PG

#### Files modified

- `backend/packages/shared/src/db/schema/ai-vectors.ts` (drop NOT NULL × 2, ajout CHECK constraint)
- `backend/packages/shared/drizzle/<new-migration>.sql` (généré + éventuellement édité manuellement)
- `backend/packages/ai/src/services/vectorize/skills.ts` (nouveau)
- `backend/packages/ai/src/services/vectorize/index.ts` (ajouter `buildSkillSemanticHeader` + extension VectorizeSourceInput)
- `backend/packages/ai/src/handlers/vectorize.ts` (ajouter branche `'skills'` dans le discriminated union Zod)
- `backend/packages/ai/src/skills/materialize.ts` (hook boot)
- `backend/packages/ai/tests/services/vectorize/skills.test.ts` (nouveau)

#### Verification

- `bun run check` sur shared + ai
- Tests : `bun test backend/packages/ai/tests/services/vectorize/skills.test.ts`
- En SQL après boot du service AI :
  - `\d ai_vectors` → `team_id` et `organization_id` nullable, CHECK constraint présente
  - `SELECT skill_name, COUNT(*) FROM ai_vectors WHERE source_type='skills' AND metadata IS NOT NULL, jsonb_to_record(...)` → 9 skills indexés
  - `SELECT COUNT(*) FROM ai_vectors WHERE team_id IS NULL` → > 0 (skills globaux)
  - `SELECT COUNT(*) FROM ai_vectors WHERE source_type='skills' AND team_id IS NOT NULL` → 0
- E2E : appel direct au service de search avec query "comment générer un fichier Excel" doit faire remonter au moins un chunk du skill `xlsx` dans le top-10 (avant filter `sourceTypes` qui sera implémenté en S5).
- No-op idempotent au reboot : second boot → `SELECT COUNT(*) FROM ai_vectors WHERE source_type='skills'` reste identique, pas de nouvelle row.

#### Update progress.json

- `Sessions[S3].status = "completed"`
- `Sessions[S3].research_done = [3+ URLs]`
- `Sessions[S3].code_changes = [...]`
- `Sessions[S3].deviations = [...]` (si découverte de cas non-prévus)
- `Sessions[S3].verification_results = { check_pass, tests_passing, ai_vectors_scope_columns_nullable, scope_check_constraint_present, global_skills_indexed_count, no_op_reboot_verified, ... }`
- Ajouter rollback détaillé dans `rollback_runbook.S3_rollback`

---

### Session S4 — Vectorize context files

**Effort** : ½j
**Préreq** : S1
**Sortie** : context files indexés au moment où `status='ready'`

#### Pre-flight

- Recherche : "Claude Projects knowledge base files RAG vs full context 2026"
- Re-analyse : `backend/packages/shared/src/services/ai-context/upload.ts`, `aiContextFiles` schema

#### Tasks

1. **Créer `services/vectorize/context.ts`**
   - Function `vectorizeContextFile({ fileId, profileId, scope, userId, teamId, organizationId, filename, content })`
   - `sourceType: 'context'`, `sourceId: fileId`
   - `user_id: NULL` si scope='team', `user_id: userId` si scope='user'
   - Contextual prefix : `[CONTEXT_FILE] {filename}` avant le content

2. **Hook status='ready'**
   - Dans `services/ai-context/upload.ts`, dans le bloc qui passe `status` à `'ready'` après extraction Mistral OCR : fire-and-forget `vectorizeContextFile(...)`
   - Dans `delete-file.ts` (ou équivalent) : DELETE FROM ai_vectors WHERE source_type='context' AND source_id=fileId

3. **Backfill** : indexer les context files existants (status='ready') une fois
   - `bun run scripts/backfill-context-vectors.ts`

4. **Tests** :
   - Upload context file team → vector indexé avec `user_id IS NULL`
   - Upload context file user → vector indexé avec `user_id = X`
   - Delete file → cascade vector delete
   - File en status `'error'` → pas indexé

#### Files modified

- `backend/packages/ai/src/services/vectorize/context.ts` (nouveau)
- `backend/packages/shared/src/services/ai-context/upload.ts` (hook ready)
- `backend/packages/shared/src/services/ai-context/delete-file.ts` (hook delete)
- `backend/packages/ai/scripts/backfill-context-vectors.ts` (one-shot)

#### Verification

- E2E : upload un PDF de conventions team, vérifier que le contenu est searchable via `searchKnowledge`
- En SQL : `SELECT * FROM ai_vectors WHERE source_type='context' AND user_id IS NULL` → match les team context files

#### Update progress.json

---

### Session S5 — `searchKnowledge` filter étendu + source-aware prefix

**Effort** : ½j
**Préreq** : S2, S3, S4
**Sortie** : tool schema mis à jour, hybrid search scoping userId, contextual prefix per-source

#### Pre-flight

- Recherche : "RAG multiple sources unified search tool filter 2026"
- Re-analyse : `backend/packages/ai/src/tools/rag-search.ts`, `backend/packages/ai/src/services/search/hybrid-search.ts`

#### Tasks

1. **Étendre tool schema `searchKnowledge`**
   - `sourceTypes` enum : `'documents' | 'memories' | 'skills' | 'context'`
   - Default : tous les sourceTypes (search broad)
   - Description mise à jour : « search across all team knowledge: documents, memories, skills, context files »
   - Garder `sourceIds` pour les filtres précis

2. **Étendre `hybrid-search.ts` scoping** ⚠ filter critique post-S3

   Le filter SQL actuel a `WHERE team_id = $teamId` strict. Il doit devenir :

   ```sql
   WHERE (team_id = $teamId OR team_id IS NULL)              -- tenant + globaux (skills)
     AND (user_id IS NULL OR user_id = $userId)              -- team-scope + user-scope owner
     AND (organization_id = $orgId OR organization_id IS NULL)  -- mêmes règles que team_id
     AND ...
   ```

   Le CHECK constraint `ai_vectors_scope_consistency` (introduit en S3) garantit que `team_id` et `organization_id` sont soit **tous deux NULL** (global), soit **tous deux non-NULL** (tenant-scoped). Donc `(team_id IS NULL)` implique `(organization_id IS NULL)` — les deux predicates sont symétriques mais on les écrit explicitement pour la clarté + perf (le planner peut hit l'index `idx_ai_vectors_global` directement).

   **Pas de NIL UUID sentinel.** Le pattern `team_id IS NULL` est sémantiquement honnête et déjà supporté par les index.

   **Tester** : query par team A doit voir docs/memories de A + skills globaux ; ne doit PAS voir docs de team B ni memories user de team A non-owner.

3. **Source-aware contextual prefix**
   - Vérifier que tous les vectorize services (S2-S4) injectent bien le bon prefix `[TEAM_MEMORY]`, `[USER_MEMORY]`, `[SKILL:name/file]`, `[TEAM_CONTEXT]`, `[USER_CONTEXT]`. Documents conservent le format descriptif `[Document: filename | Type: ... | Entity: ...]` (S5 deviation #1, retrofit non-fait pour cause de coût-cosmétique).
   - ~~Ajouter aussi `[DOCUMENT]` au pipeline existant `services/vectorize/documents.ts` pour cohérence~~ — **dropped en S5** (deviation #1) : les documents gardent leur header bracketé descriptif, qui porte déjà le signal source-type pour l'embedder/reranker.

4. **Tests d'intégration**
   - Query mixed : retourne hits de plusieurs sourceTypes
   - Query avec filter `sourceTypes: ['memories']` : retourne uniquement memories
   - Query user A : ne voit pas memories user de B
   - Query team : voit memories team + memories user A si query par user A

#### Files modified

- `backend/packages/ai/src/tools/rag-search.ts`
- `backend/packages/ai/src/services/search/hybrid-search.ts`
- `backend/packages/ai/src/services/vectorize/contextual-enrichment.ts` (ajouter `[DOCUMENT]` prefix pour cohérence)
- `backend/packages/ai/src/services/vectorize/documents.ts` (re-vectorize ?)

#### Verification

- E2E Alliance Logistics : agent reçoit chunk memory `carriers/alliance-logistics.md` via `searchKnowledge` sans appeler `memory.view`
- CSV produit suit le format prescrit (1 ligne/département, 86 lignes)
- Logs : nouveau log `memoryRagHits` augmente

#### Update progress.json

---

### Session S6 — Memory tool cleanup + retirer manifest memory du prompt

**Effort** : ½j
**Préreq** : S5
**Sortie** : `grep` retiré, description compressée, manifest retiré du system prompt

#### Pre-flight

- Recherche : "RAG vs memory tool agent design redundancy 2026"
- Re-analyse : `backend/packages/ai/src/tools/memory.ts`, `backend/packages/ai/src/agents/chatbot/system-prompt.md`, `backend/packages/shared/src/services/ai-memory/list-index.ts`

#### Tasks

1. **Retirer `grep` command de `memory` tool**
   - Schema : enum `command` perd `'grep'`
   - Switch case : retire le bloc grep
   - Description : retire les lignes correspondantes
   - **Important** : laisser le service `services/ai-memory/grep.ts` en place (utilisable depuis l'UI / debug), juste retirer du tool surface

2. **Compresser la description du memory tool**
   - Cible : ~200 tokens (vs ~600 actuels)
   - Retirer : workflow heuristics détaillées, examples verbeux
   - Garder : description concise des 5 commandes restantes (view/create/overwrite/delete/rename), namespaces user/team, audit team

3. **Retirer le manifest memory du system prompt**
   - Dans `system-prompt.md` : retirer le bloc `<persistent_memory>` avec `{{memoryIndex}}` (lines ~477-483)
   - Retirer aussi le `MEMORY-FIRST PROTOCOL` bloc ajouté à la session précédente (lines ~149-165)
   - Le `<persistent_memory_protocol>` bloc complet peut être supprimé (le tool's description suffit, et le RAG fait le job)

4. **Retirer `{{memoryIndex}}` placeholder + `buildMemoryIndexManifest` call**
   - `agents/chatbot/system-prompt.md` : retirer le placeholder
   - `handlers/chatbot.ts` : retirer le call à `buildMemoryIndexManifest` (lines ~583-597)
   - `agents/shared/prompt-renderer.ts` : retirer le placeholder dans le mapping
   - Le service `buildMemoryIndexManifest` peut rester (utilisable depuis l'UI Settings)

#### Files modified

- `backend/packages/ai/src/tools/memory.ts`
- `backend/packages/ai/src/agents/chatbot/system-prompt.md`
- `backend/packages/ai/src/handlers/chatbot.ts`
- `backend/packages/ai/src/agents/shared/prompt-renderer.ts`

#### Verification

- `bun run check` packages affectés
- Inspect rendered system prompt : aucune mention de `<persistent_memory>` ou `MEMORY-FIRST PROTOCOL`
- Tool description count : `wc -c` sur la description doit être ~30% de l'original
- E2E Alliance Logistics : agent ne fait pas `memory.view`, mais utilise `searchKnowledge` et obtient le bon contenu

#### Update progress.json

---

### Session S7 — Audit system prompt + tool descriptions + skills catalog

**Effort** : ½j
**Préreq** : S6
**Sortie** : -20% sur sections narratives, -40% tool descriptions, -65% skills catalog

#### Pre-flight

- Recherche : "Claude system prompt length tokens optimization 2026"
- Re-analyse : `backend/packages/ai/src/agents/chatbot/system-prompt.md`, all `backend/packages/ai/src/tools/*.ts`, `backend/packages/ai/src/skills/bundled/*/SKILL.md` (frontmatter)

#### Tasks

1. **Audit system prompt**
   - Sections candidates : `<vague_prompts>`, `<visual_diagrams>`, `<file_attachments>` (vision sub-section), `<sandbox_constraints>` (edge cases)
   - Cible : -20% tokens sur ces sections (~400-600 tokens économisés)
   - Garder strict : SQL rules, citations, schema, extraction workflow

2. **Audit tool descriptions**
   - Cible : ~150 tokens par tool (vs ~250 moyenne actuelle)
   - Règle : description = « quand utiliser ce tool », pas « comment l'utiliser parfaitement »
   - Tools à raccourcir en priorité : `memory` (déjà fait en S6), `read`, `python`, `bash`, `searchKnowledge`
   - Total cible : 14 tools × 150 = ~2.1K tokens (vs ~3.5K actuel)

3. **Raccourcir skills L1 catalog**
   - Dans chaque `SKILL.md` frontmatter, raccourcir la `description` à ~80 tokens (vs ~250 actuel)
   - 9 skills × 80 = ~720 tokens (vs ~2.2K actuel)

4. **Mesurer avant/après**
   - `bun run scripts/measure-system-prompt-tokens.ts` (nouveau, simple chars/4 estimator)
   - Stocker `before` / `after` dans `progress.json.global_metrics`

#### Files modified

- `backend/packages/ai/src/agents/chatbot/system-prompt.md`
- `backend/packages/ai/src/tools/*.ts` (descriptions)
- `backend/packages/ai/src/skills/bundled/*/SKILL.md` (frontmatter `description`)
- `backend/packages/ai/scripts/measure-system-prompt-tokens.ts` (nouveau)

#### Verification

- `bun run check` packages affectés
- Mesure : system_prompt_tokens_after / system_prompt_tokens_before ≈ 0.5-0.7
- Test sanity : conversation simple ("liste mes documents") fonctionne toujours
- Test complexe : conversation multi-step (extract data + generate excel) fonctionne toujours

#### Update progress.json

---

### Session S8 — Tests E2E + observability + métriques

**Effort** : ½j
**Préreq** : S7
**Sortie** : conversations témoins archivées, dashboard métriques, plan validé

#### Pre-flight

- Recherche : "RAG metrics retrieval quality production monitoring 2026"
- Re-analyse : structure logs existante, `backend/packages/ai/src/handlers/chatbot.ts` (logs émis)

#### Tasks

1. **Conversations témoins**
   - Replay Alliance Logistics : vérifier que CSV produit suit le format prescrit
   - Replay 3-5 autres conversations representatives :
     - Conversation simple (single fact lookup)
     - Conversation extraction (multi-step + skill)
     - Conversation drill-down explicite (« lis le contrat X.pdf »)
     - Conversation cross-source (info dans memory + document)
     - Conversation user-scope memory (info perso d'un user)
   - Comparer pre/post : tool calls, tokens, latence, qualité output

2. **Métriques d'observabilité**
   - Ajouter logs structurés :
     - `memoryRagHits` : nombre de chunks `source_type='memories'` retournés par `searchKnowledge` dans cette conversation
     - `skillRagHits`, `contextRagHits`, `documentRagHits` (par cohérence)
     - `memoryToolCalls` : déjà en place, vérifier qu'il continue d'être logué
     - `systemPromptTokens` : log du token count du system prompt rendu

3. **Mettre à jour `global_metrics`** dans `progress.json` :
   - `memory_rag_hits_per_turn_after` (médiane sur 100 conversations témoins)
   - `memory_tool_view_calls_after`
   - `system_prompt_tokens_after`

4. **Documentation finale**
   - Ajouter une section `## Lessons learned` dans ce PLAN.md
   - Ajouter une section `## Migration runbook` avec les commandes exactes pour rollback (drop la colonne user_id, restaurer le manifest, etc.)

#### Files modified

- `backend/packages/ai/src/handlers/chatbot.ts` (ajouter logs)
- `backend/packages/ai/docs/refactor-rag-unification/PLAN.md` (ajouter sections finales)
- `backend/packages/ai/docs/refactor-rag-unification/progress.json` (métriques finales)

#### Verification

- Toutes les conversations témoins passent
- Métriques alignées avec les attentes du plan (`memoryRagHits` augmente, `memoryToolCalls` baisse, prompt tokens baissent)
- Si une métrique dévie significativement (>30% sous attente) : ajouter une session S9 corrective

#### Update progress.json

- Sessions[S8].status = "completed"
- current_session = null
- Ajouter timestamp de complétion globale

---

## 4. Critical files (référence globale)

| Fichier                                                                   | Sessions             | Rôle                               |
| ------------------------------------------------------------------------- | -------------------- | ---------------------------------- |
| `backend/packages/shared/src/db/schema/data-vectors.ts` → `ai-vectors.ts` | S1                   | Schéma table                       |
| `backend/packages/shared/src/db/schema/ai-memory.ts`                      | S2                   | Source de vérité memories          |
| `backend/packages/shared/src/db/schema/ai-context.ts`                     | S4                   | Source de vérité context files     |
| `backend/packages/ai/src/services/vectorize/`                             | S2-S5                | Pipeline d'indexing                |
| `backend/packages/ai/src/services/search/hybrid-search.ts`                | S5                   | Filter scoping                     |
| `backend/packages/ai/src/services/search/reranker.ts`                     | (S5 si oversampling) | Cohere wrapper                     |
| `backend/packages/ai/src/tools/rag-search.ts`                             | S5                   | Tool schema                        |
| `backend/packages/ai/src/tools/memory.ts`                                 | S6                   | Tool cleanup                       |
| `backend/packages/ai/src/agents/chatbot/system-prompt.md`                 | S6, S7               | Prompt cleanup                     |
| `backend/packages/ai/src/skills/bundled/*/SKILL.md`                       | S3, S7               | Source skills                      |
| `backend/packages/ai/src/handlers/chatbot.ts`                             | S6, S8               | Manifest call retiré, logs ajoutés |

---

## 5. Risques + mitigations

| Risque                                               | Probabilité | Impact | Mitigation                                                         | Session       |
| ---------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------ | ------------- |
| Cross-contamination RAG (skill chunk au lieu de doc) | Moyenne     | Moyen  | Source-aware prefix + threshold post-rerank + filter `sourceTypes` | S5            |
| Latence RAG +50ms                                    | Haute       | Faible | HNSW + BM25 indexed parallèle. Acceptable.                         | S5            |
| Migration loss/downtime                              | Faible      | Élevé  | ALTER RENAME + ADD COLUMN instantané. Backup recommandé avant.     | S1            |
| Coût indexing initial                                | Très faible | —      | ~$5-10 one-time                                                    | S2-S4         |
| Régression drill-down                                | Faible      | Moyen  | Tests S8 incluent ce cas                                           | S8            |
| Réintroduire grep si RAG trop imprécis               | Moyenne     | Faible | Code grep préservé dans le service, juste retiré du tool           | S6 reversible |
| MiniMax M2.7 ne s'adapte pas au nouveau pattern      | Faible      | Élevé  | Tests S8 sur conversations témoins. Si pb, S9 corrective.          | S8            |

---

## 6. Out of scope (non touché)

- Compaction system existing (state-of-the-art, mirror Claude Code)
- `stepCountIs(30)` (confirmé)
- Progressive Disclosure `searchTools` (confirmé pour anticipation 30-50 SaaS tools)
- Sandbox E2B (excellent, kernel persistant)
- RAG hybride documents (state-of-the-art, juste étendu aux nouveaux source types)
- Streaming + resumable (Vercel AI SDK 5/6 + Redis)

---

## 7. Sources industrie (à consulter à chaque session)

- [Anthropic — Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [MongoDB — Multi-tenant vector search](https://www.mongodb.com/docs/atlas/atlas-vector-search/multi-tenant-architecture/)
- [Pinecone — Vector database multi-tenancy](https://www.pinecone.io/learn/series/vector-databases-in-production-for-busy-engineers/vector-database-multi-tenancy/)
- [Crunchy Data — HNSW with pgvector](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- [Oso — Secure RAG for SQLAlchemy and pgvector](https://www.osohq.com/post/secure-rag-for-sqlalchemy-and-pgvector)
- [Cohere Rerank — docs](https://docs.cohere.com/docs/reranking-with-cohere)
- [Beyond Basic RAG: Retrieval Weighting (Langflow)](https://medium.com/logspace/beyond-basic-rag-retrieval-weighting-86deb741f5cc)
- [How RAG Document Priority Works (CustomGPT)](https://customgpt.ai/prioritize-documents-in-rag-retrieval-process/)
- [AI Citation Patterns (ChatGPT/Claude/Perplexity)](https://discoveredlabs.com/blog/ai-citation-patterns-how-chatgpt-claude-and-perplexity-choose-sources)
- [Claude Skills Architecture — MindStudio](https://www.mindstudio.ai/blog/claude-code-skills-architecture-progressive-context-loading)
- [Claude Projects — Help Center](https://support.claude.com/en/articles/9517075-what-are-projects)
- [ChatGPT 5K Character Attachment Rule](https://www.mindstudio.ai/blog/chatgpt-5k-character-attachment-rule-context-window)
- [ChatGPT Enterprise — Company knowledge](https://help.openai.com/en/articles/12628342-company-knowledge-in-chatgpt-business-enterprise-and-edu)
- [Azure AI Search — Agentic retrieval](https://learn.microsoft.com/en-us/azure/search/retrieval-augmented-generation-overview)
- [RAGOps — Operating RAG Pipelines](https://arxiv.org/html/2506.03401v1)

---

## 8. Lessons learned

Distilled from S1→S8. Each lesson points back to the session where it was paid for.

- **Drizzle migrations on enum + partial index can't share a transaction (PG 17).** When a partial index references new enum values, `ALTER TYPE … ADD VALUE` fails in the same transaction even when split across files (drizzle-kit wraps everything in one tx). Default to "rebuild the enum from scratch" — rename old enum, `CREATE TYPE` with all values, `ALTER COLUMN TYPE … USING text cast`, `DROP TYPE old`. (S1 deviation_log: `migration_strategy`)
- **CHECK constraint with multiple source types forces an explicit scope decision per type.** The 2-arm shape (skills both NULL / others both set) didn't accommodate context user-scope (team_id NULL + organization_id set + user_id set). Reshaped to 3 arms in S4. Adding any future `source_type` now requires extending or adding a CHECK arm — that's the right place to think about scope consequences. (S3 + S4 deviation_log: `S4_check_constraint_3arm`)
- **Source-aware contextual prefix should be symmetrical, not literal.** The plan's `[CONTEXT_FILE] {filename}` was replaced by `[TEAM_CONTEXT] file:X` / `[USER_CONTEXT] file:X` to mirror `[TEAM_MEMORY]` / `[USER_MEMORY]` (S2). Symmetry helps the embedder + reranker pick up the scope discriminator; literal source-type tags are weaker. (S4 deviation #2)
- **"Audit then drop" beats reflex compression on the static prefix.** The Anthropic April 2026 postmortem flagged verbosity-reduction meta-instructions as a quality regression; we re-read all S7 candidates line-by-line and dropped 6/7 compressions. The cacheable static prefix lives at 0.25-0.5× rate, so a 200-token saving rarely beats the cost of one mis-routed tool call (5K-10K tokens). (S7 deviations 1-3)
- **Golden dataset = capture LIVE versionned + replay deterministic counters > synthétique scenarios.** Synthetic Q&A pairs miss the multi-turn drift that MiniMax M2.7 exhibits on long prompts; capturing real conversations (via `dump:conversation`) and asserting on counter deltas (`ragHits.memories`, `memoryCommands.view`) gives a stable regression signal even though the model's text output is non-deterministic. (S8 Task 3-4 design)

---

## 9. Migration runbook (consolidated)

For real rollback, apply in chronological reverse (S8 → S1). Each session's individual rollback steps live in `progress.json.rollback_runbook.S{N}`; this section just documents the order + dependencies.

1. **S8 (pure code, no SQL).** Revert `handlers/chatbot.ts` (drop turn-metrics emission + `extractPartsTelemetry`), delete `scripts/{dump-conversation,replay-conversations,measure-rag-metrics}.ts` + their `package.json` entries, delete `evals/fixtures/conversations/*.json`, revert the 7 `void mock.module(...)` edits in `tests/{lib/sandbox-fixture,tools/python.test,tools/download-drive-document.test}.ts`. PLAN.md sections 8 + 9 stay (they're documentation, harmless).
2. **S7 (pure code).** Delete `scripts/measure-system-prompt-tokens.ts`, drop `gpt-tokenizer` dep + `measure:tokens` script, `bun install`. No content changes were made.
3. **S6 (pure code).** Restore `tools/memory.ts` grep command + 622-token description, restore `<persistent_memory_protocol>` + `<persistent_memory>` blocks in `system-prompt.md`, restore `buildMemoryIndexManifest` call + Promise.all 3rd branch + `memoryIndexManifest` field in `chatbot.ts`/`agents/chatbot/index.ts`/`agents/shared/runtime-context.ts`/`agents/shared/prompt-renderer.ts`. Reverting brings back the per-turn ~1400-token static-prefix manifest.
4. **S5 (pure code).** Revert `services/search/hybrid-search.ts` to teamId-only strict filter (drop the 3-arm OR predicate, drop `or, isNull` imports), revert `services/search/index.ts` (drop organizationId + userId from SearchRagInput), revert `tools/rag-search.ts` (restore the previous narrower description), delete `tests/services/search/hybrid-search.test.ts`. Schema/indexes untouched. Effect: user-scope memories + user-scope context + global skills become invisible to `searchKnowledge` (still written, just not retrieved).
5. **S4 (1 migration to roll back).** `DELETE FROM ai_vectors WHERE source_type='context'`, drop the 3-arm CHECK, restore S3's 2-arm CHECK, code-revert `vector-refresh.ts` + upload/delete hooks + handlers/vectorize.ts context branch + tests. Migration: `20260509164228_dusty_tarantula`.
6. **S3 (1 migration to roll back, the most complex).** `DELETE FROM ai_vectors WHERE source_type='skills' OR team_id IS NULL`, drop `idx_ai_vectors_global`, drop the 2-arm CHECK, `ALTER TABLE … SET NOT NULL` on team_id + organization_id (only safe after the DELETE above). Code-revert `services/vectorize/skills.ts` + `materialize.ts` boot hook + `services/vectorize/index.ts` source-aware header dispatch (restore the original ternary). **KEEP the chunker.ts fix** — that one-line removal of `&& sep !== ''` is a real bug fix latent for any future content with monolithic blobs > 2.5KB. Migration: `20260509150618_fixed_nuke`.
7. **S2 (pure SQL + code).** `DELETE FROM ai_vectors WHERE source_type='memories'`, revert `services/ai-memory/{create,overwrite,delete,rename}.ts` hooks + delete `services/ai-memory/vector-refresh.ts`. No migration — S2 introduced no schema change of its own.
8. **S1 (table rename + enum extension to undo).** Recreate enum `data_vector_source_type` with the 2 original values, swap column type, drop `user_id`, drop `idx_ai_vectors_team_user_partial`, rename table + indexes back to `data_vectors_*`. Code-revert all `aiVectors`/`AiVectorSourceType` exports across @fretik/shared + @fretik/ai (~14 files). Migration: `20260509011105_polite_patch`.

Step ordering matters: each session's rollback assumes later sessions are already rolled back. Skip a step and the constraints from below will reject the change. The data CASCADE rules mean conversation rows + their messages disappear cleanly when a parent organization or team is dropped, but `ai_vectors` rows are not auto-deleted on schema rollback — always run the `DELETE FROM ai_vectors WHERE …` filters first as documented above.
