# Colonnes alimentées par des apps externes — plan d'implémentation

Étude et plan, rédigés le 2026-09-16. Rien n'est implémenté : ce document
sert à décider si le chantier vaut le coup, sous quelle forme, et dans quel
ordre.

> **Périmé — lire d'abord « Où ça en est — 2026-09-20 » ci-dessous.**
> Les phases 0 à 2 sont livrées, et le modèle a changé depuis : le kind
> `lookup` s'appelle `columns` et se lit de deux façons. Ce qui suit reste vrai
> comme étude (§2 la comparaison marché, §3 l'architecture, §4 les
> interactions) mais faux comme état des lieux (§1), comme vocabulaire (§3.2)
> et comme plan (§7).

Question posée : la partie collections est un mélange de base de données et
de CRM, mais elle n'est jamais reliée directement aux données des apps
externes. Le seul chemin aujourd'hui est de demander au chatbot ou à un
workflow de remplir des records. Un CRM/BI (Salesforce, Power BI) permet de
construire des tableaux dont des colonnes viennent directement d'une app
externe. Est-ce un gain réel, est-ce faisable de manière optimisée avec le
système SQL existant, et comment gérer formules, index, pages, workflows ?

---

## Où ça en est — 2026-09-20

Le gel du 19/09 est levé sur un point précis et un seul : **la façon de lire
l'app**. Trois questions ont été posées, et elles se répondent par un seul
changement de modèle.

### Deux axes, un seul stocké

| Axe                               | Valeurs                                                | Stocké ?                                                                  | Ce que ça décide                                                          |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **kind** — qui possède les lignes | `table` (l'app) · `columns` (l'équipe)                 | oui, enum `collection_sync_kind`                                          | création de lignes, orphelins, politique de suppression, index sémantique |
| **read** — comment on lit l'app   | `walk` (page par page) · `row` (une requête par ligne) | **non, dérivé** : `syncArgFieldKeys(args).length > 0 → row`, sinon `walk` | coût, runner, ce que « manquant » veut dire                               |

Le kind répond à « qui possède les lignes », qui décide de ce qu'est un
orphelin et de ce qu'on a le droit de supprimer — cette question devait rester.
Le `read` répond à « combien d'appels », et il se **dérive** : une source dont
un argument porte `{"$field": …}` ne peut être lue que ligne par ligne, une
source sans liaison se parcourt. Rien à choisir, donc rien à se tromper.

Trois formes valides — la quatrième, `table` + `row`, n'a pas de sens :

| kind + read        | Clé                                                               | Ligne inconnue côté app      | Coût pour N lignes |
| ------------------ | ----------------------------------------------------------------- | ---------------------------- | ------------------ |
| `table` + `walk`   | `external_id_path` ↔ `collection_records.external_id`             | créée                        | N / taille de page |
| `columns` + `walk` | `external_id_path` (côté app) ↔ `match_field_key` (colonne d'ici) | ignorée, comptée `unmatched` | N / taille de page |
| `columns` + `row`  | `{"$field": key}` dans les args                                   | n/a                          | N                  |

**Ce que ça change concrètement :** 20 000 lignes à enrichir passent de 20 000
requêtes à ~20. La lecture par ligne reste, comme repli quand l'app n'a pas de
liste pour cette entité — suivi par numéro, enrichissement par identifiant.

### Les trois réponses

**1. « Une collection `table` peut-elle avoir des colonnes personnelles ? »**
Oui, et c'était déjà vrai : le garde-fou d'écriture ne verrouille que les
champs portant un `sync_source_id`, les mises à jour de la sync sont en
`merge: true`, et même des **lignes** ajoutées à la main survivent (sans
`external_id`, elles ne sont jamais orphelines). Une collection `table` est
déjà « les données de l'app + vos colonnes ».

**2. « Fusionner les deux principes ? »** Tout sauf un : la lecture fusionne,
la propriété reste. C'est le tableau ci-dessus.

**3. « Plusieurs apps sur une collection ? »** Déjà possible — la propriété est
**par colonne** (`field_definitions.sync_source_id`), la seule contrainte étant
une source `table` au plus par collection. Ce qui manquait : que la deuxième app
coûte le prix d'une liste et non d'une requête par ligne. La clé d'une source
`columns` peut être une colonne que la source `table` remplit, et le journal
réinvalide en chaîne.

### Deux décisions

**Webhooks : inclus.** Une app qui notifie (forwarding Nango) marque ses sources
incrémentales à rafraîchir ; le sondage devient le repli. On ne lit **pas** le
payload — sa forme est propre à chaque fournisseur : l'événement dit « quelque
chose a changé », le run incrémental dit quoi. Anti-rebond Redis d'un quart
d'heure par connexion, et **seules** les sources incrémentales sont nudgées : une
notification ne dit pas « refais un parcours de 100 pages ».

**`lookup` → `columns`.** La paire `table` / `columns` dit ce que l'app donne,
là où `lookup` disait comment on la lit — précisément l'axe qui vient de cesser
d'être unique. Renommage mécanique, `ALTER TYPE … RENAME VALUE` écrit à la main
(drizzle-kit `1.0.0-rc.4` n'émet pas cette instruction et produirait un
`DROP TYPE` qui échoue sur toute ligne existante).

### Deux défauts trouvés en chemin

Aucun des deux n'était dans le plan ; les deux se voyaient dès qu'on faisait
vraiment appeler une app par l'agent.

- **`appNameOf` nommait les deux connexions pareil.** La précédence prenait le
  `displayName` du manifeste avant le nom de la connexion — donc deux
  connexions d'un même produit (« Front — Ventes », « Front — Support »)
  s'affichaient toutes deux « Front », dans la phrase même censée dire laquelle
  remplit quelle colonne. Inversée ; le nom donné par l'équipe gagne.
- **Le type `markdown` n'était jamais proposé.** L'inférence de type ne
  connaissait que `text`, donc une app qui rend du Markdown (Notion, entre
  autres) produisait une colonne texte brute. `project-row.ts` le détecte
  maintenant sur les marqueurs, et `markdown` l'emporte sur `text` quand les
  deux sont candidats.

### Ce qui reste ouvert

- **Le type `money`** — l'inférence ne peut pas le proposer : le vocabulaire
  `ParamSpec` du manifeste n'a pas de montant (string, integer, number,
  boolean, email, date, datetime, enum, array, object), et l'étendre touche
  aussi le générateur de SDK. Une colonne monétaire arrive donc en `number`.
- **Fraîcheur à l'ouverture** et **écriture inverse** — décisions du 19/09
  inchangées, déclenchées par une demande.
- **Prod** : le service **jobs** sur Dokploy a besoin de `NANGO_HOST` /
  `NANGO_SECRET_KEY`, sinon toute sync planifiée y échoue.

