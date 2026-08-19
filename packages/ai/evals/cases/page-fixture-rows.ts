/**
 * The seeded page fixture, as pure data — no imports, so the property that
 * matters can be tested without dragging in a database client.
 *
 * That property is DECORRELATION, and it is the whole reason this file is
 * separate. The first fixture indexed status by `i % 4` and owner by `i % 4`:
 * same modulus, so status, owner and team were the SAME partition. Every "To
 * do" was Ada's, every "Blocked" was Chen's, "by owner" and "by status" drew
 * the identical chart, and no generated page could demonstrate cross-analysis
 * because none existed in the data. Effort (`i % 8`) and the month (`i % 6`)
 * shared a factor with 4 and collapsed the same way — inside one status only
 * two efforts and three months ever appeared. A full eval run was scored
 * against it before anyone opened a page and saw four uniform columns.
 *
 * RULE: a fixture whose dimensions are correlated tests one dimension. The
 * periods here are chosen to be pairwise free of common factors — status 4,
 * priority 3, owner 5, team 3 stepped every fourth row (period 12), effort 13 —
 * and `page-fixture-rows.test.ts` fails if any pair collapses again.
 */

/** `group` is what makes these kanban lanes rather than four loose strings. */
export const STATUSES = [
  {
    value: "todo",
    label: "To do",
    color: "neutral",
    icon: "i-lucide-circle-dashed",
    group: "todo" as const,
  },
  {
    value: "in_progress",
    label: "In progress",
    color: "blue",
    icon: "i-lucide-loader",
    group: "in_progress" as const,
  },
  {
    value: "blocked",
    label: "Blocked",
    color: "red",
    icon: "i-lucide-octagon-alert",
    group: "in_progress" as const,
  },
  {
    value: "done",
    label: "Done",
    color: "green",
    icon: "i-lucide-check",
    group: "done" as const,
  },
];

export const PRIORITIES = [
  { value: "low", label: "Low", color: "neutral" },
  { value: "normal", label: "Normal", color: "amber" },
  { value: "high", label: "High", color: "red" },
];

export const TEAMS = [
  { value: "design", label: "Design", color: "violet" },
  { value: "engineering", label: "Engineering", color: "teal" },
  { value: "operations", label: "Operations", color: "orange" },
];

/**
 * FIVE owners, and the count is load-bearing: five is coprime with the four
 * statuses, so `i % 5` and `i % 4` cannot align. `capacity` is what makes the
 * second type worth joining to — a number the item does not carry.
 *
 * They deliberately have no team. The team belongs to the WORK and sits on the
 * item; giving owners one as well would make "group by team" ambiguous and put
 * back the correlation this fixture exists to remove.
 */
export const OWNERS = [
  { name: "Ada Okonkwo", capacity: 4 },
  { name: "Bruno Salas", capacity: 3 },
  { name: "Chen Wei", capacity: 5 },
  { name: "Dara Nilsson", capacity: 2 },
  { name: "Emil Novak", capacity: 4 },
];

export const ITEM_ROW_COUNT = 24;

/** The `sum` assertions quote this. The budget permutation preserves it. */
export const BUDGET_TOTAL = 93_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FixtureItemRow {
  title: string;
  status: string;
  priority: string;
  team: string;
  owner: string;
  effort: number;
  budget: { amount: number; currencyCode: string };
  due_at: string;
}

/**
 * Dates hang off the day the fixture is built, never off constants. Fixed dates
 * made "overdue" a function of the calendar rather than of the data: seeded
 * across H1-2026 and read in August, 18 of 24 rows were late and the 6 that
 * were not were exactly the done ones — so "overdue" became a third name for
 * "status". The offsets here straddle the seed day, a third behind it.
 */
export const itemRows = (seededAt: number): FixtureItemRow[] =>
  Array.from({ length: ITEM_ROW_COUNT }, (_, i) => ({
    title: `Eval Item ${String(i + 1).padStart(2, "0")}`,
    status: STATUSES[i % STATUSES.length]!.value,
    priority: PRIORITIES[i % PRIORITIES.length]!.value,
    team: TEAMS[Math.floor(i / STATUSES.length) % TEAMS.length]!.value,
    owner: OWNERS[i % OWNERS.length]!.name,
    effort: ((i * 7) % 13) + 1,
    // The same 24 amounts under a coprime permutation: the total the `sum`
    // assertion quotes is untouched, while the ramp that made budget a proxy
    // for the row index is gone.
    budget: {
      amount: 1000 + 250 * ((i * 7) % ITEM_ROW_COUNT),
      currencyCode: "EUR",
    },
    due_at: new Date(seededAt + (((i * 11) % ITEM_ROW_COUNT) * 7 - 56) * DAY_MS)
      .toISOString()
      .slice(0, 10),
  }));
