# Fretik — Modèle économique & stratégie de tarification

> Document de stratégie (non technique). Objectif : poser un modèle de pricing
> solide, défendable et évolutif, sur lequel s'appuyer pour communiquer et lancer.
> Rédigé à partir d'une analyse du produit (repos `fretik-app` + `fretik-backend`)
> et d'un benchmark marché France/International (juin 2026).
>
> Devise de référence : **EUR**, prix **par utilisateur / mois, facturation annuelle**
> (le tarif mensuel sans engagement = +20 à +25 %).

---

## 1. Synthèse exécutive (TL;DR)

**Recommandation : un modèle HYBRIDE à trois étages**, pas un modèle unique.

1. **Abonnement par siège (plateforme)** → capture la valeur « espace de travail
   collaboratif » (le côté Notion/CRM). Prévisible, facile à vendre, ancre le contrat.
2. **Crédits IA (consommation)** → capture la valeur « l'IA exécute le travail »
   (chatbot agentique, extraction documentaire, agents autonomes à venir). Aligne
   le prix sur le coût réel et protège ta marge.
3. **Add-ons & options** → souveraineté/BYO-endpoint, agents autonomes & workflows,
   stockage, SSO/sécurité, support. C'est là que se logent l'expansion de revenu
   et les grosses marges.

**Pourquoi pas un seul modèle ?** Parce que ton produit a deux natures :
- une partie **« logiciel »** (CRM léger, drive, mémoire, collaboration) dont la valeur
  est proportionnelle au **nombre de personnes** qui l'utilisent → siège ;
- une partie **« travail effectué par l'IA »** dont la valeur et le coût sont
  proportionnels à **l'usage**, pas au nombre de têtes → crédits.

Le pur per-seat est en train de mourir sur les produits IA (cf. §3) : si ton agent
remplace du travail humain, facturer au siège te **punit** quand tu réussis (le client
a besoin de moins de sièges). Le pur usage/crédit, lui, est imprévisible et fait peur
en achat. **L'hybride est devenu le standard 2026** (37–41 % des éditeurs) et c'est
le bon choix pour Fretik.

**Positionnement prix :** au-dessus de Notion (10–18 €) et d'un CRM léger comme Attio
(29–69 $), au niveau de **Dust (29 €)** et en dessous de **Glean (45–65 $ + plancher
50 k$)**. Fretik fait *plus* qu'un CRM ou qu'un chat : c'est un workspace agentique
complet. La grille proposée : **Free → 24 €/Pro → 54 €/Business → Enterprise sur devis**.

**Souveraineté :** c'est un **différenciateur de prix, pas une promo**. L'infra est déjà
française (Scaleway Object Storage, OCR Mistral). Le **BYO-endpoint** (le client branche
son propre fournisseur IA — Mistral/OVHcloud/Azure EU/self-hosted) doit être une option
**Enterprise payante** (offre « Souverain »), pas un cadeau : elle attire les clients
régulés et te **retire le risque de coût IA**.

**Évolution dans le temps :** **ne brade pas le prix de liste.** On attire avec un
**Free généreux + crédits offerts + tarif Design Partner privé (-40/-50 %) à vie pour
les 10–20 premiers**, et non en cassant le prix public (qu'on ne pourra plus remonter
sans douleur). Le prix de liste **monte** avec la maturité (arrivée des agents autonomes).

---

## 2. Ce que vend réellement Fretik (produit → valeur → prix)

Analyse du code : Fretik n'est **pas** « un chatbot ». C'est un **workspace IA B2B
agentique, document-centré et collaboratif**. Inventaire de la valeur (existant + en cours) :