---

## Où ça en est — 2026-09-19

Les phases 0, 1 et 2 sont livrées : le moteur parcourt en flux et reprend sur
point de reprise, le gouverneur d'appels protège les apps tierces, le plancher
d'orphelins demande confirmation au lieu de détruire, l'agent a `manageSync` et
sait choisir entre une lecture en direct, une collection synchronisée et un
workflow. La phase 3 (webhooks, relations par `external_id`, écriture inverse)
n'est pas commencée.

### Trois décisions prises le 2026-09-19

**1. Le moteur est gelé jusqu'à ce qu'un vrai client s'en serve.** Pas de
webhooks, pas de relations par `external_id`, pas de nouveau mode de
pagination tant qu'une équipe réelle n'a pas rempli une collection et n'a pas
buté sur quelque chose. Le moteur est plus capable que la demande : il tient
un million de lignes et personne n'en a encore synchronisé dix mille. La
prochaine heure d'ingénierie vaut plus sur ce qu'un utilisateur aura
effectivement demandé que sur la ligne suivante du plan. Ce qui reste ouvert
ci-dessous est un inventaire, pas une file d'attente.

**2. L'écriture inverse (modifier une colonne ici met à jour l'app) est un
chantier déclenché par la demande, pas planifié.** C'est la seule chose qui
transformerait une collection synchronisée en poste de travail plutôt qu'en
miroir, et c'est aussi la seule qui puisse casser les données de quelqu'un
d'autre. Elle exige, au minimum : une action d'écriture déclarée par le
manifeste et testée par fournisseur, un chemin d'approbation (le `plan-executor`
existe), une résolution de conflit quand l'app a changé la valeur entre-temps,
et une réponse honnête quand l'écriture réussit chez nous et échoue chez eux.
Rien de tout ça ne se conçoit dans l'abstrait : on attend le premier client qui
dit « je veux corriger ce statut ici », et on le construit pour son app.

**3. « Actualiser à l'ouverture » n'existe pas — le réglage a été retiré du
formulaire.** `refreshOnOpenAfterMinutes` est enregistré, validé, et le trigger
`open` figure dans l'enum des runs — mais rien ne lit l'un ni ne produit
l'autre. Le formulaire promettait donc quelque chose qui n'arrivait jamais. La
colonne et l'enum restent (la fonctionnalité est prévue, et c'est précisément
la réponse à « on préfère voir en direct » : une page sur une collection
synchronisée qui se rafraîchit à l'ouverture) ; l'interrupteur, lui, est parti.

### Ce qui reste ouvert

- **Fraîcheur à l'ouverture** — ci-dessus. Le chantier le plus proche d'une
  vraie demande utilisateur.
- **Découvrabilité du `lookup`** — une source `lookup` coûte un appel par
  record et rien dans le formulaire ne le dit : l'estimation de coût
  (`estimate-cost.ts`) suppose une page par run, ce qui est juste pour une
  source `table` et faux jusqu'à 200× pour un `lookup`. À corriger avant, ou
  en même temps, que toute décision sur qui a le droit d'en créer une.
- **Phase 3** — webhooks, relations par `external_id`, écriture inverse.

---

## 0. Verdict en dix lignes

1. **Le besoin est réel et le gain est élevé**, mais pas sous la forme
   « colonne live interrogée à l'affichage ». Aucun produit du marché ne livre
   des colonnes tierces filtrables, triables et utilisables dans une formule
   sans les **matérialiser** (§2). Ceux qui restent « live » (Salesforce
   Connect, Power BI DirectQuery) le paient par une liste longue de
   fonctionnalités interdites, exactement celles qui font la valeur d'un CRM.
2. Le système de collections de Fretik est **déjà la bonne cible de
   matérialisation** : une vraie table Postgres typée par collection, des
   formules en colonnes `GENERATED … STORED`, des index à la demande, des
   rollups, la RLS, l'outil SQL du chatbot, les datasets de pages (§1). Une
   valeur externe qui atterrit dans une colonne typée hérite de tout cela
   gratuitement. C'est le contraire de Salesforce, qui a dû réinventer un
   sous-langage pour ses external objects.
3. La brique manquante n'est donc pas un moteur de fédération, c'est un
   **moteur de synchronisation déclaratif** : « cette collection / cette
   colonne est alimentée par l'action `X` de la connexion `Y`, avec ces
   arguments, rafraîchie selon cette cadence ». Déterministe, sans LLM, sur
   les files BullMQ existantes.
4. Deux formes, à livrer dans cet ordre : **(A) collection synchronisée**
   (une action `list_*` devient une collection entière, à la Airtable Sync /
   Coda sync table), puis **(B) champ synchronisé** sur une collection
   existante (une action `get_*` alimente une ou plusieurs colonnes, clé
   prise sur le record, à la Salesforce indirect lookup mais matérialisée).
5. Le point dur n'est pas SQL, c'est le **N+1 vers les apps** en forme (B).
   La réponse est une combinaison : déclaration `batch` dans le manifeste
   quand l'API le permet, sinon concurrence bornée par connexion, budget par
   minute, rafraîchissement incrémental (lignes périmées d'abord, lignes
   visibles en priorité), et diff par hash pour ne rien réécrire d'inchangé.
6. Ce qui **ne doit pas** être construit : une variante « live » où le tableau
   attend l'API à chaque affichage, un FDW Postgres, un pushdown de filtres
   vers les apps. Les pages ont déjà un dataset `external` pour les petites
   lectures fraîches ; il reste le bon outil pour ça et rien de plus.
7. Coût estimé : **6 à 8 semaines** pour A + B avec UI, en trois phases
   livrables séparément (§7). La phase 0 (une semaine) est presque entièrement
   du contrat de manifeste et profite aussi au chatbot.
