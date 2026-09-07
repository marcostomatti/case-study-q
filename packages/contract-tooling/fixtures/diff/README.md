# Breaking-change diff fixtures

Test data for `../../src/diff.ts`, gate 3 of the four blocking gates in spec
section 8. `oasdiff breaking` exits 0 whether or not it found anything, so a
diff gate that reads the exit code and a diff gate that works look identical
from the outside. These fixtures are what tell them apart.

Every file here is a revision of one baseline, `base.yaml`, and the edit
between them is the whole content of the case.

## Layout and naming

| Path | What it must do when diffed against `base.yaml` |
| --- | --- |
| `breaking/<change-id>.yaml` | report `<change-id>` and no other change id |
| `not-breaking/<what-changed>.yaml` | report nothing, while still differing |

`<change-id>` is an oasdiff check id, listable with `oasdiff checks changelog`.
The expected id is the filename up to its first `.`, matching the convention
`../violations/` uses for house rule codes, so the suite derives its
expectations instead of carrying a table that drifts as cases are added.

The "while still differing" clause is load-bearing and is asserted separately.
A revision identical to the baseline reports nothing for a reason that has
nothing to do with the gate, and it would pass its own case in silence.

## `base.yaml` satisfies the house ruleset too

Deliberately, and it is not decoration: the gate runner composes lint before
diff, so a baseline that failed `../../rulesets/house.spectral.yaml` would stop
a composed run before the diff gate was ever reached — and the diff gate would
then read as passing. Every revision here is house-clean for the same reason.

`../../src/gates.integration.test.ts` is that composed run. It publishes
`base.yaml` as `openapi/published/1.0.0.json` in a scratch contract package,
because `latestPublishedSpec` recognises `<major>.<minor>.<patch>.json` only —
a published baseline is the emitted JSON document, not a YAML fixture. It
converts this file rather than copying it under a `.json` name, so anything
written here has to survive a YAML-to-JSON round trip.

## What oasdiff actually treats as breaking

Two asymmetries decide which edits are in which directory. Both are easy to get
backwards, and getting either backwards produces a fixture that never fires:

- **Only a required response property counts as removed.** Dropping an optional
  one is not breaking — a consumer could never rely on it being present. So
  `not-breaking/optional-response-property-removed.yaml` exists to stop "the
  diff gate catches removals" from being read as the general claim it is not.
- **Narrowing is breaking in the request direction only.** Tightening
  `minorUnits` from `number` to `integer` on a response is reported as nothing,
  because the provider is promising less variety, not accepting less. The same
  edit on a request body shrinks what the provider accepts and rejects a
  consumer already sending `1000.50`, so that is where the narrowing fixture
  makes its edit.

## Running them by hand

`oasdiff` is a documented prerequisite and is not vendored here. From the repo
root, with `oasdiff` on `PATH`:

```sh
oasdiff breaking \
  packages/contract-tooling/fixtures/diff/base.yaml \
  packages/contract-tooling/fixtures/diff/breaking/response-required-property-removed.yaml \
  -f json
```

`-f json` writes a bare array to stdout. Without `--fail-on`, the command
**exits 0 whether or not it found breaking changes**, so pass or fail has to
come from the parsed array. `--color` is rejected outright under `-f json`.

A load failure on either side — missing file, unparseable document — exits
`102` and writes a plain `Error: failed to load <side> spec from "<path>"` to
stderr. `diffSpecs` throws on all of those rather than returning them: a diff
that could not be computed must never be mistaken for a diff that found
nothing.

These are YAML on purpose, matching the house-rule fixtures next door. No lint
gate in this repo reads `.yaml`, but a fixture that cannot explain in a comment
which change it makes and why nothing else moves is not much of a fixture.
