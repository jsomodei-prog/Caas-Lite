# Slice 1 — npm dependencies

From the repo root:

```bash
npm install --save helmet express-rate-limit
npm install --save-dev @types/express-rate-limit
```

(`helmet` ships its own types; no separate @types package needed.)

Versions at time of build:
- helmet@^8.0.0
- express-rate-limit@^7.4.0

No transitive surprises — both packages have small dep trees, last audit
came back clean.
