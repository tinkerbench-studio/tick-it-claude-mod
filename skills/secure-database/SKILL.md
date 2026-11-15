---
name: secure-database
description: Secure-coding practices for database code, covering SQL and query builders, ORMs, raw queries, dynamic filters and sorting, migrations, and database users and grants. Use before writing or changing a query, a migration or data-access code, and when reviewing a change that touches them.
---

# Secure database code

A query is code that the database runs. When input becomes part of that code, the caller is writing the query; when a query is not scoped, it answers for everyone's rows. Follow this before you write or change a query or a migration; the security reviewer checks a change in this area against the same rules. A "Must" that the change breaks is a blocking finding. Whether the caller may see the rows is `tick-it:secure-access-control`.

## Before you write

- Look at how the project already builds queries (bound parameters, a query builder, typed helpers, a reviewed list of exceptions) and do the same. If it has a document or a test on SQL safety, read it first.
- Know where each value in the query comes from. A value from a request, a file, a queue, another service or a row that a user once wrote is input.

## Must

- **Values are bound, never spliced.** Every value reaches the database as a parameter (`?`, `$1`, a named binding, the builder's own). No string concatenation, template interpolation or formatting of a value into SQL, including in `LIKE`, `IN (...)`, `LIMIT` and `OFFSET`. An `IN` list is a generated list of placeholders.
- **What cannot be bound comes from an allow-list.** A table or column name, a sort column, `ASC`/`DESC` or an operator chosen by input is mapped from the input to one of a fixed set of constants in the code. The input itself never reaches the SQL text.
- **A raw-query escape hatch gets the same care.** `raw`, `unsafe`, `$queryRawUnsafe`, `execute(text)` and their like take a constant string and bound values, or they are not used. An ORM does not make a hand-built fragment safe.
- **Every query that returns or changes owned data carries the owner or tenant in its condition.** An `UPDATE` or `DELETE` has a `WHERE` that names the row and its owner; a missing or always-true condition is a bug however the route is guarded.
- **Stored input is still input.** A value read back from the database and used in a second query, a file path or HTML is treated as untrusted there too.
- **Numbers and limits are validated before they are bound**: an integer is parsed as one, a page size has a maximum, an unbounded read of a table that grows is not handed to a caller.
- **Errors stay inside.** A database error is logged on the server; the caller gets a general message, never the SQL, the driver's message, a table or a column name.
- **Migrations are safe to run and to be interrupted**: new numbered files, never an edit to one that has been applied; no data destroyed that the change does not mean to destroy; no secret, personal data or environment-specific value in the file; a destructive step (drop, rewrite, backfill) called out in the pull request with how to go back.
- **The application's database user has only what it uses.** No superuser, owner or DDL rights for the running application where the platform lets them be separate; a new grant is as narrow as the feature.

## Should

- Wrap several writes that must agree in a transaction, and make a retried write safe to repeat.
- Keep data access behind functions with typed arguments, so a `string` cannot be passed where an id or an enum is meant.
- Add the constraint in the schema (`NOT NULL`, `UNIQUE`, a foreign key, a `CHECK`) as well as in the code.
- Give a slow or unbounded query a limit, an index or a timeout: a query a caller can make expensive is a way to take the service down.

## Check before review

- Search the diff for SQL text beside `+`, `${`, `%s`, `format(` or `f"`: each is either a constant or a finding.
- A test with a hostile value (`' OR 1=1 --`, a quote, a semicolon, a very long string) for each new input that reaches a query, and one that asks for another tenant's row.
- Run the migration on a copy with real-shaped data, forwards, and say in the pull request what going back takes.