| Brique produit | État (repo) | Valeur perçue | Quoi facturer dessus |
|---|---|---|---|
| **Chatbot agentique** (20+ outils : SQL read-only, Python/Bash en sandbox E2B, web search/fetch, vision, RAG, sous-agents `dispatch-agent`) | ✅ Construit | Très élevée — « l'IA fait le travail » | **Crédits IA** (par turn/outil) |
| **Drive + extraction documentaire** (OCR Mistral, champs custom configurables, classification) | ✅ Construit | Élevée — automatise la saisie | **Crédits IA** (par doc) + stockage |
| **CRM léger / Entités** (objets, rôles, liens documents, enrichissement, vues) | ✅ Construit | Moyenne-élevée — le « Notion » | **Siège** + cap d'objets (fair-use) |
| **Mémoire unifiée** (team/user, audit, historique, vectorisée, manifeste injecté) | ✅ Construit (le « futur » est déjà là en partie) | Élevée — stickiness, l'IA « connaît » l'entreprise | **Siège** (Business+) + cap |
| **RAG unifié** (vecteurs Qwen 8B, BM25, contextual retrieval, rerank Cohere) | ✅ Construit | Élevée — recherche/connaissance | inclus, meter via crédits à l'ingest |
| **Skills / playbooks** (bundled + team, doc/xlsx/pptx/pdf, data-viz) | ✅ Construit | Moyenne — réutilisable | **Siège** (Business+) |
| **Intégrations externes** (Outlook, IMAP/SMTP, Exchange, Teams, Front, Shiptify via Nango, avec approbations d'écriture) | ✅ Construit | Élevée — l'IA agit dans tes outils | **Add-on / nb de connecteurs par tier** |
| **Collaboration temps réel** (conversations multi-utilisateurs, @mentions, présence, catch-up) | ✅ Construit | Élevée — c'est l'argument « collaboratif » | **Siège** |
| **Multi-tenant** (org → teams, RLS, RBAC, 2FA) | ✅ Construit | Critique pour l'entreprise | **Enterprise** (SSO/audit/RLS) |
| **Sélection de modèles par équipe** (`team_ai_settings`, 3 tiers flagship/workhorse/utility) | ✅ Construit | Moyenne — maîtrise coût/qualité | levier de **marge** + base du BYO |
| **Mémoire évènementielle / graphe de mémoire** (éléments reliés, events) | 🟡 Partiel (events Redis pub/sub + mémoire existent ; le graphe relié = à venir) | Élevée — différenciateur | **Business/Enterprise** |
| **Agents autonomes, workflows, triggers, DAG, process** | 🔴 À venir (aujourd'hui : agent réactif + task-list + sous-agents ; pas de CRON/trigger/DAG/builder visuel) | **Très élevée** — passage de « assistant » à « employé numérique » | **Add-on premium / outcome / crédits** |
| **Métrage d'usage** (`usage_metrics` : docs traités, stockage GB, appels API) | ✅ Tables prêtes, **pas de moteur de facturation** | — | **socle technique du pricing** |

**Conséquence pour le pricing :** tu as déjà l'infrastructure de métrage (`usage_metrics`,
`team_ai_settings`, traces de coût Langfuse par appel). Il manque le **moteur de
crédits/quotas + l'intégration paiement (Stripe)**. C'est le prochain chantier produit
côté monétisation, et il conditionne tout ce document.

---

## 3. Le marché & les tendances (benchmark chiffré, juin 2026)

### 3.1 La bascule des modèles de pricing

- **L'hybride domine** : ~37 % des éditeurs en hybride en 2026 ; la part « base + usage »
  est passée de 27 % à 41 % en un an.
- **Le per-seat pur recule** : Gartner projette que d'ici 2030, ≥ 40 % des dépenses SaaS
  entreprise basculent vers usage/agent/outcome ; la part de revenu « siège » des éditeurs
  tombe de 21 % à 15 %.
- **Les crédits IA explosent** : +126 % d'adoption en un an ; ~29 % des éditeurs ont des
  crédits IA, +33 % prévoient d'en introduire sous 6–12 mois.
- **Outcome-based émerge** chez les leaders : HubSpot Breeze à **0,50 $/conversation résolue**
  et **1 $/lead qualifié** ; Zendesk **1,50–2 $/résolution automatique** ; Salesforce
  Agentforce **0,10 $/action** (Flex Credits) ; Sierra 150 M$ ARR en pur outcome.
- Quasiment tous les éditeurs > 50 M$ ARR ont **revu leur pricing IA début 2026**
  (Salesforce, HubSpot, Anthropic, OpenAI, SAP, Clay, Figma…).

> **Lecture pour Fretik :** commence en **hybride siège + crédits** (simple à vendre,
> prévisible), et garde l'**outcome-based en réserve** pour les agents autonomes (facturer
> « par tâche/process exécuté avec succès » quand ils arriveront — c'est là que la valeur
> est la plus lisible et la marge la plus élevée).

### 3.2 Benchmark concurrents (par utilisateur / mois)

