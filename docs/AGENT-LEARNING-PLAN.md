# Plan — apprentissage procédural des agents Fretik (chatbot et workflows)

> Document de plan uniquement. Rien n'est implémenté. Rédigé le 2026-09-14 après
> lecture du code (`packages/ai`, `packages/shared`, `packages/jobs`,
> `packages/workflows`, `packages/providers`) et une revue de la littérature et
> des produits comparables (section 3). Les chemins cités sont ceux du dépôt.

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

1. **Deux mécanismes distincts sur un socle commun.**
   - **Workflows → « recettes de run »** (`workflow_recipes`) attachées par
     `workflowId`, sans retrieval : un workflow est une tâche fixe, on sait
     exactement à quoi rattacher ce qu'on apprend. Une recette décrit, par tâche
     du playbook, le mode d'exécution (`agentic` / `assisted` / `scripted`), les
     fichiers à lire d'emblée, les pièges rencontrés et corrigés, et pour les
     tâches déterministes un script Python consolidé, paramétré, rejouable.
   - **Chat → mémoire procédurale** : (a) des « notes apprises » par external app
     et par skill, servies **dans** le SKILL.md au moment où l'agent le lit
     (zéro token supplémentaire tant qu'il ne le lit pas, zéro appel en plus) ;
     (b) des recettes de tâches récurrentes retrouvées par similarité (nouveau
     `source_type = procedures` dans `ai_vectors`, sixième bras du recall).
2. **Socle commun : un « ledger de trajectoires » déterministe** (sans LLM),
   dérivé de ce qui est déjà persisté (`ai_messages.parts` contient chaque tool
   call avec `input` et `output`), plus des métriques par run et par tour. C'est
   la donnée qui manque aujourd'hui pour raisonner sur l'efficacité.
3. **Un « optimiseur » = un job batch, pas un agent dans la boucle.** Une
   analyse déterministe d'abord (histogramme d'outils, erreurs → correction,
   similarité de code entre runs, classification déterministe/agentique), puis
   **une seule passe LLM sur les trajectoires brutes** (jamais sur des résumés :
   la doctrine « a second model pass over model output is a summary of
   summaries » de `packages/ai/CLAUDE.md` s'applique).
4. **Ne pas sur-optimiser, par construction.** Une recette a un état
   `converged` : quand deux optimisations successives ne changent rien de
   matériel et que les runs tiennent leur budget, l'optimiseur s'arrête. Il ne
   se réveille que sur un changement de hash du playbook, une nouvelle version
   du SDK/skill d'un provider, un changement de modèle ou un run échoué.
5. **Rien ne contourne les approbations ni les modes d'autonomie.** Un script de
   recette exécuté avant le tour de l'agent (« prélude ») est limité aux
   actions de lecture ; les écritures restent construites par l'agent via
   `.op()` / `run_plan` et passent par le même chemin d'approbation.
6. **Tout est mesuré avant d'être activé par défaut** : mode `shadow` (recette
   calculée, non injectée) → canary sur un workflow → défaut. Les métriques
   (steps, tokens non cachés, durée travaillée, taux de succès) existent déjà
   en partie (`workflow_runs.usage`, `ai_messages.metadata.spend`,
   `evals/tool-efficiency.ts`) et sont complétées en phase 0.

**Gains attendus (hypothèses à valider en phase 0/1 sur le workflow PbyP).**
Sur un workflow stabilisé : −40 à −60 % de steps par run, −30 à −50 % de durée
travaillée, −30 % de tokens d'entrée non cachés, taux de succès ≥ baseline.
Sur le chat, pour une tâche déjà accomplie par l'équipe : −30 % de steps à la
deuxième occurrence. Ces chiffres sont des ordres de grandeur cohérents avec la
littérature (section 3) et avec la seule mesure interne comparable (le bloc
`<standing_memory>` a fait passer un cas de 11,9 à 5,9 tool calls par tour).

**Ordre de priorité.** Phase 0 (mesure) → Phase 1 (recettes assistées pour les
workflows, le gain le plus sûr) → Phase 2 (scripts et prélude) → Phase 3 (chat)
→ Phase 4 (boucle mainteneurs). Environ 10 à 13 semaines pour une personne, les
phases 3 et 4 pouvant glisser sans bloquer les précédentes.

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
  sous le marqueur `DYNAMIC SUFFIX`.
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
  1,5 k) ; résumé seulement au seuil de contexte.
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
- Chaque run a sa propre conversation, donc sa propre sandbox E2B (fraîche,
  bootstrap froid 6-8 s facturé) ; rien de ce qu'un run écrit comme code ne
  survit au run (`conversation-storage.ts` ne sauvegarde que `attachments/` et
  `outputs/`).
- Persisté par run : `status`, `taskStates` (+ `summary` par tâche),
  `usage` {input, output, total, cachedInput, turns}, `outputs`, `error`,
  `pausedMs`. **Le nombre de steps et l'histogramme d'outils ne sont pas
  persistés** (`toolCallCount` sert seulement au test de non-progression). La
  trajectoire complète est dans `ai_messages` de la conversation du run.
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
  une app soit `read("skills/…/SKILL.md")`. Le résultat d'un `read` est
  microcompactable : dans une longue conversation il peut être effacé, forçant
  une relecture.
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

### 1.5 Ce que l'observabilité et les evals savent déjà mesurer

- Langfuse : une trace `chatbot-turn` / `workflow-turn` par tour, coût exact
  OpenRouter, `sessionId = conversationId`, tags `team:` / `workflow:`.
- Evals (`packages/ai/evals`) : `stepsUsed`, `ttftMs`, `latencyMs`, et
  `tool-efficiency.ts` (`totalCalls`, `perTool`, `errorCalls`,
  `errorThenRetry`, `redundantCalls`, budget par cas) — **informationnels,
  jamais fondus dans la correctness**, et calculés uniquement dans le harnais,
  pas en production. Il n'existe **pas de harnais d'eval pour un run de
  workflow** (`evals/BACKLOG.md` le réclame : « needs a headless
  `POST /workflow/turn` seam »).

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
4. **Le chat, lui, a besoin de retrieval**, mais avec une clé différente de la
   mémoire métier : la _forme de la tâche_ (requête + outils + provider), et une
   granularité différente (une note d'usage d'outil, un script rejouable).
5. **Le coût dominant est le nombre de steps, pas seulement les tokens.** Chaque
   step re-soumet tout le contexte (cache ou non), attend un TTFT, et sur un run
   s'additionne avec les 6-8 s de bootstrap sandbox et les allers-retours
   Trigger.dev. Réduire les steps réduit _à la fois_ latence et tokens ; c'est
   la cible primaire. Les mesures internes vont dans ce sens : le bloc
   `<standing_memory>` a divisé par deux les tool calls d'un cas parce que
   l'agent reconstruisait à la main ce que le bloc énonce.
