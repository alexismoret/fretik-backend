# Plan — apprentissage procédural des agents Fretik (chatbot et workflows)

> Document de plan uniquement. Rien n'est implémenté. v1 rédigée le 2026-09-14
> après lecture du code (`packages/ai`, `packages/shared`, `packages/jobs`,
> `packages/workflows`, `packages/providers`) et une revue de la littérature et
> des produits comparables ; v2 le 2026-09-15 après lecture des papiers en
> texte intégral, un état de l'art de la transparence des mémoires apprises, la
> doctrine `.agent/agent-context-framework.md`, la carte des surfaces front
> existantes et une revue critique de la v1 face au code. Les chemins cités
> sont ceux du dépôt.

## 0. Résumé exécutif

**Le problème.** Un run de workflow ou un tour de chat repart à zéro à chaque fois :
il relit les skills, redécouvre le schéma d'une external app, refait les mêmes
erreurs (chemins imbriqués PbyP, appels `python` trop petits) et ne converge
qu'à la fin. La mémoire existante (`ai_memories`, `ai_episodes`) est une mémoire
de **connaissances métier** de l'équipe : elle jette explicitement la mécanique
outil (`distill-conversation.ts` : « Skip pleasantries, tool mechanics,
step-by-step narration »), ne lit jamais les arguments ni les erreurs des tool
calls, ignore les runs échoués, et n'a pas de scope « workflow ». Elle ne peut
donc pas porter l'auto-amélioration procédurale, et il ne faut pas la détourner
pour ça.

**Les décisions proposées.**

1. **Trois artefacts, un socle.** (a) Workflows → **recettes de run**
   attachées par `workflowId`, dérivées des derniers runs réussis. (b) Chat →
   **skills apprises**, proposées comme brouillons dans la page Skills et
   activées par un admin. (c) Chat et workflows → **notes apprises par app**
   (`learned/howto/<provider>.md`), servies dans le SKILL du provider au moment
   où l'agent le lit. Socle : un **ledger de trajectoires** déterministe, sans
   LLM, dérivé de ce qui est déjà persisté (`ai_messages.parts` contient chaque
   tool call avec `input` et `output`).
2. **Le code brut d'abord, et les appels regroupés.** Une recette v1 = le code
   `python` du dernier run réussi, avec les appels qui s'enchaînent **sans
   décision du modèle entre eux** fusionnés en un seul script par une règle
   mécanique ; les corps de skills lus à chaque run, **rendus dans le prompt du
   run** plutôt que relus ; un snapshot `schema.json` (`describe_collection`,
   `whoami`) tagué par la version du SKILL du provider. Aucune passe LLM : les
   agents sont fidèles aux traces brutes, pas aux leçons condensées
   (section 3.2).
3. **Toute compilation est jugée par l'historique, jamais par un modèle.** Un
   script candidat, qu'il fusionne des appels ou qu'il remplace une
   vérification que le modèle faisait de tête, est **rejoué sur les entrées des
   N derniers runs réussis** et doit reproduire exactement ce qu'ils avaient
   produit, sinon il est jeté. Les runs passés sont un jeu de test gratuit et
   déterministe. C'est ce qui permet de laisser un modèle _proposer_ des
   optimisations sans lui laisser le dernier mot. Le rejeu n'existe qu'en
   lecture : une écriture n'est jamais fusionnée ni compilée automatiquement.
4. **L'optimiseur LLM est un palier ultérieur, conditionné aux mesures** :
   deltas fusionnés de façon déterministe, ≤ 5 pitfalls conditionnels avec
   preuve, compteurs utile/nuisible, état `converged`. Il n'est construit que si
   les recettes verbatim plafonnent.
5. **Une échelle de promotion chiffrée pour l'exécution par le harnais**
   (`scripted` : ≥ 10 succès et ≥ 90 % de séquence identique ; `no-LLM` :
   ≥ 50 et clic humain), avec rétrogradation au premier échec. Palier tardif,
   optionnel par workflow.
6. **Rien n'est appris en silence, rien n'est appris sur les personnes** :
   carte au moment de l'apprentissage, ligne « Appliqué : … » au moment de
   l'usage, page Skills et page workflow comme surfaces de gestion (provenance,
   versions, statistiques, actions), politique d'équipe, journal d'audit. Les
   apprentissages décrivent des tâches et des apps, jamais la performance d'un
   employé (AI Act, annexe III 4(b)).
7. **Ne pas sur-apprendre, par construction** : les recettes sont dérivées
   (rien ne s'accumule, l'invalidation est gratuite) ; plafonds (≤ 10 skills
   apprises actives par équipe, ≤ 8 notes par app) ; porte d'admission avant
   activation ; retrait fondé sur des compteurs avec plancher d'observations.
8. **Mesure avant défaut** : baseline à budget de tokens égal (recette
   incluse), 3 répétitions, paires avec / sans, injection de dérive, pré-vol de
   conformité par modèle. Mode `shadow` → canary → défaut.

**Gains attendus (hypothèses à valider en palier 0/1 sur le workflow PbyP).**
Sur un workflow stabilisé : −40 à −60 % de steps par run, −30 à −50 % de durée
travaillée, −30 % de tokens d'entrée non cachés, taux de succès ≥ baseline.
Sur le chat, pour une tâche déjà accomplie par l'équipe : −30 % de steps à la
deuxième occurrence. Ordres de grandeur cohérents avec les mesures les plus
proches de notre cas — TraceCompiler : médiane 51 % des appels d'une trace
supprimables (découverte de schéma et répétitions byte-identiques) ;
Tool-Making : p50 −42 %, tokens de sortie −58 % sur des SOP compilés — et avec
la seule mesure interne comparable (le bloc `<standing_memory>` a fait passer
un cas de 11,9 à 5,9 tool calls par tour). Mise en garde de « Worth Their
Tokens » : le gain se mesure **tokens de recette inclus**, contre un agent
vanille qui aurait le même budget.

**Ordre de priorité.** Palier 0 (mesure) → Palier 1 (recettes dérivées sans
LLM + préchauffage sandbox, le gain le plus sûr) → Palier 2 (skills apprises
et notes par app, avec leur visibilité) → Palier 3 (optimiseur LLM et
gouvernance v1, si les chiffres le justifient) → Palier 4 (exécution par le
harnais). Environ 11 à 13 semaines pour une personne ; les paliers 3 et 4 sont
conditionnels et peuvent ne jamais être construits.

---

## 1. Constat : ce que le code fait aujourd'hui

### 1.1 Le tour de chat

- Boucle `ToolLoopAgent` (AI SDK v7), `CHATBOT_MAX_STEPS = 30` par tour,
  sous-agent 25 steps, garde-fou de boucle « steer à 3 échecs identiques, abort
  à 8 » (`agents/shared/agent-builder.ts:364`).
- Prompt système unifié (`agents/shared/agent-system-prompt.md`, 93 Ko) :
  préfixe statique ≈ 16 k tokens (chatbot) + descriptions d'outils + catalogue
  L1 des skills, suffixe dynamique (`<file_attachments>`, `<standing_memory>`,
  `<memory_index>`, `<active_memory>`, `<available_capabilities>`…). Le cache
  préfixe est implicite (préfixe byte-stable) ; tout ce qui est par tour vit
  sous le marqueur `DYNAMIC SUFFIX`. `{{skillsCatalog}}`, `{{externalAppsBlock}}`
  et `{{deferredToolList}}` sont substitués **au-dessus** du marqueur : le
  préfixe est stable par équipe, pas par tour, et toute nouvelle entrée du
  catalogue de skills invalide une fois le cache de l'équipe.
- 37 outils (12 core + 24 domain + `dispatchAgent`), divulgation progressive via
  `searchTools`. Pas d'outil dédié aux skills : l'agent fait
  `read("skills/<name>/SKILL.md")`, servi côté Bun sans aller-retour sandbox
  (`skills/read-skill-file.ts`), mais **chaque fichier lu coûte un step modèle**
  (un aller-retour LLM complet). Les external apps ne sont pas des outils :
  l'agent appelle le SDK Python généré `fretik_apps` depuis `python`, après
  avoir lu le SKILL du provider (règle « skill-first » du prompt, lignes 519-534).
- Ce qui est persisté par tour : `ai_messages.parts` (texte, raisonnement,
  **chaque tool call avec `toolCallId`, `input` non caviardé, `output`,
  `state`**), `metadata.telemetry` (usage, `cachedInputTokens`, `servedBy`),
  `metadata.spend` (steps, coût USD, providers), `metadata.langfuseTraceId`.
  L'événement de journal `chat.turn` porte `toolNames` — écrit, jamais lu.
- Compaction : microcompaction à chaque tour (efface les vieux résultats
  d'outils _stateless_, par lots avec hystérésis pour ne pas casser le cache
  préfixe — mesure dans `services/compaction/microcompact.ts:47-52` : un
  effacement naïf refacturait 58-97 k tokens non cachés pour en économiser
  1,5 k) ; résumé seulement au seuil de contexte. Le résultat d'un `read` de
  skill est microcompactable, celui d'un `python` ne l'est pas
  (`chatbot/tools.ts:138-143`).
- Aucune réutilisation de solutions passées : pas de few-shot d'historique,
  pas de cache de résultats d'outils entre tours ou conversations, pas de
  « conversation similaire ». Le cache de recall est en mémoire, 15 s, pour
  absorber les retries d'un même tour.

### 1.2 Le run de workflow

- Un workflow = un playbook (`goal`, 1-20 `tasks` {`key`, `title`,
  `instructions` ≤ 10 k, `expectedOutput`, `toolHints`}, `deliverable`,
  `successCriteria`), un `triggerType`, une `autonomy`, des
  `externalAppConnectionIds`. **Pas de colonne de version** ; le playbook est
  snapshoté dans `workflow_runs.taskStates` à la création du run.
- Exécution : Trigger.dev (`packages/workflows/src/tasks/workflow-run.ts`)
  pilote des tours via `POST /internal/trigger/runs/:runId/turn` ;
  `WORKFLOW_TURN_MAX_STEPS = 50`, historique limité à 40 messages +
  microcompaction, `NO_PROGRESS` après 2 tours, budget de tokens (6 M par
  défaut), re-ancrage tous les 10 steps, concurrence 3 par workflow.
- Contexte : prompt système **byte-stable pour tout le run** (bloc playbook
  sans statut), message de pilotage par tour (tâche courante, table des
  statuts, `nudge`, `wrapUp`), et **au tour 1 seulement** les blocs mémoire
  (`<active_memory>` retrouvé sur `nom + goal`, `<memory_index>`,
  `<standing_memory>`). **Un run ne voit aucun run précédent.** Le seul canal
  est indirect : l'épisode distillé d'un run réussi, s'il ressort au recall.
- `{{playbookBlock}}` est reconstruit **à chaque tour** depuis la ligne du run
  et la ligne du workflow (`handlers/workflow.ts:421`,
  `agents/workflow/playbook-block.ts:45-92`) : tout ce qui y est rendu doit
  venir d'une source stable pour le run, sinon les octets du prompt changent
  entre deux tours. `ensureSteeringMessage` déduplique en testant que le
  **dernier** message de l'historique est le pilotage de ce tour
  (`workflow.ts:236-244`) — tout message ajouté après lui casse cette
  idempotence. `WorkflowTurnResultSchema.parse` côté orchestrateur et le
  `safeParse` du replay **retirent les clés inconnues** : étendre `usage`
  passe par `WorkflowRunUsageSchema`, pas par « jsonb donc additif ».
- Chaque run a sa propre conversation, donc sa propre sandbox E2B (fraîche,
  `Sandbox.create` 2-5 s puis bootstrap 6-8 s facturés, en série avant le
  premier `python`) ; rien de ce qu'un run écrit comme code ne survit au run
  (`conversation-storage.ts` ne sauvegarde que `attachments/` et `outputs/`).
- Persisté par run : `status`, `taskStates` (+ `summary` par tâche),
  `usage` {input, output, total, cachedInput, turns}, `outputs`, `error`,
  `pausedMs`. **Le nombre de steps et l'histogramme d'outils ne sont pas
  persistés** (`toolCallCount` sert seulement au test de non-progression ;
  `onWorkflowStepEnd` voit pourtant déjà `step.toolCalls`). La trajectoire
  complète est dans `ai_messages` de la conversation du run.
- Succès = mécanique du harnais : toutes les tâches terminales et aucune
  `failed`. L'agent s'auto-évalue par tâche via `completeTask`. Aucun juge,
  aucune vérification du `deliverable`, aucune note humaine sur un run (seul
  `decisionFeedback` par approbation existe, jamais relu).
- Boucles de retour existantes, toutes vers la _définition_, jamais vers
  l'exécution : `recordWorkflowExternalApps` (les apps réellement ouvertes sont
  repliées dans le workflow), `toolHints` (pré-activation d'outils), le
  disjoncteur (5 échecs consécutifs), la boucle builder `run_test → get_run →
update` dans le chat.
- L'exécuteur ne peut ni créer ni modifier un skill en cours de run (doctrine
  `platform-guide/references/workflows.md`, outils `createSkill`/`updateSkill`
  retirés de son registre).

### 1.3 La mémoire

- `ai_memories` : store fichier `/memories/{user,team}/…`, scope `user | team`
  uniquement, écrit par l'outil `memory` ou par la promotion nocturne sous le
  namespace machine `learned/` (`promote-episodes.ts`, porte ADD/UPDATE/NOOP,
  provenance `Sources: episode:<id>`). Pas de GC.
- `ai_episodes` : distillation des conversations (chat **et** runs réussis
  non-test, cron limité à 1/24 h par workflow), digests d'activité de records,
  consolidation « dreaming » à 03:00, démotion à 90 j sans recall. La
  distillation lit **uniquement les parties texte** des messages, 500
  caractères par message, et son prompt exclut la mécanique outil. Les runs
  échoués ne sont pas distillés (`journal-sweep.ts:220-222`).
- Recall : 5 bras (ancres → graphe ; RAG mémoires+épisodes+records ;
  documents ; workflows+pages), sélecteur déterministe, juge sur 43 % des tours,
  bloc ≤ 2 000 caractères. `<standing_memory>` : 600 tokens rendus sans LLM.