8. Retour attendu : les apps externes cessent d'être « des outils que l'agent
   appelle » pour devenir **des données du workspace** — interrogeables en SQL,
   jointes aux clients, agrégées dans les pages, publiables (aujourd'hui la
   publication d'une page lisant une app est refusée), déclenchant des
   workflows sur changement. C'est ce que le pitch « CRM » promet.
9. Le principal risque produit n'est pas technique : c'est la **UX de
   mapping** (choisir l'action, ses arguments, la clé, les colonnes). Il est
   contenu parce que les manifestes déclarent déjà `params` et `returns`
   typés pour 10 providers sur 11 ; l'assistant peut faire le mapping à la
   place de l'utilisateur.
10. Alternative « ne rien faire » : le chemin documenté (« sync it into a
    collection with a workflow ») est un agent LLM qui refait à chaque run un
    travail déterministe, sans clé externe, sans schéma, sans fraîcheur
    visible. Même leçon que le digest supprimé le 2026-09-11 : un second
    passage de modèle sur un travail mécanique coûte plus qu'il n'apporte.

---

## 1. Ce que le code fait aujourd'hui (état des lieux)

### 1.1 Collections

- `collections` + `field_definitions` forment le catalogue ; les valeurs
  vivent dans **une table physique par collection** `data.coll_<id-hex>`
  (`services/collection-schema/table.ts`), une colonne typée par champ
  scalaire (`columns.ts`). `collection_records` n'est que le registre
  (label, statut, source, provenance, audit).
- 22 types de champs (`db/schema/field-types.ts`). `formula` est une colonne
  `GENERATED ALWAYS AS (…) STORED` compilée depuis un langage maison
  (`formula/compile.ts`, immutable par construction). `rollup` et
  `relation` sont virtuels, calculés à la demande depuis `links`
  (`computed.ts`).
- Lecture : `listCollectionRecords` (`collection-records/retrieve.ts`)
  filtre par `EXISTS` sur la table d'extension avec cast du littéral et non
  de la colonne (`field-filter.ts`), trie par jointure sur l'index
  `(_team_id, _status, col)` (28 ms sur 200 k lignes), pagine en offset ou en
  curseur.
- Index **à la demande** : créés `CONCURRENTLY` quand une page ou une
  requête les réclame, supprimés après 30 jours sans scan, ressuscités si
  redemandés (`indexes.ts`, `reconcile-indexes.ts`, sweep nocturne
  `collection-index-sweep`).
- Écriture : `createCollectionRecord` / `setRecordData` (unitaires,
  transactionnels) et `bulkCreate/UpdateCollectionRecords` (set-based,
  chunkés, succès partiel). Chaque écriture émet un `domain_events` dans la
  même transaction ; le journal alimente les cartes sémantiques
  (`journal-sweep` → `record-card`) et les triggers de workflows
  (`workflow-trigger-sweep`), avec deux gardes anti-boucle
  (`isWorkflowOriginated`, `isImportedRecord`).
- Déjà réservés mais **inutilisés** : `collection_records.source =
'connector'`, `domain_event_actor = 'connector'`, `worker_cursors`, le
  ledger `bulk_operations` (exactly-once par chunk). Aucune notion de clé
  externe, de curseur de sync ni de `synced_at`.
- Le chatbot lit les vraies tables via `AI_DB_READONLY_URL` + RLS
  (`ai/src/lib/sql-sanitizer.ts`, seules `data.coll_*` et quelques tables
  publiques sont autorisées). Il n'y a **plus de vues** `v_<key>`.

### 1.2 Apps externes

- Un **manifeste** typé par provider (`external-apps/manifest-schema.ts`,
  932 lignes) déclare actions (`kind: read|write`, `params: ParamSpec`,
  `returns: {ref|list|page|fields|void}`), transport (`nango-proxy`,
  `custom-handler`, `http-direct`), `concurrency` (`parallel|serial`,
  seule déclaration de charge existante), formulaire de credentials,
  catégories. Les connexions MCP compilent vers le même IR
  (`ExternalAppDescriptor`) mais avec `returns: {fields: {}}`, donc **sans
  schéma de retour**.
- 11 providers, 301 actions (129 reads). Retours **précis** partout sauf
  Pbyp (Directus générique, volontairement libre). Pagination hétérogène :
  Front en curseur (`{page}` + `page_token`), la plupart en `limit`/`offset`,
  Planner/SharePoint auto-parcourus par `paginate: true` (25 pages max),
  Akanea sans pagination du tout. Un seul vrai « batch par ids » en lecture
  (`ftp-sftp.get_entries`). Aucune déclaration de quota par action.
- Exécution : `executeReadAction` (`exec/read-executor.ts`) sous
  `withConnectionSlot` (verrou Redis pour les connexions `serial`), Nango
  gère les credentials et 3 retries sur 5xx/429, deadline 50 s.
- **Les pages ont déjà une source `external`** (`pages/sources/external.ts`
  - `exec/page-query.ts`) : cache Redis par `(connexion, opération, args,
resultPath)` avec TTL 15 s–900 s (défaut 60), single-flight en mémoire,
    budget de 120 questions distinctes/min/connexion, attente 45 s avec la
    réponse tardive qui remplit quand même le cache, budget de 90 s par
    rendu. Les colonnes sont **inférées** depuis 20 lignes
    (`inferExternalFields`) et marquées `sortable: false`. Le commentaire de
    tête dit explicitement : « WHAT THIS IS NOT FOR: large volumes… the
    documented path for real volume is a workflow syncs the data into a
    collection ». La publication d'une page avec dataset externe est refusée
    (`pagePublishError`).
- Le chemin chatbot/sandbox n'est **pas caché** ; aucune table ne stocke de
  données tirées d'une app ; les syncs Nango ne sont pas utilisés ; le seam
  `ExternalAppTrigger` (`mode: webhook|poll`) est déclaré dans l'IR et vide
  partout ; aucune télémétrie sur les appels externes.

### 1.3 Frontend

- Tableau `UTable` non virtualisé, tri/filtre **côté serveur**, colonnes
  construites depuis un registre par type (`fieldRegistry.ts`,
  `useFieldComponent.ts` : `Display` / `Editor` / `Config` par type), cellule
  éditable unique (`EditableCell.vue`), écritures optimistes. Pas de vues
  sauvegardées : l'équivalent est une page.
- Les pages consomment un `PageDataset` de kind `collections` (records ou
  agrégat, filtres, tri, `fields` typés renvoyés avec les lignes) ou
  `external`. Le viewer est un iframe sandboxé qui ne parle qu'au bridge
  (`data.query`, `ops.run`).
- Aucune notion UI de « synchronisé / dernière mise à jour / rafraîchir » au
  niveau champ ou collection. Le chip de source `connector`
  (`SourceChip.vue`) existe déjà et n'est jamais affiché.

---

## 2. Ce que font les autres (recherche externe, synthèse)

| Produit                                                       | Modèle                                                                                                                                                                                       | Ce qu'on y perd / ce qu'on y gagne                                                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Salesforce Connect (external objects, OData / Apex adapter)   | **Fédération live** par requête                                                                                                                                                              | Pas de formule, pas de roll-up, pas de `GROUP BY` ni d'agrégats, 4 jointures max, 1 000 lignes en sous-requête, tri délégué à la source ; 20 k callouts/h historiquement ; licence ≈ 4 000 $/mois par source de données |
| Salesforce Data Cloud « zero copy »                           | Fédération vers un lakehouse, avec un mode **cache accéléré** recommandé par Salesforce lui-même                                                                                             | Pushdown vers Snowflake/BigQuery, pas vers des API SaaS ; les données ne sont pas des objets CRM                                                                                                                        |
| Power BI                                                      | Import vs DirectQuery vs composite                                                                                                                                                           | DirectQuery : 1 M lignes, DAX restreint, pas de table calculée, 30–200 connexions max ; la réponse de Microsoft est l'hybride (Dual, agrégations pré-matérialisées)                                                     |
| Airtable Sync                                                 | **Matérialisation** one-way, 5 min à 1 h                                                                                                                                                     | Champs synchronisés en lecture seule ; l'utilisateur ajoute formules, lookups et champs locaux à côté                                                                                                                   |
| Coda Packs sync tables                                        | Matérialisation avec schéma déclaré par le pack, `continuation` de pagination, 1 min par appel, 10 k lignes, manuel / horaire / quotidien ; two-way via `mutable` + `executeUpdate` par lots | La référence la plus propre pour la forme (A)                                                                                                                                                                           |
| Notion synced DB, Baserow data sync, Glide                    | Matérialisation                                                                                                                                                                              | Read-only, plafonds de lignes (Notion 20 k), types aplatis (Baserow : texte/nombre/date/booléen seulement)                                                                                                              |
| HubSpot Data Sync, Attio, Folk, Twenty                        | ETL dans leur propre base (Ops Hub, Segment, reverse-ETL)                                                                                                                                    | Aucun n'a de type d'attribut « live »                                                                                                                                                                                   |
| NocoDB, Budibase                                              | Live, **mais uniquement sur des bases SQL**                                                                                                                                                  | Le pushdown est total parce que la source est indexée                                                                                                                                                                   |
| Retool, Softr                                                 | Live sur API avec cache (Softr : 24 h)                                                                                                                                                       | Softr pousse sa propre base dès qu'il y a du trafic (Airtable : 5 req/s)                                                                                                                                                |
| Trino, FDW Postgres (Multicorn, Steampipe, Supabase Wrappers) | Fédération avec pushdown **spécifique à chaque connecteur**                                                                                                                                  | Steampipe met un cache de 5 min par défaut ; Supabase Stripe FDW ne pousse le filtre que sur certaines colonnes ; « large result sets may experience slower performance »                                               |

Trois patterns réutilisables ressortent :

- **(a) Sync table** : schéma déclaré + curseur de pagination + upsert par
  id externe + cadence + plafond de lignes (Coda, Airtable, Baserow).
- **(b) Colonne lookup par id externe**, fetch par lot pour la page visible,
  cache TTL, et acceptation que la colonne ne se filtre/trie pas côté
  serveur **sauf si elle est aussi persistée** (Salesforce indirect lookup +
  Steampipe/Retool).
- **(c) Fédération avec pushdown** : nécessite des métadonnées de capacité
  par connecteur, des plafonds de connexions, et de toute façon un cache.

Lecture pratique : **personne ne livre (c) sur des API SaaS**. Les produits
qui convergent (Power BI Dual, Data Cloud cached acceleration, Steampipe)
matérialisent tout ce qui doit être interrogé et gardent une lecture fraîche
pour une poignée de valeurs affichées. C'est exactement la ligne de partage
entre le dataset `external` des pages (qui existe) et ce plan.

---

## 3. Décision d'architecture

### 3.1 Principe : matérialiser dans les colonnes typées existantes

Une valeur externe atterrit dans **une colonne ordinaire** de
`data.coll_<id>`, avec le type physique de son champ (`number`, `text`,
`date`, `select`, …). Conséquences, toutes gratuites :

- Formules : une colonne `GENERATED STORED` qui lit une colonne synchronisée
  se recalcule à chaque `UPDATE` de sync. Rien à écrire.
- Filtres, tris, index à la demande, agrégats de pages, rollups depuis une
  autre collection : inchangés.
- Outil SQL du chatbot : les colonnes sont là, sous RLS, sans nouveau
  sanitizer.
- Pages : dataset `collections` inchangé ; la publication devient possible
  puisque la page ne lit plus l'app.
- Workflows : `record.updated` émis par la sync = déclencheur sur changement
  externe, sans webhook.

Ce qui est **ajouté** : la provenance (d'où vient la colonne, quand, avec
quelle clé), la lecture seule sur ces champs, et le moteur qui remplit.

### 3.2 Deux kinds, deux lectures : la « source de sync »

> Le vocabulaire ci-dessous est celui de l'étude du 16/09. `lookup` s'appelle
> `columns` depuis le 20/09, et se lit **de deux façons** (`walk` ou `row`) —
> voir « Où ça en est — 2026-09-20 ». Le schéma réel porte en plus
> `match_field_key` et `unmatched_count`.

Une table `collection_sync_sources` porte la déclaration, dans les deux
formes :

```
collection_sync_sources
  id, organization_id, team_id, collection_id
  kind            'table' | 'lookup'
  connection_id   → external_app_connections (nullable : provider_key + résolution
                    par équipe, comme les pages ; en pratique on pinne)
  provider_key, operation
  args            jsonb   -- littéraux, ou {"$field": "<key>"} en kind=lookup
  result_path     text    -- comme PageDataset.resultPath
  external_id_path text   -- kind=table : chemin de l'id dans une ligne (obligatoire)
  field_mapping   jsonb   -- [{ path, fieldKey, fieldType, transform? }]
  schedule        jsonb   -- { mode: 'manual'|'interval'|'cron', everyMinutes?, cron?, onOpenIfOlderThanMinutes? }
  orphan_policy   'keep' | 'reject' | 'delete'   -- kind=table : ligne disparue upstream
  row_cap         int     -- kind=table
  enabled, last_run_at, last_success_at, last_error, next_run_at
  created_by_user_id, timestamps
```

- **kind = `table`** (forme A) : la source _possède_ la collection. Les champs
  mappés sont créés par elle, en lecture seule ; l'utilisateur ajoute des
  champs locaux (formule, relation, rollup, notes) qui survivent aux syncs.
  Chaque record porte un id externe.
- **kind = `lookup`** (forme B) : la source alimente **un sous-ensemble de
  champs** d'une collection existante, pour chaque record, en résolvant
  `args` depuis les valeurs du record (`{"$field": "siret"}`). Les champs
  mappés sont en lecture seule ; le reste de la collection reste éditable.

Une collection peut avoir une source `table` et plusieurs sources `lookup`
(ex. une collection Shiptify `shipments` enrichie d'une colonne « statut
douane » venue d'Akanea).

### 3.3 Provenance sur les records et les champs

- `collection_records.external_id varchar(200)` + index unique partiel
  `(collection_id, sync_source_id, external_id) WHERE external_id IS NOT NULL`
  et `collection_records.sync_source_id uuid` (nullable). Pour la forme A
  c'est la clé d'upsert ; pour la forme B on n'en a pas besoin (la clé est un
  champ du record).
- `field_definitions.sync_source_id uuid` (nullable) : le champ appartient à
  une source. `NON_WRITABLE_FIELD_TYPES` reste inchangé (ce sont des types),
  mais `buildRecordShape` / `validateRecordData` refusent l'écriture d'un
  champ dont `sync_source_id` est non nul, sauf pour l'acteur `connector`.
  La colonne physique reste un `text`/`numeric` ordinaire : pas de nouveau
  type de champ, donc pas de migration d'enum, pas de nouveau `Display`
  frontend, et formules/filtres/index continuent de raisonner sur le type
  réel.
- `record_sync_state (record_id, sync_source_id, synced_at, content_hash,
status 'ok'|'error'|'missing', error, attempts)` : l'état par ligne et par
  source. Sert au diff (ne rien réécrire d'inchangé, donc aucun
  `domain_events`, aucune ré-indexation de carte sémantique), au
  rafraîchissement incrémental (les plus périmés d'abord), à l'affichage
  « mis à jour il y a 5 min » et à la politique orphelins.

### 3.4 Le moteur de sync

**BullMQ et non Trigger.dev, et ce n'est pas une préférence.** Les deux rails
existent dans le dépôt et la ligne de partage actuelle est cohérente :
Trigger.dev exécute les runs d'agent durables, longs et visibles par
l'utilisateur, avec humain dans la boucle ; BullMQ exécute la plomberie
d'infrastructure qui écrit en base. Trois faits tranchent pour ce moteur.

- **Les tasks Trigger.dev ne peuvent pas atteindre la base.** C'est délibéré
  et écrit en tête de `packages/workflows/src/tasks/workflow-run.ts` : faire
  tourner la boucle agent dans la task obligerait à exposer publiquement
  Postgres, Redis et E2B. Les deux tasks existantes ne font que des appels
  HTTP vers le service AI. Or un run de sync est à 90 % du travail base de
  données, en chunks. L'y mettre voudrait dire exposer la base, ou inventer
  une surface d'endpoints internes avec un aller-retour HTTP par lot.
- **Le registre de providers est déjà dans le conteneur jobs.**
  `@fretik/providers` y est en dépendance et dans le Dockerfile ; il manque
  seulement l'import à effet de bord au boot. Le package `@fretik/workflows`
  ne l'a pas, et l'y ajouter ferait entrer imapflow, nodemailer,
  ews-javascript-api et ssh2-sftp-client dans le build Trigger.dev.
- **Le verrou de connexion traverse trois processus.**
  `withConnectionSlot` est pris côté API pour un rendu de page, côté AI pour
  une lecture sandbox, et ici. Le `concurrencyKey` de Trigger.dev ne
  sérialise que des runs Trigger et ne verrait pas le rendu de page : le lock
  Redis reste nécessaire de toute façon.

Ce que Trigger.dev fait mieux et qu'on ne prend pas : l'exécution durable à
travers un déploiement, à laquelle le ledger `bulk_operations` répond ; le
dashboard de runs, dont l'équivalent produit est la table
`collection_sync_runs` ; la progression temps réel, qu'un polling sur cette
même table couvre. Un cron ne descend pas non plus sous la minute, alors que
les sweeps à 15 s restent BullMQ quoi qu'il arrive.

Donc : nouvelle file BullMQ `external-sync`, concurrence 3, jamais sur la file
maintenance à concurrence 1, même raison que `mcp-refresh` et
`collection-index-sweep`. Trois déclencheurs :

1. **Planifié** : un sweep à la minute réclame les sources échues
   (`next_run_at <= now()`) et les met en file, exactement comme
   `workflow-trigger-sweep` le fait pour les événements. **Pas un job
   répétable par source** : ces objets vivent dans Redis, alors que la
   planification d'une source appartient à la base qui possède déjà la
   source. Un Redis vidé coûte alors un cycle, pas une sync silencieusement
   morte, et il n'y a aucun objet de planification à créer ou détruire à
   chaque source. La colonne `claimed_at` empêche deux replicas de
   double-réclamer. Intervalle minimal 15 min. Cadences proposées dans
   l'UI : 15 min / 1 h / 6 h / 24 h / manuel (Airtable et Coda se tiennent
   là).
2. **À la demande** : bouton « Rafraîchir » sur la collection ou le champ,
   outil `manageCollection` du chatbot, et _à l'ouverture_ de la collection
   si `last_success_at` est plus vieux que `onOpenIfOlderThanMinutes`
   (déclenchement asynchrone : la page s'affiche avec les données
   matérialisées, le rafraîchissement arrive derrière et la liste se
   ré-invalide, exactement le modèle « still working, ask again » du
   dataset externe des pages).
3. **Sur événement** (forme B) : le `journal-sweep` (15 s) repère un
   `record.created` / `record.updated` dont le diff touche un champ utilisé
   dans les `args` d'une source `lookup` et met la ligne en file. C'est ce
   qui donne l'impression de « live » : créer un client avec son SIRET
   remplit ses colonnes externes dans les secondes qui suivent.

Le runner d'une source `table` :

```
walk(read action, args, pagination) -> lignes upstream (cap row_cap)
  -> projeter field_mapping -> { external_id, data, hash }
  -> charger record_sync_state de la source (une requête)
  -> partitionner : nouveaux / changés (hash ≠) / inchangés / disparus
  -> bulkCreateCollectionRecords(nouveaux)   actor connector, source 'connector'
  -> bulkUpdateCollectionRecords(changés)    mode merge sur les champs de la source uniquement
  -> orphan_policy sur les disparus (keep : status 'missing' ; reject : status 'rejected' ; delete)
  -> upsert record_sync_state, last_success_at, next_run_at
```

Tout passe par les services existants (validation, identité, journal,
index après chargement), avec `skipIndexReconcile` pendant les chunks et un
`reconcileFieldIndexes` en fin de run, comme l'import. L'`agentKey` vaut
`connector:<sourceId>` : le `workflow-trigger-sweep` doit le traiter comme il
traite `import:<id>` (§5.3).

Le runner d'une source `lookup` :

```
sélectionner N records à rafraîchir : demandés explicitement > périmés > jamais faits
  -> résoudre args depuis data (records sans clé : status 'missing', pas d'appel)
  -> si l'action déclare batch : grouper par maxItems, un appel par groupe
     sinon : appels unitaires sous withConnectionSlot, concurrence bornée
  -> hash, diff, bulkUpdate des seuls changés, record_sync_state
```

### 3.5 Optimisation des appels externes (le vrai problème)

Par ordre d'efficacité :

1. **Préférer `list_*` à `get_*`**. Une source `lookup` peut être configurée
   sur une action de liste filtrée (`list_shipments(sr_internal_ref=…)`)
   ou, mieux, sur une action de liste **globale** dont on fait la jointure
   localement par clé : un seul parcours upstream remplit tous les records.
   C'est le mode par défaut à proposer dans l'UI quand l'action `list`
   existe ; le `get` unitaire est le repli.
2. **Déclaration `batch` dans le manifeste** (phase 0) : `batch: { param:
"ids", maxItems: 20 }` sur une action de lecture qui accepte une liste
   (`ftp-sftp.get_entries` aujourd'hui, Graph `$batch` demain pour Outlook,
   Pbyp `query_items` avec `filter: {id: {_in: […]}}`). Le runner groupe.
3. **Diff par hash** : une valeur inchangée ne produit ni `UPDATE`, ni
   `domain_events`, ni ré-embedding. Sur une collection de 10 k lignes
   rafraîchie toutes les heures, c'est ce qui rend le coût supportable pour
   la base et pour la mémoire.
4. **Incrémental quand l'API le permet** : `args` peut référencer
   `{"$since": "last_success_at"}` sur un paramètre `updated_after`
   (Front `list_contacts(updated_after)`, Shiptify `created_date_from`).
   Réduit un parcours complet à un delta.
5. **Bornes** : `row_cap` (défaut 20 k, plafond 100 k, aligné sur
   `INDEX_ROW_THRESHOLD`), budget d'appels par run et par minute par
   connexion (réutiliser `rl:page-ext:<connectionId>` ou un jumeau
   `rl:sync:`), `withConnectionSlot` pour les `serial`, deadline par run,
   `MAX_PAGES` du parcours. Un run qui atteint une borne se termine
   proprement avec `truncated` et le dit dans l'UI.
6. **Priorité à ce qui est regardé** : le rafraîchissement à l'ouverture
   met d'abord en file les ids de la page affichée (le frontend les connaît),
   puis le reste.

Ce qu'on ne fait pas : attendre l'API pendant le rendu du tableau. Le
tableau lit toujours Postgres. La fraîcheur est une information affichée,
jamais une latence subie.

### 3.6 Mapping des types : `ParamSpec` → type de champ

| `ParamSpec.type`                | Champ                                                                                            | Remarque                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| `string`                        | `text` (ou `url`/`phone` si le nom le suggère, proposé, pas imposé)                              |                                  |
| `integer`, `number`             | `number`                                                                                         |                                  |
| `boolean`                       | `boolean`                                                                                        |                                  |
| `email`                         | `email`                                                                                          |                                  |
| `date`                          | `date` (`hasTime: false`)                                                                        |                                  |
| `datetime`                      | `date` (`hasTime: true`)                                                                         |                                  |
| `enum`                          | `select` avec `options` = `values`                                                               | couleurs par `fillOptionColors`  |
| `array` de `string`/`enum`      | `multi_select` (`freeform: true`)                                                                |                                  |
| `object`                        | aplati un niveau : `address.city` → champ `address_city` ; l'utilisateur coche les sous-chemins  | la même logique que `resultPath` |
| `array` d'`object`              | non mappable en V1 (proposer une seconde source `table` sur l'action de détail, ou une relation) |                                  |
| MCP `{fields: {}}` / Pbyp libre | inférence sur échantillon (réutiliser `inferExternalFields`), puis confirmation utilisateur      | type `unknown` → `text`          |

Un objet `money` amont (`amount` + `currency`) se mappe sur le type `money`
existant via deux chemins. Les identifiants externes vers d'autres objets de
la même app (ex. `shipper_id`) peuvent, en V2, se mapper sur une `relation`
vers une autre collection synchronisée de la même connexion, résolue par
`external_id` : c'est l'équivalent Fretik de l'_external lookup_ Salesforce,
et le moment où le CRM devient un graphe. Hors V1.

### 3.7 Alternatives écartées

- **Colonne live sans persistance (pattern b pur)** : une cellule qui appelle
  l'API à l'affichage. Écartée parce qu'elle n'est ni filtrable ni triable
  ni utilisable dans une formule ou par le SQL du chatbot, et parce que le
  tableau attendrait des tiers (Akanea : 12–15 s par appel). Si un cas
  « valeur du moment, jamais stockée » apparaît, une page avec dataset
  `external` le couvre déjà.
- **Fédération / FDW** : Postgres ne peut pas pousser un `WHERE` vers Nango ;
  écrire un FDW par provider n'est pas raisonnable ; la RLS et les colonnes
  générées ne s'appliqueraient pas. Aucun produit ne le fait sur des API
  SaaS.
- **Nouveau type de champ `external`** : refusé au profit d'un attribut
  `sync_source_id` sur un champ de type réel. Un type dédié casserait
  `formulaTypeOf`, `VALUE_CAST`, les index par type physique et exigerait un
  `Display` par sous-type.
- **Nango Syncs** : Nango sait exécuter des scripts de sync et stocker des
  records ; mais on perdrait le contrôle du schéma, du typage, de la RLS et
  du journal, et les providers `custom-handler` / `http-direct` n'y
  passeraient pas. On garde Nango comme coffre-fort, rien de plus.
- **Trigger.dev pour le moteur** : écarté pour les trois raisons de §3.4,
  dont la première est structurelle et non contournable sans changer la
  topologie réseau.
- **Un job répétable BullMQ par source** : écarté au profit du sweep sur
  `next_run_at` (§3.4), qui garde la base comme source de vérité.
- **Laisser le workflow faire** (statu quo) : voir §0 point 10.

---

## 4. Fonctionnalités interconnectées

### 4.1 Pages

- Dataset `collections` : rien à changer, il voit les colonnes.
- `pagePublishError` : une page qui lit une collection synchronisée est
  publiable, puisque le lecteur anonyme lit Postgres, pas l'app. C'est le
  débouché immédiat le plus visible : des dashboards publics sur des données
  d'apps.
- Le dataset `external` reste pour les lectures ponctuelles et fraîches. Le
  builder de pages doit apprendre la règle (skill `platform-guide`) :
  « volume ou besoin de filtre/agrégat → collection synchronisée ; valeur
  instantanée → dataset external ».
- `PageFieldDescriptor` gagne `synced: true` + `syncedAt` pour qu'une page
  puisse afficher « données Shiptify, mises à jour à 14 h 05 ».

### 4.2 Workflows

- Déclencheur `event` : les événements `record.created/updated` émis par une
  sync sont aujourd'hui sans garde (seuls `workflow:` et `import:` sont
  filtrés). Deux choix à trancher : (1) filtrer `connector:` par défaut et
  ajouter un type de déclencheur explicite `record_synced` ; (2) laisser
  passer. Recommandation : **(1)**, sinon un premier chargement de 20 k
  lignes lance 20 k runs, c'est le bug que la garde `import:` a déjà corrigé
  une fois. Le filtre `object_type` existant s'applique.
