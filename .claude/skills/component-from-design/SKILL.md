---
name: component-from-design
description: Use when implementing any component in this library from a design source — the bundle catalog page staged at design/bundle/ (rosetta-stone spec loop), the inline-styled design pages under design/pages/ (auth, topbar, whole-app screens), or a prose spec (the component's spec doc, when present — e.g. docs/specs/UI-<Name>.md). Turns the source into a verifiable atom/molecule/organism with CVA variants, a Storybook story per variant, a side-by-side screenshot comparison where a design artboard exists, and visual regression baselines.
---

> Scope: file paths in this document are relative to `packages/ui/` (the `@marcos-corp/ui` package), except `.claude/`, `.plans/`, and `.specs/`, which live at the umbrella repo root.

# Component implementation workflow (rosetta stone)

## Overview

Design references live under [design/](../../../design/) — the design side of the rosetta comparator (see `design/README.md` for the per-mode file contract). The bundle catalog at `design/bundle/` is a frozen design handoff: real CVA-shaped specs for every primitive, each rendered live on the page. Every component we ship traces back to one of these sources or a spec doc.

The job is **never** to invent — it's to translate a spec that already exists into a typed React component, and to **prove the translation is 1:1** with screenshots before locking it in as a visual baseline. Two verification layers exist:

- **Compare** (`scripts/compare-design.mjs`) — our story next to the design source's live demo. Correctness of the *translation*.
- **Visual regression** (`bun run test:visual`) — every story × light/dark against this machine's baselines. Protection against *future drift*. Baselines are untracked and per-environment; CI keeps its own set.

## When to use

Three source situations, one skill. Identify which one you're in first — it
decides the READ step and the fidelity check; everything from PLACE onward is
identical.

1. **Bundle spec** (the original rosetta loop below) — the component has a
   spec object in the bundle catalog (`design/bundle/index.html` plus the
   chapter sources staged next to it).
2. **Design-page JSX** — the component exists only as an unmigrated screen or
   widget in a page under `design/pages/` (auth screens, the topbar showcase,
   whole-app dashboard-style pages). See
   [Design-page JSX sources](#design-page-jsx-sources-topbar--dashboard--adapted-loop).
3. **Spec-driven** — no artboard anywhere; the component is specced in prose
   in its spec doc, when present (e.g. `docs/specs/UI-<Name>.md`).
   See [Spec-driven components](#spec-driven-components-no-design-artboard).

Also applies when refactoring incoming JSX into the TSX library (see
also: `JSX to TSX` notes in [AGENTS.md](../../../AGENTS.md)).

**Do not** use this for components with none of the three sources — those
need a brainstorming/design pass first.

## Reading a bundle spec

The bundle's chapter sources (the JSX files staged next to `design/bundle/index.html`) define spec objects with:

| Field | What it is | How to treat it |
|-------|-----------|-----------------|
| `variants` / `defaultVariants` | the variant axes + defaults | **the contract** — copy names, values, class strings verbatim |
| `source` | the real CVA string the designer wrote | mirror it in `<Name>.variants.ts` |
| `demo(state)` | the live rendering with inline styles | **rendered truth** — when `source` and `demo` disagree (a missing text token, a shadow the demo drops), the demo wins; note the reconciliation in a comment (see `Button.variants.ts`) |
| `flags` | boolean behaviors outside CVA | map to typed props (e.g. `icon` → `iconLeading` slot, `asButton` → `asChild`) |
| `usage(state)` | the intended call-site API | the shape of your props |
| `blurb` / `role` | intent + box role | docs; the role overlays in the HTML are a **human legend — never migrate them, never let them into screenshots** |

## The loop

```
┌── For every component ──────────────────────────────────────────────────────┐
│ 1. READ      the bundle spec object (fields above). Also skim demo()       │
│              for what source alone doesn't encode.                         │
│ 2. PLACE     decide the atomic level. Atoms → src/atoms/, composed         │
│              templates → src/molecules/, page chrome → organisms.          │
│ 3. WRITE     <Name>.variants.ts → cva() literally mirroring the spec's     │
│              `source` block. Variant keys + class strings verbatim.        │
│ 4. WRITE     <Name>.tsx → typed props (extends VariantProps<...>), Radix   │
│              when behavior calls for it (Slot for asChild, Dialog for      │
│              Overlay, etc.). NO inline styling, NO arbitrary className     │
│              from callers driving visuals — all chrome via variants.       │
│ 5. WRITE     <Name>.stories.tsx → one story per variant value + each       │
│              flag combination that matters. Stories are pure docs — no     │
│              assertions, and NEVER `import ... from 'vitest'` (it breaks   │
│              the preview). Make the canonical story's children mirror      │
│              the spec demo's filler so step 7 compares like with like.     │
│ 6. WRITE     index.ts barrel: re-export component, props type, cva, and    │
│              variants type. Add to parent src/<level>/index.ts.            │
│ 7. COMPARE   bun run build:storybook                                       │
│              node scripts/compare-design.mjs <story-id> <SpecName>         │
│              [--theme dark] [--set variant=<value>]                        │
│              Open both PNGs in visual/__compare__/ and eyeball: fill,      │
│              border, radius, type, spacing, icon treatment. Fix via        │
│              variants until they match. Repeat for non-default variants    │
│              that have any visual doubt.                                   │
│ 8. VERIFY    bun run check-types       # types                             │
│              bun run test              # 1 smoke test per story            │
│              bun run test:visual:update  # write baselines for new stories │
│              bun run test:visual       # deterministic re-run, green       │
│              bun run check:stories     # preview renders error-free        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File layout

Per AGENTS.md, every component is a folder:

```
src/atoms/Button/
├── index.ts                   barrel exporter
├── Button.tsx                 component definition
├── Button.variants.ts         CVA variants definition
└── Button.stories.tsx         Storybook stories
```

No `__snapshots__/` — DOM snapshots are banned. Visual baselines live in the untracked `/visual/__image_snapshots__/` (this machine's set) and are never committed.

Molecules and above may colocate smaller atoms that are only used inside the parent (e.g. `Table/TableRow.tsx`) — keep variants and stories on the parent only, do not re-story the internals.

## CVA conventions

Mirror the design source's `source` field as closely as possible. Three rules:

1. **Variant names match the source.** If the spec says `variant`, don't rename it `kind`. The spec is the contract.
2. **Defaults match the source.** `defaultVariants` carries semantic meaning — keep them.
3. **Class strings stay Tailwind-only.** No inline style props from the variants object. If a variant needs a custom value, extend the `@theme` contract in `src/styles/theme.css` so the utility exists.

When `source` and `demo()` disagree, encode the demo's rendered truth and leave a comment naming the delta (see the header of `Button.variants.ts` for the pattern).

```ts
// Button.variants.ts — verbatim shape from the design source
export const button = cva(
  ['inline-flex items-center justify-center gap-2', /* … */],
  {
    variants: {
      variant: { primary: 'bg-primary text-on-primary', /* … */ },
      size: { sm: 'h-8 px-3 text-sm', md: 'h-9 px-4 text-sm', lg: 'h-11 px-5 text-base' },
      block: { false: 'w-auto', true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export type ButtonVariants = VariantProps<typeof button>;
```

Compose with `cn()` from `src/lib` (handles `tailwind-merge`):

```tsx
className={cn(
  touchable({ rounded: 'md', stretch: block }),  // behavior layer
  button({ variant, size, block }),               // styling layer
  className,                                      // caller override (last)
)}
```

## Component conventions

- Use `forwardRef` for any DOM-backed component.
- Type props as `Omit<ButtonHTMLAttributes<...>, 'type'> & VariantProps` (or the right HTML element). Don't accept arbitrary `style` props.
- Always set `displayName`.
- For behavioral primitives (Touchable, Overlay, Menu), provide `asChild` via `@radix-ui/react-slot` so consumers can compose without an extra wrapper.

## Story conventions

- File header: `import type { Meta, StoryObj } from '@storybook/react-vite';`
- `title: 'Atoms/Button'` (mirrors atomic level + name).
- `parameters.layout` is `'centered'` for atoms, `'padded'` for full-width.
- Add `tags: ['autodocs']` so an args table is generated.
- One story per meaningful variant value. Don't write one story per state — use the args panel for that.
- Stories carry **no assertions and no `vitest` imports** — importing `vitest` in a story file crashes the Storybook preview (duplicate `@vitest/expect` global state → `customEqualityTesters` TypeError). Every story is screenshotted in light + dark by the visual suite; add a `play()` (importing from `storybook/test` only) solely for genuine interaction assertions.
- The canonical story's children should mirror the design demo's filler content (same icon, label, surface treatment) so `compare-design.mjs` compares like with like.

## Verification

```bash
bun run check-types        # types
bun run test               # smoke: 1 test per story (addon-vitest, native)
bun run test:visual        # screenshot diff vs this machine's baselines
bun run check:stories      # every story renders error-free in the preview
bun run build:storybook    # full Storybook build
```

If `bun run test:visual` fails on a screenshot:
- **Intentional change** → `bun run test:visual:update` regenerates this machine's baselines. CI refreshes its own set automatically when the change merges to `main`.
- **Regression** → fix the component, not the baseline.

## Side-by-side review

`scripts/compare-design.mjs` automates the old manual eyeballing:

```bash
bun run build:storybook
node scripts/compare-design.mjs atoms-button--primary Button
node scripts/compare-design.mjs atoms-button--secondary Button --set variant=secondary
node scripts/compare-design.mjs atoms-button--primary Button --theme dark
```

Output: `visual/__compare__/<story-id>--{ours,design}.png`. The design side captures only the spec's live demo box (`#prim-<SpecName>`), so the bundle page's role-overlay decorations never appear. The ours capture applies the bundle's hatched backdrop so transparent surfaces and edges read identically on both sides — the hatch is comparator-only doc chrome and must never appear in stories or baselines. For interactive states (hover/focus) or specs without a `#prim-` anchor, fall back to `bun run storybook` next to opening `design/bundle/index.html` manually (serve the directory, e.g. `bunx serve design/bundle`).

## Design-page JSX sources (topbar + dashboard) — adapted loop

The unmigrated screens live under `design/pages/` as inline-styled JSX
compiled in-browser by Babel standalone: page shells (`topbar.html` and
whole-app pages like `usage.html`, `agents.html`, …) that load JSX sources
staged next to them. These are **richer than bundle specs** — full working
widgets, not spec objects — but carry **no CVA `source` blocks**: the inline
`style={{ … }}` objects are the spec. `design/` is read-only reference;
never edit it to fit the component.

The loop's READ and COMPARE steps adapt; PLACE→VERIFY are unchanged:

1. **LOCATE** — find the function component in the page's JSX sources.
   Components resolve shared pieces from `window` (each file ends in
   `Object.assign(window, …)`), so a widget may render helpers from the
   page's shared/primitives modules — read those too before concluding
   what draws what.
2. **EXTRACT** — translate the inline style objects into visual intent. Raw
   CSS vars map to our theme tokens (`var(--surface-1)` → `bg-surface-1`,
   `var(--fg3)` → `text-fg3`, `var(--radius-lg)` → `rounded-lg`,
   `var(--font-mono)` → `font-mono`, …); px values become the closest
   Tailwind utility or an arbitrary value when the token doesn't exist.
3. **MAP to CVA** — the page JSX has no variant axes; derive them from the
   call sites: prop differences across usages (`danger`, `verbose`,
   `density`, size numbers) become variant axes, one-off inline conditionals
   become flags. Where the design page and the component's spec doc diverge,
   **the spec wins** — note the delta in the variants-file header comment.
4. **COMPARE** — `compare-design.mjs` has two design-page sources beyond
   `--source auth`:

   ```bash
   # topbar widgets: captures one showcase card's demo box by its title —
   # the exact card title string in design/pages/topbar.html (mind the
   # middots, e.g. "Search · suggest", "Workspace switcher", "Notifications")
   node scripts/compare-design.mjs organisms-searchsuggest--default "Search · suggest" --source topbar

   # whole-app screens: SpecName is the page file under design/pages/;
   # full-page capture by default, --selector to crop a region
   node scripts/compare-design.mjs pages-usage--default usage.html --source dashboard
   node scripts/compare-design.mjs molecules-usagechart--default usage.html --source dashboard --selector "main section:nth-of-type(2)"
   ```

   Both need network access (the pages load React UMD + Babel from a CDN)
   and tolerate the long in-browser compile (60s waits). Whole-app pages
   have no ids or classes on their markup — find a structural `--selector`
   via devtools, or fall back to manual side-by-side: `bun run storybook`
   next to opening `design/pages/<page>.html` served locally
   (`bunx serve design/pages`), same theme both sides, and eyeball
   fill/border/radius/type/spacing exactly as in step 7.

The auth screens follow this same shape with `--source auth`
(artboard-per-screen, so the capture story is cleaner there).

## Spec-driven components (no design artboard)

Some components exist only as prose specs — the component's spec doc, when
present (e.g. `docs/specs/UI-<Name>.md`; the Icon, StatusIndicator,
TrendIndicator, Formatted* family, and Modal `footerStatus` slot were all
built this way). There is no design side to screenshot, so step 7 (COMPARE)
is replaced by a spec-checklist pass; everything else in the loop is
unchanged. The verification path:

1. **Spec checklist in the stories.** Each story's JSDoc description names
   the spec clause it demonstrates ("spec: ratio mode requires…"). The
   stories file is the living checklist — a reviewer must be able to read
   spec + stories side by side and tick every specced variant/state off.
2. **A story per specced variant/state.** Not one per prop combination —
   one per *clause of the spec*. If the spec says "ratio or raw", both get
   a story. If it names a default ("precision defaults to 2"), the default
   story's description says so.
3. **Deterministic stories.** Formatting/date components must never render
   from a live `now` or ambient locale: pass fixed reference dates and
   explicit locale props in stories, or the visual baselines flake.
4. **Visual baselines are the regression net.** With no design side, the
   first `bun run test:visual:update` after a self-review *is* the accepted
   truth — review the new baselines deliberately before trusting them.
5. **Interpretation decisions get recorded.** Where the spec leaves a
   question open (e.g. "show or hide a zero trend?"), decide, default it in
   a prop, and document the decision in the component docblock — don't
   leave it implicit.

## Reference implementations

- **[Touchable](../../../src/atoms/Touchable/)** — the behavioral primitive. Demonstrates: CVA defaults from spec, Radix Slot for `asChild`, no chrome of its own, demo-mirroring story filler.
- **[Button](../../../src/atoms/Button/)** — composed on Touchable. Demonstrates: layered CVA (behavior + styling combined via `cn`), variant API mirroring the design source, documented source↔demo reconciliation.

## Common mistakes

- **Inventing variants the source doesn't have.** If you think the design is incomplete, surface it as a question — don't silently add variants.
- **Trusting `source` alone.** The demo is rendered truth; diff them before writing the CVA.
- **Driving visuals via `className` from a caller.** Variants own the visuals. Callers pass `className` only for layout context, never to override decoration.
- **Importing `vitest` in a story file.** Breaks every story in the preview (expect-state clash). Interaction assertions import from `storybook/test`.
- **Migrating the role overlays.** The colored rings/badges in the bundle page are a reading aid, not design.
- **Committing anything under `visual/`.** Baselines are per-environment; the folder is gitignored for a reason.
- **Slot anchors that swallow Radix's injected props.** Anything passed to an `asChild` trigger (Tooltip/Menu triggers, Touchable asChild) gets cloned with a ref + event handlers injected — the child must `forwardRef` AND spread `...props` onto its DOM node, or positioning and hover silently break (no error, not even in `check:stories`). Library components already comply; watch for story fixtures and app-side wrappers.
- **Trusting a spec's `/* global … */` name over the rendered DOM.** Bundle sources resolve shared components from `window` at render time, and a name can be defined more than once across the bundle's source files — the demo may render a different chrome than the spec you were reading. When a demo passes props the spec'd component lacks (e.g. `<Tag dot>` where `Tag` has no `dot`), probe the served bundle's DOM; the spec's `usage` code block usually names the real component.
- **Importing tokens.css separately in stories.** Stories load tokens through `.storybook/preview.ts` already.
- **Forgetting to add the component to its level's barrel.** `src/atoms/Button/index.ts` re-exports — but `src/atoms/index.ts` also needs `export * from './Button'`.
- **Reintroducing unlayered element rules.** `src/styles/tokens.css` keeps its element defaults (`h1`–`h6`, `a`, `p`) inside `@layer base` precisely so Tailwind utilities beat them without the `!` modifier. Unlayered author CSS outranks `@layer utilities` — one unlayered `h2` rule and every bare `text-[26px]`/`no-underline`/`m-0` on a raw heading or link in your markup silently loses again. Keep element rules inside `@layer base`, or scope them by class (the scoped-prose pattern) so specificity, not layering, decides.

## Known hazards

Traps that cost real debugging time across the build sessions. The component agents (`component-builder`, `fidelity-verifier`, `component-porter`, `component-reviewer`) all reference this section — keep it the single canonical list.

- **Built-storybook barrel-init chunking.** A cross-tree import through a *multi-file* barrel (`import { X } from '../../molecules/Progress'` where the barrel re-exports X from a separate file) can be dropped by the **production** storybook build's lazy-init chunking — the component resolves to `undefined` and throws React error #130 / "u is not a function" in the built preview **only**; `bun run test` (vitest) and `bun run dev` stay green, so it passes the smoke layer and surfaces in `test:visual`/`check:stories` against the built storybook. Fix: **deep member import** from the component's own module (`'../../molecules/Progress/Progress'`), with a one-line comment. This recurred four separate times across build sessions before the deep-import rule stuck.
- **Icon dynamic loading.** Resolve lucide by name via `dynamicIconImports` from `lucide-react/dynamic` + a per-name `React.lazy` cache — **never** the static `icons` namespace (that ships the full ~1996-icon set to every consumer and mis-resolves ~245 alias kebab names like `help-circle`). The lazy chunk means the visual runner must wait for `data-glyph-pending` to detach before capturing, or icon stories flake; that wait is in `.storybook/test-runner.ts` and is guarded so glyph-less stories keep their original capture timing.
- **Orphaned storybook servers.** Interrupted `check:stories` / `test:visual` runs leave static servers on ports **6006 / 6007 / 6016**; the next run fails with `EADDRINUSE` (a false failure that looks like a real one). Kill them before re-running: `pkill -f "test-storybook|test-visual|serve-static|check-stories"` then free the three ports. Run long suites in the background and read the log rather than racing them (concurrent runs re-collide). Grep logs with `-a` — they contain binary/ANSI bytes that make plain `grep` silently miss matches.
- **Baseline-safe verification order.** Always `bun run test:visual` against **existing** baselines FIRST — pre-existing snapshots passing unchanged is the behaviour-preservation proof. Only then `test:visual:update` the new/legitimately-changed baselines, each called out. Watch for a **sub-threshold markup change** hiding under the ~0.01% diff threshold: if you changed a story's markup on purpose but its baseline passed unchanged, delete + reseed it deliberately so the accepted truth reflects the change.
- **Date & input discipline.** Date-only ISO strings (`"2026-05-04"`) parse as **UTC** midnight, so local getters read the previous day in negative-UTC zones — parse date-only strings as local calendar dates (`toDate`). Freeze the clock in fixtures (no `Date.now()`/`new Date()`). Guard `Enter` handlers with `e.nativeEvent.isComposing` so committing an IME candidate doesn't navigate/submit.
- **Menu keyboard traps.** Plain buttons rendered inside a Radix `DropdownMenu.Content` (e.g. a destructive-confirm panel) are unreachable by keyboard — Tab/Arrow/Enter dead-end on the container. Wrap them as `DropdownMenu.Item asChild` so they join the roving-tabindex collection, and focus the safe/default control on entry.
- **Un-captured pointer release.** A drag handle that arms on `pointerdown` but only disarms on its own `pointerup` stays armed if the release lands elsewhere (no pointer capture) — a later unrelated drag then reorders silently. Register window-level `pointerup`/`pointercancel` disarm, or use `setPointerCapture`.

## Extending the catalog

The shipped catalog under `src/` (browse the layer barrels) is the reuse
inventory — compose it, never fork it; formatting goes through
`src/lib/format.ts`. New components come from the three source situations
above: a bundle spec, a design page, or a prose spec doc. A component with
none of the three needs a brainstorming/design pass first — this skill
translates designs, it does not originate them.
