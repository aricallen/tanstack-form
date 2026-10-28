---
'@tanstack/form-core': patch
---

BREAKING: `handleSubmit()` now rejects when a validator or `onSubmit` throws, and resolves to `{ errors, cause }` instead of an array. This applies to both forms and form groups. `onSubmitInvalid` also receives a `cause` naming the phase that failed.

Migration:

- replace `const errors = await form.handleSubmit()` with `const { errors } = await form.handleSubmit()`
- add a `.catch()` or `try`/`catch` where you call `handleSubmit()` if a validator or `onSubmit` can throw