- Un workflow peut alors réagir à un changement **dans l'app externe** (une
  expédition passe en « livrée ») sans webhook : la sync produit le diff, le
  journal le porte. Latence = cadence de sync.
- `record_external_apps` : une sync compte comme une dépendance app de la
  collection, pas du workflow ; pas de changement.

### 4.3 Chatbot et outil SQL

- `describe-team-schema.ts` : ajouter par collection `syncedFrom: { app,
operation, lastSuccessAt }` et par champ `synced: true`. L'agent sait
  qu'il ne doit pas écrire ces champs et peut répondre « données Outlook de
  9 h 12 ».
- `manageCollection` / `manageField` : actions `setSyncSource`,
  `refreshSync`. Le composer « Décris-le à l'IA » devient le chemin le plus
  simple pour créer une collection synchronisée : l'agent connaît le
  manifeste (SKILL) et peut proposer le mapping.
- SQL : rien. Les tables sont les mêmes.

### 4.4 Mémoire, vecteurs, index

- Cartes sémantiques : un `record.updated` par ligne changée déclenche un
  ré-embedding. Le diff par hash limite au strict changé ; pour une
  collection synchronisée volumineuse, `collections.semanticIndex` doit
  être **`false` par défaut** à la création (une table d'expéditions n'a pas
  sa place dans le recall), l'utilisateur peut le remettre.
