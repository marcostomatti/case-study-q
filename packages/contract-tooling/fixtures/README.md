# House ruleset fixtures

> The `diff/` subdirectory belongs to a different gate and has its own
> [README](diff/README.md). Everything below is about the house ruleset.

Test data for `../rulesets/house.spectral.yaml`. A ruleset that loads and
reports nothing looks exactly like a correct one, so every rule in that file is
paired here with a document that must fail on it and on no other rule, and the
whole set is paired with one document that must fail on nothing.

## Layout and naming

| Path | What it must do when linted |
| --- | --- |
| `valid/satisfies-all-rules.yaml` | report zero findings |
| `violations/<rule-code>[.<leg>].yaml` | report `<rule-code>` and no other code |

The expected rule code is the filename up to its first `.`, so a suite can
derive it rather than carry a hand-maintained table that drifts as rules are
added. `violations/house-no-null.nullable.yaml` expects `house-no-null`; the
`.nullable` segment names which leg of that rule it exercises and is not part
of the code.

Each file opens with a comment naming the rule it breaks, the `given` entry or
`then` leg it exercises, and the compliance it deliberately carries so that the
reported code set stays a single element.

## Why there are more fixtures than rules

Six rules, nine violation documents. Two properties of the ruleset make
one-fixture-per-rule insufficient, and both fail silently:

- **Every entry of a multi-path `given` needs its own hit.** A `given` entry
  that matches nothing is not an error, it is coverage that reads as present
  and is not. `house-no-typeless-schema` has a seven-entry `given`, so its
  single fixture plants one typeless schema at each of the seven positions.
- **Every entry of a `then` array needs its own violating document.** Rules 4,
  5 and 6 each carry two `then` entries, and satisfying one while breaking the
  other is the only way to attribute a finding to a specific leg. The sunset
  rule is the clearest case: vacuum's `pattern` function passes silently on an
  absent field, so a fixture that only omits `x-sunset` never exercises the
  pattern leg at all.

The satisfying document carries the mirror of this: tolerance cases for the two
rules that are easiest to write too broadly. `house-no-typeless-schema` must
not fire on an `anyOf` or `enum` schema that legitimately carries no `type`,
and `house-no-null` must not fire on `nullable: false`.

## Assert the code set, never a finding count

vacuum resolves `$ref` before running a rule, so one violation on a referenced
schema is reported twice — once at its real path, once at the resolved copy,
where vacuum cannot render a path and prints the raw filter instead. A fixture
producing two findings of one code is therefore normal. Assert the set of
distinct `code` values; an assertion of exactly one finding is flaky by
construction.

## Running them by hand

`vacuum` is a documented prerequisite and is not vendored here. From the repo
root, with `vacuum` on `PATH`:

```sh
vacuum spectral-report \
  -r packages/contract-tooling/rulesets/house.spectral.yaml \
  -o packages/contract-tooling/fixtures/valid/satisfies-all-rules.yaml
```

`spectral-report` writes a bare JSON array to stdout and **exits 0 whether or
not there are findings**, so pass or fail has to come from the parsed array
rather than from the exit code. `vacuum lint` does set an exit code but emits
no JSON.

These are YAML on purpose: no lint gate in this repo reads `.yaml`, but a
fixture that cannot explain in a comment which rule it targets and why it
targets nothing else is not much of a fixture. They are validated by vacuum
itself, through the suite in `../src/lint.test.ts`, which shells out to the
real binary rather than to a stub — a stubbed vacuum would prove that suite
parses these files, not that these rules fire on them.