| Produit | Positionnement | Prix d'entrée payant | Haut de gamme | Modèle |
|---|---|---|---|---|
| **Notion** | Workspace généraliste | ~10 € (Plus) | ~18 € (Business) | Per-seat + add-on IA |
| **Airtable** | Base de données / ops | ~20 $ (Team) | 45–100 $+ (Business/Ent) | Per-seat + caps records/automations |
| **Attio** | CRM moderne | 29 $ (Plus) | 69 $ (Pro) + Ent | Per-seat + caps objets/records |
| **Mistral Le Chat** | Assistant IA souverain 🇫🇷 | 19,99–24,99 € (Team) | Enterprise sur devis | Per-seat |
| **Dust.tt** 🇫🇷 | Plateforme d'agents IA | **29 €** (Pro) | Enterprise (100+) sur devis | Per-seat + usage |
| **Glean** | Work AI / search entreprise | ~45–50 $ + add-ons | 50–65 $+ , **plancher ~50 k$/an** | Per-seat opaque + support 10 % ARR |
| **HubSpot Breeze** | Agents IA | — | — | **Outcome** (0,50 $/résolution) |

**Cible de positionnement Fretik :** Fretik fait *davantage* qu'un Notion (agentique +
RAG + intégrations + extraction) et davantage qu'un CRM. Le bon **point d'ancrage** est
**Dust (29 €) / Mistral Team (25 €)** en entrée Pro, et un **Business à 49–59 €** qui reste
**sous Glean** tout en étant bien plus riche. Glean montre qu'il y a de la place au-dessus,
mais son opacité + plancher 50 k$ est un **repoussoir** pour les PME → Fretik se différencie
par la **transparence** et l'**absence de plancher** sur les tiers self-serve.

### 3.3 Le marché français (réalité, pas hype)

- **Adoption en hausse mais inégale** : 34 % des PME françaises utilisent l'IA (vs 13 %
  un an plus tôt), mais seuls **~8 % des dirigeants de TPE-PME** utilisent la genAI
  *régulièrement*. → Il faut **éduquer** et **réduire le risque à l'entrée** (Free + ROI rapide).
- **Sweet spot budgétaire** : la tranche **100–500 €/mois** est celle recommandée pour
  **70 % des PME** en 2026 (meilleur ROI perçu). → Une équipe de 5–10 personnes doit
  pouvoir entrer dans Fretik **dans cette fourchette**.
- **Souveraineté = argument commercial différenciant** : marché cloud souverain européen
  ~12,4 Md€ (+34 %/an). SecNumCloud (OVHcloud, Outscale, Scaleway, Numspot) résout en un
  achat RGPD art. 32 + transferts internationaux + « Cloud de confiance » (secteur public,
  OIV/OSE). Coût souverain ≈ +30/+50 % vs hyperscaler → **les clients régulés acceptent de
  payer plus pour la conformité**. Mistral (Forge) capitalise déjà là-dessus.
- **Marché SaaS FR** : +4,3 % en 2026, tiré par l'édition logicielle/SaaS ; 80 % des
  entreprises utiliseront du SaaS à IA générative d'ici fin 2026.

> **Lecture pour Fretik :** double cible — (a) **PME** sensibles au prix mais nombreuses,
> à capter en self-serve dans la tranche 100–500 €/mois ; (b) **organisations régulées**
> (public, santé, finance, juridique, industrie) prêtes à payer une prime pour la
> souveraineté et le BYO-endpoint. La grille doit servir les deux.

---

## 4. Le modèle de tarification recommandé (architecture)

### 4.1 Les trois métriques de valeur (value metrics)

1. **Siège (utilisateur actif)** — métrique primaire de la plateforme.
   - *Pourquoi :* la valeur collaborative (mémoire partagée, CRM, conversations multi-users,
     drive) croît avec le nombre de personnes. Prévisible, familier en B2B, ancre le contrat.
2. **Crédit IA (unité de consommation normalisée)** — métrique primaire de l'IA.
   - *Pourquoi :* aligne le prix sur le coût (OpenRouter/Mistral/E2B/Tavily varient par
     ordre de grandeur selon modèle et tâche), protège la marge, permet d'offrir des modèles
     flagship coûteux sans saigner.
   - **1 crédit = une unité abstraite** (jamais exposer les tokens au client). Mapping interne :
     un *turn* chatbot, une *extraction de document*, un *appel d'outil lourd* (Python/web),
     une *exécution d'agent* consomment X crédits selon le modèle choisi (flagship > workhorse
     > utility). Tu as déjà le coût réel par appel via **Langfuse** → table de conversion simple.