- Index : un run de sync fait le même `reconcileFieldIndexes` final qu'un
  import ; le sweep nocturne gère le reste. Les colonnes synchronisées sont
  indexées **exactement** comme les autres, selon l'usage réel.

### 4.5 Approvals, politiques, sécurité

- Une sync est une **lecture** déclarée une fois par un utilisateur, comme un
  dataset de page : politique `blocked` refuse, `approval` n'a pas de sens
  hors conversation → traité comme `auto`, identique à `page-query.ts`.
- La sync n'écrit **jamais** `connection.status` (même invariant que les
  pages) ; une erreur d'auth est reportée dans `last_error` de la source et
  un chip « reconnexion nécessaire » renvoie vers les réglages.
- Connexion personnelle (`user_id` non nul) : une source `table` alimentant
  une collection d'équipe depuis une boîte mail personnelle exposerait des
  données privées à l'équipe. **V1 : seules les connexions d'équipe** sont
  éligibles à une source `table` ; les connexions personnelles restent
  autorisées pour une source `lookup` sur une collection privée
  (`collection_records.user_id`).
- RLS, partage inter-équipes, `inherit_type_sharing` : inchangés, ce sont des
  records ordinaires.

### 4.6 Import en masse, ledger

- Le premier chargement d'une source `table` volumineuse réutilise
  `bulk_operations` (chunks = transactions, reprise après crash) plutôt qu'un
  run monolithique.