6. **Les contraintes non négociables du code** que le plan doit respecter :
   préfixe de prompt byte-stable (tout ce qui est par run/tour va dans le
   message de pilotage ou le suffixe dynamique) ; pas de seconde passe LLM sur
   des résumés ; toute constante est une mesure ; les approbations et modes
   d'autonomie gouvernent toute écriture ; un run ne modifie pas un skill ;
   un agent-singleton ne ferme jamais sur du contexte de requête.

## 3. État de l'art : ce que font la recherche et les autres acteurs

Note de méthode : les PDF arXiv et plusieurs blogs éditeurs étaient
inaccessibles depuis cette session (proxy) ; les chiffres viennent des
résumés, pages projet, dépôts GitHub et docs primaires atteignables. Les
chiffres marqués « rapporté » n'ont pu être vérifiés que sur des sources
secondaires. Beaucoup d'articles de 2026 sont des préprints.

### 3.1 Taxonomie des approches (littérature 2023-2026)

| famille                                     | idée                                                                   | exemples et résultats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | limite principale                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Exemplaires / mémoire épisodique**        | garder les trajectoires réussies et les retrouver comme démonstrations | Synapse (ICLR 2024, 99,2 % MiniWoB++) ; ExpeL (AAAI 2024) ; _Self-Generated In-Context Examples_ (NeurIPS 2025 : ALFWorld 73 → 89 % en accumulant ses propres succès) ; Memento (2025, GAIA 87,9 % val, **K = 4 cas optimal, plus dégrade**)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | coût en tokens ; saturation rapide ; ne transfère que si la tâche ressemble                |
| **Insights distillés / playbooks**          | règles courtes tirées des succès _et_ des échecs                       | Reflexion (NeurIPS 2023) ; AutoGuide (NeurIPS 2024 : règles **conditionnelles** à l'état, ALFWorld 79 % vs 59 % ExpeL) ; ReasoningBank (Google, ICLR 2026 : +34 % succès relatif, **−16 % de steps**, les échecs produisent des « à éviter ») ; ACE (ICLR 2026 : deltas incrémentaux avec compteurs utile/nuisible, dédoublonnage sans LLM ; nomme deux pannes des optimiseurs qui réécrivent tout : _brevity bias_ et _context collapse_) ; Dynamic Cheatsheet (2025)                                                                                                                                                                                                                                                                                                                                                                                                                                               | confabulation des auto-diagnostics ; croissance additive ; le modèle peut ignorer la règle |
| **Mémoire de workflow**                     | sous-routines semi-structurées avec paramètres abstraits               | Agent Workflow Memory (ICML 2025 : +51 % relatif WebArena, **≈ 2 steps de moins par tâche**, workflows induits compacts) ; Memp (ACL 2026 : ablation build / retrieve / update)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | textuel, ne s'exécute pas ; retrieval grossier                                             |
| **Bibliothèque de compétences exécutables** | compiler ce qui a marché en code paramétré, vérifié par exécution      | Voyager (2023) ; LATM / CREATOR (un modèle fort écrit l'outil, un modèle bon marché l'utilise) ; SkillWeaver (2025, +31,8 % WebArena) ; **ASI** (2025, successeur d'AWM : les skills exécutables battent les workflows textuels, 10-15 % de steps en moins, rapporté) ; **SkillDroid** (2026 : rejeu **sans appel LLM**, −49 % d'appels LLM, 85 % vs 62 %, et surtout le baseline sans mémoire se _dégrade_ dans le temps 80 → 44 % quand SkillDroid monte 87 → 91 %) ; **Tool-Making in Low-Latency Systems** (2026, production : compiler les séquences répétées d'un SOP en outils versionnés, **p50 −42 %, erreurs −53 %**) ; **Progressive Crystallization** (Microsoft, 2026 : échelle de promotion agentique → hybride → déterministe zéro-token, **rétrogradation automatique**, ×3 sur le coût en production) ; Agentic Compilation (2026 : de ~150 $ à < 0,10 $ pour 500 rejeux d'un workflow de 5 étapes) | fragile aux changements d'API / UI ; exige une boucle réparation-rétrogradation            |
| **Optimisation de prompt hors ligne**       | faire évoluer le prompt système sur un jeu de validation               | GEPA (ICLR 2026), Training-Free GRPO, LangMem `create_prompt_optimizer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | améliore le prompt partagé, pas la tâche récurrente                                        |
| **Fine-tuning / RL sur la mémoire**         | apprendre quoi écrire                                                  | MemAgent, Memory-R1, Mem-α, SkillRL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | hors de portée sans boucle d'entraînement ; ne survit pas au changement de modèle          |
| **Caches système sans apprentissage**       | réutiliser plans, résultats, appels                                    | AgentReuse (≈ 30 % des requêtes réelles sont identiques ou proches) ; ToolCaching (2026) ; PASTE (Microsoft, 2026 : exécution spéculative des appels prédits, −48 % de temps) ; _sleep-time compute_ (Letta, 2025 : ×5 de calcul en moins au moment de la requête)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | orthogonal, empilable                                                                      |

### 3.2 Les résultats qui contraignent le design

1. **Compter les tokens de la mémoire.** _Are Online Skill and Memory Modules
   Always Worth Their Tokens?_ (2026) rejoue AWM, ASI et ReasoningBank contre
   un agent vanille **à budget de tokens égal** : le vanille fait aussi bien ou
   mieux en agrégat. Seules les familles « code exécutable » et « caches »
   réduisent _à la fois_ tokens et appels à succès égal. → Le critère de
   victoire du plan est « moins de steps et de tokens totaux à succès ≥ »,
   mesuré avec les tokens de la recette inclus.
2. **Le brut vaut plus que le condensé.** _LLM Agents Are Not Always Faithful
   Self-Evolvers_ (ICML 2026) : les agents exploitent l'expérience brute mais
   ignorent ou lisent mal l'expérience condensée ; _Honest Lying_ (2026) : les
   auto-diagnostics type Reflexion sont souvent confabulés et ExpeL les
   globalise ; _Verbatim Chunks Beat Extracted Artifacts_ (2026). → Le
   ledger garde les trajectoires brutes ; chaque artefact distillé cite sa
   source et reste révocable ; le code compilé, lui, est _vérifié par
   exécution_.
3. **Petit et gardé plutôt que grand et additif.** Memento (K = 4), ExpeL
   (upvote/downvote), GRASP (2026 : bibliothèque bornée admise seulement si
   elle améliore une sonde tenue à l'écart sous budget de régression, ~×10
   moins de tokens injectés), _When Self-Evolution Backfires_ (2026 : au-delà
   d'une taille critique les nouveaux skills dégradent, et le rollback ne
   récupère pas, d'où le **gating avant commit**). → Plafonds, porte de
   dédoublonnage, mesure d'utilité par élément, convergence.
4. **Tout artefact appris est une entrée de cache avec un contrat de
   validité.** _Invalidation Contracts for Cross-Episode Agent Memory_ (2026) :
   des suggestions de récupération d'erreurs API deviennent silencieusement
   fausses à la dérive du serveur ; l'invalidation **par ligne** avec
   estampille de version sauve 29-33 % du coût, l'invalidation par table
   détruit le gain. STALE (2026) : le meilleur modèle ne détecte qu'à 55 %
   qu'une mémoire est périmée. Repo2Skill-Evo (2026) : **chaque** transition
   de version invalide une partie des skills. → La détection de péremption
   doit être mécanique (hash du playbook, version SDK/skill, fingerprint
   MCP), jamais laissée au modèle.
5. **Le retrieval est le goulot à l'échelle.** _How Well Do Agentic Skills
   Work in the Wild_ (2026) : avec 34 k skills candidats, un modèle de tête
   passe de 55 % (skill chargé à la main) à 38 % (auto-retrouvé), à peine
   au-dessus du sans-skill. _Demystifying Agent Skills_ (2026) : 66 % des
   gains d'un SKILL.md viennent de **l'ancrage procédural** (quoi faire en
   premier, quel outil, quoi vérifier), 4,5 % de connaissance manquante ; un
   skill nuit quand il est appliqué au mauvais endroit ou suivi rigidement.
   → Pour les workflows : pas de retrieval, attachement par identité. Pour le
   chat : espaces de noms par équipe et par app, clé = (app, signature de
   tâche), K petit, seuil élevé.
6. **La conformité dépend du modèle.** Les mêmes octets de mémoire donnent
   100 % d'application au premier essai sur un modèle et ≤ 11 % sur un autre
   (Invalidation Contracts). → Réévaluer les recettes à chaque changement de
   modèle (d'où `modelProfileKey` dans le fingerprint) ; faire écrire par un
   modèle fort ce qu'un modèle moins cher utilise (LATM, Memp).
7. **Sécurité des écritures.** MINJA (NeurIPS 2025 : empoisonnement de mémoire
   par de simples requêtes, 98 % de succès), _Practice Makes Unsafe_ (2026 :
   un succès dangereux devient une politique réutilisable), _Your Agent May
   Misevolve_ (2025). → Jamais d'écriture de mémoire partagée à partir de
   contenu non vérifié ; provenance ; visibilité humaine ; moindre privilège
   (les scripts tournent avec l'identité du run, pas plus).
8. **Consolider hors du chemin critique.** Sleep-time compute, ACE, le
   « dreaming » d'Anthropic et d'OpenAI : la réflexion est un job batch
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
  **Dreaming** (2026, preview) : job planifié qui lit le store + les
  transcripts récents et produit une _nouvelle version_ du store (fusion,
  remplacement du périmé, motifs inter-sessions), **revue avant application**.
  _Programmatic tool calling_ : les outils deviennent des fonctions dans un
  sandbox Python, seul le résultat final entre dans le contexte ; **−38 % de
  tokens facturés sur un agent à 75 outils, −20-40 % en production avec 10-49
  outils, mais +8 % de coût et aucun gain sur des tours à 1-2 appels
  séquentiels** — le batching paie quand il y a des appels à batcher. _Code
  execution with MCP_ : l'agent **enregistre le code qui a marché dans un
  dossier `skills/` avec un SKILL.md** pour accumuler des capacités. _Tool
  search_ / `defer_loading` (ce que `searchTools` reproduit). _Prompt
  caching_ : préfixe stable, pas d'horodatage avant un point de cache,
  sérialisation déterministe.
- **OpenAI.** Agents SDK : `Memory()` en sandbox avec `memory_summary.md`
  injecté au départ, `MEMORY.md` index, `rollout_summaries/`, `raw_memories/`,
  `skills/` ; génération **post-run en deux phases** (résumé par
  conversation puis consolidation qui réécrit l'index) ; oubli par plafond.
  Codex : skills SKILL.md + `skill-creator`. ChatGPT « dreaming » (2026) :
  consolidation hors ligne. Structurellement identique à Claude Code +
  Dreaming.
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
  de coût (rapporté).
- **Caches.** Cache sémantique de réponses (GPTCache) : déconseillé sur les
  pipelines agentiques par Vercel comme par ses auteurs. Cache de résultats
  d'outils : opt-in par outil en lecture seule, clé = sha256(nom + args
  canoniques + tenant), TTL court, « une donnée périmée est pire qu'un
  re-fetch ». Étude _Don't Break the Cache_ (2026) : le cache de prompt
  réduit le coût de 45-80 % et le TTFT de 13-31 %, mais un cache naïf du
  contexte complet peut _augmenter_ la latence — le dynamique en dernier.
- **Garde-fous observés.** Revue avant application (Dreaming), évaluation
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
compilation des séquences répétées en artefacts exécutables, attachés à
l'identité du workflow, avec une échelle de promotion / rétrogradation
(Progressive Crystallization, SkillDroid, Skyvern) ; (3) des contrats de
validité mécaniques (version, hash, fingerprint) sur tout ce qui est appris ;
(4) une porte d'évaluation avec vs sans avant promotion ; (5) pour le chat,
une mémoire procédurale bornée, par équipe et par app, servie au moment de
l'usage plutôt que payée à chaque tour. C'est exactement le périmètre de la
section 4.

## 4. Architecture cible

Vue d'ensemble :

```
                 ┌────────────────────────────────────────────────────────┐
                 │ 4.1 Ledger de trajectoires (déterministe, sans LLM)     │
                 │  ai_messages.parts → extractTrajectory() → steps,       │
                 │  tool calls, code python, erreurs→corrections, skills   │
                 │  lus, tokens/step ; métriques par run et par tour       │
                 └───────────────┬──────────────────────┬─────────────────┘
                                 │                      │
        ┌────────────────────────▼─────────┐   ┌────────▼──────────────────────────┐
        │ 4.2 Workflows : recettes de run   │   │ 4.3 Chat : mémoire procédurale     │
        │  workflow_recipes (par workflowId,│   │  (a) notes apprises par app/skill   │
        │  hash playbook, version, statut)  │   │      servies dans le SKILL.md       │
        │  optimiseur batch → shadow →      │   │  (b) recettes de tâches (procedures │
        │  active → converged / invalidated │   │      dans ai_vectors, 6e bras)      │
        │  injection : message de pilotage  │   │  (c) règles de préchargement        │
        │  + fichiers dans la sandbox       │   │      déterministes                  │
        └────────────────────────┬─────────┘   └────────┬──────────────────────────┘
                                 │                      │
                 ┌───────────────▼──────────────────────▼─────────────────┐
                 │ 4.4 Boucle mainteneurs : insights récurrents cross-team │
                 │  → propositions d'amélioration de skills (jamais auto)  │
                 └────────────────────────────────────────────────────────┘
```

### 4.1 Le ledger de trajectoires

**But.** Rendre lisible, sans LLM, ce qu'un tour ou un run a réellement fait,
pour trois consommateurs : les métriques de production, l'optimiseur de
workflows, l'extracteur d'insights du chat. Un seul module pur, réutilisé par
les evals (aujourd'hui `evals/tool-efficiency.ts` fait ce calcul, mais
uniquement dans le harnais).

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
  puis réussi). Réutilise la canonicalisation de `approvals/hash.ts` pour les
  clés d'identité d'appel. Reprend, et remplace à terme, `evals/tool-efficiency.ts`.
- **Métriques par run, persistées** : étendre `WorkflowRunUsage` (jsonb, donc
  additif) avec `steps`, `toolCalls`, `perTool`, `skillReads`, `errorCalls`,
  `pythonCells`. Écrites par `recordTurnResult` à chaque tour, comme `usage`.
- **Métriques par tour de chat** : déjà dans `metadata.spend` (steps, tokens,
  coût) ; ajouter l'histogramme d'outils et les skills lus dans le même objet.
- **Scores Langfuse** par trace (`steps`, `skill-reads`, `error-calls`,
  `redundant-calls`), pour que le tableau de bord existant les affiche par
  workflow et par équipe sans nouvelle UI.
- **Les runs échoués entrent dans le ledger** (pas dans les épisodes) : un run
  échoué _après_ avoir utilisé une recette est la donnée la plus précieuse
  pour l'optimiseur.
- Un script opérateur `workflows:profile -- <workflowId> [--runs N]` (dans
  `packages/jobs`, derrière `assertOperatorTarget`) qui imprime, pour les N
  derniers runs, la répartition des steps par tâche et par outil, les lectures
  de skills, les erreurs et leur correction, la similarité de code entre runs.
  C'est l'outil de la phase 0 et celui qu'on rouvre avant chaque décision.

**Ce qui n'est pas fait.** Pas de nouvelle table de steps au départ : la
dérivation à la demande suffit pour l'optimiseur (quelques runs à la fois) ;
on ne crée `agent_trajectory_steps` que si les requêtes analytiques le
justifient (mesure en phase 0).

### 4.2 Workflows : les recettes de run

#### Modèle de données

`workflow_recipes` (une ligne par version) :

| colonne                                  | rôle                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`, `teamId`, `organizationId` | rattachement direct, pas de retrieval                                                                                                                            |
| `playbookHash`                           | sha256 canonique de `{playbook, autonomy, externalAppConnectionIds triés}` — **la clé d'invalidation**                                                           |
| `environmentFingerprint`                 | jsonb : versions des SKILL de providers utilisés (le `version:` du frontmatter généré par `gen:sdk`), fingerprints des snapshots MCP, `modelProfileKey` effectif |
| `version`                                | entier croissant par workflow                                                                                                                                    |
| `status`                                 | `shadow` \| `active` \| `converged` \| `degraded` \| `disabled` \| `invalidated`                                                                                 |
| `perTask`                                | jsonb `Record<taskKey, TaskRecipe>` (ci-dessous)                                                                                                                 |
| `sourceRunIds`, `stats`                  | runs observés, `successRate`, médianes steps / tokens / durée travaillée                                                                                         |
| `metrics`                                | `{ baseline, withRecipe }` sur les mêmes indicateurs, remplis au fil des runs                                                                                    |
| `rationale`                              | texte court lisible par un humain (ce que l'optimiseur a vu)                                                                                                     |
| `supersededById`, `createdAt`            | historique jamais supprimé, comme les épisodes                                                                                                                   |

`TaskRecipe` :

```ts
{
  mode: "agentic" | "assisted" | "scripted",
  classification: { kind: "stable" | "noisy" | "judgment", codeSimilarity, runsObserved },
  preloads: string[],           // ex. ["skills/pbyp/SKILL.md", "skills/pbyp/references/collections.md", "skills/xlsx/SKILL.md"]
  pitfalls: { symptom, fix, evidence: { runId, toolCallId } }[],   // ≤ 8, une ligne chacun
  scripts: { path, purpose, params: string[], readOnly: boolean, sourceRunIds: string[], hash }[],
  expectations: { toolCallsP50, durationMsP50, outputShape? }      // pour l'auto-contrôle et la convergence
}
```

Les scripts sont des fichiers (stockage S3 sous une racine `recipes/<workflowId>/<version>/`),
matérialisés dans la sandbox du run à `/workspace/recipes/<taskKey>/<file>.py` par le
même mécanisme que les skills d'équipe (`materialize-team-skill.ts`,
`conversation-storage.ts`). Un script lit ses paramètres dans
`/workspace/.fretik/run-params.json` (payload du trigger, date courante,
identifiants de connexions), écrit par le harnais avec `auth.json`. Aucune
valeur observée dans un run (id, date, numéro) n'est autorisée en dur : c'est
une règle de validation statique, pas un conseil au modèle.

#### L'optimiseur (job BullMQ `workflow-optimize`)

Déclenchement : `journal-sweep.ts` reçoit déjà `workflow.run.completed` ; on
ajoute une file `workflow-optimize` avec dédoublonnage par
`(workflowId, playbookHash)` et un débounce (par exemple 10 min, pour absorber
les rafales d'event runs). Pré-conditions vérifiées sans LLM :

- au moins **2 runs réussis, non-test**, au même `playbookHash` depuis la
  dernière version de recette (au premier run réussi : rien — un seul exemple
  ne distingue pas le stable du fortuit ; c'est aussi le seuil de
  `promote-episodes.ts` : « Promote ONLY a fact that RECURS ») ;
- la recette courante n'est pas `converged` ni `disabled` ;
- l'équipe a l'option activée (`team_ai_settings.workflowRecipes`, `shadow`
  par défaut au début).

Étapes :

1. **Charger** les K ≤ 5 derniers runs éligibles + le dernier run échoué s'il
   a utilisé une recette. Extraire les trajectoires (4.1), segmentées par tâche.
2. **Analyse déterministe** par tâche :
   - histogramme d'outils, skills et références lus, cellules `python` (code
     complet), erreurs `{error, code}` suivies d'un appel réussi du même outil
     (paire symptôme → correction candidate), exceptions Python (stderr)
     suivies d'une cellule réussie ;
   - **similarité de code entre runs** : normalisation (littéraux qui
     apparaissent dans le payload du trigger ou ressemblent à une date/un id →
     `<PARAM>`), puis ratio de similarité (difflib) et hash ; une tâche est
     `stable` si ≥ 2 runs ont le même ensemble d'outils, une similarité ≥ 0,85
     et zéro erreur non corrigée ; `judgment` si la tâche contient
     `askUserQuestion`, `dispatchAgent`, une approbation, ou si la majorité des
     tokens de sortie sont du texte libre (mail, synthèse) ; sinon `noisy` ;
   - budget observé : médianes de steps, durée, tokens.
3. **Une passe LLM** (rôle nouveau `workflow-optimize`, lié à un modèle de
   la classe « consolidation » ou au flagship de l'équipe — à décider par
   mesure, comme les autres `role-bindings`), température 0, sortie JSON
   validée par Zod, **entrée = trajectoires brutes** (code, erreurs, aperçus de
   sorties), jamais les résumés de tâches ni les épisodes. Elle produit, par
   tâche : les `preloads`, les `pitfalls` (chacun doit citer un `toolCallId`
   réel — sinon rejeté, même principe que `salientRecordIds` choisis _dans_ la
   liste candidate), et pour les tâches `stable` **un script consolidé** qui
   fusionne les cellules qui ont marché en une seule, paramétrée. Pour les
   tâches `judgment` : pas de script, seulement preloads et pitfalls.
4. **Validation déterministe** des scripts : `ast.parse` ; n'appelle que des
   actions `fretik_apps.<provider>.<action>` _observées_ dans les runs sources ;
   `readOnly = true` si aucun `.op(` / `run_plan(` / `records.bulk_*` ; aucun
   secret (le scrubber de `upsertEpisode`) ; aucun littéral marqué `<PARAM>`
   resté en dur ; taille bornée. Optionnel, opt-in par équipe : **dry-run**
   d'un script `readOnly` dans une sandbox jetable avec les paramètres du
   dernier run, comparaison de la forme de sortie (colonnes, ordre de grandeur
   du nombre de lignes) à ce que le run source avait obtenu. Un script qui
   échoue la validation est jeté ; la tâche reste `assisted`.
5. **Persister** une nouvelle version. Politique de promotion par mode :
   - `assisted` (preloads + pitfalls + scripts _proposés_ que l'agent décide
     d'utiliser) → `active` immédiatement si l'équipe est en mode `active`,
     `shadow` sinon. Risque faible : l'agent garde la main ;
   - `scripted` (le harnais exécute le script en prélude) → exige la
     validation, un `readOnly = true`, et **un run `assisted` réussi où
     l'agent a effectivement utilisé le script** (visible dans la trajectoire).
6. **Convergence.** Après chaque optimisation, diff avec la version
   précédente. Si deux optimisations successives ne changent rien de matériel
   (mêmes hashes de scripts, mêmes pitfalls, mêmes modes) **et** que les
   derniers runs tiennent `expectations` (steps ≤ p50 × 1,2, zéro erreur non
   corrigée), la recette passe `converged` et le job ne se replanifie plus.
   C'est la réponse au « ne pas sur-améliorer » : l'optimiseur sait dire
   « c'est déjà au maximum ».
7. **Invalidation / réveil.** `playbookHash` changé (édition du playbook, de
   l'autonomie, des apps) → `invalidated` ; les runs suivants repartent en
   `agentic` et l'optimiseur redémarre, en reportant les `pitfalls` des tâches
   dont la `key` a survécu (les clés sont stables par construction :
   `WorkflowPlaybookTaskSchema`). Nouvelle version d'un SKILL/SDK de provider
   ou d'un snapshot MCP → les scripts de ce provider passent `degraded`
   (retour `assisted`) jusqu'à re-validation. Changement de modèle → `degraded`
   pour les tâches `scripted` (le script ne dépend pas du modèle, mais les
   `expectations` si). Run échoué avec recette → `degraded` immédiat + réveil.

#### Ce que le run voit

Rien dans le prompt système (byte-stable). Deux endroits :

- **Message de pilotage du tour 1** : un bloc `<run_recipe>` ≤ 1 200 tokens,
  après les blocs mémoire : par tâche, le mode, la liste des fichiers à lire
  **en un seul step parallèle** (« read these 3 files now, in parallel »),
  les pitfalls (une ligne), et la référence des scripts (« `recipes/fetch/
folders.py` reproduit la collecte du dernier run réussi ; exécute-le tel quel
  via `python` puis vérifie : ~120 lignes attendues, colonnes […] »).
- **Pin de la tâche courante** à chaque tour : les lignes de la recette de la
  tâche courante seulement (le bloc du tour 1 peut sortir de la fenêtre de 40
  messages ; le pin, lui, est régénéré à chaque tour).

Deux choix délibérés :

- **Précharger = lire en un step, pas injecter le corps.** Injecter le corps
  d'un SKILL (5-6 k tokens) dans le message de pilotage épingle ces tokens pour
  tout le run alors qu'un `read` est microcompactable ; le gain net est un step.
  On commence par la version « un seul step parallèle » (3 à 5 steps
  séquentiels → 1), on mesure, et on n'injecte le corps que si la mesure le
  justifie (question ouverte n° 3).
- **Le script est un fichier, pas un bloc dans le prompt.** Il ne coûte des
  tokens que s'il est lu, et l'agent l'exécute par `exec(open(...).read())`
  sans le retaper (la doctrine « never transcribe tool output into another tool
  call » vaut pour le code aussi).

#### Mode `scripted` : le prélude

Pour une tâche `scripted`, le harnais (`handlers/workflow.ts`, avant de
lancer le tour où la tâche devient courante) exécute le script via
`runInSandbox` dans la sandbox du run, avec la même `auth.json`, et injecte le
résultat comme **une paire tool-call / tool-result synthétique** en tête de
l'historique du tour (le même procédé que
`buildSyntheticActivationReplayMessage` pour `searchTools`). L'agent démarre
avec les données en main, vérifie, et fait le reste (jugement, livrable,
`completeTask`). Contraintes :

- `readOnly` obligatoire (validation statique) : un script qui lèverait
  `ApprovalPending` ne peut pas être exécuté hors tour. Les écritures restent
  construites par l'agent, qui peut réutiliser un script de recette `readOnly =
false` **lui-même**, ce qui déclenche la pause d'approbation normale.
- Échec du prélude (exception, sortie vide, forme inattendue) → la tâche
  s'exécute en `assisted` ce run-ci, la recette passe `degraded`, l'optimiseur
  est réveillé avec ce run.
- Coût comptabilisé dans le run (durée sandbox, appels API du provider).

**Cible finale, optionnelle et à décider après mesure (phase 4) : la tâche
sans LLM.** Une tâche `scripted` stable sur ≥ 3 runs dont le script produit
lui-même le `summary` et l'`expectedOutput` pourrait être fermée par le
harnais sans tour modèle. C'est exactement « ce qui est déterministe, on
sauvegarde le code ». On ne l'active que par équipe et par workflow, et la
tâche suivante voit toujours la sortie dans son contexte (l'agent reste le
filet de sécurité).

#### Interface et contrôle humain

Onglet « Optimisations » sur la page du workflow : version courante et statut,
tableau par tâche (mode, pitfalls, scripts lisibles), métriques avant / après,
historique des versions, actions **désactiver**, **réinitialiser**,
**re-optimiser maintenant**, et le choix du niveau par workflow
(`off` / `assisted` / `scripted`). Les recettes sont visibles au même titre
que les mémoires `learned/` : rien n'est appris en silence.

### 4.3 Chat : la mémoire procédurale

Le chat n'a pas d'identité de tâche stable ; il a besoin de deux choses plus
légères que la recette de run.

#### (a) Notes apprises par external app et par skill

**Quoi.** Des faits d'usage courts, vérifiés, à l'échelle de l'équipe :
« `consignee.country` renvoie une clé étrangère nue ; utiliser
`consignee.country_id.name` », « le compte du client ne voit pas
`sea_folders` master : filtrer `folder_type != master` évite un résultat vide
interprété comme inexistant », « pour un export xlsx à 12 colonnes fixes,
le pattern openpyxl qui a produit le livrable est `recipes/...` ». Pas de
données métier, pas de valeurs d'un document.

**Extraction.** Un worker nocturne (dans le sweep « dreaming », étape 5) lit
via le ledger les tours de chat et les runs de la journée qui ont touché un
provider ou un skill donné, et sélectionne **mécaniquement** les candidats :
paires erreur → correction (code d'erreur ou exception, puis appel réussi du
même outil avec arguments modifiés), formes de requêtes qui ont répondu
(appels `query_items` non vides et leurs `fields`), lectures de références qui
ont précédé un succès. Une passe LLM rédige une ligne par candidat avec sa
preuve (`conversationId`, `toolCallId`), puis la porte ADD / UPDATE / NOOP
existante de `promote-episodes.ts` est réutilisée telle quelle contre les
notes déjà écrites. Règle de récurrence : une note n'est écrite que si le
motif apparaît dans **≥ 2 conversations ou runs distincts** (même barre que la
promotion).

**Stockage et service.** Nouveau namespace machine dans `ai_memories` :
`learned/howto/<provider-ou-skill>.md`, scope équipe (jamais utilisateur :
une connexion est d'équipe ou privée, mais la _manière_ de s'en servir ne
contient pas de donnée privée ; on exclut les notes dérivées d'une connexion
privée si elles nomment la connexion). Servi de deux façons :

1. **Dans le SKILL lui-même** : `skills/read-skill-file.ts` résout déjà le
   fichier par équipe (bundled → provider → snapshot MCP → skill d'équipe) ; il
   ajoute, au moment du `read`, une section finale
   `## Appris dans cette équipe` (≤ 40 lignes, ≤ 1 500 tokens) tirée de
   `learned/howto/<slug>.md`. Zéro appel supplémentaire, zéro token tant que le
   skill n'est pas lu, et l'agent lit la note exactement au moment où il en a
   besoin — au lieu d'un bloc de prompt payé à chaque tour.
2. Indexé dans `ai_vectors` comme les autres mémoires, donc trouvable par
   `searchKnowledge` et par le recall existant.

**Hygiène.** Plafond par fichier ; horodatage de dernière observation par
note ; suppression d'une note non ré-observée depuis 90 jours (même échelle que
la démotion des épisodes) ; invalidation à la nouvelle version du SKILL/SDK du
provider (on garde les notes dont les actions et champs cités existent encore,
on marque les autres « à vérifier »). Visible dans le panneau mémoire de
l'équipe, éditable et supprimable comme n'importe quelle mémoire `learned/`.

#### (b) Recettes de tâches récurrentes (chat)

**Quoi.** Quand une même _forme_ de demande a été menée à bien plusieurs fois
dans l'équipe (« sors-moi le récap des dossiers aériens de la semaine en
xlsx »), la séquence qui a marché et le code qui a produit le livrable
deviennent une `procedure` : `{ title, trigger (reformulation neutre de la
demande), steps (3-8 lignes), skills, tools, script? (fichier), evidence }`.