3. **Caps de « fair use »** (secondaires, anti-abus, pas des meters à facturer agressivement) :
   - **Stockage** (GB S3), **nombre d'objets CRM/documents**, **nombre de connecteurs**,
     **taille de la mémoire/contexte**. Servent à **différencier les tiers**, pas à matraquer.
   - ⚠️ **Ne fais PAS du nombre d'objets CRM ta métrique principale.** Attio/Airtable le font
     et c'est leur point de friction n°1 (les clients détestent être bloqués sur leurs propres
     données). Garde des caps **larges** par tier (ex. illimité « soft » en Business).

### 4.2 Comment ça s'assemble

```
Facture mensuelle = (Sièges × prix du tier)
                  + (Crédits IA consommés au-delà de l'allocation incluse)
                  + (Add-ons : Souverain/BYO, Agents autonomes, stockage sup., support)
```

- Chaque tier **inclut une allocation de crédits IA généreuse** (couvre l'usage normal de
  90 % des équipes → ils ne voient jamais la facture d'usage, perception « tout compris »).
- Les **10 % power users** consomment au-delà → **packs de crédits** ou **passage au tier
  supérieur**. C'est ton **expansion de revenu** naturelle (net revenue retention).
- Les **gros comptes régulés** prennent l'**add-on Souverain/BYO** → **pas de markup IA**
  (ils paient leur propre fournisseur) **mais** un **prix de licence plateforme plus élevé**.

### 4.3 Économie des crédits (marge)

- **Cible de marge brute** : viser **75–80 % blended**, avec un **plancher de 55–60 % sur
  la part IA** (les tâches flagship/agents coûtent cher). La marge logiciel (siège) est ~90 %
  et compense la marge IA plus faible.
- **Markup crédits** : vends le crédit avec **~1,8–2,2× le coût de revient IA** réel
  (OpenRouter + OCR Mistral + E2B + Tavily + embeddings/rerank). Ça paraît élevé mais ça
  couvre l'infra, le RAG, la R&D et les pics ; c'est la norme des plateformes qui revendent
  de l'inférence.
- **Garde-fou anti-bill-shock** : alerte à 80 % de l'allocation, **plafond dur configurable**
  par équipe, et **dégradation douce** (bascule auto vers modèle workhorse/utility quand
  l'allocation est dépassée, plutôt que de couper). Tu as déjà les 3 tiers de modèles pour ça.
- **Levier de marge unique à Fretik** : `team_ai_settings` permet de router les tâches
  auxiliaires (extraction, mémoire, titres, compaction) vers des modèles bon marché. Optimise
  ça en continu → ta marge s'améliore sans toucher au prix de vente.

---

## 5. Grille tarifaire détaillée (proposition)

> Prix par utilisateur / mois, **facturation annuelle**. Mensuel = +20–25 %.
> Les chiffres sont des **points de départ** à valider par tests de prix (§9.4).

### 🆓 Free — « Découverte » (acquisition / PLG)
**0 €** — jusqu'à **3 utilisateurs**, 1 équipe.
- Chatbot avec modèles **utility/workhorse** uniquement (pas de flagship).
- **Petite allocation de crédits IA/mois** (ex. de quoi traiter ~30–50 docs ou ~150 turns).
- **1–2 GB** de stockage, **caps objets** serrés, **1 connecteur** en lecture seule.
- Mémoire limitée, pas d'extraction de champs custom, pas d'écriture via intégrations.
- *Filigrane discret « Propulsé par Fretik »* facultatif.
- **But :** faire entrer les PME (qui n'utilisent pas encore la genAI), démontrer le ROI,
  semer le land-and-expand. **Pas** une version utilisable à long terme par une équipe sérieuse.

### 💼 Pro / Team — « Équipe » (cœur self-serve PME)
**~24 €/utilisateur/mois** (≈ Dust/Mistral Team).
- **Tous les modèles** dont **flagship** (avec quotas), extended thinking inclus.
- **Allocation de crédits IA confortable** (couvre l'usage quotidien d'une équipe active).
- Extraction documentaire + champs custom, CRM/entités, **mémoire d'équipe**, skills.
- **Stockage généreux** (ex. 50–100 GB/équipe), **objets en illimité soft**.
- **3–5 connecteurs** (email, calendrier, 1 CRM…) avec écriture + approbations.
- Collaboration temps réel, support email.
- **Cible :** une équipe de 5–10 → **120–240 €/mois** → pile dans le sweet spot PME 100–500 €.

### 🏢 Business — « Entreprise » (équipes exigeantes / mid-market)
**~54 €/utilisateur/mois** (sous Glean, au-dessus d'Attio Pro).
- Tout Pro **+** : **allocation de crédits ×3–4**, priorité de file (BullMQ),
  **modèles flagship sans quota strict** (fair use).
- **Connecteurs illimités**, **mémoire évènementielle / graphe de mémoire relié** (à mesure
  qu'il sort), skills avancés, vues CRM avancées.
- **Stockage important**, rétention/audit étendus, logs d'activité, webhooks.
- **SSO (SAML)**, rôles avancés (RBAC), gestion multi-équipes.
- Support prioritaire, onboarding assisté.
- **Cible :** mid-market et équipes data/ops intensives en IA.

### 🏛️ Enterprise / Souverain — « sur devis »
**À partir d'un plancher annuel** (ex. **15–25 k€/an**) + prix/siège négocié (**75 €+**).
- Tout Business **+** :
  - **Add-on Souverain / BYO-endpoint** (cf. §6) : le client branche **son propre fournisseur
    IA** (Mistral on Scaleway, OVHcloud AI Endpoints, Azure OpenAI EU, modèle self-hosted) →
    **données et inférence 100 % maîtrisées**, **pas de markup crédits** (il paie son contrat),
    **licence plateforme premium**.
  - **Agents autonomes & workflows** (triggers, DAG, process) en avant-première / inclus
    (cf. §8) — facturés en **crédits** ou **à la tâche réussie (outcome)**.
  - **Déploiement souverain** : hébergement Scaleway/OVHcloud dédié, **engagement de
    résidence des données en France/UE**, roadmap **SecNumCloud**, DPA/RGPD, **on-premise/VPC**
    en option.
  - **SLA**, support dédié, SSO/SCIM, audit avancé, RLS renforcé (déjà en place côté DB),
    contrôle des modèles autorisés par équipe.
- **Cible :** secteur public, santé, finance, juridique, industrie, grands comptes régulés.

### Récap

| | Free | Pro/Team | Business | Enterprise/Souverain |
|---|---|---|---|---|
| Prix /user/mois (annuel) | 0 € | ~24 € | ~54 € | 75 €+ (devis) |
| Utilisateurs | 3 max | illimité | illimité | illimité |
| Modèles | utility/workhorse | + flagship (quota) | flagship fair-use | + **BYO endpoint** |
| Crédits IA inclus | XS | M | XL (×3–4) | négocié / BYO sans markup |
| Connecteurs | 1 (lecture) | 3–5 | illimités | illimités + custom |
| Stockage | 1–2 GB | 50–100 GB | 500 GB+ | sur mesure |
| Mémoire/graphe | basique | équipe | **graphe relié** | + souverain |
| Agents autonomes/workflows | ❌ | ❌/limité | aperçu | ✅ (outcome/crédits) |
| SSO / RLS / audit | ❌ | ❌ | SSO | SSO/SCIM + souverain + SLA |
| Plancher annuel | — | — | — | ~15–25 k€ |

---

## 6. La souveraineté comme axe de monétisation (différenciateur clé 🇫🇷)

Tu as un **atout réel et déjà en production**, pas juste un argument marketing :
- **Stockage Scaleway Object Storage** (français/UE) déjà câblé.
- **OCR Mistral** (modèle français) déjà intégré.
- **Multi-tenant + RLS** (sécurité au niveau ligne) déjà en place.

### 6.1 Trois niveaux de souveraineté à packager (et facturer)

1. **Niveau « Données en France » (inclus dès Pro, argument de vente transverse)**
   - Stockage Scaleway FR, hébergement applicatif UE, DPA RGPD, chiffrement.
   - Argument : « Vos documents ne quittent jamais l'UE. » Gratuit à servir (déjà le cas) →
     **inclus**, mis en avant partout.
   - ⚠️ **Honnêteté** : les **modèles IA** passent par OpenRouter (US/divers). Ne prétends pas
     « 100 % souverain » par défaut — dis « **données hébergées en France ; option inférence
     souveraine disponible** ». La nuance protège ta crédibilité (et te démarque de ceux qui
     survendent).

2. **Niveau « Inférence souveraine » (option Business/Enterprise)**
   - Router **par défaut vers des modèles hébergés UE** (Mistral, modèles open-weights sur
     Scaleway/OVHcloud GPU). Faisable car `team_ai_settings` + registre de modèles existent déjà.
   - Léger surcoût crédit (GPU souverain ≈ +30/+50 %) **assumé et vendu** comme conformité.

3. **Niveau « BYO-endpoint / BYOK » (Enterprise — le vrai levier)**
   - Le client configure **son propre endpoint URL + clé** vers son fournisseur (Mistral,
     OVHcloud, Azure OpenAI EU, AWS Bedrock EU, ou modèle **self-hosted/on-prem**).
   - **Faisabilité technique** : l'archi est **prête à 80 %** — abstraction OpenRouter + 3 rôles
     de modèles + `team_ai_settings` (clés de profils par équipe). Il manque : champ
     **base URL custom + clé chiffrée par équipe**, et un **mode « provider client »** dans la
     résolution de modèle. Chantier modéré, **pas** une refonte.
   - **Comment le monétiser sans se tirer une balle dans le pied :**
     - **NE PAS** le donner gratuitement « pour faire moderne ». Le BYOK te fait perdre la
       marge sur les crédits → il doit être **compensé par une licence plateforme plus chère**.
     - Modèle : **Enterprise = licence/siège premium + plancher annuel, crédits IA à 0 markup**
       (le client paie son fournisseur en direct). Tu gagnes sur la **plateforme** (la vraie
       valeur : agentique, RAG, mémoire, intégrations, collaboration), pas sur la revente d'inférence.
     - **Bénéfice business pour toi :** tu **élimines le risque de coût IA** (pas de pic de
       conso non payé), tu **débloques les comptes régulés** qui refusent que leurs données
       transitent par un tiers, et tu transformes une **objection sécurité en argument de vente**.
   - **Bénéfice client (le pitch) :** conformité RGPD/secteur, pas de transfert hors UE,
     réutilisation de leurs contrats IA négociés, gouvernance et visibilité des coûts,
     choix du modèle. C'est exactement ce que demandent les acheteurs régulés français.

### 6.2 Roadmap souveraineté (à séquencer)
- **Court terme :** badge « Données hébergées en France 🇫🇷 » + page conformité (RGPD, DPA,
  sous-traitants, localisation). Coût ≈ 0, impact commercial immédiat.
- **Moyen terme :** option « inférence UE » (route Mistral/Scaleway par défaut).
- **Plus tard :** BYO-endpoint/BYOK (Enterprise), puis **qualification SecNumCloud** /
  hébergement dédié pour viser le **secteur public et OIV/OSE** (gros budgets, faible churn).

---

## 7. Pourquoi ce prix se justifie (le pitch de valeur)

À sortir en clientèle / sur le site. Sois **objectif** : la techno est réellement avancée,
mais l'argument qui *vend* est le **ROI**, pas la prouesse technique.

1. **« Un employé numérique, pas un chatbot. »** Fretik **exécute** : lit/écrit dans tes
   outils (email, CRM, agenda, Teams) avec garde-fou d'approbation, extrait la donnée des
   documents, interroge ta base, génère des livrables (Word/Excel/PPT). On ne vend pas des
   tokens, on vend **du travail fait**.
2. **« Il connaît votre entreprise. »** Mémoire unifiée + RAG contextuel + contexte
   persistant : l'assistant **s'améliore avec l'usage** et capitalise le savoir de l'équipe.
   → **coût de sortie élevé** (stickiness) = justifie un abonnement, pas un one-shot.
3. **« Tout-en-un. »** Remplace l'empilement chatbot + outil RAG + CRM léger + outil
   d'extraction + automatisations. **Compare le prix de Fretik à la somme des outils
   remplacés**, pas à un chatbot à 20 €.
4. **« Souverain par conception. »** Données en France, option inférence UE, BYO-endpoint.
   Argument différenciant face aux US (et même face à des concurrents FR) pour tout secteur régulé.
5. **« Collaboratif. »** Conversations multi-utilisateurs, mémoire et skills partagés : la
   valeur **croît avec l'équipe** → justifie le per-seat.
6. **ROI chiffrable :** « X heures/semaine économisées sur la saisie, la recherche
   documentaire et la rédaction. » Sur la base FR (sweet spot 100–500 €/mois pour la PME,
   ROI 3 000–15 000 % revendiqué par le marché), une équipe de 5 à ~120–240 €/mois s'amortit
   en quelques heures gagnées. **Mets une page ROI / calculateur** sur le site.

**Ce qu'il faut éviter de survendre :** ne base pas le pitch sur « on utilise les meilleurs
LLM » (ils sont à tout le monde via OpenRouter). Base-le sur **l'orchestration agentique +
la mémoire + l'intégration + la souveraineté + le collaboratif** — c'est ça, ton fossé.

---

## 8. Add-ons & expansion de revenu (où sont les grosses marges)

1. **Agents autonomes & Workflows (le futur chantier 🔴)** — quand triggers/DAG/process
   arriveront, c'est ton **upsell le plus puissant** :
   - Vendre **à la tâche/process exécuté** (outcome-based, cf. HubSpot 0,50 $/résolution,
     Zendesk 1,50–2 $) **ou** en **gros crédits** par exécution d'agent.
   - Pricing « employé numérique » assumé : un agent qui tourne 24/7 peut être facturé
     **bien plus cher qu'un siège humain** car il remplace de l'effort. C'est là que se
     justifie la sortie du per-seat pur.
2. **Packs de crédits IA** (auto-recharge) — expansion naturelle des power users.
3. **Stockage additionnel** (par tranche de GB).
4. **Connecteurs premium / custom** (intégrations métier type Shiptify, ou connecteur sur mesure).
5. **Souverain / BYO-endpoint** (cf. §6) — add-on Enterprise.
6. **Sécurité & conformité** : SSO/SCIM, audit avancé, résidence dédiée, SecNumCloud → add-ons Enterprise.
7. **Services** : onboarding, configuration de champs/skills, formation, support premium/SLA.
8. **Marketplace de skills** (plus tard) : skills premium / partagées → revenu de plateforme.

> Objectif : **NRR > 110–120 %** porté par crédits + montée en gamme + agents, pour que la
> base installée croisse même sans nouveaux logos.

---

## 9. Évolution dans le temps & plan de lancement

### 9.1 Faut-il être « pas cher au début » ?

**Non — ne casse pas le prix de liste.** Raisons :
- Un prix public bas **ancre la valeur trop bas** ; le remonter ensuite est douloureux
  (grogne, churn, signal négatif).
- Le marché IA B2B 2026 **tolère des prix élevés** quand le ROI est clair.

**Ce qu'il faut faire à la place :** réduire le **risque** d'entrée, pas le **prix** :
- **Free généreux** + **crédits offerts** au démarrage.
- **Tarif Design Partner** privé : **-40 à -50 % à vie** (« founding customers ») pour les
  **10–20 premiers** comptes, en échange de feedback, logo, témoignage. Remise **nominative
  et fermée**, jamais publique.
- **Essai Pro 14–30 jours** sans CB.
- Garantie **« remboursé si pas convaincu »** sur le premier mois.

### 9.2 Trajectoire de prix (les prix de liste montent avec la valeur)

- **Phase 0 — Beta privée / Design Partners (maintenant → lancement)**
  Produit déjà très riche (chatbot, drive, CRM, mémoire, intégrations). **Pré-requis
  monétisation : brancher Stripe + moteur de crédits/quotas** sur les tables `usage_metrics`
  existantes. Recruter 10–20 design partners (idéalement quelques comptes « souveraineté »).
  Prix : remise founding. **Objectif : preuves de ROI + cas d'usage + ajustement value metric.**
- **Phase 1 — Lancement public (grille du §5)**
  Free + Pro 24 € + Business 54 € + Enterprise devis. Self-serve pour Free/Pro, sales-assisted
  pour Business/Enterprise. Page conformité « Données en France ».
- **Phase 2 — Land & expand (3–9 mois après)**
  Pousser crédits/packs, montée Pro→Business, option **inférence souveraine UE**. Mesurer
  marge IA réelle et **ajuster le markup crédits**. Premiers add-ons.
- **Phase 3 — Agents autonomes & souveraineté avancée (chantier 🔴 livré)**
  Sortie workflows/triggers/DAG → **nouvel étage de prix outcome/agents** + **BYO-endpoint**
  Enterprise + roadmap **SecNumCloud**. **C'est ici qu'on augmente le prix de liste** (les
  nouveaux entrants paient plus ; les anciens sont grandfathered un temps = fidélité).

### 9.3 Go-to-market (axes)

- **PLG bottom-up** sur Free/Pro pour les PME (self-serve, contenu, ROI calculator, SEO
  « assistant IA RGPD / souverain / français »).
- **Sales top-down** sur Business/Enterprise, **angle souveraineté** pour secteur public,
  santé, finance, juridique, industrie (cycles longs mais gros tickets, faible churn).
- **Co-marketing souveraineté** : s'appuyer sur l'écosystème FR (Scaleway, Mistral, OVHcloud)
  et le narratif « cloud de confiance ».
- **Partenaires/intégrateurs** : revendeurs et ESN qui déploient chez leurs clients PME.

### 9.4 Comment fixer/valider les chiffres (ne pas deviner)

- **Van Westendorp** (Price Sensitivity Meter) + entretiens sur 20–30 prospects FR.
- **Mesurer la marge IA réelle** via Langfuse sur la beta (coût/turn, coût/doc, coût/agent)
  **avant** de figer le mapping crédits.
- **A/B sur la page pricing** (ancrage, nb de tiers, crédits inclus).
- **Suivre :** taux Free→Pro, ARPA, marge brute blended + part IA, NRR, taux d'usage des
  crédits (sur/sous-consommation), churn par tier.

---

## 10. Risques & anti-patterns à éviter

- **Bill-shock IA** : un client qui prend une grosse facture d'usage churne et parle.
  → allocations généreuses, alertes, plafond dur, dégradation douce (déjà outillable via les
  3 tiers de modèles).
- **Cap d'objets CRM trop serré** : friction n°1 d'Attio/Airtable. → caps larges, l'objet
  CRM n'est PAS la métrique de facturation principale.
- **Survendre « 100 % souverain »** alors que l'inférence passe par OpenRouter par défaut.
  → message honnête « données FR + option inférence souveraine » ; crédibilité = actif.
- **Trop de tiers / grille illisible** : garder **4 lignes** max (Free/Pro/Business/Enterprise).
- **Brader le prix public** pour acquérir → préférer Free + remises founding nominatives.
- **Donner le BYOK gratuitement** → toujours compensé par une licence plateforme premium.
- **Lancer la monétisation sans moteur de crédits/quotas + Stripe** : c'est le **bloquant
  technique n°1**. Les tables `usage_metrics`/`team_ai_settings` existent, mais le moteur de
  facturation et l'enforcement des quotas restent à construire.

---

## 11. Prochaines étapes concrètes

1. **Valider la value metric** (siège + crédits) et le mapping crédits sur données réelles de
   la beta (Langfuse).
2. **Construire le moteur de monétisation** : Stripe + crédits/quotas/allocations + enforcement
   + alertes/plafonds, branché sur `usage_metrics`.
3. **Page conformité « Données en France »** + DPA + liste sous-traitants (quick win commercial).
4. **Spécifier le BYO-endpoint** (base URL + clé chiffrée par équipe + mode provider client)
   pour l'offre Souverain Enterprise.
5. **Recruter 10–20 design partners** (dont 2–3 « souveraineté ») au tarif founding.
6. **Tests de prix** (Van Westendorp + entretiens) avant de figer la grille publique.
7. **Page pricing** transparente (différenciation vs Glean opaque) : Free / 24 € / 54 € / devis.

---

*Benchmarks et sources : voir le message d'accompagnement (Outrunly, GetMonetizely,
GrowthUnhinged, Gartner via Flexera/SoftwareSeni, Dust, Glean/CheckThat, Attio/MarketBetter,
Notion/Airtable/CompareTiers, Mistral, HubSpot/SaaStr/CMSWire, Kinde/GitHub BYOK,
Legiscope SecNumCloud, mission-open-data budget IA PME, Polara/BeaBoss marché FR).*