---

## 5. Contrats à modifier

### 5.1 Manifeste (`manifest-schema.ts`) — additions optionnelles

```ts
// sur actionSchema, lecture uniquement
pagination?: {
  kind: "cursor" | "offset" | "none";
  limitParam?: string;       // "limit"
  maxLimit?: number;         // 100
  tokenParam?: string;       // "page_token"  (cursor)
  offsetParam?: string;      // "offset"      (offset)
}
batch?: { param: string; maxItems: number };   // lecture par lots d'ids
incremental?: { param: string; kind: "datetime" | "cursor" };  // updated_after
```

Sans `pagination`, le runner déduit : `returns: {page}` → cursor avec
`page_token` ; `paginate: true` → l'exécuteur parcourt déjà ; sinon un seul
appel. Les 11 manifestes reçoivent la déclaration au fil de l'eau (une ligne
chacun). Le générateur SDK/SKILL les ignore : aucun impact sur le chatbot.

### 5.2 Schéma (migrations)

- `collection_sync_sources` (§3.2), `record_sync_state` (§3.3).
- `collection_records.external_id`, `collection_records.sync_source_id` +
  index unique partiel.
- `field_definitions.sync_source_id`.
- Pas de changement d'enum : `ontology_source.connector` et
  `domain_event_actor.connector` existent.

