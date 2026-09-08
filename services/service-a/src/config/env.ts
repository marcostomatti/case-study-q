/**
 * The service's environment, parsed once and refused loudly.
 *
 * Three variables decide how this process runs: the database it reads through,
 * the port it binds, and the contract version it claims to serve. Everything
 * else about `service-a` is code. Reading them straight from `process.env` at
 * each use site is how a service starts happily and fails on the first request
 * instead — `undefined` flows into a connection string, `'4001'` flows into
 * arithmetic, and the contract version reaches `api_usage` as whatever the
 * shell happened to hold.
 *
 * Zod is the tool here, deliberately and without exception. The contract this
 * service serves is authored in TypeBox because it is *published* and every
 * construct in it has to survive as JSON Schema (spec section 2.4). Nothing
 * about the environment is published, so the internal tool applies: this
 * module, request coercion after parse, and the repository-layer shapes all
 * use Zod, and none of them may leak into `@marcos-corp/contracts-service-a`.
 *
 * Four decisions worth knowing before changing anything here:
 *
 * - **No defaults, for any of the three.** A default port makes "PORT is not
 *   set" unreachable, and a default connection string is how a service ends up
 *   talking to whatever database happened to be listening — the same argument
 *   `packages/db`'s `drizzle.config.ts` makes for carrying no fallback URL.
 *   The compose stack and CI both set all three explicitly.
 * - **A blank value is read as unset.** `PORT=` in an env file hands this
 *   process an empty string, not an absent key, and an operator who wrote that
 *   line means "unset". Values are trimmed first, so a stray space around a
 *   value in an env file is not a startup failure.
 * - **The contract version is stated by the deployment, not read from the
 *   workspace.** It is what `api_usage.contract_version` records (spec section
 *   2.3), and what a consumer's pinned version is compared against. A build
 *   that shipped last week must keep reporting the version it was built from
 *   even after the source tree moves on, so reading it out of the workspace
 *   manifest at runtime would report a version this process does not serve.
 *   It is refused unless it is an exact release version, because that is the
 *   only spelling `latestPublishedSpec` will name a published baseline after.
 * - **A rejected `DATABASE_URL` is never echoed.** It carries a password, and
 *   a startup failure is the most-copied text a service ever produces. The
 *   redaction is a property of the built `EnvProblem`, not of the renderer, so
 *   a caller that logs `error.problems` as JSON is covered too.
 *
 * The failure is a throw rather than a `process.exit`, so a test can drive it
 * and the entrypoint decides what an operator sees. Nothing here runs at
 * import time: a module-level parse would make importing any part of this
 * service fail on a machine with no environment, including the suites that
 * have no business touching one.
 */
import { z } from 'zod';

/** Lowest and highest TCP port a listener may be given. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * How much of a rejected value is echoed back. Long enough to recognise a
 * typo, short enough that a variable holding a pasted file does not become the
 * whole failure.
 */
const MAX_ECHOED_LENGTH = 40;

/** Prefixes the failure, so a stack of services in one log is separable. */
const SERVICE_NAME = 'service-a';

/**
 * An exact release version — no `v` prefix, no prerelease, no leading zeros.
 * The same spelling `latestPublishedSpec` requires of a published baseline;
 * anything else names a document no contract package can hold.
 */
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * An environment as this module reads one: a variable name to its value, or
 * to nothing. `process.env` is the production instance; a suite passes a
 * literal.
 */
export type EnvSource = Record<string, string | undefined>;

/** One environment variable this service requires, and how to describe it. */
export interface EnvVariable {
  /** The name as it appears in the environment. */
  readonly name: string;
  /**
   * What the variable must hold, phrased to follow "Expected". Printed when
   * the variable is not set, which is the case where the operator has nothing
   * else to go on.
   */
  readonly expectation: string;
  /**
   * Whether the value is a secret. When it is, a rejected value is described
   * but never reproduced.
   */
  readonly carriesCredentials: boolean;
}

/**
 * The variables `loadServiceEnv` reads, in the order a failure reports them.
 *
 * Exported as data rather than described in prose: `docker/compose.yaml`, the
 * demo script and the CI job all have to set exactly this list, and a comment
 * cannot be iterated. `env.test.ts` closes the loop in both directions — every
 * entry here is individually required by the schema, and the schema requires
 * nothing that is missing from here.
 */
export const SERVICE_ENV_VARIABLES: readonly EnvVariable[] = [
  {
    name: 'DATABASE_URL',
    expectation: 'the PostgreSQL connection URL this service reads through, '
      + 'for example postgres://service_a:password@localhost:5432/service_a',
    carriesCredentials: true,
  },
  {
    name: 'PORT',
    expectation: `the TCP port the HTTP server binds, between ${MIN_PORT} and ${MAX_PORT}`,
    carriesCredentials: false,
  },
  {
    name: 'CONTRACT_VERSION',
    expectation: 'the exact version of @marcos-corp/contracts-service-a this deployment '
      + 'serves, spelled <major>.<minor>.<patch>',
    carriesCredentials: false,
  },
];

/**
 * A connection URL `pg` can act on.
 *
 * Checked by parsing rather than by pattern: the realistic mistakes are a bare
 * `host:port`, a URL for another engine, and a sentence someone pasted from a
 * runbook. A socket URL (`postgresql:///db?host=/tmp/pg`) carries no host at
 * all and has to keep working — `packages/db`'s throwaway server hands one out.
 */
function isPostgresConnectionUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}

/**
 * Every message below is written to follow the variable's name in a sentence
 * ("PORT is '80x', which must be a whole number"), so each one starts with
 * "must".
 */
