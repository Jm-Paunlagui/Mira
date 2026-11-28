# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 3.x     | Yes       |
| 2.x     | No: upgrade to 3.x ([docs/MIGRATION-3.0.md](docs/MIGRATION-3.0.md)) |

## Reporting a vulnerability

Please do **not** open a public issue. Report it privately through GitHub's
**Security → Report a vulnerability** form on this repository. Include the Mira
version, the call that misbehaves, and the SQL or error it produces. Leave out
credentials and real data.

Expect an acknowledgement within 3 working days. A fix ships in a patch release
with a regression test in `test/security/`; the report is credited unless you ask otherwise.

## What Mira guarantees, and what it does not

Mira binds every **value**: filter values, update values, inserted rows, aggregate
literals and `sql\`…\`` interpolations. It quotes every **name** it is given (tables,
columns, pools, savepoints) and validates every keyword-like option (sort directions,
window frames, privileges, constraint types, connect-string parts). The fuzzer in
`test/security/fuzz.test.ts` checks that no caller string reaches SQL unquoted.

Some inputs **are SQL** by design and must come from your code, never from a request:

- `createView(name, "SELECT …")` and `Session.execute(sql)` / migrations' `execute`, which run their text as written
- column types, `default` and `check` in `createTable` / `alterTable` (checked to be one balanced fragment, but still SQL)
- `sql.ident(...)` names (checked to be plain identifiers)

A Mongo-style filter is itself a small query language. **Never pass request input
straight into a filter.** A body or query string can carry operators
(`{ "NAME": { "$ne": "" } }`). Reduce it to equality first:

```ts
import { sanitizeFilter } from "@jm-paunlagui/mira";
users.find({ ...sanitizeFilter(req.query), TENANT_ID: tenantId });
```

Least privilege still matters: run the app's pool as a schema user with no `ANY`
or `DBA` privileges (the security suite asserts this for the test account).
