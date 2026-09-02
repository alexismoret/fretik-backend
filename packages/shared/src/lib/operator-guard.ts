import { sql } from "drizzle-orm";
import db from "../db";

/**
 * The gate every script that can write to a database passes through.
 *
 * On 2026-08-30 a `models:admin` command run from a laptop, over an SSH
 * tunnel, applied a migration to production two days before the code that
 * needed it. Nothing about that invocation looked dangerous: the URL said
 * `127.0.0.1:5434`, `NODE_ENV` said nothing useful, and the script's intent
 * was read-only. The lesson is narrow and worth stating plainly — **a
 * connection cannot be judged by where it appears to point**.
 *
 * So this guard judges two things a tunnel cannot forge:
 *
 *  1. the database's own NAME, asked of the server itself, and
 *  2. whether this process is running inside one of our containers
 *     (`FRETIK_RUNTIME=container`, set in the three Dockerfiles).
 *
 * A disposable database (`…_dev`, `…_test`, `…_ci`) needs neither ceremony nor
 * a flag. Anything else is production until proven otherwise, and reaching it
 * takes BOTH an explicit `--target=prod` and a container. A laptop with a
 * tunnel and the flag is refused, with the `docker exec` line to run instead.
 */

/**
 * Databases an operator may write to without saying so out loud.
 *
 * The marker has to be a whole word at one END of the name — `test-fretik` and
 * `fretik_test` both qualify, `fretik` does not, and neither does
 * `fretik_dev_restore`, which is a restored copy of production wearing a
 * reassuring middle name. Matching a bare substring is how a safe-list stops
 * being one.
 */
const SAFE_DB_NAME_PATTERN = /^(dev|test|ci)[-_]|[-_](dev|test|ci)$/;

export interface OperatorTarget {
  /** `dev` for a disposable database, `prod` for everything else. */
  target: "dev" | "prod";
  /** `current_database()` — what the SERVER calls itself, not the URL. */
  database: string;
}

/** What the guard decided, before anything is printed or thrown. */
export type OperatorDecision =
  | { verdict: "allow"; target: "dev" | "prod"; breakGlass: boolean }
  | {
      verdict: "refuse";
      target: "prod";
      reason: "unflagged" | "not-in-container";
    };

/**
 * The decision itself — a pure function of the database's name, the flags and
 * the environment.
 *
 * Separated from the connection so the rule can be tested for what it is: a
 * three-line policy that decides whether a command touches production. The
 * queries around it are plumbing, and plumbing is a poor place to keep a rule
 * whose failure mode is an outage.
 */
export const decideOperatorTarget = (
  database: string,
  argv: readonly string[],
  env: { runtime?: string; allowLaptopProd?: string },
): OperatorDecision => {
  if (SAFE_DB_NAME_PATTERN.test(database)) {
    return { verdict: "allow", target: "dev", breakGlass: false };
  }
  if (!argv.includes("--target=prod")) {
    return { verdict: "refuse", target: "prod", reason: "unflagged" };
  }

  const inContainer = env.runtime === "container";
  const breakGlass = env.allowLaptopProd === "1";
  if (!inContainer && !breakGlass) {
    return { verdict: "refuse", target: "prod", reason: "not-in-container" };
  }
  return { verdict: "allow", target: "prod", breakGlass: !inContainer };
};

interface ServerIdentity {
  database: string;
  host: string | null;
  port: number;
  user: string;
}

const readServerIdentity = async (): Promise<ServerIdentity> => {
  const result = await db.execute(
    sql`select current_database() as database, inet_server_addr()::text as host, inet_server_port() as port, current_user as "user"`,
  );
  const row = result.rows[0] as ServerIdentity | undefined;
  if (row === undefined) {
    throw new Error("The database answered no row for current_database()");
  }
  return row;
};

/**
 * Resolve and authorise the target of a script that can write.
 *
 * ALWAYS prints what it resolved, whatever the verdict — a script that ran
 * against the wrong database and said nothing is the failure mode this exists
 * to remove, and the line is as useful in a passing run as in a refused one.
 */
export const assertOperatorTarget = async (
  argv: readonly string[],
): Promise<OperatorTarget> => {
  const identity = await readServerIdentity();
  const decision = decideOperatorTarget(identity.database, argv, {
    runtime: process.env.FRETIK_RUNTIME,
    allowLaptopProd: process.env.FRETIK_ALLOW_LAPTOP_PROD,
  });

  console.log(
    `[target] ${decision.target} — db=${identity.database} host=${identity.host ?? "local socket"}:${identity.port.toString()} user=${identity.user}`,
  );

  if (decision.verdict === "refuse" && decision.reason === "unflagged") {
    throw new Error(
      `Refusing to run against "${identity.database}": its name is not one of the disposable ones (…_dev, …_test, …_ci), so it is treated as production. Pass --target=prod if that is what you mean.`,
    );
  }

  if (decision.verdict === "refuse") {
    throw new Error(
      [
        `Refusing to run against production from outside a container.`,
        ``,
        `A tunnel makes production look local, so --target=prod alone is not enough.`,
        `Run it where the code is deployed:`,
        ``,
        `  ssh root@<host> 'docker exec -w /app/packages/shared $(docker ps -q -f name=fretik-api -f status=running) bun run <script> -- --target=prod'`,
        ``,
        `If you genuinely need to run it from here, set FRETIK_ALLOW_LAPTOP_PROD=1.`,
      ].join("\n"),
    );
  }

  if (decision.breakGlass) {
    console.warn(
      `[target] BREAK-GLASS: writing to production "${identity.database}" from outside a container.`,
    );
  }

  return { target: decision.target, database: identity.database };
};
