---
name: react-hooks
description: Use when setState (setForm/setX) is called inside useEffect — resetting modal/drawer form state on an `open` prop, or syncing/filtering one piece of state from another — or when the IDE/ESLint flags "Calling setState synchronously within an effect can trigger cascading renders", react-hooks/exhaustive-deps, or stale state when reopening a modal for a different item.
---

> Scope: file paths in this document are relative to `packages/ui/` (the `@marcos-corp/ui` package), except `.claude/`, `.plans/`, and `.specs/`, which live at the umbrella repo root.

# Removing setState from useEffect

## Overview

**An effect that calls `setState` to derive or reset state is almost always the wrong tool.** Effects exist to synchronize React with *external* systems (DOM, timers, subscriptions, network). State that can be computed from props/other state belongs in render; state that resets per "session" belongs to the mount lifecycle.

This repo repeats the same anti-patterns across modals and overlays: reset-on-open (Fix A), derived/synced state (Fix B), and genuine effects carrying a synchronous reset (Fix C). Reference: https://react.dev/learn/you-might-not-need-an-effect

## When to use

Recognize these shapes:

- **Reset-on-open:** `useEffect(() => { if (open) { setForm(existing ?? DEFAULT()); setTab(0); } }, [open, existing])`
- **Derived/synced state:** `useEffect(() => { setX(deriveFrom(y)); }, [y])` (filtering, mapping, recomputing)
- **Genuine effect + a synchronous reset:** a real `setInterval`/DOM-measure/subscription effect that *also* does `if (!open) { setX(reset); return }` or seeds an initial value synchronously — only the reset is flagged (Fix C)

Or these signals:
- IDE/ESLint: *"Calling setState synchronously within an effect can trigger cascading renders"*
- `react-hooks/exhaustive-deps` warning (a dep like `existing` or the derived source is "missing")
- A modal shows **stale data when reopened** for a different item, or shows it correctly only because an effect papers over it.

**Do NOT apply to legitimate effects** — leave these alone:
- DOM sync: `document.documentElement.setAttribute('data-theme', theme)`
- Timers/animation: `setInterval` driving a counter
- Subscriptions / event listeners / network side effects

If the effect talks to something *outside React*, it stays. If it only moves React state around, remove it. **But if a legitimate effect *also* calls `setState` synchronously (a reset on its off-branch, or seeding an initial value), that one call is still flagged — keep the effect, strip the synchronous reset (Fix C).**

## Fix A — Reset-on-open → unmount + lazy init

The bug: a component kept permanently mounted only runs `useState(initial)` once, so it leaks state between uses. The effect is a workaround. The real fix is to **make a fresh session = a fresh mount**.

**Parent** — mount only while open (unmount discards state for free):

```tsx
// ❌ Before: always mounted, state leaks between opens
<Editor open={open} onClose={close} existing={editing} />

// ✅ After: mounted only while open
{open && <Editor open onClose={close} existing={editing} />}
```

**TS note (this repo):** the "currently editing" state is usually typed `T | null` while the child prop is optional (`existing?: T`, i.e. `T | undefined`). Passing `null` to that prop is a type error, so write `existing={editing ?? undefined}`. Incoming JSX often masks this with `existing={editing as T}` — that cast lies (the value really is `null` on the create path). Use `?? undefined`, don't reintroduce the cast.

**Child** — lazy-init from props, delete the reset effect:

```tsx
// ❌ Before
const [form, setForm] = useState(existing || DEFAULT());
useEffect(() => { if (open) { setForm(existing || DEFAULT()); setTab(0); } }, [open, existing]);

// ✅ After — runs once per mount, no effect
const [form, setForm] = useState(() => existing ?? DEFAULT());
const [tab, setTab] = useState(0);
```

Modals here (`Modal`/`Drawer`) return `null` when closed and have only an *enter* animation — so unmounting the parent breaks no exit transition.

## Fix B — Derived/synced state → render or event handler