### 5.3 Services

- `services/collection-sync/` : `create-source.ts`, `update-source.ts`,
  `delete-source.ts` (que faire des champs : les convertir en champs locaux
  éditables, données conservées — un `UPDATE field_definitions SET
sync_source_id = NULL`), `preview.ts` (échantillon 20 lignes + inférence,
  sans écrire), `run-table-sync.ts`, `run-lookup-sync.ts`, `walk-read.ts`
  (pagination générique), `project-row.ts` (mapping + hash),
  `schedule.ts`.
- `collection-records/validate.ts` : refus d'écriture sur champ synchronisé
  hors acteur `connector`.
- `jobs/lib/workflow-trigger-matching.ts` : garde `connector:`.
- `collections/describe-team-schema.ts`, `pages/field-descriptors.ts`.
- `jobs/workers/external-sync.ts` + file + scheduler.

### 5.4 API

- `/collection-sync-sources` : `GET` (par collection), `POST`, `PATCH /{id}`,
  `DELETE /{id}`, `POST /preview` (connexion + opération + args →
  échantillon + champs inférés), `POST /{id}/run` (déclenche, renvoie un
  `runId`), `GET /{id}/runs` (historique court : début, fin, créés, modifiés,
  disparus, erreurs).
- `GET /external-apps/providers` : exposer `params` et `returns` des actions
  de lecture (aujourd'hui volontairement absents du wire). Nécessaire pour
  que le formulaire d'arguments se rende depuis le manifeste, comme
  `DynamicCredentialsForm` le fait pour les credentials.

### 5.5 Frontend

- `ComposerDrawer` : troisième onglet « Depuis une app connectée » :
  connexion → action de lecture (liste, avec `summary`) → formulaire
  d'arguments généré depuis `params` (réutiliser le rendu de
  `SchemaField.vue`/`DynamicCredentialsForm`) → aperçu 20 lignes → choix de
  l'id externe et des colonnes (types pré-remplis, modifiables) → cadence →
  créer.
- `FieldEditorDrawer` : section « Valeur depuis une app » (source `lookup`) :
  connexion, action `get`/`list`, mapping des arguments vers des champs du
  record, chemin du résultat, cadence.