- Rien de procédural n'existe : aucun événement `tool.error`, aucune
  persistance des arguments d'outils dans le journal, aucun scope workflow
  (la provenance `metadata.workflowId` des épisodes n'est lue que pour les
  cacher à l'archivage), et la table `action_types` (« governed mutations »)
  est un squelette sans exécution.
- Le plus proche d'une mémoire procédurale : les **skills d'équipe** que
  l'agent peut rédiger (`createSkill` / `updateSkill`, brouillon confirmé par
  un admin), mais à partir d'une description ou du transcript, jamais à partir
  de trajectoires observées, et jamais alimentés par le résultat des runs.

### 1.4 Skills et external apps : où partent les appels

- 10 skills bundled (SKILL.md ≈ 113 Ko au total ; `pptx` 23 Ko, `xlsx` 9,5 Ko,
  `docx` 7,5 Ko), 10 skills de providers générés par `gen:sdk` (PbyP 21 Ko /
  246 lignes + 6 références ≈ 40 Ko ; Shiptify 22 Ko ; Outlook 18 Ko), plus
  les snapshots MCP en base. Le SKILL d'un provider vaut 5 à 6 k tokens ; les
  références se lisent à la demande, un step chacune.
- Le prompt impose que le **premier** tool call pour un livrable fichier ou
  une app soit `read("skills/…/SKILL.md")` (`<tool_routing>`, ligne 1 : « the
  FIRST tool call is `read(...)`. `python` is off-limits for that task until
  the skill body is in context »). Le résultat d'un `read` est
  microcompactable : dans une longue conversation il peut être effacé, forçant
  une relecture.