**Extraction.** Même worker nocturne, autre sélection mécanique : tours (ou
suites de tours) réussis avec ≥ 4 tool calls, un livrable (`presentFiles`,
`run_plan` approuvé, écriture de records) et pas de correction de l'utilisateur
au tour suivant (heuristique : message suivant sans « non / pas ça / plutôt » ni
répétition de la demande — à calibrer sur les traces). Regroupement par
similarité d'embedding de la demande **et** signature d'outils ; une procedure
n'est écrite qu'à partir de **≥ 2 occurrences** dans l'équipe. Même passe LLM
que (a), même porte de dédoublonnage.

**Stockage et retrieval.** Nouveau `source_type = 'procedures'` dans
`ai_vectors` (l'enum est extensible, la contrainte de scope « team+org » des
mémoires s'applique), texte indexé = `title + trigger + steps`. Le recall
gagne un **sixième bras** `procedures` (`topK 2`, seuil absolu élevé, jamais
mélangé au juge : même traitement que le bras « capability » des workflows,
`CAPABILITY_MARGIN`). Rendu dans un bloc `<procedural_memory>` du suffixe
dynamique (≤ 500 tokens), avec le chemin du script matérialisé sous
`memories/procedures/<slug>.py` dans la sandbox (`memories/` est déjà miroité).
Le prompt ajoute une règle courte dans `<memory_protocol>` : « une procédure
retrouvée est un point de départ à vérifier, pas une réponse ; adapte les
paramètres, ne recopie pas le code, exécute le fichier ».

**Pourquoi pas un skill d'équipe automatique.** `createSkill` existe et
produit exactement cet artefact, mais avec confirmation d'un admin : c'est la
bonne voie pour les procédures que l'équipe veut _nommer et gouverner_. Les
`procedures` apprises sont la couche en dessous : automatiques, plafonnées,
périssables, et **promouvables** en skill d'équipe par un clic dans le panneau
mémoire (le brouillon `createSkill` est pré-rempli). Les deux couches ne se
recouvrent pas : une procedure dont un skill d'équipe couvre le déclencheur
n'est pas écrite (la porte NOOP voit le catalogue des skills).

#### (c) Règles de préchargement déterministes

Sans apprentissage, deux règles mesurables : si le message porte une pièce
jointe `.xlsx/.csv/.docx/.pptx/.pdf`, ou si une recette / procedure retrouvée
nomme un skill, le message de pilotage (chat : `<session_state>` du suffixe
dynamique) demande la lecture **en un step** des SKILL concernés, avant tout
`python`. Le même mécanisme sert les preloads des recettes de run. À mesurer
en phase 3 : la part des tours de chat qui lisent un skill, et le nombre de
steps séquentiels qu'ils y consacrent aujourd'hui.

### 4.4 Boucle mainteneurs

Les skills bundled et les SKILL générés des providers sont des actifs
plateforme, industrie-agnostiques (`packages/ai/CLAUDE.md`) : **aucune
écriture automatique**. Mais ils sont le bon endroit pour corriger une erreur
que _toutes_ les équipes font. Chaque semaine, un script opérateur
(`skills:insights-report`) agrège les notes `learned/howto/*` et les pitfalls
de recettes par provider et par skill, anonymisés (sans valeurs, sans noms
d'équipe), et classe les motifs qui reviennent dans ≥ 2 équipes. Le rapport
alimente `skills/bundled/BACKLOG.md` et `providers/src/<key>/guidance.md` via
des PR humaines. Une note reprise dans le skill est ensuite supprimée des
notes d'équipe par la porte NOOP (« déjà couvert par le skill »).

### 4.5 Gains structurels indépendants de l'apprentissage

Repérés pendant l'analyse ; à instruire séparément, mais ils comptent pour
« plus rapide » :

- **Préchauffer la sandbox** d'un run pendant que le tour 1 calcule son recall
  (bootstrap froid 6-8 s facturé, aujourd'hui en série).
- **Cache déterministe des lectures de schéma** par connexion et par
  fingerprint : `describe_collection` (PbyP) et `whoami()` renvoient la même
  chose d'un run à l'autre ; un cache Redis côté `sandbox-exec` (TTL 24 h,
  invalidé à `pbyp:schema` / au changement de connexion) supprime un
  aller-retour API à chaque run sans toucher au prompt.
- **Garde-fou « cellules python trop petites »** dans `withLoopGuard` : après
  4 cellules consécutives de moins de N lignes sans erreur, un message
  transitoire « batch the remaining steps in one cell » — le pendant du
  steer-à-3-échecs, pour le motif que tu observes. À calibrer avec la mesure
  d'Anthropic sur le _programmatic tool calling_ (section 3.3) : le batching
  paie à partir de plusieurs appels indépendants et coûte plus cher sur un
  tour à un ou deux appels séquentiels ; le garde-fou ne doit donc jamais
  pousser à regrouper ce qui dépend d'un résultat intermédiaire.
- **Découper le SKILL PbyP** (246 lignes, 21 Ko) en un corps court (lectures,
  routage, recettes) et des références déjà séparées : à faire dans
  `guidance.md`, hors plan.

## 5. Garde-fous

- **Approbations et autonomie inchangées.** Aucun chemin nouveau n'exécute une
  écriture : les préludes sont `readOnly` par validation statique, les scripts
  d'écriture ne sont exécutés que par l'agent dans le tour, via `.op()` /
  `run_plan` / `records.bulk_*`, avec la pause habituelle. Un workflow
  `read_only` ne reçoit que des recettes `readOnly`.
- **Même périmètre d'identité.** Un script s'exécute dans la sandbox du run
  avec l'`auth.json` du run : mêmes connexions, mêmes RLS, même équipe. Une
  recette est liée à `teamId` ; un `playbookHash` inclut les
  `externalAppConnectionIds`, donc un changement de connexion invalide.
- **Provenance obligatoire.** Chaque pitfall, chaque note, chaque procedure
  cite un `runId` / `conversationId` + `toolCallId` qui existe ; le rejet est
  mécanique. C'est la même défense contre le « memory rot » que la ligne
  `Sources:` des promotions.
- **Pas de données métier dans le procédural.** Le scrubber de secrets
  d'`upsertEpisode` s'applique ; les littéraux du payload du trigger sont
  paramétrés ; une note qui contient un numéro de dossier, un montant, un nom
  de contact est rejetée par regex avant la passe LLM et par le prompt.
- **Cache préfixe protégé.** Tout ce qui est par run ou par tour vit dans le
  message de pilotage ou sous `DYNAMIC SUFFIX` ; le bloc `<run_recipe>` est
  borné ; les scripts sont des fichiers.
- **Rétrogradation automatique.** `scripted` → `assisted` au premier prélude
  raté ; `assisted` → `disabled` si le taux de succès des runs avec recette
  passe sous celui de la baseline sur une fenêtre glissante ; le disjoncteur
  existant reste le dernier filet. Une recette `disabled` est visible et
  réactivable.
- **Budgets.** ≤ 1 200 tokens de `<run_recipe>`, ≤ 1 500 tokens de notes par
  skill, ≤ 500 tokens de `<procedural_memory>` ; ≤ 8 pitfalls par tâche ; ≤ 3
  scripts par tâche ; une passe LLM par optimisation, plafonnée par jour et
  par équipe (même logique que `MAX_DISTILLS_PER_TEAM`).
- **Rien d'appris en silence.** UI des recettes, panneau mémoire pour les
  notes et procedures, journal `domain_events` (`recipe.created`,
  `recipe.promoted`, `recipe.degraded`, `procedure.created`…) pour le script
  `memory:audit`.
- **Opt-in progressif.** `team_ai_settings` : `workflowRecipes: off | shadow |
assisted | scripted`, `proceduralMemory: off | on`. Défaut initial `shadow`
  pour les équipes pilotes, `off` ailleurs ; on ne change le défaut qu'avec
  les mesures de la section 6.

## 6. Mesure et evals

**Indicateurs** (tous dérivables du ledger, publiés en scores Langfuse) :

| niveau             | indicateurs                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| run de workflow    | steps, tool calls par outil, lectures de skills, cellules `python`, `errorCalls`, `errorThenRetry`, tokens d'entrée non cachés / cachés / sortie, durée travaillée (`finishedAt − startedAt − pausedMs`), statut, `recipeVersion` et modes utilisés |
| tour de chat       | idem, plus `procedureHit` (une procedure a été retrouvée) et `skillReadBatched`                                                                                                                                                                     |
| recette            | delta baseline → avec recette sur les mêmes indicateurs, taux de succès, nombre de versions, temps jusqu'à `converged`                                                                                                                              |
| notes / procedures | nombre écrit / mis à jour / supprimé, taux de citation (la note était dans le contexte d'un tour qui a fini sans l'erreur qu'elle prévient)                                                                                                         |

**Harnais.** Il manque le harnais de run de workflow ; il devient un prérequis
de la phase 1, pas un à-côté : un point d'entrée headless (`POST
/internal/trigger/runs/:runId/turn` piloté par le harnais à la place de
Trigger.dev, comme `evals:chain` pilote déjà un run e2e) + un playbook fixture
PbyP sur l'équipe `eval-write`, avec `--repeats` et détection de bimodalité
comme `evals:recall`. Suite `evals:workflow-recipes` : le même workflow
exécuté N fois **sans** recette (baseline), puis N fois **avec** (recette
générée par l'optimiseur à partir des runs baseline), sur des payloads
différents pour prouver la paramétrisation ; critères : succès ≥ baseline,
steps et durée en baisse significative (la même statistique que
`evals/langfuse/criteria.ts`), zéro écriture non approuvée.

Pour le chat : suite `evals:procedures` (« même demande deux fois, la seconde
doit coûter moins de steps », et « une note apprise évite l'erreur qu'elle
décrit »), sur `EVAL_WRITE_TEAM_ID`, avec `--cleanup` comme `evals:memory`.
Les cas de recall existants (`evals:recall`, `memory-recall`) servent de
non-régression : le sixième bras ne doit rien changer à leurs scores.

**Déploiement par paliers.** `shadow` (recette calculée, injectée nulle part,
delta estimé) → canary sur le workflow PbyP d'une équipe pilote → `assisted`
par défaut pour les équipes pilotes → `scripted` opt-in → défaut global.
Chaque palier a un critère chiffré écrit _avant_ (même discipline que le gate
des modèles : `latencyFactor`, enveloppe de coût) et un chemin de retour sans
déploiement (`team_ai_settings`, statut `disabled`).

## 7. Phasage

| phase                                        | contenu                                                                                                                                                                                                                                                                                                                                                               | durée indicative | dépend de                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------- |
| **0 — Mesurer**                              | `extractTrajectory` + `summarizeTrajectory` (module pur, tests unitaires sur des transcripts réels anonymisés) ; `usage.steps/perTool/skillReads/errorCalls` sur les runs ; scores Langfuse ; script `workflows:profile` ; ledger des runs échoués ; baseline chiffrée du workflow PbyP (et d'un second workflow sans external app)                                   | 1-2 sem          | —                                   |
| **1 — Recettes assistées**                   | table `workflow_recipes` + migration (expand) ; job `workflow-optimize` (analyse déterministe + 1 passe LLM + porte de dédoublonnage) ; `<run_recipe>` dans le pilotage + pin de tâche ; invalidation par `playbookHash` ; convergence ; harnais de run headless + `evals:workflow-recipes` ; UI lecture seule + toggles ; `shadow` → canary                          | 3 sem            | 0                                   |
| **2 — Scripts et prélude**                   | synthèse et validation statique des scripts ; matérialisation dans la sandbox ; `run-params.json` ; dry-run opt-in ; prélude `readOnly` avec tool-result synthétique ; rétrogradation automatique ; `environmentFingerprint` (versions SKILL/SDK/MCP)                                                                                                                 | 2-3 sem          | 1                                   |
| **3 — Chat**                                 | (a) notes apprises : sélection mécanique + passe LLM + `learned/howto/` + section « Appris dans cette équipe » servie par `read-skill-file.ts` + hygiène ; (b) procedures : `source_type procedures`, sixième bras, `<procedural_memory>`, matérialisation `memories/procedures/` ; (c) préchargement en un step ; `evals:procedures` ; non-régression `evals:recall` | 3-4 sem          | 0 (et 1 pour partager l'optimiseur) |
| **4 — Boucle mainteneurs et tâche sans LLM** | rapport hebdomadaire `skills:insights-report` ; promotion procedure → skill d'équipe dans l'UI ; expérimentation « tâche `scripted` fermée sans tour modèle » sur un workflow pilote                                                                                                                                                                                  | 1-2 sem          | 2, 3                                |

Ordre de valeur : la phase 1 seule capture déjà l'essentiel du gain sur les
workflows récurrents (moins de découverte, moins d'erreurs répétées, lectures
groupées) avec un risque faible ; la phase 2 apporte le gain de latence le plus
net sur les tâches de collecte ; la phase 3 est plus diffuse (le chat est
varié) et repose sur les mêmes briques.

## 8. Alternatives écartées

- **Étendre la mémoire métier au procédural** (mettre les pitfalls dans les
  épisodes / `learned/`) : casse la calibration du recall (`evals:recall`),
  mélange deux régimes de vérité (un fait métier vs une manière de faire) et
  n'attache rien à l'identité stable d'un workflow.
- **Un agent optimiseur dans la boucle** (qui réécrit le playbook à chaque
  run) : non — le playbook est la spécification de l'équipe (« goal, never a
  tool name »), et un playbook réécrit par un modèle dérive. L'optimiseur
  produit une couche _à côté_ du playbook, versionnée et jetable.
- **Rejouer un run entier sans LLM** (style enregistrement / replay) : les
  runs Fretik mêlent collecte déterministe et jugement (mails, rapprochements,
  livrables). On rejoue par tâche, avec l'agent comme filet ; le « sans LLM »
  reste une option par tâche, gagnée par la mesure.
- **Injecter les skills complets dans le préfixe statique** : 15-20 k tokens
  de plus par tour pour toutes les équipes, la plupart des tours n'en ayant pas
  besoin ; le cache lecture ne rend pas ça gratuit et la latence de prefill
  monte. À reconsidérer uniquement pour un skill toujours-on court, mesure à
  l'appui.
- **Cache sémantique de réponses** (type GPTCache) : les réponses dépendent de
  données vivantes ; ce qui est stable, c'est la _procédure_, pas la réponse.
- **Fine-tuning** : la flotte de modèles est multi-fournisseur et pilotée par
  le registre ; un savoir appris doit survivre à un changement de modèle.
- **Distiller aussi les runs échoués en épisodes** : non — ils entrent dans
  le ledger et alimentent l'optimiseur, pas la mémoire de l'équipe.

## 9. Questions ouvertes, à trancher par toi

1. **Périmètre pilote.** Le workflow PbyP est le candidat évident ; quel second
   workflow (sans external app, avec livrable xlsx) sert de contrôle ?
2. **Modèle de l'optimiseur.** Classe « consolidation » (`gpt-oss-120b`, comme
   `promote-episodes`) ou flagship de l'équipe ? La synthèse de script est
   plus exigeante que la promotion ; je propose de mesurer les deux sur les
   runs baseline de la phase 0 avant de lier le rôle.
3. **Précharger par lecture groupée ou par injection du corps ?** Je propose
   de commencer par la lecture groupée en un step et de ne trancher qu'avec la
   mesure (tokens épinglés vs step économisé).
4. **Dry-run des scripts.** Il consomme des appels API du provider hors run ;
   opt-in par équipe, ou seulement pour les providers `http-direct` comme
   PbyP ?
5. **Tâche sans LLM.** Faut-il viser cette cible dès la phase 2, ou la garder
   en phase 4 comme prévu ? Mon avis : phase 4, après avoir vu combien de
   tâches deviennent réellement `stable` en pratique.
6. **Portée des notes apprises.** Équipe uniquement (proposé) ou aussi un
   niveau organisation quand plusieurs équipes partagent une connexion ?
7. **Visibilité.** Les scripts de recettes doivent-ils être lisibles par tous
   les membres de l'équipe, ou seulement par les admins (comme la confirmation
   des skills) ?

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
the Cache 2601.06007 · Dynamic Agent Skills survey 2607.10113.

Industrie : Anthropic — Agent Skills
(platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
skill-creator (github.com/anthropics/skills), mémoire de Claude Code
(code.claude.com/docs/en/memory), memory tool / context editing / compaction
(platform.claude.com/docs/en/build-with-claude/…), Managed Agents memory et
Dreaming (claude.com/blog), programmatic tool calling et tool search
(platform.claude.com/docs/en/agents-and-tools/tool-use/…), code execution with
MCP (anthropic.com/engineering), prompt caching. OpenAI — Agents SDK
sessions et sandbox Memory (github.com/openai/openai-agents-python), Codex
skills. Letta — sleep-time compute, context repositories, ezra-memory
(github.com/letta-ai). Mem0, Graphiti/Zep, LangMem (dépôts GitHub). Manus —
_Context Engineering for AI Agents_. Devin — Knowledge et Playbooks
(docs.devin.ai). Skyvern — code caching
(github.com/Skyvern-AI/skyvern/blob/main/docs/developers/features/code-caching.mdx).
Browser Use — workflow-use. Stagehand — caching et deterministic agent
(github.com/browserbase/stagehand). Vercel AI SDK — caching et middleware.
Langfuse — A/B testing et prompt CI/CD.
