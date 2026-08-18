<!-- Closes #<issue> -->

## What and why

## Verification

<!-- What did you actually run? Paste real output, not a claim (axiom A3). -->

```
npm run check
```

## Checklist

- [ ] links its issue with `Closes #N`
- [ ] `npm run check` passes locally
- [ ] no `any` introduced
- [ ] UI work reuses `@renderer/ui` primitives — no one-off styling
- [ ] no domain state added to the renderer store (axiom A1)
- [ ] the seven axioms in the README are not violated
- [ ] tests cover the new behaviour
- [ ] anything deferred is stated explicitly, with the issue that will do it
