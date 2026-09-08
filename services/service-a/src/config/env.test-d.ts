import type { EnvProblem, EnvVariable, ServiceEnv } from './env';

import { expectTypeOf } from 'vitest';

import { EnvironmentError, loadServiceEnv, SERVICE_ENV_VARIABLES } from './env';

/**
 * Type-level cases for the service environment. These are read by
 * `bun run check-types`, not by `bun run test`: the leaf tsconfig excludes
 * `*.test.ts` and does not exclude this file's suffix, and vitest never
 * executes it.
 *
 * The claim they own is the one `env.test.ts` cannot make. `PORT` arrives from
 * the environment as a string and the schema converts it, so a caller writing
 * `port + 1` or handing it to `app.listen` depends on a conversion that is
 * invisible at runtime — `expect(port).toBe(4001)` passes against the string
 * `'4001'` under `toEqual`'s coercion-free comparison only because the runtime
 * suite happens to compare against a number literal. Drop the conversion and
 * the failure surfaces here first, naming the field.
 */

/**
 * Pinned literally rather than against `z.infer<typeof serviceEnvSchema>`,
 * which would compare the type against the thing it is derived from and stay
 * green through any rename.
 */
expectTypeOf<ServiceEnv>().toEqualTypeOf<{
  databaseUrl: string;
  port: number;
  contractVersion: string;
}>();

/** The loader hands back the parsed settings, never the raw strings it read. */
expectTypeOf(loadServiceEnv).returns.toEqualTypeOf<ServiceEnv>();

/**
 * `process.env` is the production argument, so it has to be assignable to the
 * parameter. Its index signature is `string | undefined`, which is why the
 * parameter is spelled that way rather than `Record<string, string>`.
 */
expectTypeOf(loadServiceEnv).parameter(0)
  .toEqualTypeOf<Record<string, string | undefined> | undefined>();
expectTypeOf(process.env).toMatchObjectType<Record<string, string | undefined>>();

/**
 * `reason` is a closed union: a caller branching on it gets an exhaustiveness
 * check from tsc rather than a `string` comparison that silently never matches.
 */
expectTypeOf<EnvProblem['reason']>().toEqualTypeOf<'missing' | 'invalid'>();

/** Every field of a problem is renderable text, and none of them is the value read. */
expectTypeOf<EnvProblem>().toEqualTypeOf<{
  readonly variable: string;
  readonly reason: 'missing' | 'invalid';
  readonly detail: string;
  readonly message: string;
}>();

/** The problems travel with the error, so a caller need not re-parse its message. */
expectTypeOf<EnvironmentError['problems']>().toEqualTypeOf<readonly EnvProblem[]>();
expectTypeOf(new EnvironmentError([])).toExtend<Error>();

/** The declared variables are data a later task can iterate, not a doc comment. */
expectTypeOf<typeof SERVICE_ENV_VARIABLES>().toEqualTypeOf<readonly EnvVariable[]>();
expectTypeOf<EnvVariable>().toEqualTypeOf<{
  readonly name: string;
  readonly expectation: string;
  readonly carriesCredentials: boolean;
}>();