```tsx
// ❌ Before: extra render + exhaustive-deps warning
const allowed = useMemo(() => toolsForModel(form.model), [form.model]);
useEffect(() => {
  const ids = new Set(allowed.map(t => t.id));
  setForm(f => ({ ...f, tools: f.tools.filter(t => ids.has(t)) }));
}, [form.model]);

// ✅ After: prune in the handler that changes the model (one atomic update)
const selectModel = useCallback((modelId: string) => {
  setForm(f => {
    const ids = new Set(toolsForModel(modelId).map(t => t.id));
    return { ...f, model: modelId, tools: f.tools.filter(t => ids.has(t)) };
  });
}, []);
```

Rule of thumb: **pure derivation → compute in render (`useMemo` if expensive); a change caused by a user action → do it in that event handler.**

## Fix C — Genuine effect that *also* resets synchronously

The effect is legitimately external sync (a `setInterval`, a `getBoundingClientRect` measure, an event-listener subscription) **but** also calls `setState` synchronously — usually `if (!open) { setX(reset); return }`, or seeding an initial value before the real work. Only that synchronous `setState` is flagged; the external-sync work is fine. **Keep the effect; remove the synchronous reset.** How depends on who owns the open/on flag.

**C1 — a parent owns the flag and can unmount** (e.g. a log stream's streaming `setInterval`). Conditional-mount the parent (Fix A) and fold the seed/reset value into `useState`. The effect then does *only* the external work, with `[]` deps:

```tsx
// ❌ Before — reset + seed are synchronous setState inside the effect
const [visible, setVisible] = useState(0);
useEffect(() => {
  if (!open) { setVisible(0); return; }  // ← flagged (reset on close)
  setVisible(1);                          // ← flagged (synchronous seed)
  const iv = setInterval(() => setVisible(v => v + 1), 380);
  return () => clearInterval(iv);
}, [open]);

// ✅ After — parent renders {open && <LogStream/>}; effect is timer-only
const [visible, setVisible] = useState(1); // seed lives in the initializer
useEffect(() => {
  const iv = setInterval(() => setVisible(v => v + 1), 380);
  return () => clearInterval(iv);
}, []);
```

**C2 — the component owns its own flag, so there's no parent to unmount** (e.g. a popover's internal `open`). The reset is usually *redundant*: if render is already gated on the flag (`{open && coords && …}`) and the value is recomputed on each activation, just delete it. (Only if the value were read while off would you move the reset into the handler that flips the flag off — never leave it in the effect.)

```tsx
// ❌ Before — setCoords(null) on close is the flagged synchronous reset
useEffect(() => {
  if (!open) { setCoords(null); return; }  // ← flagged; redundant
  computePosition();                        // recomputes on every open anyway
  /* …attach scroll/resize/click/key listeners… */
}, [open]);

// ✅ After — keep the genuine measure + subscription, drop the reset
useEffect(() => {
  if (!open) return;
  computePosition();
  /* …attach scroll/resize/click/key listeners… */
}, [open]);
```

`computePosition()` calls `setCoords` too, but indirectly through a helper — the lint rule only flags *direct* synchronous `setState` in the effect body, so it stays quiet. Stale coords while closed are never read (the portal is gated on `open`).

## Quick reference

| Shape | Fix |
|-------|-----|
| Reset form/step when `open` flips true | Conditional-mount parent + lazy `useState(() => …)`; delete effect |
| Filter/recompute state B from state A | Compute in render / `useMemo`, or update in the event handler |
| `setX` in effect on `[a]` derived purely from `a` | Derive during render |
| DOM attr, `setInterval`, subscription | **Keep** — genuine external sync |
| Genuine effect that *also* resets state synchronously when closed | Keep the effect; lift the seed into `useState` + conditional-mount if a parent owns the flag (C1), or delete the redundant reset if the component owns it (C2) — **Fix C** |

Each Fix A also needs its parent to mount conditionally (`{open && <…/>}`).

## Common mistakes

- **Fixing the child but not the parent.** Lazy `useState` still runs once; without unmount-on-close the state never resets. Both edits are required for Fix A.
- **Reaching for `key={id}` instead of unmounting.** A stable id won't remount when reopening the *same* item after a cancel, so discarded edits persist. Unmount-on-close is unconditional; prefer it.
- **Deleting a genuine effect.** DOM/timer/subscription effects look similar but sync with the outside world — keep them.
- **Leaving the now-unused `useEffect` import** after removing the last effect (TS6133 / lint noise).
