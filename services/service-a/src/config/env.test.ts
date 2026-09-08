/**
 * Runtime suite for `env.ts`.
 *
 * It owns the behaviour: which environments are accepted, which are refused,
 * how a refusal reads, and what never reaches the rendered text. The
 * type-level claims — that `port` arrives as a `number` and not the string it
 * was read from — belong to `env.test-d.ts`, because a leaf tsconfig here
 * excludes `*.test.ts` from `check-types` and does not exclude `*.test-d.ts`.
 *
 * Every refusal case varies exactly one variable away from `VALID_ENV` and
 * asserts the *set* of variables reported. A case that only asserted "it
 * threw" would pass just as well against a loader that refuses everything.
 */
import type { EnvSource } from './env';

import { describe, expect, it } from 'vitest';

import { EnvironmentError, loadServiceEnv, SERVICE_ENV_VARIABLES } from './env';

/**
 * The password is real-looking on purpose: the redaction cases below search
 * the rendered failure for it, and a placeholder like `password` would also
 * match ordinary prose.
 */
const SECRET_PASSWORD = 'h0rse-battery-staple';

const VALID_ENV: EnvSource = {
  DATABASE_URL: `postgres://service_a:${SECRET_PASSWORD}@db.internal:5432/service_a`,
  PORT: '4001',
  CONTRACT_VERSION: '0.1.0',
};

/** `VALID_ENV` with one variable overridden, or removed when given `undefined`. */
function envWith(overrides: EnvSource): EnvSource {
  return { ...VALID_ENV, ...overrides };
}

/**
 * Drives a refusal and hands back the error.
 *
 * The final throw is what stops a case from passing vacuously: without it, a
 * `loadServiceEnv` that quietly accepted the environment would leave the
 * assertions after it unreached and the case green.
 */
function refuse(source: EnvSource): EnvironmentError {
  try {
    loadServiceEnv(source);
  } catch (err) {
    if (err instanceof EnvironmentError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected loadServiceEnv to refuse this environment, but it returned a value');
}

function reportedVariables(error: EnvironmentError): string[] {
  return error.problems.map((problem) => problem.variable);
}

describe('loadServiceEnv, given a complete environment', () => {
  it('returns the three settings the service runs on, with the port as a number', () => {
    expect(loadServiceEnv(VALID_ENV)).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      port: 4001,
      contractVersion: '0.1.0',
    });
  });

  it('ignores variables the service does not declare', () => {
    const noisy = envWith({ HOME: '/home/nobody', PATH: '/usr/bin', SHLVL: '2' });

    expect(loadServiceEnv(noisy)).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      port: 4001,
      contractVersion: '0.1.0',
    });
  });

  it('accepts a unix-socket connection URL, which carries no host', () => {
    const socket = envWith({ DATABASE_URL: 'postgresql:///service_a?host=/tmp/pg' });

    expect(loadServiceEnv(socket).databaseUrl).toBe('postgresql:///service_a?host=/tmp/pg');
  });

  it('trims surrounding whitespace, which an env file is free to carry', () => {
    const padded = envWith({ PORT: '  4001  ', CONTRACT_VERSION: ' 0.1.0\n' });

    expect(loadServiceEnv(padded)).toEqual({
      databaseUrl: VALID_ENV.DATABASE_URL,
      port: 4001,
      contractVersion: '0.1.0',
    });
  });

  it('reads process.env when no source is given', () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, VALID_ENV);
      expect(loadServiceEnv()).toEqual({
        databaseUrl: VALID_ENV.DATABASE_URL,
        port: 4001,
        contractVersion: '0.1.0',
      });
    } finally {
      for (const name of Object.keys(VALID_ENV)) {
        delete process.env[name];
      }
      Object.assign(process.env, before);
    }
  });
});

describe('loadServiceEnv, given a variable that is not set', () => {
  it('names every variable that is missing, and only those', () => {
    const error = refuse({});

    expect(reportedVariables(error)).toEqual(['DATABASE_URL', 'PORT', 'CONTRACT_VERSION']);
    expect(error.problems.every((problem) => problem.reason === 'missing')).toBe(true);
  });

  it('says the variable is not set and what it should hold', () => {
    const error = refuse(envWith({ DATABASE_URL: undefined }));

    expect(reportedVariables(error)).toEqual(['DATABASE_URL']);
    expect(error.message).toContain('DATABASE_URL is not set.');
    expect(error.message).toContain('postgres://');
  });

  it('reads a blank value as not set, because that is what an empty compose entry produces', () => {
    const error = refuse(envWith({ PORT: '   ' }));

    expect(reportedVariables(error)).toEqual(['PORT']);
    expect(error.problems[0]?.reason).toBe('missing');
    expect(error.message).toContain('PORT is not set.');
  });
});