const databaseUrlSchema = z
  .string()
  .refine(isPostgresConnectionUrl, 'must be a postgres:// or postgresql:// connection URL');

const portSchema = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .refine(
    (port) => port >= MIN_PORT && port <= MAX_PORT,
    `must be a TCP port between ${MIN_PORT} and ${MAX_PORT}`,
  );

const contractVersionSchema = z
  .string()
  .regex(RELEASE_VERSION, 'must be an exact release version, spelled <major>.<minor>.<patch>');

/**
 * The environment as this service reads it. Keyed on the variable names on the
 * way in and on ordinary field names on the way out, so nothing downstream
 * shouts in upper snake case or re-parses the port.
 */
export const serviceEnvSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    PORT: portSchema,
    CONTRACT_VERSION: contractVersionSchema,
  })
  .transform((raw) => ({
    databaseUrl: raw.DATABASE_URL,
    port: raw.PORT,
    contractVersion: raw.CONTRACT_VERSION,
  }));

/** The settings the rest of the service is given. */
export type ServiceEnv = z.infer<typeof serviceEnvSchema>;

/** One unusable variable, rendered and safe to log as it stands. */
export interface EnvProblem {
  readonly variable: string;
  /** `missing` covers absent and blank; `invalid` covers set but unusable. */
  readonly reason: 'missing' | 'invalid';
  /** Why it is unusable, phrased to follow the variable's name. */
  readonly detail: string;
  /** The rendered line. Carries no secret value, whatever the variable holds. */
  readonly message: string;
}

/**
 * Thrown when the environment cannot start the service.
 *
 * The message is the operator's copy — one summary line, then one line per
 * problem. `problems` is the same information as data, for a caller that would
 * rather emit structured logs than parse text.
 */
export class EnvironmentError extends Error {
  readonly problems: readonly EnvProblem[];

  constructor(problems: readonly EnvProblem[]) {
    super(renderFailure(problems));
    this.name = 'EnvironmentError';
    this.problems = problems;
  }
}

/**
 * Reads the declared variables and nothing else, trimming as it goes and
 * folding a blank value onto absent.
 */
function readDeclared(source: EnvSource): EnvSource {
  const read: EnvSource = {};
  for (const variable of SERVICE_ENV_VARIABLES) {
    const trimmed = source[variable.name]?.trim();
    read[variable.name] = trimmed === ''
      ? undefined
      : trimmed;
  }
  return read;
}

/**
 * An undeclared variable can only appear if the schema and
 * `SERVICE_ENV_VARIABLES` have drifted apart, which `env.test.ts` forbids.
 * Reporting it anyway — and treating it as a secret — is what stops that drift
 * from turning a real failure into a problem list that silently omits it.
 */
function specFor(name: string): EnvVariable {
  return SERVICE_ENV_VARIABLES.find((variable) => variable.name === name)
    ?? { name, expectation: 'a value this service declares', carriesCredentials: true };
}

/** Where a variable sorts in a report. Undeclared ones go last — see `specFor`. */
function declarationIndex(name: string): number {
  const index = SERVICE_ENV_VARIABLES.findIndex((variable) => variable.name === name);
  return index === -1
    ? Number.MAX_SAFE_INTEGER
    : index;
}

/** Keeps a rendered problem to one line, whatever the value contained. */
function forEcho(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ');
  return collapsed.length > MAX_ECHOED_LENGTH
    ? `${collapsed.slice(0, MAX_ECHOED_LENGTH)}...`
    : collapsed;
}

function buildProblem(name: string, detail: string, value: string | undefined): EnvProblem {
  const variable = specFor(name);
  if (value === undefined) {
    return {
      variable: name,
      reason: 'missing',
      detail: 'is not set',
      message: `${name} is not set. Expected ${variable.expectation}.`,
    };
  }
  const message = variable.carriesCredentials
    ? `${name} was rejected: it ${detail}. Its value is not shown because it carries credentials.`
    : `${name} is '${forEcho(value)}', which ${detail}.`;
  return { variable: name, reason: 'invalid', detail, message };
}

/**
 * One problem per variable, ordered as `SERVICE_ENV_VARIABLES` declares them
 * rather than as Zod happens to report them, and keeping only the first issue
 * per variable: an operator fixing `PORT` does not need to be told twice.
 */
function collectProblems(
  error: z.ZodError,
  read: EnvSource,
): EnvProblem[] {
  const detailByVariable = new Map<string, string>();
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? '');
    if (name !== '' && !detailByVariable.has(name)) {
      detailByVariable.set(name, issue.message);
    }
  }

  return [...detailByVariable.entries()]
    .sort(([left], [right]) => declarationIndex(left) - declarationIndex(right))
    .map(([name, detail]) => buildProblem(name, detail, read[name]));
}

function renderFailure(problems: readonly EnvProblem[]): string {
  const counted = `${problems.length} of ${SERVICE_ENV_VARIABLES.length}`;
  const summary = `${SERVICE_NAME} cannot start: ${counted} `
    + 'required environment variables are missing or invalid.';
  return [summary, ...problems.map((problem) => `  ${problem.message}`)].join('\n');
}

/**
 * Parses the environment, or throws an `EnvironmentError` naming every
 * variable that is missing or unusable.
 *
 * The source is a parameter so a suite can hand one in; production passes
 * nothing and gets `process.env`.
 */
export function loadServiceEnv(source: EnvSource = process.env): ServiceEnv {
  const read = readDeclared(source);
  const result = serviceEnvSchema.safeParse(read);
  if (result.success) {
    return result.data;
  }
  throw new EnvironmentError(collectProblems(result.error, read));
}