- La table `skills` porte déjà `source` (`bundled` | `team_uploaded`),
  `sourceUrl` / `sourceHash` (provenance d'une installation), `version`,
  `deletedAt`, un cap `MAX_ENABLED_TEAM_UPLOADED_PER_TEAM = 30` dimensionné
  pour le catalogue L1 (« 30 × ~320 tokens ≈ 10 k »), des toggles `team_skills`
  et la matérialisation dans la sandbox. **Toutes** les lectures filtrent sur
  le littéral `'team_uploaded'` (`services/skills/list-for-team.ts:74-79`,
  `list-enabled-team-uploaded-with-body.ts:64` qui sert à la fois
  `read-skill-file.ts` et `pushTeamSkills`, `slugify-name.ts`, `get-by-id` /
  `update` / `delete`). Les skills ne sont vectorisées qu'en scope GLOBAL
  (`vectorize/skills.ts`) : le seul routeur d'une skill d'équipe est sa
  `description` dans le catalogue. `createSkill` crée toujours activé ; « créer
  puis basculer » existe via `PATCH`.
- PbyP : 37 actions (11 lectures dont `describe_collection` et `query_items`
  de type Directus, 26 écritures via `.op()`), 91 collections / 845 champs côté
  serveur. Le `guidance.md` dit déjà « NEVER guess a field path », « Batch. One
  `python` cell can run every query your plan needs », et décrit le mode
  d'échec observé : un chemin imbriqué faux renvoie silencieusement la clé
  étrangère, l'agent tire alors deux tables et joint à la main, « a one-call
  question becomes fifteen ». Autrement dit **la doctrine est déjà écrite dans
  le prompt et le skill ; ce qui manque, c'est l'expérience concrète** (les
  chemins qui marchent pour _cette_ équipe, les requêtes qui ont déjà
  répondu, le code qui a déjà produit le livrable).
- La frontière d'écriture des external apps est **côté serveur** :
  `/sandbox/exec` distingue `kind: 'read'` (exécution immédiate) de
  `kind: 'plan'` (dispatcher d'approbations). Aucune analyse statique de code
  n'est une frontière de sécurité.

### 1.5 Ce que l'observabilité, les evals et le front savent déjà faire

- Langfuse : une trace `chatbot-turn` / `workflow-turn` par tour, coût exact
  OpenRouter, `sessionId = conversationId`, tags `team:` / `workflow:` ;
  `lib/langfuse-scores.ts` publie des scores par trace.
- Evals (`packages/ai/evals`) : `stepsUsed`, `ttftMs`, `latencyMs`, et
  `tool-efficiency.ts` (`totalCalls`, `perTool`, `errorCalls`,
  `errorThenRetry`, `redundantCalls`, budget par cas) — **informationnels,
  jamais fondus dans la correctness**, et calculés uniquement dans le harnais,
  pas en production. Il n'existe **pas de harnais d'eval pour un run de
  workflow** (`evals/BACKLOG.md` le réclame : « needs a headless
  `POST /workflow/turn` seam »).
- Front : `ToolSkillRead.vue` affiche déjà un `read` de SKILL comme « playbook
  consulté » ; `ToolSkillDraft.vue` est une carte de proposition de niveau
  supérieur (Garder / Modifier & garder / Ignorer, états pending / saved /
  dismissed) ; `SettingsSkillEditor` accepte `initialDraft` ; la page Skills
  (`pages/settings/skills.vue`) liste bundled + équipe avec badges (Always on /
  Custom / Configurable), toggles et menu Edit / Delete, lecture pour tout
  membre et mutations admin côté serveur ; la page Mémoire affiche un badge
  « via agent » et un historique avec diff (`MemoryHistoryModal`,
  `MemoryActivity`), mais rend la ligne `Sources:` en texte brut ; la page
  workflow est une pile sans onglets (définition, alerte `pausedReason`,
  actions, trigger, grille runs | run sélectionné avec `RunStatsStrip`,
  `RunTimeline` — détail repliable par tâche qui montre déjà `toolHints` —,
  `RunSidebar`, transcript readonly), et `SettingsSlideover` a des
  `BaseSection` Limits et Notifications ; `ActivityCard` affiche
  automatiquement tout nouveau type d'événement de journal. Il n'existe
  **aucune** surface « ce que l'assistant a retenu » ni « contexte utilisé »
  dans le chat, et aucun centre de notifications (activité du dashboard, toasts,
  emails).

## 2. Diagnostic : pourquoi ça repart de zéro, et pourquoi la mémoire actuelle ne suffit pas

1. **La donnée procédurale existe mais n'est jamais exploitée.** Les tool calls
   complets (arguments, code Python, sorties, codes d'erreur `{error, code}`)
   sont en base dans `ai_messages.parts`, pour le chat comme pour les runs. Rien
   ne les relit : le journal ne garde que les noms d'outils, la distillation ne
   lit que le texte, les runs échoués sont ignorés, les steps ne sont pas
   comptés par run. On ne peut donc même pas répondre aujourd'hui à « combien de
   `read` de skill et de cellules `python` coûte un run du workflow PbyP ».
2. **La mémoire est query-shaped et métier.** Le recall d'un run est indexé sur
   `nom + goal` du workflow et renvoie au mieux un épisode narratif de 1 500
   caractères qui, par construction, ne contient ni chemin de champ ni code. Y
   faire entrer du procédural dégraderait sa précision (le sélecteur est calibré
   par `evals:recall` sur des cas métier) et violerait la doctrine
   « mémoire = connaissance générique de l'équipe ».
3. **Un workflow n'a pas besoin de retrieval.** Il a une identité stable
   (`workflowId`, hash du playbook). Ce qu'on apprend d'un run doit être attaché
   à cette identité et servi de manière déterministe, pas retrouvé par
   similarité.
4. **Le chat a déjà son routeur procédural : le catalogue de skills.** Une
   skill est routée par sa `description` (le déclencheur), pas par le recall,
   et le catalogue est borné. Une procédure apprise du chat est donc une
   skill de plus dans ce catalogue, pas un nouveau bras de retrieval — ce que
   la littérature confirme (un petit catalogue curé bat le retrieval à grande
   échelle, section 3.2).
5. **Le coût dominant est le nombre de steps, pas seulement les tokens.** Chaque
   step re-soumet tout le contexte (cache ou non), attend un TTFT, et sur un run
   s'additionne avec les 6-8 s de bootstrap sandbox et les allers-retours
   Trigger.dev. Réduire les steps réduit _à la fois_ latence et tokens ; c'est
   la cible primaire. Les mesures internes vont dans ce sens : le bloc
   `<standing_memory>` a divisé par deux les tool calls d'un cas parce que
   l'agent reconstruisait à la main ce que le bloc énonce.
6. **Le chat n'a pas de signal de succès déterministe ; le run en a un.** Un
   run réussi est un fait du harnais ; un tour de chat « réussi » est une
   heuristique. Ce qui s'apprend du chat passe donc par une revue humaine ; ce
   qui s'apprend des runs peut être automatique.
7. **Les contraintes non négociables du code** que le plan doit respecter :
   préfixe de prompt byte-stable (tout ce qui est par run/tour vient d'une
   source stable pour le run ou vit dans le suffixe dynamique) ; pas de seconde
   passe LLM sur des résumés ; toute constante est une mesure ; les
   approbations et modes d'autonomie gouvernent toute écriture ; un run ne
   modifie pas un skill ; un agent-singleton ne ferme jamais sur du contexte de
   requête ; « une référence que l'agent doit TOUJOURS lire est son prompt
   arrivant un step plus tard, au prix fort » (`agent-context-framework.md`
   §8).

## 3. État de l'art : ce que font la recherche et les autres acteurs

Note de méthode : la v1 n'avait accès qu'aux résumés ; la v2 a lu les 17
papiers principaux en texte intégral, plus six travaux de juin-septembre 2026,
et a vérifié les chiffres marqués « rapporté ». Beaucoup d'articles de 2026
restent des préprints.

### 3.1 Taxonomie des approches (littérature 2023-2026)

| famille                                     | idée                                                                   | exemples et résultats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | limite principale                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Exemplaires / mémoire épisodique**        | garder les trajectoires réussies et les retrouver comme démonstrations | Synapse (ICLR 2024, 99,2 % MiniWoB++) ; ExpeL (AAAI 2024) ; _Self-Generated In-Context Examples_ (NeurIPS 2025 : ALFWorld 73 → 89 % en accumulant ses propres succès, 93 % avec curation) ; Memento (2025, GAIA 87,9 % val, **K = 4 cas optimal, plus dégrade**)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | coût en tokens ; saturation rapide ; ne transfère que si la tâche ressemble                |
| **Insights distillés / playbooks**          | règles courtes tirées des succès _et_ des échecs                       | Reflexion (NeurIPS 2023) ; AutoGuide (NeurIPS 2024 : règles **conditionnelles** à l'état, ALFWorld 79 % vs 59 % ExpeL) ; ReasoningBank (Google, ICLR 2026 : WebArena 40,5 → 48,8 %, steps 9,7 → 8,3, ≤ 3 items par trajectoire, k = 1) ; ACE (ICLR 2026 : deltas incrémentaux avec compteurs utile/nuisible, dédoublonnage sans LLM ; nomme deux pannes des optimiseurs qui réécrivent tout : _brevity bias_ et _context collapse_) ; Dynamic Cheatsheet (2025)                                                                                                                                                                                                                                                                                                                                                                                                                 | confabulation des auto-diagnostics ; croissance additive ; le modèle peut ignorer la règle |
| **Mémoire de workflow**                     | sous-routines semi-structurées avec paramètres abstraits               | Agent Workflow Memory (ICML 2025 : WebArena 23,5 → 35,5 %, steps 7,9 → 5,9, plateau après ~40 exemples) ; Memp (ACL 2026 : ablation build / retrieve / update, la réflexion sur échec bat l'ajout simple)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | textuel, ne s'exécute pas ; retrieval grossier                                             |
| **Bibliothèque de compétences exécutables** | compiler ce qui a marché en code paramétré, vérifié par exécution      | Voyager (2023) ; LATM / CREATOR (un modèle fort écrit l'outil, un modèle bon marché l'utilise) ; SkillWeaver (2025, +31,8 % WebArena) ; **ASI** (2025 : skills = fonctions vérifiées par ré-exécution, seuls 15,6 % des programmes passent ; steps −15,3 % vs vanille, −10,6 % vs AWM) ; **SkillDroid** (2026 : rejeu **sans appel LLM**, −49 % d'appels LLM, 85 % vs 62 %, le baseline sans mémoire se _dégrade_ dans le temps 80 → 44 % quand SkillDroid monte 87 → 91 %) ; **Tool-Making in Low-Latency Systems** (2026, production : SOP compilé en outils versionnés, **p50 −42 %, tokens de sortie −58 %**, erreurs −53 %) ; **Progressive Crystallization** (Microsoft, 2026 : échelle agentique → hybride → déterministe, rétrogradation automatique, coût −70 %) ; **TraceCompiler** (2026 : trace → graphe d'appels avec règle def-use, 51 % des appels supprimables) | fragile aux changements d'API / UI ; exige une boucle réparation-rétrogradation            |
| **Optimisation de prompt hors ligne**       | faire évoluer le prompt système sur un jeu de validation               | GEPA (ICLR 2026), Training-Free GRPO, LangMem `create_prompt_optimizer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | améliore le prompt partagé, pas la tâche récurrente                                        |
| **Fine-tuning / RL sur la mémoire**         | apprendre quoi écrire                                                  | MemAgent, Memory-R1, Mem-α, SkillRL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | hors de portée sans boucle d'entraînement ; ne survit pas au changement de modèle          |
| **Caches système sans apprentissage**       | réutiliser plans, résultats, appels                                    | AgentReuse (≈ 30 % des requêtes réelles sont identiques ou proches) ; ToolCaching (2026) ; PASTE (Microsoft, 2026 : exécution spéculative des appels prédits, −48,5 % de latence) ; _sleep-time compute_ (Letta, 2025 : ×5 de calcul en moins au moment de la requête)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | orthogonal, empilable                                                                      |

### 3.2 Les constantes de design mesurées

| constante                          | valeur mesurée                                                                                                                                                                                                                                             | source                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| support pour induire une procédure | ≥ 3 traces par cluster (cosinus ≥ 0,45) ; ≥ 2 occurrences pour une leçon (« recurs »)                                                                                                                                                                      | TraceCompiler ; AWM, `promote-episodes.ts` |
| pas déterministe                   | chaque argument est `constant`, `user_input`, ou copie / transformation attribuable de façon unique à une sortie amont ; sinon nœud LLM ; **une écriture irréversible sous-déterminée n'est jamais compilée**                                              | TraceCompiler                              |
| agent → hybride                    | ≥ 10 succès, 0 violation, ≥ 90 % de séquence d'actions identique, tests d'acceptation générés verts                                                                                                                                                        | Progressive Crystallization                |
| hybride → déterministe             | ≥ 50 succès, cohérence ≥ 99 %, revue humaine                                                                                                                                                                                                               | idem                                       |
| outil compilé déployable           | ≥ 90 % d'un held-out (en pratique 100 %), ≤ 3 tours de réparation, repli par nœud ; l'agent reste capable sans outils (97,4 %)                                                                                                                             | Tool-Making                                |
| recompilation d'un replay          | `r_fail > 0.5` → recompile, ≤ 3 versions ; repli par étape avant repli complet                                                                                                                                                                             | SkillDroid                                 |
| retrait d'un skill appris          | ssi n ≥ 100 essais et contribution ≤ −0,10 ; cap 50 actifs ; retrait à n = 20 → **pire que sans bibliothèque** (collapse à 2 skills)                                                                                                                       | Library Drift                              |
| admission d'un skill               | schéma ∧ replay A/B held-out (k = 3) ∧ critique sémantique, puis sélection par gain marginal ; sans porte : pic 62 % à 105 skills → 50 % à 179 ; le rollback a posteriori récupère < 20 % du dégât                                                         | When Self-Evolution Backfires              |
| items par trajectoire              | ≤ 3 leçons ; ≤ 4 candidats par lot de 48 épisodes                                                                                                                                                                                                          | ReasoningBank ; GRASP                      |
| k de retrieval                     | 1 ; 4 (plateau au-delà) ; ensembles bornés injectés plutôt que retrouvés (≤ 10 skills, ~5,6 k tokens contre 34-53 k pour une mémoire non bornée)                                                                                                           | ReasoningBank ; Memento ; GRASP            |
| invalidation                       | par **ligne** avec version de dépendance (par table : précision 0,25, un cas 66,7 % → 0 %) ; la conformité dépend du modèle (0 → 100 % selon le modèle) → pré-vol par modèle                                                                               | Invalidation Contracts                     |
| notes par app                      | `{category, confidence, applies_to, lemma, provenance}` ; curateur en session séparée avec **sondes read-only** avant écriture ; seule méthode qui répare une règle après migration de schéma ; 73 % vs 61 % full-ICL à 1/3 des tokens                     | Grounding Agent Memory                     |
| mise à jour d'un contexte appris   | deltas fusionnés de façon déterministe, compteurs utile/nuisible, jamais de réécriture complète (context collapse : 18 282 tokens / 66,7 % → 122 tokens / 57,1 %)                                                                                          | ACE                                        |
| budget égal                        | AWM / ASI / ReasoningBank perdent contre un agent vanille avec 5 steps de plus ; ~50 % des mémoires « succès » venaient de runs échoués (le juge ne voit que l'état final)                                                                                 | Worth Their Tokens                         |
| fidélité                           | traces brutes perturbées : −30 à −90 % ; leçons condensées perturbées : −1 à −5 % ; quand elles nuisent : distraction 40-79 %                                                                                                                              | Not Faithful                               |
| où un skill aide                   | 65,7 % du gain = ancrage procédural (quoi faire en premier, quel outil, quoi vérifier) ; erreurs d'environnement / format, pas algorithmiques ; nouveau mode d'échec « guidance misapplied » 10 % ; retrieval top-1 70 → 53 % avec distracteurs similaires | Demystifying                               |
| transfert                          | strong → weak aide, weak → strong nuit (−23) ; entre rôles / équipes : **négatif** (−4,8 / −7,5)                                                                                                                                                           | GRASP, AFTER                               |
| exécution spéculative              | −48,5 % de latence bout en bout (p99 −61,9 %)                                                                                                                                                                                                              | PASTE                                      |

Ce que ces constantes imposent au design :

1. **Compter les tokens de la mémoire.** Le critère de victoire est « moins de
   steps et de tokens totaux à succès ≥ », mesuré tokens de recette inclus,
   contre un vanille qui aurait le même budget. Seules les familles « code
   exécutable » et « caches » réduisent à la fois tokens et appels.
2. **Le brut vaut plus que le condensé.** Le ledger garde les trajectoires
   brutes ; une recette porte d'abord du code verbatim ; chaque artefact
   distillé cite sa source et reste révocable ; le code compilé est vérifié par
   exécution. Les leçons condensées sont peu nombreuses et conditionnelles
   (« quand X, faire Y »), jamais un résumé.
3. **Petit et gardé plutôt que grand et additif.** Plafonds, porte d'admission
   avant activation (le nettoyage a posteriori ne récupère pas), compteurs
   utile/nuisible par item, retrait avec plancher d'observations, pas de
   retrait précoce.
4. **Tout artefact appris est une entrée de cache avec un contrat de
   validité.** Détection de péremption mécanique (hash du playbook, version
   SDK/skill, fingerprint MCP), par ligne, jamais laissée au modèle (STALE :
   le meilleur modèle ne détecte qu'à 55 % qu'une mémoire est périmée) ; une
   note vérifiée par sonde read-only survit à une migration de schéma.
5. **Le retrieval est le goulot à l'échelle.** Pour les workflows : pas de
   retrieval, attachement par identité. Pour le chat : un catalogue borné
   (≤ 10) dont la description est le routeur, pas un nouveau bras de recall.
6. **La conformité dépend du modèle.** Réévaluer les recettes à chaque
   changement de modèle (`modelProfileKey` dans le fingerprint) ; faire écrire
   par un modèle fort ce qu'un modèle moins cher utilise ; jamais de transfert
   entre équipes.
7. **Sécurité des écritures.** MINJA (empoisonnement de mémoire par simples
   requêtes, 98 %), _Practice Makes Unsafe_, _Your Agent May Misevolve_ →
   jamais d'écriture partagée à partir de contenu non vérifié ; provenance ;
   visibilité humaine ; moindre privilège (identité du run, pas plus).
8. **Consolider hors du chemin critique.** La réflexion est un job batch
   versionné, jamais un appel de plus dans le tour.

### 3.3 Ce que font les acteurs industriels

- **Anthropic.** _Agent Skills_ : exactement le modèle L1 / L2 / L3 que Fretik
  a déjà (métadonnées ≈ 100 tokens par skill, corps < 5 k tokens lu à la
  demande, scripts exécutés hors contexte). _skill-creator_ : boucle
  humaine — brouillon depuis le transcript, **évaluation avec vs sans skill**
  par sous-agents parallèles, notation, itération ; règle notable : « si tous
  les runs de test réécrivent le même helper, déplace-le dans `scripts/` »
  (compiler le comportement répété en code). _Auto memory_ de Claude Code :
  index de 200 lignes / 25 Ko chargé à chaque session, fichiers sujets à la
  demande, `type` + `modified` par mémoire, consignes explicites « rien de
  dérivable du code, rien que CLAUDE.md dit déjà ». _Managed Agents_ :
  mémoires versionnées (SHA, acteur, verrou optimiste) montées comme fichiers ;
  **Dreams** : job planifié qui lit le store + les transcripts récents et
  produit une _nouvelle version_ du store (fusion, remplacement du périmé,
  motifs inter-sessions), **revue avant application**. _Programmatic tool
  calling_ : les outils deviennent des fonctions dans un sandbox Python, seul
  le résultat final entre dans le contexte ; **−38 % de tokens facturés sur un
  agent à 75 outils, −20-40 % en production avec 10-49 outils, mais +8 % de
  coût et aucun gain sur des tours à 1-2 appels séquentiels** — le batching
  paie quand il y a des appels à batcher. _Code execution with MCP_ : l'agent
  **enregistre le code qui a marché dans un dossier `skills/` avec un
  SKILL.md** pour accumuler des capacités. _Tool search_ / `defer_loading` (ce
  que `searchTools` reproduit). _Prompt caching_ : préfixe stable, pas
  d'horodatage avant un point de cache, sérialisation déterministe.
- **OpenAI.** Agents SDK : `Memory()` en sandbox avec `memory_summary.md`
  injecté au départ, `MEMORY.md` index, `rollout_summaries/`, `raw_memories/`,
  `skills/` ; génération **post-run en deux phases** (résumé par
  conversation puis consolidation qui réécrit l'index) ; oubli par plafond.
  Codex : skills SKILL.md + `skill-creator`. ChatGPT « dreaming » (2026) :
  consolidation hors ligne. Structurellement identique à Claude Code +
  Dreams.
- **Letta (MemGPT).** Blocs de mémoire en contexte édités par outils ;
  **agents de sommeil** qui réécrivent la mémoire entre les tours ; _context
  repositories_ (2026) : tout le contexte est un dépôt git, arbre de fichiers
  toujours dans le prompt, `system/` épinglé, le reste divulgué par
  description YAML, `skills/` pour les procédures, chaque changement est un
  commit. Pratiques publiées (Ezra) : mémoire épinglée minimale, lier plutôt
  qu'incorporer, **les erreurs pilotent les améliorations**, audits
  périodiques du périmé.
- **Frameworks mémoire.** Mem0 : extraction puis ADD/UPDATE/DELETE/NOOP (ce
  que `promote-episodes.ts` reproduit), et un type `procedural_memory` par
  agent (résumé pas-à-pas d'une tâche). Zep/Graphiti : graphe **bitemporel**,
  la contradiction _invalide_ sans supprimer — le bon primitif pour la
  péremption procédurale. LangMem : la mémoire procédurale _est_ le prompt
  système, optimisé hors ligne depuis les trajectoires (sans porte d'eval :
  à ajouter soi-même).
- **Manus.** Le taux de hit du KV-cache est la métrique n° 1 (×10 de prix
  entre caché et non caché) ; **masquer les outils plutôt que les retirer** ;
  le système de fichiers comme contexte illimité ; réciter le plan en fin de
  contexte (`todo.md`) ; **garder les échecs dans le contexte** ; éviter
  l'ornière du few-shot par de la variation structurée.
- **Devin.** _Knowledge_ = contenu + description de déclenchement, proposé
  automatiquement depuis les corrections, **approuvé par un humain** ;
  _Playbooks_ = gabarits pour les workflows répétés. Cursor a retiré ses
  « memories » auto-capturées ; Windsurf les garde locales et jetables : la
  mémoire apprise sans validation est traitée comme peu fiable, la
  connaissance partagée est explicite et versionnée.
- **Automatisation.** Zapier a replié ses Agents en _une étape IA dans un Zap
  déterministe_ ; Gumloop / n8n / Bardeen compilent l'intention en DAG
  révisable ; aucun n'apprend des exécutions. Le mouvement de l'industrie est
  « agent comme étape bornée d'un flux déterministe », pas « run compilé en
  Zap ».
- **Le motif « rejeu déterministe avec repli agentique »** (Skyvern _code
  caching_, Browser Use _workflow-use_, Stagehand _caching_) : (a) explorer
  avec l'agent et **enregistrer les appels concrets avec leurs arguments
  résolus**, pas le raisonnement ; (b) compiler et paramétrer (Stagehand
  indexe le cache sur les **noms** de variables, pas leurs valeurs, donc un
  gabarit sert toutes les valeurs) ; (c) clé = instruction + signature
  d'environnement + configuration du modèle ; (d) rejouer sans LLM avec des
  assertions à chaque étape ; (e) au premier échec, repli sur l'agent pour
  l'étape ou la tâche, puis régénération du cache — Skyvern conserve les
  caches des anciennes branches, les étapes conditionnelles et les attentes
  restent toujours vivantes. Gains marketing 3-5× plus rapide, jusqu'à −70 %
  de coût (chiffres éditeur, non vérifiés).
- **Caches.** Cache sémantique de réponses (GPTCache) : déconseillé sur les
  pipelines agentiques par Vercel comme par ses auteurs. Cache de résultats
  d'outils : opt-in par outil en lecture seule, clé = sha256(nom + args
  canoniques + tenant), TTL court, « une donnée périmée est pire qu'un
  re-fetch ». Étude _Don't Break the Cache_ (2026) : le cache de prompt
  réduit le coût de 45-80 % et le TTFT de 13-31 %, mais un cache naïf du
  contexte complet peut _augmenter_ la latence — le dynamique en dernier.
- **Garde-fous observés.** Revue avant application (Dreams), évaluation
  avec vs sans (skill-creator, SkillAudit), grader indépendant (Outcomes),
  labels et expériences de datasets comme porte de promotion (Langfuse :
  `prod-a` / `prod-b`, promotion = déplacement de label, rollback idem),
  mode ombre d'abord, rollback instantané.

### 3.4 Où Fretik se situe, et ce qui manque

Fretik a déjà, et plutôt bien, les couches que les éditeurs convergent vers :
skills à divulgation progressive (Anthropic), outil `memory` calqué sur
`memory_20250818`, microcompaction équivalente au _context editing_,
« dreaming » nocturne (distillation, consolidation, promotion Mem0-style),
`searchTools` équivalent au _tool search_, et surtout **le SDK Python
`fretik_apps` dans le sandbox, qui est déjà du _programmatic tool calling_ /
_code mode_** — le batching que l'industrie mesure à −20-40 % est
disponible, c'est son _usage_ qui n'est pas appris.

Ce qui manque correspond aux couches 3 et 4 de la synthèse de la
littérature : (1) un ledger de trajectoires brutes exploitable ; (2) la
réutilisation des séquences répétées en artefacts attachés à l'identité du
workflow (le code du run précédent, les skills déjà en contexte, le schéma
déjà lu), avec, plus tard, une échelle de promotion / rétrogradation
(Progressive Crystallization, SkillDroid, Skyvern) ; (3) des contrats de
validité mécaniques (version, hash, fingerprint) sur tout ce qui est appris ;
(4) une porte d'évaluation avec vs sans avant promotion ; (5) pour le chat,
des skills apprises bornées, par équipe, revues par un humain, et des notes
par app servies au moment de l'usage plutôt que payées à chaque tour ; (6) les
surfaces de visibilité et de gouvernance décrites en 3.5. C'est le périmètre
de la section 4.

### 3.5 Transparence et gouvernance des apprentissages : ce que font les autres

- **Signal inline au moment d'apprendre.** ChatGPT : chip « Memory updated »
  → « Manage memories » (liste plate, suppression par item, tout effacer),
  deux toggles distincts pour les faits explicites et les inférences tirées
  de l'historique, et un chat temporaire qui ne lit ni n'écrit ; la critique
  de Willison (un « dossier » invisible injecté partout, contrôlable seulement
  en tout-ou-rien) a précédé la refonte « dreaming » de 2026 (page de résumé,
  correction par item). Copilot 365 : signal discret + « Manage saved
  memories ». Claude Code : « Saved 2 memories » / « Recalled 2 memories »,
  fichiers typés `user` / `feedback` / `project` / `reference` avec un
  `modified` explicite, vue `/memory` pour parcourir, éditer, désactiver.
  Claude.ai et Gemini séparent l'explicite de l'inféré ; Gemini auto-supprime à
  18 mois et le désactive sur les comptes pro.
- **Proposition puis approbation.** **Devin Knowledge** est l'analogue le plus
  proche : chaque item = contenu + **description de déclenchement** éditable
  (quand le rappeler), proposé depuis le feedback, Éditer / Ignorer /
  Régénérer, dossiers, promotion org → entreprise ; à l'usage, la session
  liste « Accessed Knowledge », et un onglet « Knowledge Usage » sépare
  **Useful** de **Misleading** avec un lien vers l'item pour le corriger.
  **Intercom Fin Operator** ne modifie jamais directement : « Fin propose un
  changement, vous voyez un diff dans le chat, vous approuvez, éditez ou
  rejetez » (« une pull request pour votre support ») ; les Recommendations
  montrent les conversations exactes qui les ont déclenchées ; les « Fin
  thoughts » exposent dans la timeline l'étape de procédure et la raison d'un
  saut. Cursor a retiré ses memories auto-capturées (non versionnées, non
  partagées, gate de confidentialité rejetée par les utilisateurs) ; Windsurf
  recommande d'écrire une Rule pour tout ce qu'on veut réutiliser.
- **Versions et rollback.** Anthropic Managed Agents : chaque changement d'une
  mémoire est une version immuable attribuée à la session, restaurable, et
  **rédigeable** (secrets, PII, demande d'effacement) sans perdre le qui /
  quand ; **Dreams** consolide un store et jusqu'à 100 transcripts dans un
  **nouveau** store, « l'entrée n'est jamais modifiée, vous relisez la sortie
  et la jetez si besoin ». Decagon : chaque édition de procédure = commit, diff,
  rollback, allocation de trafic par version, « quelle version a traité cette
  conversation ». Sierra : releases immuables (code, prompts, modèle et
  connaissance), rôle Reviewer, diff ligne à ligne. Agentforce : 20 versions,
  une active, draft → commit → publish → activate.
- **Gouvernance d'entreprise.** Kill switch admin partout (Claude, Gemini
  Enterprise, Perplexity — qui **supprime** les mémoires à la désactivation et
  le dit) ; export de conformité (ChatGPT Enterprise Compliance API) ; Glean
  et Copilot Studio : soumission puis approbation admin d'un agent, badge
  « vérifié », registre et journal Purview ; ServiceNow : approbation
  obligatoire d'un serveur MCP avant usage, journal de chaque entrée /
  politique / approbation / action. Le contre-exemple documenté de Copilot
  memory : « les actions de mémoire ne génèrent pas d'entrée d'audit »,
  « les politiques de rétention ne s'appliquent pas », « supprimer un chat ne
  supprime pas les mémoires qui en dérivent ».
- **Recherche HCI.** Chen et al. (CHI 2026, 20 utilisateurs) : découvrir ce
  que ChatGPT avait retenu a provoqué des **violations d'attente négatives**
  et un besoin fort de visibilité, d'accès et de contrôle ; Memory Sandbox
  (UIST 2023) : la mémoire comme objets manipulables (basculer, éditer,
  supprimer, partager) ; Kizilcec (CHI 2016) : la transparence est en cloche
  — l'explication restaure la confiance après une violation, mais exposer les
  internes bruts nuit autant que l'opacité ; Eslami (CHI 2018) : exposer des
  inférences fausses ou intrusives désillusionne ; HAX G11 / G13 / G14 / G17 /
  G18 (expliquer, apprendre du comportement, s'adapter prudemment, contrôles
  globaux, notifier les changements) ; Anthropic 2026 : **93 % des prompts
  d'approbation sont acceptés** et les humains ne détectent que 13,6 % des
  commandes dangereuses plantées → les gates uniformes dégénèrent en tampon ;
  gates par niveau de risque, audits aléatoires d'items déjà approuvés.
- **Réglementaire, seulement ce qui change le design.** AI Act art. 50 :
  information des tiers quand l'agent écrit vers l'extérieur ; annexe III
  4(b) : un système qui « évalue la performance et le comportement des
  personnes » en emploi est à haut risque → les apprentissages décrivent des
  tâches et des apps, jamais un employé, et aucune surface n'expose à un
  manager ce qu'un membre « fait mal » ; art. 12-14 (journal, sortie
  interprétable, supervision) si un client en fait un usage à haut risque.
  RGPD : base = intérêt légitime documenté (le consentement n'est pas
  utilisable en emploi), notice art. 13, finalité « améliorer mon assistant »
  ≠ « partager avec l'équipe » (identité du contributeur retirée), effacement
  en cascade conversation → apprentissages dérivés, minimisation (la
  procédure, pas le transcript), export par utilisateur ; EDPB 2025 : usage
  secondaire des entrées sans base = violation de l'art. 5(1)(b). ISO 42001
  A.6.2.8 et NIST AI 600-1 : un journal d'événements assez détaillé pour
  reconstruire ce que l'agent a fait, tool calls inclus.

Le pattern qui en ressort, et que la section 4.6 applique : **visible par
défaut avec annulation** pour ce qui est personnel, réversible et non
exécutable ; **revue explicite** pour ce qui est partagé ou exécutable ;
provenance, versions et journal d'audit partout ; on montre quel item, quelle
version, ce qu'il dit et d'où il vient — jamais le raisonnement brut.

## 4. Architecture cible

Vue d'ensemble :

```
                 ┌────────────────────────────────────────────────────────┐
                 │ 4.1 Ledger de trajectoires (déterministe, sans LLM)     │
                 │  ai_messages.parts → extractTrajectory() → steps,       │
                 │  tool calls, code python, liaisons par argument,        │
                 │  erreurs→corrections, skills lus ; métriques par run    │
                 └───────────────┬──────────────────────┬─────────────────┘
                                 │                      │
        ┌────────────────────────▼─────────┐   ┌────────▼──────────────────────────┐
        │ 4.2 Workflows : recettes de run   │   │ 4.3 Chat : skills et notes apprises│
        │  dérivées sans LLM à la création  │   │  (a) notes par app → servies dans   │
        │  du run (K=3 runs réussis, même   │   │      le SKILL du provider           │
        │  playbookHash + fingerprint),     │   │  (b) skills apprises → brouillons    │
        │  snapshot sur workflow_runs.recipe│   │      dans la page Skills, activées  │
        │  → corps rendus dans le prompt,   │   │      par un admin (catalogue L1)    │
        │  fichiers recipes/ dans la sandbox│   │  (c) préchargement en un step (chat)│
        └────────────────────────┬─────────┘   └────────┬──────────────────────────┘
                                 │                      │
                 ┌───────────────▼──────────────────────▼─────────────────┐
                 │ 4.6 Visibilité et gouvernance : carte au moment         │
                 │  d'apprendre, ligne « Appliqué » à l'usage, pages       │
                 │  Skills / Mémoire / Workflow, politique, journal        │
                 └───────────────┬────────────────────────────────────────┘
                 ┌───────────────▼────────────────────────────────────────┐
                 │ 4.4 Boucle mainteneurs : motifs récurrents cross-team   │
                 │  → propositions d'amélioration de skills (jamais auto)  │
                 └────────────────────────────────────────────────────────┘
```

### 4.1 Le ledger de trajectoires

**But.** Rendre lisible, sans LLM, ce qu'un tour ou un run a réellement fait,
pour trois consommateurs : les métriques de production, la dérivation des
recettes de run, l'extraction des candidats du chat. Un seul module pur,
réutilisé par les evals (aujourd'hui `evals/tool-efficiency.ts` fait ce
calcul, mais uniquement dans le harnais).

**Source.** `ai_messages.parts` (UIMessage) : chaque part `tool-<name>` porte
`toolCallId`, `input`, `output`, `state` ; le texte et le raisonnement sont à
côté ; `metadata.telemetry.usage` et `metadata.spend` donnent tokens et coût par
message. Pour un run, la conversation est `workflow_runs.conversationId` et les
frontières de tâches sont les appels `completeTask`. Aucune capture nouvelle
n'est nécessaire au tour ; on ajoute seulement ce qui manque pour requêter
sans relire les transcripts.

**Livrables.**

- `packages/shared/src/services/trajectory/extract.ts` — fonction pure
  `extractTrajectory(messages) → TrajectoryStep[]` : `{ index, toolName,
input (canonique, tronqué), outputPreview, errorCode?, durationMs?,
tokens?, taskKey? }`, plus `summarizeTrajectory()` (histogramme par outil,
  `errorCalls`, `errorThenRetry`, `redundantCalls`, fichiers de skills lus,
  nombre et taille des cellules `python`, cellules ayant levé une exception
  puis réussi, fichiers `recipes/` lus ou exécutés). Réutilise la
  canonicalisation de `approvals/hash.ts` pour les clés d'identité d'appel.
  Reprend, et remplace à terme, `evals/tool-efficiency.ts`.
- **Classification des liaisons** par argument de tool call, entre runs d'un
  même workflow (règle def-use de TraceCompiler) : `constant` (même valeur
  dans tous les runs), `user_input` (présent dans le payload du trigger),
  `copy_edge` / `transform_edge` (attribuable de façon unique à une sortie
  amont), `dynamic` (le reste). C'est ce qui décide, par tâche, `stable` /
  `noisy` / `judgment` — et ce qui interdit de compiler une écriture
  irréversible dont un argument est `dynamic`.
- **Chaînes droites**, ce qui rend « 5 appels deviennent 1 » mécanique : une
  suite maximale d'appels consécutifs dont **chaque** argument est `constant`,
  `user_input`, ou attribuable de façon unique à la sortie d'un appel plus haut
  dans la même suite, est une ligne droite et peut devenir un seul script. Un
  seul argument `dynamic` casse la chaîne, et c'est le garde-fou : un argument
  `dynamic` signifie que le modèle a regardé un résultat intermédiaire avant de
  décider, donc fusionner lui retirerait cette décision. Le ledger sort aussi
  les **répétitions** — même appel, mêmes arguments canoniques, deux fois dans
  un run ou dans tous les runs. Découverte de schéma et relectures : c'est la
  moitié des appels supprimables que TraceCompiler mesure.
- **Candidats de vérification**, ce qui rend « un script vaudrait mieux qu'un
  modèle » détectable : une tâche où, sur ≥ 3 runs, la trajectoire a la même
  forme — une lecture ou une extraction, puis un tour de modèle **sans aucun
  appel d'outil** qui produit un verdict court (un booléen, un compte, une
  correspondance), puis `completeTask`. C'est une vérification faite de tête,
  et un script la ferait plus vite et sans varier. Le ledger la **signale** ;
  il ne décide rien : ce qui tranche est le rejeu (4.2).
- **Vérité terrain d'un succès**, pour la dérivation des recettes : run
  `succeeded`, non-test, **et** livrable présent quand le playbook en déclare
  un, **et** aucune approbation rejetée, **et** aucune relance manuelle du
  même workflow dans les 2 h. Un run « réussi » selon le harnais mais relancé
  à la main est une donnée **négative**. Le chat n'a pas de tel signal.
- **« A utilisé la recette »** = présence de `read("recipes/…")` ou
  `exec(open("recipes/…"))` dans la trajectoire — déterministe, la porte ASI
  « accepté ssi correct **et** artefact utilisé ».
- **Métriques par run, persistées** : étendre `WorkflowRunUsageSchema`
  (`schemas/workflows.ts:411-421`) avec des champs **optionnels** (`steps`,
  `toolCalls`, `perTool`, `skillReads`, `errorCalls`, `pythonCells`,
  `recipeUsed`), remplis dans `onWorkflowStepEnd` (`handlers/workflow.ts:487-501`)
  et écrits par `recordTurnResult` avec `usage`. Champs optionnels, parce que
  les deux parseurs du protocole de tour retirent les clés inconnues.
- **Métriques par tour de chat** : déjà dans `metadata.spend` (steps, tokens,
  coût) ; ajouter l'histogramme d'outils et les skills lus dans le même objet.
- **Scores Langfuse** par trace via `lib/langfuse-scores.ts` (`steps`,
  `skill-reads`, `error-calls`, `redundant-calls`, `recipe-used`), pour que le
  tableau de bord existant les affiche par workflow et par équipe sans
  nouvelle UI.
- **Les runs échoués entrent dans le ledger** (pas dans les épisodes) : un run
  échoué _après_ avoir reçu une recette est la donnée la plus précieuse.
- Un script opérateur `workflows:profile -- <workflowId> [--runs N]` (dans
  `packages/jobs`, derrière `assertOperatorTarget`) qui imprime, pour les N
  derniers runs, la répartition des steps par tâche et par outil, les lectures
  de skills, les erreurs et leur correction, les liaisons par argument et la
  similarité de code entre runs. C'est l'outil du palier 0 et celui qu'on
  rouvre avant chaque décision.

**Ce qui n'est pas fait.** Pas de nouvelle table de steps au départ : la
dérivation à la demande suffit (quelques runs à la fois) ; on ne crée
`agent_trajectory_steps` que si les requêtes analytiques le justifient (mesure
au palier 0).

### 4.2 Workflows : les recettes de run

#### Recette v1 : une vue dérivée, sans LLM, snapshotée sur le run

Une recette n'est pas une table à faire vivre : c'est ce que les K derniers
runs réussis du même workflow, dans le même environnement, ont fait de
réutilisable. Elle se recalcule à chaque run et ne s'accumule pas.

- **Calcul** à `createWorkflowRun` (`services/workflows/create-run.ts:112`, à
  côté du snapshot `taskStates`), quand `team_ai_settings.learning.workflowRecipes ≠ off`
  et que le workflow n'est pas en `off` : à partir des **K = 3** derniers runs
  réussis (vérité terrain de 4.1) au même `playbookHash` (sha256 canonique de
  `{playbook, autonomy, externalAppConnectionIds triés}`) et au même
  **fingerprint d'environnement** (versions `version:` des SKILL de providers
  utilisés, fingerprints des snapshots MCP, `modelProfileKey` effectif).
- **Stockage** : une colonne `workflow_runs.recipe` jsonb — le run rend **depuis
  sa propre ligne** uniquement. Le bloc playbook est reconstruit à chaque tour ;
  une recette lue en direct qui changerait entre deux tours changerait les
  octets du prompt et casserait le cache. Historique gratuit : chaque run
  garde la recette qu'il a reçue.
- **Contenu par tâche** (`Record<taskKey, TaskRecipe>`) :
  - `skillsInContext` : les fichiers de skills lus dans **≥ 2** des K runs
    (SKILL.md et références) → leurs corps sont rendus dans le prompt du run ;
  - `code` : le code `python` du **dernier** run réussi, matérialisé sous
    `recipes/<taskKey>/`. Les appels formant une **chaîne droite** (4.1) sont
    concaténés en un seul fichier exécutable d'un coup : c'est littéralement
    « cinq appels d'outil deviennent un ». Ce qui n'est pas fusionnable reste
    en blocs séparés et étiquetés, dans l'ordre, parce qu'entre deux blocs le
    modèle avait regardé un résultat avant de décider. Les littéraux qui
    apparaissent dans le payload du trigger sont remplacés par des lectures de
    `/workspace/.fretik/run-params.json` (écrit par le harnais avec
    `auth.json`) ; le reste est laissé tel quel — c'est le code qui a marché,
    pas une réécriture. **Toute fusion passe la porte du rejeu** avant d'être
    servie ;
  - `schemaSnapshot` : les sorties `describe_collection` / `whoami` du
    dernier run → `recipes/<taskKey>/schema.json`, tagué par le `version:` du
    SKILL du provider ;
  - `bindings` (4.1) et `classification` (`stable` / `noisy` / `judgment`),
    pour l'affichage et les paliers suivants ;
  - `sourceRunIds`.
- **Invalidation gratuite** : la clé de dérivation contient `playbookHash` et
  le fingerprint ; un playbook édité, une autonomie changée, une connexion
  ajoutée, un SDK republié ou un modèle changé donnent un run sans recette
  (retour `agentic`) jusqu'aux prochains succès. Pas de machine à états, pas
  de convergence, pas de file BullMQ, pas de « degraded » tant que l'agent
  reste dans la boucle.
- **Aucune analyse statique n'est une frontière de sécurité.** Les fichiers
  `recipes/` sont du code que l'agent lit et exécute lui-même dans le tour ;
  une écriture y passe par `.op()` / `run_plan` / `records.bulk_*` et donc par
  `/sandbox/exec` et les approbations, exactement comme si l'agent l'avait
  écrite.
- **Modes par workflow** : `off` ; `shadow` = calculer et persister sur le run,
  ne rien rendre (le delta se lit dans les métriques) ; `on` = rendre. Choix
  dans `SettingsSlideover` (troisième `BaseSection`, à côté de Limits et
  Notifications) ; défaut d'équipe dans `team_ai_settings.learning`.

#### Ce que le run voit

- **Les lignes de recette vivent à côté de la tâche, dans le bloc playbook**,
  exactement comme `toolHints` (`playbook-block.ts:87-89`) : « Skills already
  in context: … », « Previous successful run's code: `recipes/<key>/run-3.py`
  — adapt parameters, `exec(open(...).read())` », « Schema snapshot:
  `recipes/<key>/schema.json` ». Pas de bloc `<run_recipe>`, pas de pin de
  tâche, pas de changement du message de pilotage : le bloc est déjà stable
  pour le run et présent à chaque tour, ce qui règle aussi le cas où le tour 1
  sort de la fenêtre de 40 messages.
- **Les corps de skills sont rendus dans `<workflow_context>`** (premier bloc
  sous `DYNAMIC SUFFIX`, `agent-system-prompt.md:855-861`), obtenus via
  `readSkillWorkspaceFile(conversationId, …)` pour conserver la porte des
  providers actifs (`read-skill-file.ts:74-77`) — jamais lus sur le disque
  directement. C'est l'application de `agent-context-framework.md` §8 : une
  référence lue à chaque run est le prompt du run arrivant un step plus tard.
  Gain : un step par fichier, et l'immunité à la microcompaction (un `read`
  est compactable, le prompt non). Coût : ces tokens sont payés au tarif cache
  à chaque step et écrits une fois par run ; **plafond ~8 k tokens de corps
  rendus par run** (PbyP ≈ 5,5 k), au-delà duquel la ligne redevient « read
  these files in one step ». Sur les upstreams à cache explicite,
  `openrouter-cache.ts` met un seul breakpoint sur le message système : un
  `<workflow_context>` plus gros est un bloc caché plus gros, sans
  interaction.
- **Le prompt ordonne encore le `read`.** `<tool_routing>` ligne 1 impose un
  `read("skills/<name>/SKILL.md")` avant tout `python` ; un modèle qui voit
  cette règle relira le corps et le step économisé disparaît. Une phrase
  `AGENT:workflow` s'ajoute à cette ligne : « bodies rendered in
  `<workflow_context>` are already in context — do not read them again ».
  Édition de prompt couplée à la suite `doctrine` (`doc-skill-first-xlsx`) et
  au seed Langfuse, per la checklist du framework.
- **Les fichiers `recipes/`** sont écrits au bootstrap de la sandbox par
  `writeSandboxFiles`, dans le même lot que `pushTeamSkills`
  (`conversation-storage.ts:740-747`), gaté sur `agentType === 'workflow'`, et
  lisibles côté Bun via `read` (préfixe `recipes/` à ajouter à la liste
  autorisée, `tools/read.ts:540`). Le script ne coûte des tokens que s'il est
  lu ; l'agent l'exécute par `exec(open(...).read())` sans le retaper (la
  doctrine « never transcribe tool output into another tool call » vaut pour
  le code aussi).

#### La compilation déterministe des séquences, et sa porte

C'est le cœur de « moins d'appels », et il n'y a aucun modèle dedans.

**Ce qui est fusionné.** Les chaînes droites de 4.1, et rien d'autre. Une tâche
qui a fait quinze lectures pour reconstruire à la main une jointure que le
serveur savait faire produit quinze appels dont les arguments descendent tous
des précédents : une chaîne droite, un fichier, un appel. Une tâche qui a fait
deux lectures puis a choisi un dossier en fonction de ce qu'elle a vu a un
argument `dynamic` au milieu : deux blocs, pas un. La règle décide seule, sans
qu'on ait à deviner ce que le modèle « pensait ».

**Ce qui est supprimé.** Les répétitions : le même appel avec les mêmes
arguments deux fois dans un run, ou dans tous les runs. La découverte de schéma
en est le cas majeur et elle a déjà son fichier ; la règle générale couvre le
reste (relecture d'un même document, `whoami` répété, listing déjà obtenu).

**La porte : le rejeu contre l'historique.** Avant qu'une fusion ou une
suppression soit servie à un run, elle est exécutée avec les entrées des
N derniers runs réussis et sa sortie est comparée à ce que ces runs avaient
obtenu au même endroit. Identique, elle passe ; différente, elle est jetée sans
autre forme de procès. C'est gratuit, déterministe, et ça ne demande ni juge
modèle ni humain. C'est la porte d'ASI, où seulement 15,6 % des programmes
candidats survivent : **un taux de rejet élevé est le signe que la porte
travaille**, pas qu'elle est mal réglée. C'est aussi ce qui autorise, au palier
suivant, un modèle à _proposer_ des optimisations sans jamais décider seul.

**Trois limites à énoncer tout de suite.** Le rejeu n'existe qu'en lecture :
une chaîne qui écrit n'est jamais fusionnée automatiquement, elle reste
agentique ou devient une proposition à un humain. La règle def-use est
conservatrice par construction : elle refusera des fusions qu'un humain
trouverait évidentes, et c'est le bon compromis, parce que l'erreur inverse
retire silencieusement une décision au modèle. Et le chiffre de 51 % d'appels
supprimables de TraceCompiler vient d'un autre corpus que le nôtre : le palier
0 mesure le nôtre avant qu'on construise quoi que ce soit.

#### Paliers ultérieurs, conditionnés aux mesures

La substance de la v1 (optimiseur, pitfalls, prélude, tâche sans LLM) reste
la cible, mais chaque marche a une condition d'entrée chiffrée et un retour
arrière :

| palier                                                   | condition d'entrée                                                                                                                                                                                             | contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | retour arrière                                                                                                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **remplacer une vérification par du code** (`assisted+`) | ≥ 3 runs présentant le même candidat de vérification (4.1) ; ou des recettes verbatim qui plafonnent alors que les mêmes erreurs se répètent d'un run à l'autre                                                | une passe LLM sur les **trajectoires brutes** (rôle `workflow-optimize`, à lier par mesure) qui **propose** : (a) pour chaque candidat de vérification, une fonction Python produisant le même verdict à partir des mêmes entrées ; (b) ≤ 5 pitfalls conditionnels (« quand X, faire Y ») citant chacun un `toolCallId` réel, sinon rejetés ; (c) un script consolidé pour les tâches `stable` que la règle def-use n'a pas su fusionner seule. **Chaque proposition passe la porte du rejeu** et doit reproduire le verdict ou la sortie de CHAQUE run passé ; acceptée, elle démarre en `assisted`, c'est-à-dire offerte à l'agent qui décide de s'en servir. Deltas fusionnés par un curateur déterministe, jamais une réécriture ; compteurs `applied` / `errorRecurred` ; dédup mécanique par embedding, pas de porte LLM sur des lignes LLM ; validation statique (`ast.parse`, actions observées seulement, aucun littéral paramétrable en dur) ; recette versionnée avec parent ; `converged` quand deux passes n'acceptent aucun delta | rétrogradation à la recette dérivée v1 si le taux de succès des runs avec recette passe sous la baseline sur 10 runs                                                                                          |
| **propositions de playbook**                             | une tâche dont les steps ne baissent pas et dont le ledger montre un motif connu : le même document relu puis extrait, un inventaire séparé de l'extraction, une tâche de jugement à qui on a soufflé `python` | l'optimiseur rédige un **diff proposé** des `instructions` ou des `toolHints` de cette tâche, affiché dans la carte « Optimisations » avec les runs qui le motivent, à la manière d'une pull request. **Jamais appliqué automatiquement** : le playbook est la spécification de l'équipe. C'est souvent le levier le plus fort et le moins cher, la doctrine du dépôt attribuant déjà les pires runs observés à des playbooks mal écrits plutôt qu'à des outils défaillants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | l'humain ignore la proposition ; elle n'est pas reproposée tant qu'un nouveau run ne rapporte pas le même motif                                                                                               |
| **`scripted`** (prélude par le harnais)                  | ≥ 10 runs réussis au même `playbookHash`, ≥ 90 % de séquence d'actions identique, script sans écriture, ≥ 2 runs où l'agent l'a **exécuté lui-même** avec la forme de sortie attendue                          | le harnais exécute le script avant le tour où la tâche devient courante, **par le chemin du tool `python`** (bootstrap, JWT via `ensureSandboxAuthFile`, `maybePersistLargeOutput`, `consumeSandboxApprovalPending`) et non par un `runInSandbox` parallèle ; injecte une paire tool-call / tool-result synthétique (`tool-python`, `output-available`, le procédé de `buildSyntheticActivationReplayMessage`) **en queue** de l'historique, jamais mi-historique, sauvée avant le tour avec `workflowTurnIndex` ; `ensureSteeringMessage` passe d'un test sur le dernier message à un `find` par métadonnée ; cache adressé par contenu `(runId, taskKey, scriptHash, paramsHash)` pour l'idempotence du replay                                                                                                                                                                                                                                                                                                                                | échec de prélude (exception, sortie vide, forme inattendue) → `assisted` ce run-ci ; `r_fail > 0.5` sur les 4 derniers → recompilation ; ≤ 3 recompilations par `playbookHash` puis `disabled` + notification |
| **`no-LLM`**                                             | ≥ 50 runs `scripted` réussis, 0 échec de prélude, le script produit `summary` et `expectedOutput`, **clic humain** « Automatiser cette tâche »                                                                 | la tâche est fermée par le harnais sans tour modèle ; la tâche suivante voit la sortie dans son contexte ; l'agent reste le filet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | tout échec → `scripted` ; changement de `playbookHash` ou de fingerprint → recette v1                                                                                                                         |
| **niveau de raisonnement par tâche**                     | à mesurer (latence par step sur les tâches `stable`)                                                                                                                                                           | la recette propose un `reasoningLevel` par tâche, appliqué par le harnais au tour (`effectiveReasoningLevel`, `handlers/workflow.ts:515`) **seulement** quand toutes les tâches encore ouvertes sont `stable` (les tâches s'enchaînent dans un tour via `completeTask`), seulement pour **baisser**, seulement si `workflow.reasoningLevel` est null ; vérifier l'effet dans la trace, car la fonction renvoie `undefined` en silence au niveau par défaut ou sur une échelle à un seul barreau                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | désactivation par workflow                                                                                                                                                                                    |

**Pré-vol par modèle.** Au changement de modèle de l'équipe ou du workflow,
le fingerprint change et la recette repart de zéro ; avec l'optimiseur, une
recette n'est rendue sur un nouveau modèle qu'après un run où elle a été
utilisée (4.1).

#### Interface et contrôle humain

Voir 4.6. En résumé : niveau par workflow (`off` / `shadow` / `on`) dans les
réglages ; carte « Optimisations » sur la page du workflow (ce que le dernier
run a reçu, par tâche, les fichiers lisibles, les runs sources, les métriques
avant / après, désactiver / réinitialiser) ; le détail repliable de
`RunTimeline` liste par tâche ce qui lui a été donné.

### 4.3 Chat : skills et notes apprises

Le chat n'a pas d'identité de tâche stable ni de signal de succès
déterministe. Il a besoin de deux choses plus légères que la recette de run,
et d'un humain dans la boucle pour ce qui est partagé.

#### (a) Notes apprises par external app

**Quoi.** Des faits d'usage courts, vérifiés, à l'échelle de l'équipe :
« `consignee.country` renvoie une clé étrangère nue ; utiliser
`consignee.country_id.name` », « le compte du client ne voit pas
`sea_folders` master : filtrer `folder_type != master` évite un résultat vide
interprété comme inexistant ». Pas de données métier, pas de valeurs d'un
document.

**Schéma** (Grounding Agent Memory) : `{ category: pattern | rule | trap |
schema | policy, confidence: high | medium | low, appliesTo (collection ou
action), lemma (une ligne impérative), provenance [{ conversationId | runId,
toolCallId }], dependsOn [{ kind: provider-skill | collection | mcp-snapshot,
key, version }], lastObservedAt, counters { applied, useful, misleading } }`.

**Extraction.** Un worker nocturne (dans le sweep « dreaming ») lit via le
ledger les runs et les tours de chat de la journée qui ont touché un
provider, et sélectionne **mécaniquement** les candidats : paires erreur →
correction (code d'erreur ou exception, puis appel réussi du même outil avec
arguments modifiés), formes de requêtes qui ont répondu (appels `query_items`
non vides et leurs `fields`), lectures de références qui ont précédé un
succès. Sources v1 : les **runs** (succès déterministe) et, pour le chat, les
paires erreur → correction **vérifiées par une sonde read-only** — rejouer
l'appel de lecture cité avec la correction et constater que le résultat n'est
plus la clé étrangère nue (opt-in par équipe, providers `http-direct` comme
PbyP d'abord). Une seule passe LLM rédige la ligne ; la dédup contre les notes
existantes et contre le **corps du SKILL** (canonicité : une note déjà
couverte par le skill n'est pas écrite) est **mécanique** (cosinus sur
`lemma`), jamais une porte LLM sur des lignes écrites par un LLM. Règle de
récurrence : ≥ 2 runs ou conversations distincts.

**Stockage et service.** Namespace machine `learned/howto/<provider>.md` dans
`ai_memories`, scope équipe (jamais utilisateur ; on exclut les notes dérivées
d'une connexion privée si elles nomment la connexion). Servi de deux façons :
(1) **dans le SKILL lui-même** — `read-skill-file.ts` résout déjà le fichier
par équipe (bundled → provider → snapshot MCP → skill d'équipe) et ajoute, au
moment du `read`, une section finale `## Appris dans cette équipe` (≤ 8 notes,
≤ 1 500 tokens) ; zéro appel supplémentaire, zéro token tant que le skill
n'est pas lu, et l'agent lit la note exactement au moment où il en a besoin ;
la même section est présente dans le SKILL rendu en preload d'un run (4.2) ;
(2) indexé dans `ai_vectors` comme les autres mémoires, donc trouvable par
`searchKnowledge`.

**Hygiène.** ≤ 8 notes actives par provider ; invalidation **par ligne** : une
note dont une dépendance change de version (SKILL republié, collection
renommée, snapshot MCP) passe « à vérifier » (re-sonde ou suppression), les
autres restent ; retrait d'une note non ré-observée en 90 j ; jamais partagée
hors de l'équipe (transfert négatif, 3.2). Visible et éditable dans la page
Mémoire (4.6).

#### (b) Skills apprises

**Quoi.** Quand une même _forme_ de demande a été menée à bien plusieurs fois
dans l'équipe (« sors-moi le récap des dossiers de la semaine en xlsx »), la
séquence qui a marché et le code qui a produit le livrable deviennent une
**skill** : un SKILL.md (quand l'utiliser, 3-8 étapes, outils, le script en
annexe) dont la `description` est le **déclencheur** — le routeur L1, éditable
par l'utilisateur, le levier n° 1 de précision (Devin).

**v0, sans migration.** Le job nocturne crée, par le chemin `createSkill`
existant, une ligne `team_uploaded` avec `sourceUrl = 'learned:<conversationId>[,…]'`
(provenance) et `sourceHash`, puis la **désactive** via `team_skills` (« créer
puis basculer », documenté dans `services/skills/create.ts`). Elle apparaît
dans la page Skills sous « Proposées par l'assistant » (filtre sur le préfixe
`learned:`), badge « Proposée », désactivée ; **activer = approuver** (mutation
admin, `assertOrgAdmin`, le contrat existant). Tant qu'elle est désactivée,
elle n'est ni dans le catalogue ni dans la sandbox : `listEnabledSkillsForTeam`
et `listEnabledTeamUploadedSkillsWithBodyForConversation` la filtrent déjà.
Zéro colonne nouvelle, zéro nouveau chemin de lecture, et exactement le modèle
« proposé, revu, activé » vers lequel convergent Devin, Intercom et Dreams.

**v1, si le volume le justifie** (palier 3) : `source = 'learned'` (l'ajout
d'une valeur d'enum est **sa propre migration** — Postgres refuse de
l'utiliser dans la transaction qui la crée), `activated_at` (NULL = proposée)
plutôt qu'un enum de statut, `evidence` et `counters` jsonb, une table
`skill_history` calquée sur `ai_memory_history`. Fan-out à traiter, parce que
toutes les lectures filtrent sur `'team_uploaded'` : `list-for-team.ts`,
`list-enabled-team-uploaded-with-body.ts` (qui sert `read-skill-file.ts`
**et** `pushTeamSkills`), `slugify-name.ts` (une skill apprise homonyme d'une
bundled serait masquée, `read-skill-file.ts` résolvant bundled d'abord),
`get-by-id` / `update` / `delete`, et un cap **séparé** ≤ 10 dans le même
budget de préfixe que les 30 skills d'équipe (~100 tokens par ligne).

**Extraction.** Même worker nocturne : tours (ou suites de tours) avec ≥ 4 tool
calls et un livrable (`presentFiles`, `run_plan` approuvé, écriture de records),
regroupés par similarité d'embedding de la demande **et** signature d'outils ;
une skill n'est proposée qu'à partir de **≥ 2 occurrences** dans l'équipe ; une
passe LLM rédige le SKILL.md ; dédup mécanique contre le catalogue (bundled +
équipe + proposées). Écriture nocturne par lots : le catalogue est dans le
préfixe d'équipe, chaque activation invalide son cache une fois.

**Service.** Le catalogue L1 et le pipeline sandbox existants ; aucun
`source_type` nouveau, aucun bras de recall, aucun bloc de prompt nouveau. Une
ligne dans `<memory_protocol>` : « une skill marquée _apprise_ est un point de
départ à vérifier, pas une réponse ; adapte les paramètres, exécute le
fichier ».

**Retrait.** Compteurs `useful` / `misleading` (flags utilisateur, 4.6) et
`successAfterRead` (tour terminé sans erreur après lecture) ; contribution
`(useful − misleading) / lectures` ; retrait automatique ssi n ≥ 30 lectures
et contribution ≤ −0,10 (constantes de Library Drift réduites à notre volume,
**à calibrer** ; jamais de retrait précoce, mesuré pire que pas de
bibliothèque) ; expiration si non lue en 90 j, avec un nudge « toujours
utile ? » plutôt qu'une suppression silencieuse.

#### (c) Règles de préchargement déterministes (chat)

Sans apprentissage, une règle mesurable : si le message porte une pièce jointe
`.xlsx/.csv/.docx/.pptx/.pdf`, ou si une skill apprise activée nomme un skill
bundled, le bloc `<session_state>` du suffixe dynamique demande la lecture
**en un step** des SKILL concernés, avant tout `python`. À mesurer au palier 2 :
la part des tours de chat qui lisent un skill, et le nombre de steps
séquentiels qu'ils y consacrent aujourd'hui. Pour les runs, ce mécanisme est
remplacé par le rendu dans le prompt (4.2).

### 4.4 Boucle mainteneurs

Les skills bundled et les SKILL générés des providers sont des actifs
plateforme, industrie-agnostiques (`packages/ai/CLAUDE.md`) : **aucune
écriture automatique**. Mais ils sont le bon endroit pour corriger une erreur
que _toutes_ les équipes font. Chaque semaine, un script opérateur
(`skills:insights-report`) agrège les notes `learned/howto/*` et les erreurs
récurrentes du ledger par provider et par skill, anonymisés (sans valeurs,
sans noms d'équipe), et classe les motifs qui reviennent dans ≥ 2 équipes. Le
rapport alimente `skills/bundled/BACKLOG.md` et
`providers/src/<key>/guidance.md` via des PR humaines. Une note reprise dans
le skill est ensuite retirée des notes d'équipe par la dédup mécanique contre
le corps du skill.

### 4.5 Gains structurels indépendants de l'apprentissage

Repérés pendant l'analyse ; à instruire séparément, mais ils comptent pour
« plus rapide » :

- **Préchauffer la sandbox du run** : `void prepareSandbox(conversationId)`
  (`conversation-storage.ts:396-398`, dédoublonné in-process via
  `inFlightInits` et cross-réplica via `.fretik-init`) juste après le test de
  replay dans `executeTurn` (`handlers/workflow.ts:892`) — jamais avant, pour
  qu'un tour rejoué ne crée pas de sandbox ; `releaseSandbox` en `finally` met
  déjà en pause. `Sandbox.create` vaut 2-5 s, le bootstrap 6-8 s : c'est ce
  dernier qu'on parallélise avec le recall du tour 1 (18 s de budget).
  `prepareSandboxForCode` (JWT, hydratation du contexte) reste sur le chemin du
  tool, il a besoin de `ctx`. Mesure : `startedAt → premier python` dans le
  ledger. Quelques heures de travail, aucun risque.
- **Découper le SKILL PbyP** (246 lignes, 21 Ko) en un corps court (lectures,
  routage, recettes) et des références déjà séparées : à faire dans
  `guidance.md`, hors plan.
- **À mesurer avant de construire** : un garde-fou « cellules python trop
  petites » dans `withLoopGuard` (Anthropic mesure que le batching coûte plus
  cher sur un tour à 1-2 appels séquentiels ; le ledger dira d'abord combien
  de cellules consécutives sans dépendance un run typique produit). Le cache
  Redis de `describe_collection` de la v1 est retiré : le snapshot de schéma
  de 4.2 couvre le même besoin et économise le step, pas seulement l'appel.

### 4.6 Visibilité et gouvernance des apprentissages

**Principes** (issus de 3.5) : visible par défaut, jamais modal ; annulation
plutôt qu'approbation pour ce qui est personnel, réversible et non exécutable ;
revue explicite pour ce qui est partagé (équipe) ou exécutable (recette rendue,
prélude, `no-LLM`) ; on montre **quel item, quelle version, ce qu'il dit, d'où
il vient** — jamais le raisonnement brut ; risque par paliers, pas de gate
uniforme ; tout est journalisé.

**Au moment de l'apprentissage.**

- Chat : au prochain tour de l'utilisateur concerné après la passe nocturne,
  une carte compacte de niveau supérieur, sur le modèle de `ToolSkillDraft.vue`
  (proposition) ou de `ChatStepCompaction.vue` (data part système) :
  « L'assistant propose une skill : _<déclencheur>_ » avec **Voir**,
  **Modifier**, **Ignorer** ; pour une note d'app : « L'assistant a noté :
  _<lemma>_ » avec **Garder** (défaut, sans clic), **Modifier**, **Ne pas
  retenir**, annulable toute la session. Distinguer visuellement _explicite_
  (« retiens ça ») et _inféré_.
- Run : `RunResultCard` : « Recette dérivée de 3 runs — voir » ; email de fin
  de run (`send-run-completion-email.ts`) : une ligne, pas plus.
- Dashboard : `ActivityCard` affiche déjà `skill.created` — le payload porte
  `proposed: true` et la carte le rend « proposée par l'assistant » ;
  `AttentionCard` gagne une `kind: 'review'` (l'enum `approval | error` de
  `schemas/dashboard.ts` à étendre) pour les skills en attente d'activation.

**Au moment de l'usage.**

- Chat : `ToolSkillRead` existe pour un `read` de SKILL → badge « apprise » ;
  pour un SKILL de provider, sous-titre « avec N notes apprises » ; sur chaque
  item, **Utile** / **Trompeur** (le split Useful / Misleading de Devin) →
  compteurs et preuve négative, visibles dans la fiche de l'item. C'est ce qui
  garde une base d'apprentissages honnête sans qu'un admin relise des
  transcripts.
- Run : `RunTimeline` — le détail repliable par tâche (qui montre déjà
  `toolHints`) liste ce que la tâche a reçu : skills en contexte, fichier de
  code, snapshot de schéma ; chip « recette (3 runs) » ; `RunSidebar` — ligne
  « Recette : dérivée des runs #… ». Le transcript readonly montre les mêmes
  cartes.

**Surface de gestion.**

- **Skills apprises** — page Skills (`pages/settings/skills.vue`) : section
  « Proposées par l'assistant » (rows désactivées, badge « Proposée »,
  provenance = liens vers les conversations sources reconstruits depuis
  `sourceUrl`) ; une fois activées, badge « apprise » dans la liste courante.
  Fiche (slideover) : contenu markdown éditable (une édition = une version en
  v1, `skill_history` + `BaseVersionTimeline` + `BaseDiffViewer`), déclencheur
  éditable, provenance, preuves (tours où elle a aidé / été signalée),
  dernière lecture, nombre de lectures, ratio utile / trompeur, marqueur de
  fraîcheur ; actions activer / désactiver / modifier / supprimer / fusionner
  dans une skill existante (`SettingsSkillEditor` pré-rempli via
  `initialDraft`). Lecture pour tout membre ; mutations admin côté serveur
  (contrat existant) ; « Ignorer » et « Trompeur » ouverts à tous.
- **Notes par app** — ce sont des `ai_memories` (`learned/howto/`) → page
  Mémoire, onglet équipe, filtre « Procédural (par app) », badge du provider ;
  la ligne `Sources:` brute devient une liste de liens (conversation / run) ;
  lien « N notes apprises » sur la carte de connexion dans External apps.
- **Recettes** — page workflow : dans la pile, une carte « Optimisations »
  entre `WorkflowTriggerEditor` et la grille des runs (recette du dernier run :
  par tâche, ce qui a été rendu et les fichiers, lisibles ; runs sources ;
  métriques avant / après ; actions **désactiver** / **réinitialiser**) ; les
  **propositions de playbook** y apparaissent comme des diffs à accepter ou à
  ignorer, avec les runs qui les motivent, jamais appliquées seules ; le
  niveau (`off` / `shadow` / `on`) en troisième `BaseSection` de
  `SettingsSlideover`. Le bouton « Automatiser cette tâche » (palier `no-LLM`)
  vivra dans ce tableau.

**Politique d'équipe** (`team_ai_settings`, jsonb additif `learning`, le
voisin que le commentaire de la table prévoit déjà pour `hostConstraints`) :
`mode: off | personal | propose | auto` — `auto` n'active seul que les notes
d'app (non exécutables, réversibles) ; les skills apprises restent des
propositions ; recettes rendues et prélude sont des opt-in par workflow —,
`excludedConnectionIds`, `retentionDays` (défaut 90), kill switch = **gel**
(désactivation, conservation) et suppression sur demande explicite ;
l'identité du contributeur n'apparaît jamais dans le corps d'une skill
d'équipe. Approbateurs = admins d'organisation (le contrat `assertOrgAdmin`
existant, pas d'exception à creuser). Défaut à la sortie : `propose` pour les
équipes pilotes, `off` ailleurs.

**Journal d'audit** (registre `event-types.ts`) : `skill.created` existe
(payload `proposed: true`) ; ajouter `skill.activated`, `skill.applied`
(conversation / run, version), `skill.flagged`, `recipe.derived`,
`recipe.disabled`, `recipe.reset`, `learning.policy_changed`,
`learning.source_deleted_cascade` ; chaque événement porte l'acteur
(utilisateur, agent, job nocturne, admin), l'id d'item, l'id de version et un
hash du contenu. Versions conservées au-delà de la suppression, rédaction
possible d'une version (modèle Managed Agents). Export avec `memory:audit`.

**Effacement.** Supprimer une conversation supprime les propositions dérivées
d'elle seule et marque « à revoir » les items actifs qui la citent ;
documenté dans les paramètres (le découplage documenté de Copilot et Gemini
est précisément ce qu'un DPO demandera).

**Compromis.** Mesurer la latence de revue, le taux de rejet et le taux de
signalement par item, et ré-examiner un échantillon aléatoire d'items déjà
approuvés : le tampon se détecte.

## 5. Garde-fous

- **Approbations et autonomie inchangées.** Aucun chemin nouveau n'exécute une
  écriture : le code d'une recette est exécuté par l'agent dans le tour, via
  `.op()` / `run_plan` / `records.bulk_*`, avec la pause habituelle ; la
  frontière est `/sandbox/exec` et les approbations, jamais une regex. Un
  workflow `read_only` reçoit une recette sans code d'écriture.
- **Même périmètre d'identité.** Un script s'exécute dans la sandbox du run
  avec l'`auth.json` du run : mêmes connexions, mêmes RLS, même équipe. Une
  recette est liée à `teamId` ; un `playbookHash` inclut les
  `externalAppConnectionIds`, donc un changement de connexion invalide.
- **Provenance obligatoire.** Chaque note, chaque skill proposée, chaque
  pitfall cite un `runId` / `conversationId` + `toolCallId` qui existe ; le
  rejet est mécanique. C'est la même défense contre le « memory rot » que la
  ligne `Sources:` des promotions.
- **Porte d'admission avant activation** (VaG) : schéma valide ∧ preuve citée
  existante ∧ critique (fabrication, contradiction avec le skill, donnée
  métier) ; pour un script exécuté par le harnais : replay. Jamais de
  nettoyage a posteriori comme filet principal — il ne récupère pas.
- **Pas de données métier dans le procédural.** Le scrubber de secrets
  d'`upsertEpisode` s'applique ; les littéraux du payload du trigger sont
  paramétrés ; une note qui contient un numéro de dossier, un montant, un nom
  de contact est rejetée par regex avant la passe LLM et par le prompt.
- **Rien sur les personnes.** Les apprentissages décrivent des tâches et des
  apps ; aucune surface n'expose à un manager ce qu'un membre « fait mal ».
- **Jamais de transfert inter-équipes ni inter-organisations.**
- **Cache préfixe protégé.** Tout ce qui est par run vient de la ligne du run ;
  les corps rendus sont plafonnés ; les scripts sont des fichiers ; les
  écritures dans le catalogue de skills sont nocturnes.
- **L'agent reste capable sans recette.** Une recette est une aide optionnelle,
  jamais une dépendance ; `off` est toujours un état sûr ; rétrogradation
  automatique aux paliers 3-4 ; le disjoncteur existant reste le dernier filet.
- **Budgets.** ≤ 8 k tokens de corps rendus par run ; ≤ 1 500 tokens de notes
  par SKILL ; ≤ 10 skills apprises actives par équipe ; ≤ 8 notes par provider ;
  aux paliers 3-4, ≤ 5 pitfalls et ≤ 3 scripts par tâche, une passe LLM par
  optimisation plafonnée par jour et par équipe (même logique que
  `MAX_DISTILLS_PER_TEAM`).
- **Rien d'appris en silence.** Section 4.6 : cartes, pages, journal.
- **Effacement en cascade.** Section 4.6.
- **Opt-in progressif.** `team_ai_settings.learning` ; défaut initial `shadow`
  / `propose` pour les équipes pilotes, `off` ailleurs ; on ne change le
  défaut qu'avec les mesures de la section 6.

## 6. Mesure et evals

**Indicateurs** (tous dérivables du ledger, publiés en scores Langfuse) :

| niveau          | indicateurs                                                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run de workflow | steps, tool calls par outil, lectures de skills, cellules `python`, `errorCalls`, `errorThenRetry`, tokens d'entrée non cachés / cachés / sortie, TTFT par step, durée travaillée (`finishedAt − startedAt − pausedMs`), `startedAt → premier python`, statut, `recipeUsed`, mode de recette |
| tour de chat    | idem, plus lectures de skills apprises / tours éligibles (engagement du routeur) et `skillReadBatched`                                                                                                                                                                                       |
| recette         | delta baseline → avec recette sur les mêmes indicateurs, **tokens de recette inclus**, taux de succès, part des runs qui ont utilisé le code                                                                                                                                                 |
| skills et notes | proposées / activées / rejetées / expirées, `applied`, `useful`, `misleading`, `successAfterRead`, latence de revue, taux de rejet, taux de signalement                                                                                                                                      |

### Lire la production pour le palier 0

Les données dont le palier 0 a besoin sont déjà en production, et rien n'a
besoin d'être instrumenté avant de les lire. Deux sources, deux méthodes, et
quelques règles qui ne se négocient pas.

**La topologie réelle, vérifiée le 2026-09-15** sur l'hôte de production
(`193.168.146.115`, entrée dédiée dans `~/.ssh/config`, clé `amoret_rsa`
chargée dans l'agent) :

| ce qu'on veut          | conteneur                                            | port sur l'hôte         |
| ---------------------- | ---------------------------------------------------- | ----------------------- |
| base applicative       | `fretik-dbtunnelproxy-…-postgres-tunnel-proxy-1`     | `127.0.0.1:5434`        |
| Redis applicatif       | `fretik-dbtunnelproxy-…-redis-tunnel-proxy-1`        | `127.0.0.1:6381`        |
| service `@fretik/ai`   | `fretik-ai-…`                                        | pour `docker exec`      |
| Langfuse, auto-hébergé | `fretik-langfuse-…-langfuse-web-1`, derrière Traefik | via `LANGFUSE_BASE_URL` |

**Le piège à ne pas rater.** `127.0.0.1:5432` sur cet hôte est la base de
**Langfuse**, pas la base applicative. Seul `5434` est la base produit. Se
tromper de port, c'est profiler le mauvais corpus sans s'en apercevoir, parce
que les deux répondent.

**Méthode A, préférée : dans le conteneur, sans rien ouvrir.** C'est la classe
« ad-hoc operator » de `docs/OPERATIONS.md` §3. `FRETIK_RUNTIME=container` est
posé par l'image, donc la garde autorise sans bris de glace.

```bash
ssh 193.168.146.115 "docker exec -w /app/packages/jobs \
  \$(docker ps -q -f name=fretik-ai -f status=running) \
  bun run workflows:profile -- --workflow=<id> --target=prod"
```

**Méthode B : le tunnel depuis le laptop.** Plus rapide à mettre en route,
mais c'est la forme exacte qui a causé l'incident du 2026-08-30, donc elle
exige le bris de glace et se referme tout de suite après.

```bash
ssh -N -L 5434:127.0.0.1:5434 193.168.146.115 &
NODE_ENV=production FRETIK_ALLOW_LAPTOP_PROD=1 \
  bun run workflows:profile -- --workflow=<id> --target=prod
```

`NODE_ENV=production` suffit à faire charger `.env.production.local` par Bun :
la chaîne de connexion n'est ni lue, ni affichée, ni recopiée nulle part.

**La ligne à lire avant tout le reste.** Quelle que soit la méthode, la garde
imprime, avant la moindre requête :

```
[target] prod — db=<nom> host=<ip>:<port> user=<rôle>
```

C'est le nom que le serveur se donne, pas l'URL à laquelle on croit. Si cette
ligne ne nomme pas la base attendue, tout ce qui suit ne vaut rien. Elle existe
parce qu'un script dont l'intention était la lecture seule, par ce même tunnel,
a migré la production.

**Ce qu'on lit, et ce qu'on n'écrit jamais.** Des `SELECT`, sur `workflows`,
`workflow_runs` et les `ai_messages` des conversations de run. Aucun `INSERT`,
aucun `UPDATE`, aucune migration, aucun script qui garde un chemin d'écriture
« au cas où ». La sortie du profileur est **agrégée** : compteurs, histogrammes
par outil et par tâche, hachages d'arguments canoniques, ratios de similarité,
quantiles. Elle n'imprime jamais un argument ni une sortie d'outil, qui sont
les données métier des clients. Un identifiant de run et une clé de tâche
suffisent à remonter à un cas à la main si besoin.

**Langfuse.** L'API HTTP sur `LANGFUSE_BASE_URL`, avec les clés déjà présentes
dans `packages/ai/.env`, filtrée sur l'attribut d'environnement de production.
Elle apporte ce que la base n'a pas : le temps jusqu'au premier token et la
latence par étape, et le coût exact, sur les traces `workflow-turn` et
`chatbot-turn`, groupées par session, la session étant la conversation du run.
**Ne jamais interroger la base Postgres de Langfuse directement** : c'est un
détail d'implémentation du produit, son schéma n'est pas un contrat, et l'API
répond à la même question.

**Les quatre questions auxquelles ce profilage doit répondre**, et dont dépend
tout le reste du plan :

1. Où partent les étapes d'un run, par tâche et par outil ?
2. Quelle part des étapes est de la relecture de skills et de la redécouverte
   de schéma ? C'est le gain direct du palier 1.
3. Quelle part des cellules `python` consécutives est fusionnable, c'est-à-dire
   ne contient aucun littéral apparu dans la sortie de la cellule précédente ?
   C'est le gain du palier 1b.
4. Reste-t-il des tâches dont les étapes partent en jugement plutôt qu'en
   mécanique ? Si oui, le levier est le playbook, pas la recette.

**Ce que la production ne peut pas faire.** Mesurer, oui. Valider, non. On ne
peut pas comparer une recette à son absence sur la production sans lancer de
vrais runs qui écrivent dans de vrais systèmes. La validation reste au harnais
headless sur l'équipe d'eval, ou au **mode ombre** de 4.2, qui calcule ce que
chaque run aurait reçu sans rien lui donner. Le mode ombre est le seul moyen
d'obtenir le chiffre « combien on aurait économisé » sur du trafic réel à
risque nul.

**Harnais.** Il manque le harnais de run de workflow ; il devient un prérequis
du palier 1, pas un à-côté : un point d'entrée headless (`POST
/internal/trigger/runs/:runId/turn` piloté par le harnais à la place de
Trigger.dev, comme `evals:chain` pilote déjà un run e2e) + un playbook fixture
PbyP sur l'équipe `eval-write`, avec `--repeats` et détection de bimodalité
comme `evals:recall`. Suite `evals:workflow-recipes` : le même workflow
exécuté N fois **sans** recette (baseline), puis N fois **avec** (recette
dérivée des runs baseline), sur des payloads différents pour prouver la
paramétrisation ; critères : succès ≥ baseline, steps et durée en baisse
significative (la même statistique que `evals/langfuse/criteria.ts`), zéro
écriture non approuvée.

**Protocole** (3.2) :

- Baseline **à budget égal** : tokens totaux recette / corps rendus / notes
  inclus ; comparer aussi à « vanille + 5 steps ».
- ≥ 3 répétitions par cas, Any-of-3 / All-of-3, intervalles de Wilson ; tokens
  acteur vs module séparés ; steps, appels modèle, TTFT par step (le préfixe
  grossit), latence, coût.
- Paires **avec / sans** par item (SkillAudit) ; veto « nuit » ; vérificateur
  d'ancrage déterministe (forme du livrable).
- **Injection de dérive** : bump du `version:` d'un SKILL de provider dans la
  fixture → la recette doit disparaître, les notes passer « à vérifier ».
- Compteurs par item en scores Langfuse ; `recipeUsed` par run.
- Pré-vol de conformité par modèle avant de faire confiance à une recette sur
  un nouveau modèle.

Pour le chat : suite `evals:procedures` (« même demande deux fois, la seconde
doit coûter moins de steps une fois la skill activée », et « une note apprise
évite l'erreur qu'elle décrit »), sur `EVAL_WRITE_TEAM_ID`, avec `--cleanup`
comme `evals:memory`. Les cas de recall existants (`evals:recall`,
`memory-recall`) servent de non-régression : rien ne change dans le recall.

**Déploiement par paliers.** `shadow` (recette calculée, rendue nulle part,
delta estimé) → canary sur le workflow PbyP d'une équipe pilote → `on` par
défaut pour les équipes pilotes → défaut global. Chaque palier a un critère
chiffré écrit _avant_ (même discipline que le gate des modèles :
`latencyFactor`, enveloppe de coût) et un chemin de retour sans déploiement
(`team_ai_settings`, niveau par workflow).

## 7. Phasage

| palier                                                               | contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                  | durée indicative | dépend de      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------- |
| **0 — Mesurer** (profilage lecture seule sur la production, voir §6) | `extractTrajectory` + `summarizeTrajectory` (module pur, tests unitaires sur des transcripts réels anonymisés, reprend `evals/tool-efficiency.ts`) ; `WorkflowRunUsageSchema` étendu + `onWorkflowStepEnd` ; scores Langfuse ; `workflows:profile` ; runs échoués inclus ; classification des liaisons ; vérité terrain du succès ; baseline chiffrée du workflow PbyP et d'un second workflow sans external app                                         | ~1 sem           | —              |
| **1 — Recettes dérivées + préchauffage**                             | `prepareSandbox` en parallèle du recall ; recette dérivée sans LLM à `createWorkflowRun`, `workflow_runs.recipe` ; corps rendus dans `<workflow_context>` avec plafond ; `recipes/` matérialisés + préfixe `read` ; phrase `<tool_routing>` + suite `doctrine` + seed ; `shadow` → `on` par workflow (`BaseSection`) ; détail `RunTimeline` ; harnais de run headless + `evals:workflow-recipes`                                                         | 2-3 sem          | 0              |
| **1b — Fusion des appels et porte de rejeu**                         | détection des chaînes droites et des répétitions dans le ledger (règle def-use, aucun modèle) ; émission d'un fichier fusionné par chaîne dans `recipes/` ; **rejeu du candidat sur les entrées des N derniers runs réussis**, comparaison à leur sortie, rejet silencieux en cas d'écart ; jamais de fusion d'une chaîne qui écrit ; métriques « appels fusionnés » et « appels supprimés » par run                                                     | 1-2 sem          | 1              |
| **2 — Skills apprises v0 + notes d'app + visibilité**                | brouillons `team_uploaded` désactivés (`sourceUrl = learned:`), section « Proposées par l'assistant », cartes « propose / a noté » et « appliqué », flags Utile / Trompeur, `skill.applied` ; notes `learned/howto/` (runs + sondes opt-in), section « Appris dans cette équipe » servie par `read-skill-file.ts`, filtre Mémoire ; politique `learning` ; événements d'audit ; `evals:procedures` en paires avec / sans ; non-régression `evals:recall` | 3 sem            | 0, 1           |
| **3 — Optimiseur LLM et gouvernance v1**                             | si les recettes verbatim plafonnent : deltas, pitfalls, compteurs, `converged`, porte d'admission ; `source = 'learned'`, `activated_at`, `skill_history`, versions / diff ; export d'audit ; ré-examen aléatoire                                                                                                                                                                                                                                        | 3 sem            | mesures de 1-2 |
| **4 — Exécution par le harnais**                                     | `scripted` (prélude via le chemin `python`, idempotence de `ensureSteeringMessage`, cache adressé par contenu), niveau de raisonnement par tâche, `no-LLM` avec clic humain ; boucle mainteneurs `skills:insights-report`                                                                                                                                                                                                                                | 2-3 sem          | 3              |

Total 12-15 semaines pour une personne ; les paliers 3 et 4 sont conditionnels
et peuvent ne jamais être construits si les chiffres des paliers 1-2 suffisent.
Ordre de valeur : le palier 1 capture l'essentiel du gain sur les workflows
récurrents (plus de redécouverte de schéma, plus de relecture de skills, le
code du run précédent sous la main) avec un risque très faible ; le palier 1b
est celui qui répond directement à « cinq appels devraient en faire un », et il
le fait sans modèle ; le palier 2
apporte la visibilité et le chat ; les suivants ne se justifient que par la
mesure.

## 8. Alternatives écartées

- **Étendre la mémoire métier au procédural** (mettre les pitfalls dans les
  épisodes / `learned/`) : casse la calibration du recall (`evals:recall`),
  mélange deux régimes de vérité (un fait métier vs une manière de faire) et
  n'attache rien à l'identité stable d'un workflow.
- **Un `source_type = procedures` + un sixième bras de recall** (v1 de ce
  plan) : le retrieval à grande échelle est moins précis qu'un catalogue
  borné, la calibration du recall serait à risque, et tout le pipeline
  (stockage, matérialisation, UI, drafts) existe déjà pour les skills.
- **Une machine à états de recette avec convergence** (v1) : inutile tant que
  la recette est dérivée sans LLM ; réintroduite avec l'optimiseur seulement.
- **Un prélude exécuté par le harnais dès le palier 2** (v1) : un second
  chemin d'exécution sandbox à maintenir, l'idempotence du tour à refaire,
  pour un step économisé que l'agent fait de toute façon en `exec` ; reporté
  au palier 4 avec ses conditions.
- **Un agent optimiseur dans la boucle** (qui réécrit le playbook à chaque
  run) : non — le playbook est la spécification de l'équipe (« goal, never a
  tool name »), et un playbook réécrit par un modèle dérive. Une recette est
  une couche _à côté_ du playbook, dérivée et jetable.
- **Rejouer un run entier sans LLM** (style enregistrement / replay) : les
  runs Fretik mêlent collecte déterministe et jugement (mails, rapprochements,
  livrables). On rejoue par tâche, avec l'agent comme filet ; le « sans LLM »
  reste une option par tâche, gagnée par la mesure.
- **Injecter les skills complets dans le préfixe statique** : 15-20 k tokens
  de plus par tour pour toutes les équipes, la plupart des tours n'en ayant pas
  besoin ; le cache lecture ne rend pas ça gratuit et la latence de prefill
  monte. Ce que fait 4.2 est différent : le rendu est **par run**, seulement
  pour les skills que ce workflow lit à chaque fois.
- **Approbation humaine sur chaque item appris** : 93 % de tampon (Anthropic 2026) ; les utilisateurs de Cursor ont désactivé la fonction plutôt que
  d'accepter une gate qu'ils ne comprenaient pas ; réservée au partagé et à
  l'exécutable. **Apprentissage silencieux** : violation d'attente mesurée
  (CHI 2026), dossier invisible (critique de Willison).
- **Fusionner des appels sans porte de rejeu**, à la confiance : c'est le
  défaut explicite de TraceCompiler, qui supprime les appels de découverte de
  schéma sans versioning et transforme un changement d'API en comportement
  faux et silencieux. Une fusion non rejouée est une régression qui attend son
  heure.
- **Laisser un modèle décider qu'un pas est déterministe** : il ne le sait pas
  mieux que la règle def-use, et il se trompe dans le sens dangereux — retirer
  une décision que le modèle prenait vraiment. Le modèle propose, l'historique
  juge.
- **Retrait agressif des skills peu utiles** : mesuré pire que pas de
  bibliothèque (Library Drift).
- **Une porte LLM ADD / UPDATE / NOOP sur des lignes écrites par un LLM** :
  une passe sur une passe ; dédup mécanique.
- **Cache sémantique de réponses** (type GPTCache) : les réponses dépendent de
  données vivantes ; ce qui est stable, c'est la _procédure_, pas la réponse.
- **Cache Redis de `describe_collection`** et **garde-fou « cellules python
  trop petites »** : le premier est couvert par le snapshot de schéma, le second
  n'est pas mesuré.
- **Fine-tuning** : la flotte de modèles est multi-fournisseur et pilotée par
  le registre ; un savoir appris doit survivre à un changement de modèle.
- **Distiller aussi les runs échoués en épisodes** : non — ils entrent dans
  le ledger, pas dans la mémoire de l'équipe.

## 9. Questions ouvertes, à trancher par toi

Résolues par la v2 : précharger par lecture groupée ou par rendu dans le
prompt (rendu pour les runs, lecture groupée pour le chat) ; quand viser la
tâche sans LLM (palier 4, après `scripted`) ; qui approuve (admins
d'organisation, le contrat existant).

1. **Périmètre pilote.** Le workflow PbyP est le candidat évident ; quel second
   workflow (sans external app, avec livrable xlsx) sert de contrôle ?
2. **Modèle de l'optimiseur** (palier 3). À mesurer sur les runs baseline —
   ou ne jamais le construire si les recettes verbatim suffisent.
3. **Sondes read-only à l'écriture d'une note.** Elles consomment des appels
   API du provider hors run ; opt-in par équipe, providers `http-direct`
   comme PbyP d'abord ?
4. **Politique par défaut.** `propose` pour tout, ou `auto` pour les notes
   d'app et `propose` pour les skills ?
5. **Nom produit.** « Skills » avec badges « proposée » / « apprise »
   (unifié, recommandé) ou « Procédures apprises » à part ?
6. **Scope personnel.** Une skill proposée à partir des conversations d'un
   seul utilisateur est-elle visible de lui seul avant activation
   (recommandé), ou de toute l'équipe ?
7. **Visibilité des fichiers `recipes/`.** Tous les membres de l'équipe
   (lecture) ou seulement les admins ?

## 10. Références principales

Littérature (arXiv sauf mention ; URL = `https://arxiv.org/abs/<id>`) :
CoALA 2309.02427 · Reflexion 2303.11366 · Voyager 2305.16291 · LATM
2305.17126 · Synapse 2306.07863 · ExpeL 2308.10144 · AutoGuide 2403.08978 ·
Agent Workflow Memory 2409.07429 (code : github.com/zorazrw/agent-workflow-memory)
· ASI 2504.06821 · SkillWeaver 2504.07079 · Dynamic Cheatsheet 2504.07952 ·
Sleep-time Compute 2504.13171 · Self-Generated In-Context Examples 2505.00234 ·
Memp 2508.06433 · Memento 2508.16153 · ReasoningBank 2509.25140 · ACE
2510.04618 (code : github.com/ace-agent/ace) · Mem0 2504.19413 · Zep
2501.13956 · MINJA 2503.03704 · Your Agent May Misevolve 2509.26354 ·
AgentReuse 2512.21309 · ToolCaching 2601.15335 · PASTE 2603.18897 ·
Tool-Making in Low-Latency Systems 2607.08010 · Progressive Crystallization
2607.07052 · SkillDroid 2604.14872 · WorkflowGen 2604.19756 · Agentic
Compilation 2604.09718 · Invalidation Contracts 2609.00243 · STALE 2605.06527 ·
Repo2Skill-Evo 2608.21964 · When Self-Evolution Backfires 2608.05810 · GRASP
2605.29668 · SkillAudit 2606.14239 · Not Always Faithful Self-Evolvers
2601.22436 · Honest Lying 2605.29463 · Verbatim Chunks Beat Extracted
Artifacts 2601.00821 · Skills in the Wild 2604.04323 · Demystifying Agent
Skills 2608.14036 · Are Modules Worth Their Tokens 2606.15017 · Don't Break
the Cache 2601.06007 · Dynamic Agent Skills survey 2607.10113 ·
**TraceCompiler 2608.02680** · **Grounding Agent Memory (environment-probing
curation) 2609.11060** · **AFTER (Managing Procedural Memory) 2606.23127** ·
**Library Drift 2605.19576** · From Agent Loops to Deterministic Graphs
2605.06365 · Memory Sandbox 2308.01542 · RAG memory mental models 2508.07664 ·
Cognitive forcing functions 2102.09692.

Industrie : Anthropic — Agent Skills
(platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
skill-creator (github.com/anthropics/skills), mémoire de Claude Code
(code.claude.com/docs/en/memory), memory tool / context editing / compaction
(platform.claude.com/docs/en/build-with-claude/…), Managed Agents memory et
Dreams (platform.claude.com/docs/en/managed-agents/memory, …/dreams),
programmatic tool calling et tool search
(platform.claude.com/docs/en/agents-and-tools/tool-use/…), code execution with
MCP (anthropic.com/engineering), prompt caching, auto mode et le taux
d'approbation de 93 % (anthropic.com/engineering/claude-code-auto-mode).
OpenAI — Agents SDK sessions et sandbox Memory
(github.com/openai/openai-agents-python), Codex skills, memory FAQ et outils
de conformité Enterprise. Letta — sleep-time compute, context repositories,
ezra-memory (github.com/letta-ai). Mem0, Graphiti/Zep, LangMem (dépôts
GitHub). Manus — _Context Engineering for AI Agents_. Devin — Knowledge,
Session Insights et Playbooks (docs.devin.ai) ; Cascade memories. Cursor —
forum 0.51 memories et 2.1. Intercom — Fin Operator, Recommendations, Fin
Procedures (intercom.com/help). Ada — coaching. Decagon — agent versioning.
Sierra — release governance, ADLC. Glean — Agent Library. Microsoft — Copilot
personalization memory (learn.microsoft.com), M365 agents admin guide, HAX
toolkit. Google — Gemini saved info, Gemini Enterprise personalization.
Perplexity — memory for enterprise. ServiceNow — AI Control Tower. Salesforce
— Agentforce versions, Slackbot. Skyvern — code caching
(github.com/Skyvern-AI/skyvern/blob/main/docs/developers/features/code-caching.mdx).
Browser Use — workflow-use. Stagehand — caching et deterministic agent
(github.com/browserbase/stagehand). Vercel AI SDK — caching et middleware.
Langfuse — A/B testing et prompt CI/CD.

Recherche HCI et réglementaire : Chen et al., CHI 2026
(dl.acm.org/doi/10.1145/3772318.3791635) ; CHI EA 2026 survey
(dl.acm.org/doi/full/10.1145/3772363.3799198) ; Kizilcec, CHI 2016
(dl.acm.org/doi/10.1145/2858036.2858402) ; Eslami et al., CHI 2018 ;
Vasconcelos et al., CSCW 2023 ; Amershi et al., HAX guidelines (2019). EU AI
Act art. 12, 13, 26, 50 et annexe III (artificialintelligenceact.eu) ;
Commission européenne, FAQ art. 50 ; EDPB, _AI Privacy Risks and Mitigations
in LLMs_ (2025) ; ISO/IEC 42001 A.6.2.8 ; NIST AI RMF et NIST AI 600-1.