describe('loadServiceEnv, given a variable that is set to something unusable', () => {
  it('refuses a port that is not a whole number, and echoes what it read', () => {
    const typo = '80x';
    const error = refuse(envWith({ PORT: typo }));

    expect(reportedVariables(error)).toEqual(['PORT']);
    expect(error.problems[0]?.reason).toBe('invalid');
    expect(error.message).toContain(`PORT is '${typo}'`);
  });

  it.each(['0', '65536', '-1'])('refuses the out-of-range port %s', (port) => {
    const error = refuse(envWith({ PORT: port }));

    expect(reportedVariables(error)).toEqual(['PORT']);
    expect(error.problems[0]?.reason).toBe('invalid');
  });

  it.each([
    ['a bare host and port', 'db.internal:5432'],
    ['another database engine', 'mysql://service_a@db.internal:3306/service_a'],
    ['prose', 'ask the platform team'],
  ])('refuses a database URL that is %s', (_label, url) => {
    const error = refuse(envWith({ DATABASE_URL: url }));

    expect(reportedVariables(error)).toEqual(['DATABASE_URL']);
    expect(error.problems[0]?.reason).toBe('invalid');
  });

  it.each(['1.0.0-rc.1', 'v1.0.0', '1.0', 'latest', '01.0.0'])(
    'refuses the contract version %s, which no published baseline can be named after',
    (version) => {
      const error = refuse(envWith({ CONTRACT_VERSION: version }));

      expect(reportedVariables(error)).toEqual(['CONTRACT_VERSION']);
      expect(error.problems[0]?.reason).toBe('invalid');
    },
  );

  it('keeps a value carrying newlines on one line, so the report stays readable', () => {
    const collapsed = 'eighty eighty eighty';
    const error = refuse(envWith({ PORT: collapsed.replace(/ /g, '\n') }));

    expect(error.message.split('\n')).toHaveLength(2);
    expect(error.message).toContain(`PORT is '${collapsed}'`);
  });

  it('truncates a long value rather than pasting it into the failure', () => {
    const error = refuse(envWith({ PORT: '9'.repeat(400) }));

    expect(error.message).toContain('...');
    expect(error.message.length).toBeLessThan(400);
  });
});

describe('the refusal loadServiceEnv throws', () => {
  it('names the service and counts the problems in its first line', () => {
    const error = refuse(envWith({ PORT: undefined, CONTRACT_VERSION: 'v9' }));
    const [summary] = error.message.split('\n');

    expect(summary).toBe(
      'service-a cannot start: 2 of 3 required environment variables are missing or invalid.',
    );
  });

  it('reports every bad variable in one throw, not just the first', () => {
    const error = refuse({
      DATABASE_URL: 'mysql://x@y/z',
      PORT: 'eighty',
      CONTRACT_VERSION: undefined,
    });

    expect(reportedVariables(error)).toEqual(['DATABASE_URL', 'PORT', 'CONTRACT_VERSION']);
    expect(error.message.split('\n')).toHaveLength(4);
  });

  it('renders one line per problem, each naming its own variable', () => {
    const error = refuse({});
    const lines = error.message.split('\n')
      .slice(1);

    for (const [index, problem] of error.problems.entries()) {
      expect(lines[index]).toContain(problem.variable);
      expect(lines[index]).toBe(`  ${problem.message}`);
    }
  });

  it('never renders the database password, in the message or in the problems', () => {
    // Wrong scheme, right credentials: the value is refused and still carries
    // everything a leak would expose.
    const leaky = `mysql://service_a:${SECRET_PASSWORD}@db.internal:3306/service_a`;
    const error = refuse(envWith({ DATABASE_URL: leaky }));

    // Re-read the rendered output with a second reader rather than trusting
    // the renderer's own account of what it redacted.
    expect(error.message).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(error.problems)).not.toContain(SECRET_PASSWORD);
    expect(reportedVariables(error)).toEqual(['DATABASE_URL']);
    expect(error.message).toContain('DATABASE_URL');
  });

  it('carries the problems as data, so a caller can report them its own way', () => {
    const error = refuse(envWith({ PORT: 'eighty' }));

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EnvironmentError');
    expect(error.problems).toEqual([
      {
        variable: 'PORT',
        reason: 'invalid',
        detail: expect.stringContaining('must be'),
        message: expect.stringContaining('PORT'),
      },
    ]);
  });
});

describe('SERVICE_ENV_VARIABLES', () => {
  it('declares exactly the variables the schema requires, in the order they are reported', () => {
    const declared = SERVICE_ENV_VARIABLES.map((variable) => variable.name);

    expect(declared).toEqual(reportedVariables(refuse({})));
  });

  it('makes every declared variable individually required', () => {
    for (const variable of SERVICE_ENV_VARIABLES) {
      const error = refuse(envWith({ [variable.name]: undefined }));

      expect(reportedVariables(error)).toEqual([variable.name]);
    }
  });

  it('marks only the connection URL as carrying credentials', () => {
    const secret = SERVICE_ENV_VARIABLES.filter((variable) => variable.carriesCredentials);

    expect(secret.map((variable) => variable.name)).toEqual(['DATABASE_URL']);
  });

  it('gives every variable an expectation the failure can print', () => {
    for (const variable of SERVICE_ENV_VARIABLES) {
      expect(variable.expectation.length).toBeGreaterThan(0);
      expect(refuse(envWith({ [variable.name]: undefined }))
        .message).toContain(variable.expectation);
    }
  });
});
