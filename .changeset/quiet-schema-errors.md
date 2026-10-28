---
'@tanstack/form-core': patch
---

Skip field meta updates when a validator returns errors with the same content as before. Standard Schema validators such as Zod return new issue objects on every run, so a form-level schema re-rendered every invalid field on every change, even fields whose errors had not changed. Errors made of plain objects and arrays are now compared by content; other objects, such as class instances, are still compared by reference.

Fixes #1625