- Collection : bandeau `synced` avec logo de l'app, « mis à jour il y a … »,
  bouton Rafraîchir, état d'erreur avec lien vers la connexion. Colonnes
  synchronisées : icône de source dans l'en-tête, cellule non éditable
  (`EditableCell` : `READ_ONLY` étendu par `field.syncSourceId`), tooltip
  « depuis Shiptify, 14 h 05 ».
- `SourceChip` affiché quand `source = connector`.
- Pages : `SourceList` montre l'app derrière une collection synchronisée.
- i18n `en` + `fr` pour tout.

---

## 6. Ce que le SaaS y gagne, objectivement

**Gains**

- Les 129 actions de lecture existantes deviennent 129 tables potentielles,
  sans écrire une ligne de provider. Une équipe transport obtient
  `shipments`, `receptions`, `stock_movements` comme collections en dix
  minutes, avec formules, kanban, cartes (les `location` se géocodent
  déjà), et le chatbot les joint à `clients` en SQL.
- Les pages sur données d'apps deviennent **publiables** et rapides (20 s de
  cache page + Postgres au lieu de 45 s d'attente d'API).
- Les workflows réagissent aux changements externes sans webhook.
- Le pitch « CRM » tient : Attio, HubSpot, Airtable font exactement cela ;
  aucun ne le fait avec un agent qui construit le mapping.
- Les connexions personnelles peuvent, en forme `lookup` sur collection
  privée, alimenter un espace perso (ex. « mes derniers échanges » depuis
  Outlook) — à cadrer en V2.

**Coûts et risques**

- Quotas d'API : une cadence de 15 min sur 10 k lignes sans `incremental`
  c'est 100 pages/appel × 96/jour. Les bornes (§3.5) protègent, mais il faut
  **afficher le coût** (appels par run) dans l'UI de la source, et par défaut
  proposer 1 h.
- Attentes de fraîcheur : « synchronisé » n'est pas « live ». L'UI doit dire
  l'heure partout où la donnée apparaît. Airtable et Notion vivent très bien
  avec 5 min à 1 h.
- Volume Postgres : une collection synchronisée est une collection comme une
  autre ; le seuil d'index (20 k) et le sweep existent. Rien de nouveau, mais
  le premier gros client fera grossir la base plus vite.
- UX de mapping : c'est là que le projet peut s'enliser. D'où l'aperçu
  systématique, le mapping pré-rempli, et le composer IA comme chemin
  principal.
- Écriture inverse (modifier une cellule synchronisée → écrire dans l'app) :
  attendue par les utilisateurs de CRM, hors V1. La mécanique existe
  (`.op()` → plan → approval) ; ce sera une V2 propre.

**Ce que ça ne règle pas**

- Une valeur qui doit être exacte à la seconde (solde, disponibilité) : le
  dataset `external` des pages reste la réponse.
- Les apps sans identifiant stable par ligne (Akanea partiellement) : on
  hache la ligne, et on accepte que la « même » ligne changée devienne une
  nouvelle ligne + un orphelin. À documenter par provider.

---

## 7. Phases et estimation

| Phase                               | Contenu                                                                                                                                                                                                                                                                                                      | Estimation   | Livrable seul ?                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------- |
| **0 — Contrats**                    | `pagination`/`batch`/`incremental` dans le manifeste + déclaration sur les 11 providers ; `walk-read.ts` générique ; `external_id` + `record_sync_state` ; exposition `params`/`returns` sur `/providers` ; garde `connector:` dans le trigger sweep                                                         | 1 semaine    | Oui : le parcours générique sert immédiatement au dataset `external` des pages (qui ne pagine pas aujourd'hui) |
| **1 — Collection synchronisée (A)** | `collection_sync_sources`, services, runner `table`, file + scheduler, orphelins, aperçu, API, composer frontend, bandeau/refresh, `describe-team-schema`, outil `manageCollection`, publication de pages autorisée, tests d'intégration sur Postgres réel                                                   | 3 semaines   | Oui, c'est la valeur principale                                                                                |
| **2 — Champ synchronisé (B)**       | runner `lookup`, résolution `{"$field"}`, groupage `batch`, déclenchement sur événement via `journal-sweep`, priorité viewport, `FieldEditorDrawer`, cellules lecture seule, `SourceChip`                                                                                                                    | 2 semaines   | Oui                                                                                                            |
| **3 — Consolidation**               | Webhooks via le seam `ExternalAppTrigger` (fraîcheur quasi temps réel là où le provider le permet), relations par `external_id` entre collections d'une même app, écriture inverse avec approval, télémétrie (`usage_metrics` : appels, lignes, durée par source), connexions personnelles en `lookup` privé | 2 semaines + | Chaque item indépendant                                                                                        |

Total A + B avec UI : **6 semaines**, 8 avec la consolidation. Les phases 0
et 1 se testent avec Shiptify (`list_shipments`, id stable, pagination
offset, `created_date_from` pour l'incrémental) et Front (`list_contacts`,
curseur, `updated_after`) : deux providers, trois modes de pagination.

### Critères de sortie de la phase 1

- 10 k expéditions Shiptify synchronisées en moins de 2 min au premier run,
  moins de 20 s ensuite (diff par hash, incrémental) ; zéro `domain_events`
  quand rien n'a changé.
- Une formule `days_between(now_ish, departure_date)` sur la collection se
  recalcule sans code supplémentaire ; une page agrégée par `status` se
  publie.
- Le chatbot répond à « combien d'expéditions en retard pour le client X »
  en une requête SQL jointe, sans appeler Shiptify.
- La suppression d'une connexion ne casse pas la collection : les données
  restent, la source passe en erreur, l'UI le dit.

---

## 8. Questions ouvertes à trancher avant la phase 1

1. **Politique orphelins par défaut** : `keep` (marquer `missing`, garder) ou
   `reject` (statut `rejected`, invisible mais historisé) ? Recommandation
   `keep` : Airtable supprime, Coda supprime, mais nos records peuvent porter
   des champs locaux et des liens qu'on ne veut pas perdre silencieusement.
2. **Cadence minimale** : 15 min (proposé) ou 5 min (Airtable base-à-base) ?
   5 min multiplie par 3 la charge sur les APIs tierces pour un gain
   perceptible seulement sur des apps qui, elles, publient des webhooks — à
   traiter en phase 3 plutôt.
3. **Qui peut créer une source** : tout membre (comme une collection) ou
   admin d'équipe (comme une connexion) ? Une source engage le quota d'une
   connexion d'équipe ; recommandation : même règle que la connexion.
4. **Faut-il un type `json`** pour ranger un objet non aplati ? Utile pour
   MCP et Pbyp, mais un champ non typé est invisible pour les formules et
   les filtres. Recommandation : non en V1, aplatir ou ignorer.
