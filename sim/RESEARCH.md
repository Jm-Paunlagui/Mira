# Mira Simulation Research: Oracle 19c Queries for Accounting, Inventory and Enterprise

Research collected on 2026-11-24 to grow `bun run sim` beyond the canteen scenario into more complex accounting, inventory and enterprise queries. It also records the Mira defects confirmed so far.

All SQL targets **Oracle Database 19c** (the local Docker image is 19c EE). Features newer than 19c are listed in Part 2 under "Not in 19c" and are not used.

| Part | Contents | Status |
|---|---|---|
| [1. Findings and plan](#part-1-findings-and-sim-expansion-plan) | Confirmed Mira defects and the simulation expansion plan | Defects reproduced live on 19c |
| [2. Oracle 19c SQL catalog](#part-2-oracle-19c-sql-catalog) | 209 statements, clauses and functions, basic to expert; "Not in 19c" list; common pitfalls | Written from the 19c SQL Language Reference; examples not run |
| [3. Accounting patterns](#part-3-accounting-and-finance-patterns) | 35 general ledger, AR/AP, close, currency, payroll and audit patterns | All 35 ran on 19c (56 statements), in private temporary tables |
| [4. Inventory patterns](#part-4-inventory-and-supply-chain-patterns) | 33 stock ledger, costing, replenishment, BOM, MRP and procurement patterns | 24 matched hand-computed results, 7 ran with plausible output, 2 partly verified (multi-session behaviour untested) |
| [5. Mira capability map](#part-5-mira-capability-map) | What SQL Mira's API can generate, what it cannot, suspected quirks | From reading the code; only the items in Part 1 are confirmed |

---

# Part 1: Findings and sim expansion plan

## 1.1 Confirmed Mira defects (16) — all fixed

Each defect was reproduced live against the `MIRA_SIM` schema on Oracle 19c, proven by a failing test (`test/integration/defects.test.ts`, plus two unit tests), then fixed on branch `fix/sim-defects` (2026-11-24). After the fixes: test suite 324/324 with 100% line and function coverage, simulation 234/234, all 115 public functions exercised. The two type-declaration gaps below are fixed too.

- **Found by the simulation (1–6):** each already has a `DEFECT:` check in `sim/stages/*`.
- **Suspected in Part 5, then confirmed by a probe (7–16):** none has a simulation check yet.

| # | Area | Defect | Live result | Severity |
|---|---|---|---|---|
| 1 | `OracleSchema.createView` | A query with a filter sends its bind values along with the DDL | NJS-098 | Fails loudly |
| 2 | `performance.createMaterializedView` | Same as #1 | NJS-098 | Fails loudly |
| 3 | `insertOne` | On a table without an `ID` column, it always appends `RETURNING "ID"` | ORA-00904 | Fails loudly |
| 4 | `getIndexes` | A descending index column shows as Oracle's hidden `SYS_NC…$` name | Wrong column name | Wrong output |
| 5 | `db.isHealthy` | Still `true` after `closePool()` | `true` | Wrong output |
| 6 | `$now` | Compares `SYSTIMESTAMP` (WITH TIME ZONE) against a plain `TIMESTAMP` column, which Oracle converts using the session time zone. When the app's time zone differs from the database's, the window is off by the difference. `bun test` always runs in UTC, which hides this | 0 of 26 rows matched (New York vs UTC) | **Silent wrong data** |
| 7 | Filter `{ $ne: null }` / `{ $eq: null }` | The null is bound as a value instead of producing `IS [NOT] NULL` | 0 rows (expected 2 and 1) | **Silent wrong data** |
| 8 | Filter `$coalesce` | Puts a value expression where a condition belongs | ORA-00920 | Fails loudly |
| 9 | Filter `$case` | Same as #8 | ORA-00920 | Fails loudly |
| 10 | `$inSelect` (and very likely `withCTE`) | The subquery and outer query both name their binds from counters starting at 0, so the same column name in both makes one value overwrite the other | 0 rows (expected 1) | **Silent wrong data** |
| 11 | `findOneAndUpdate` (and `findOneAndReplace`, per code) | Updates every matching row, not just the one returned, and does not lock it between the read and the update | 2 rows updated (expected 1) | **Silent wrong data** |
| 12 | `updateFromJoin` | Any string literal containing a dot (an email address, `"a.b"`) is treated as a column reference | ORA-00904 | Fails loudly |
| 13 | Pipeline expressions | An unknown operator (e.g. `$round`) becomes a column reference instead of an "unsupported operator" error | ORA-00904 `"$A,0"` | Misleading error |
| 14 | `$size` | Generates `JSON_ARRAY_LENGTH`, which is not an Oracle function | ORA-00904 | Fails loudly |
| 15 | `$match` after `$group` | `$group` upper-cases its aliases but `$match` does not, so a lower-case alias fails | ORA-00904 | Fails loudly |
| 16 | `bulkWrite` on a session collection | Ignores the session and commits on its own connection | Row survived the rollback (expected 0) | **Silent wrong data** |

Two smaller gaps are in the type declarations only; runtime is fine:

- `updateOne`'s declared return type omits `upsertedCount`.
- `SetResultBuilder.then` is not typed as `PromiseLike`, so TypeScript rejects `await` on it.

Two documented behaviours are worth knowing:

- `insertedId` is a string when `returning` is used and a number otherwise.
- `convertTypes` turns `"3500"` into the number 3500 but leaves `"3500.50"` as a string.

Fix order: the five silent wrong-data defects (6, 7, 10, 11, 16) come first. Follow the project's rule of proving each defect with a failing test before fixing it.

### Found while building the expanded simulation (17–19) — all fixed

| # | Area | Defect | Live result | Severity |
|---|---|---|---|---|
| 17 | `OracleSchema.createTable` | `notNull` or `primaryKey` together with `default` emitted `NOT NULL DEFAULT 0`; Oracle wants `DEFAULT` first | ORA-00907 | Fails loudly |
| 18 | `find().limit(n).forUpdate("skip locked")` | The page was chosen in a `FETCH FIRST` subquery before the lock skipped busy rows, so a second worker on a queue got nothing while free rows waited. Now the cursor locks rows as it fetches them and stops after `n` (`maxRows`, prefetch sized to match so no extra row is locked) | `[]` instead of the next free row | **Silent wrong data** |
| 19 | Standalone `forUpdate` read | Ran with `autoCommit`, and the commit ended the FOR UPDATE cursor before every row was fetched | ORA-01002 whenever rows were skipped | Fails loudly |

## 1.2 Sim expansion plan (built: stages 9–14)

Status: built on 2026-11-24. `bun run sim` runs 15 stages, 286 checks; 33 business queries go through Mira's API and 17 are coverage gaps (run as hand-written SQL, still checked), listed at the end of every run.

The simulation keeps its current shape: one schema owned by the simulation (`MIRA_SIM`), an in-memory model as the source of truth, `DEFECT:` checks, and the API-surface tracker. It grows from a canteen into a small enterprise:

| New stage | Builds on | Patterns used (from Parts 3 and 4) |
|---|---|---|
| **General ledger** | Every canteen sale, purchase and payroll run posts a balanced journal | Chart-of-accounts tree with roll-up (CONNECT BY / recursive WITH), unbalanced-journal detection, trial balance, running-balance ledger card, opening/closing balances per period, period close with retained earnings |
| **Receivables and payables** | Customer credit becomes invoices; suppliers send invoices | Aging buckets, payments applied to the oldest invoice first (FIFO), three-way match, duplicate-payment and document-gap checks, DSO |
| **Inventory** | The stock table becomes a movement ledger | On-hand from movements with snapshot reconciliation, FIFO / moving-average costing, reorder point with open purchase orders, ABC analysis, lots with earliest expiry picked first (FEFO), stock-out islands |
| **Kitchen production** | Menu dishes get recipes | Multi-level bill-of-materials explosion and where-used, MRP net requirements, cost roll-up |
| **Finance reports** | Everything above | PIVOT income statement, balance-sheet equation, budget vs actual with ROLLUP/CUBE/GROUPING SETS subtotals, month-on-month / year-on-year, exchange-rate conversion on or before a date, depreciation and loan schedules |
| **Audit** | Ledger and payments | Benford first-digit test, MATCH_RECOGNIZE split-payment and round-trip detection, penny-exact allocation |

Each query is written **through Mira where the API can express it**. Where it cannot (Part 5 lists 45 gaps, e.g. ROLLUP outside `$group`, LISTAGG, KEEP DENSE_RANK, MATCH_RECOGNIZE, MODEL, date functions, conditional aggregation), the simulation runs the hand-written SQL through the untracked raw handle and records it as a **coverage gap**. That turns the gap list into a measured backlog of what Mira should support next. Results are checked against the model as now; money is compared in cents.

Order of work:

1. **Proof first:** add `DEFECT:` checks for defects 7–16.
2. **Domains:** add the general ledger and inventory stages first. They feed every report after them.
3. **Coverage report:** print a gap table next to the API-surface report (the operation, whether Mira can express it, and the raw SQL used when it can't).

---


# Part 2: Oracle 19c SQL catalog

## Oracle Database 19c SQL Catalog: Basic to Expert

This catalog is for the Mira project. Mira maps a MongoDB-style API onto Oracle SQL, and its simulation runs an enterprise business on Oracle 19c EE.

The primary source is the **Oracle Database 19c SQL Language Reference** (`sqlrf`). Secondary sources are the 19c Data Warehousing Guide (`dwhsg`), the JSON Developer's Guide (`adjsn`), the PL/SQL Language Reference (`lnpls`) and the PL/SQL Packages and Types Reference (`arpls`).

Base URL for every `sqlrf` link: `https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/`

- Function index: https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Functions.html
- Single-row functions: https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html
- Aggregate functions: https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Aggregate-Functions.html
- Analytic functions: https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html

**Conventions**

- Every syntax example is meant to be valid on 19c. The examples use a simulated enterprise schema: `customers`, `orders`, `order_lines`, `products`, `inventory`, `employees`, `departments`, `gl_entries`, `invoices`, `payments`, `stock_moves`.
- **Since** marks the release that introduced a feature, where that matters. Anything from 12.1 through 18c is available in 19c.
- Release-update (RU) caveats are noted where Oracle backported 21c features into some 19c RUs. Mira should treat RU-only features as **unavailable** unless the target RU is pinned.
- Two lists are checked against the 19c docs: the aggregate function list (56 entries) and the single-row function list by category. In 19c, **`ANY_VALUE`, `CHECKSUM`, `BIT_AND_AGG` and `KURTOSIS_*` are absent from the 19c aggregate list.** **`JSON_TRANSFORM` is absent from the 19c JSON function list.**

---

### Tier 1: Basic

Sources: [SELECT](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html) · [INSERT](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/INSERT.html) · [UPDATE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/UPDATE.html) · [DELETE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/DELETE.html) · [COMMIT](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/COMMIT.html) · [ROLLBACK](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROLLBACK.html) · [Conditions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Conditions.html) · [Character functions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html) · [NULL-related functions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/NVL.html)

#### B1. SELECT … FROM
**Use:** Read columns or expressions from a table or view.
```sql
SELECT customer_id, name, credit_limit FROM customers;
```
**Business:** List customer master data for the sales team.

#### B2. Column aliases and `*`
**Use:** Rename output columns. `t.*` selects every column of one table.
```sql
SELECT c.*, c.credit_limit * 1.1 AS proposed_limit FROM customers c;
```
**Business:** Show a proposed 10% credit-limit increase.

#### B3. DUAL
**Use:** A one-row dummy table for evaluating expressions. In 19c, `FROM` is **mandatory**.
```sql
SELECT SYSDATE, USER FROM dual;
```
**Business:** Return the server date to stamp a batch run.

#### B4. DISTINCT / UNIQUE
**Use:** Remove duplicate rows from the result.
```sql
SELECT DISTINCT country FROM customers;
```
**Business:** List the countries you sell into.

#### B5. WHERE with comparison operators (`= <> != ^= < > <= >=`)
**Use:** Filter rows.
```sql
SELECT * FROM invoices WHERE amount_due > 0 AND status <> 'VOID';
```
**Business:** List open invoices in accounts receivable.

#### B6. AND / OR / NOT and precedence
**Use:** Combine conditions. `NOT` binds before `AND`, and `AND` before `OR`. Use parentheses.
```sql
SELECT * FROM orders WHERE (status = 'NEW' OR status = 'HOLD') AND region = 'EU';
```
**Business:** List EU orders that are not yet shipped.

#### B7. BETWEEN … AND
**Use:** Inclusive range test.
```sql
SELECT * FROM gl_entries WHERE posting_date BETWEEN DATE '2025-01-01' AND DATE '2025-01-31';
```
**Business:** Pull January journal entries. See pitfall P5: the time portion of a DATE.

#### B8. IN (list) / NOT IN
**Use:** Test membership in a list or subquery.
```sql
SELECT * FROM products WHERE category IN ('BEVERAGE','SNACK');
```
**Business:** Filter the catalog by category. See pitfalls P1 (NULLs in NOT IN) and P2 (1000-item limit).

#### B9. LIKE, with `%`, `_` and ESCAPE
**Use:** Pattern match. `%` matches any string and `_` matches one character. LIKE is case-sensitive.
```sql
SELECT * FROM products WHERE sku LIKE 'PRO\_%' ESCAPE '\';
```
**Business:** Find SKUs that start with the literal prefix `PRO_`.

#### B10. IS NULL / IS NOT NULL
**Use:** Test for NULL. `= NULL` is never true.
```sql
SELECT * FROM employees WHERE termination_date IS NULL;
```
**Business:** Count active headcount in HR.

#### B11. ORDER BY (ASC/DESC, NULLS FIRST/LAST, by position)
**Use:** Sort the result. Without ORDER BY the row order is undefined. NULLs sort last in ASC order and first in DESC order by default.
```sql
SELECT * FROM orders ORDER BY order_date DESC NULLS LAST, 1;
```
**Business:** Show the newest orders first in the order-entry screen.

#### B12. Literals: DATE, TIMESTAMP, INTERVAL, q-quote
**Use:** ANSI date literals avoid NLS-dependent conversion. `q'[...]'` avoids doubling quotes.
```sql
SELECT DATE '2025-06-30', TIMESTAMP '2025-06-30 23:59:59', INTERVAL '30' DAY, q'[O'Reilly]' FROM dual;
```
**Business:** Hard-code the fiscal year-end cut-off.
Source: [Literals](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Literals.html)

#### B13. Arithmetic and concatenation (`+ - * /`, `||`)
**Use:** Calculate values and concatenate strings. `/` performs real division. `||` treats NULL as an empty string.
```sql
SELECT first_name || ' ' || last_name AS full_name, salary * 12 AS annual FROM employees;
```
**Business:** Build an annual-salary report in HR.

#### B14. INSERT … VALUES
**Use:** Insert one row. In 19c, VALUES takes a single row only.
```sql
INSERT INTO customers (customer_id, name, country) VALUES (1001, 'Acme Ltd', 'GB');
```
**Business:** Onboard a new customer.

#### B15. INSERT … SELECT
**Use:** Insert many rows from a query.
```sql
INSERT INTO invoice_archive SELECT * FROM invoices WHERE paid_date < DATE '2020-01-01';
```
**Business:** Archive invoices paid more than five years ago.

#### B16. INSERT ALL (unconditional multi-row)
**Use:** The 19c way to insert several literal rows in one statement.
```sql
INSERT ALL
  INTO uom (code, name) VALUES ('EA', 'Each')
  INTO uom (code, name) VALUES ('BX', 'Box')
SELECT * FROM dual;
```
**Business:** Seed reference data such as units of measure.

#### B17. UPDATE … SET … WHERE
**Use:** Change existing rows.
```sql
UPDATE products SET list_price = list_price * 1.05 WHERE category = 'BEVERAGE';
```
**Business:** Apply a 5% price rise.

#### B18. DELETE … WHERE
**Use:** Remove rows. DELETE is undoable with ROLLBACK.
```sql
DELETE FROM cart_items WHERE created_at < SYSDATE - 30;
```
**Business:** Purge abandoned shopping carts.

#### B19. COMMIT
**Use:** Make the transaction's changes permanent and visible to other sessions.
```sql
COMMIT;
```
**Business:** Finalise a posted journal batch.

#### B20. ROLLBACK
**Use:** Undo uncommitted changes.
```sql
ROLLBACK;
```
**Business:** Abandon a failed order import.

#### B21. UPPER / LOWER / INITCAP
**Use:** Change letter case. Often used for case-insensitive matching.
```sql
SELECT * FROM customers WHERE UPPER(email) = UPPER(:email);
```
**Business:** Look up a customer by email when the case may differ.

#### B22. SUBSTR / INSTR / LENGTH
**Use:** Extract part of a string, find a position, or measure length. Positions are 1-based, and a negative start counts from the end.
```sql
SELECT SUBSTR(iban, 1, 2) AS country, INSTR(email, '@') AS at_pos, LENGTH(name) FROM customers;
```
**Business:** Derive the country code from an IBAN.

#### B23. TRIM / LTRIM / RTRIM / LPAD / RPAD
**Use:** Strip or pad characters.
```sql
SELECT LPAD(invoice_no, 10, '0'), TRIM(BOTH ' ' FROM name) FROM invoices;
```
**Business:** Format invoice numbers zero-padded for an EDI file.

#### B24. REPLACE / TRANSLATE / CONCAT
**Use:** Replace substrings or map characters one-for-one. CONCAT takes two arguments only.
```sql
SELECT REPLACE(phone, '-', ''), TRANSLATE(sku, 'abc', 'ABC') FROM customers;
```
**Business:** Normalise phone numbers before de-duplicating.

#### B25. ROUND / TRUNC (number)
**Use:** Round or truncate to n decimal places. A negative n works on the left of the decimal point.
```sql
SELECT ROUND(amount * 0.2, 2) AS vat, TRUNC(amount, -2) FROM invoices;
```
**Business:** Calculate VAT to the cent.

#### B26. MOD / REMAINDER / CEIL / FLOOR / ABS / SIGN / POWER / SQRT
**Use:** Basic math.
```sql
SELECT CEIL(qty / 12) AS cartons, MOD(qty, 12) AS loose FROM order_lines;
```
**Business:** Work out the cartons needed to pick an order.

#### B27. SYSDATE / CURRENT_DATE
**Use:** The current date and time as a DATE. **SYSDATE** uses the database host OS time zone. **CURRENT_DATE** uses the session time zone.
```sql
SELECT SYSDATE, CURRENT_DATE FROM dual;
```
**Business:** Set the default posting date.

#### B28. ADD_MONTHS / MONTHS_BETWEEN / LAST_DAY / NEXT_DAY
**Use:** Calendar arithmetic. ADD_MONTHS clamps to month-end.
```sql
SELECT ADD_MONTHS(hire_date, 6) AS probation_end, LAST_DAY(SYSDATE), NEXT_DAY(SYSDATE, 'MONDAY') FROM employees;
```
**Business:** Find each employee's probation end date.
Note: `NEXT_DAY`'s day name depends on `NLS_DATE_LANGUAGE`.

#### B29. Date arithmetic (`date + n`, `date - date`)
**Use:** Adding a number adds days. Subtracting two DATEs gives days as a NUMBER.
```sql
SELECT due_date - invoice_date AS terms_days, SYSDATE + 1/24 AS in_one_hour FROM invoices;
```
**Business:** Calculate payment terms in days.

#### B30. EXTRACT (datetime)
**Use:** Get YEAR, MONTH, DAY, HOUR and other fields. HOUR, MINUTE and SECOND require a TIMESTAMP.
```sql
SELECT EXTRACT(YEAR FROM order_date) AS yr, COUNT(*) FROM orders GROUP BY EXTRACT(YEAR FROM order_date);
```
**Business:** Count orders per year.

#### B31. TRUNC / ROUND (date)
**Use:** Truncate or round a date to a unit: `'DD'`, `'MM'`, `'Q'`, `'YYYY'`, `'IW'` (ISO week) or `'HH'`.
```sql
SELECT TRUNC(order_date, 'MM') AS month_start, SUM(total) FROM orders GROUP BY TRUNC(order_date, 'MM');
```
**Business:** Monthly sales totals.
Source: [ROUND and TRUNC date format models](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROUND-and-TRUNC-Date-Functions.html)

#### B32. NVL
**Use:** Replace NULL with a value. Both arguments are always evaluated.
```sql
SELECT NVL(discount, 0) FROM order_lines;
```
**Business:** Treat a missing discount as zero.

#### B33. NVL2
**Use:** Return one value when the expression is not NULL and another when it is.
```sql
SELECT NVL2(paid_date, 'PAID', 'OPEN') FROM invoices;
```
**Business:** Show invoice payment status.

#### B34. COALESCE
**Use:** Return the first non-NULL argument (ANSI). It short-circuits.
```sql
SELECT COALESCE(mobile, work_phone, home_phone, 'n/a') FROM employees;
```
**Business:** Pick the best contact number.

#### B35. NULLIF
**Use:** Return NULL when the two arguments are equal. Commonly used to avoid division by zero.
```sql
SELECT revenue / NULLIF(units, 0) AS avg_price FROM sales_summary;
```
**Business:** Average selling price without ORA-01476.

#### B36. CASE (simple and searched)
**Use:** Conditional expression (ANSI).
```sql
SELECT CASE WHEN days_overdue > 90 THEN '90+' WHEN days_overdue > 30 THEN '31-90' ELSE 'current' END AS bucket FROM ar_aging;
```
**Business:** Accounts-receivable ageing buckets.
Source: [CASE Expressions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CASE-Expressions.html)

#### B37. DECODE
**Use:** Oracle's legacy equality-based CASE. Unlike CASE, `DECODE(NULL, NULL, …)` treats NULL as equal to NULL.
```sql
SELECT DECODE(status, 'A', 'Active', 'I', 'Inactive', 'Unknown') FROM employees;
```
**Business:** Map status codes to labels.

#### B38. Aggregates COUNT / SUM / AVG / MIN / MAX
**Use:** Summarise rows. `COUNT(*)` counts every row. `COUNT(col)` and the other aggregates ignore NULLs.
```sql
SELECT COUNT(*), SUM(total), AVG(total), MIN(order_date), MAX(order_date) FROM orders;
```
**Business:** Sales KPIs.

#### B39. ROWNUM (pseudocolumn)
**Use:** The legacy way to limit rows. It is assigned **before** ORDER BY (see pitfall P7).
```sql
SELECT * FROM (SELECT * FROM orders ORDER BY total DESC) WHERE ROWNUM <= 10;
```
**Business:** Top 10 orders by value.
Source: [ROWNUM](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROWNUM-Pseudocolumn.html)

#### B40. CREATE TABLE (basic) with PK / NOT NULL / DEFAULT / UNIQUE / FK
**Use:** Define a table.
```sql
CREATE TABLE departments (
  dept_id   NUMBER(6)     CONSTRAINT dept_pk PRIMARY KEY,
  name      VARCHAR2(100 CHAR) NOT NULL CONSTRAINT dept_name_uk UNIQUE,
  parent_id NUMBER(6)     REFERENCES departments(dept_id),
  created   DATE          DEFAULT SYSDATE NOT NULL
);
```
**Business:** Define the HR organisation table.
Source: [CREATE TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-TABLE.html)

#### B41. Core data types
**Use:** The 19c data types to choose from: `NUMBER(p,s)`, `VARCHAR2(n BYTE|CHAR)` (4000 bytes, or 32767 with `MAX_STRING_SIZE=EXTENDED`), `CHAR`, `NVARCHAR2`, `CLOB`, `BLOB`, `RAW`, `DATE` (always includes time), `TIMESTAMP[(p)]`, `TIMESTAMP WITH [LOCAL] TIME ZONE`, `INTERVAL YEAR TO MONTH`, `INTERVAL DAY TO SECOND`, `BINARY_FLOAT` and `BINARY_DOUBLE`.
19c has **no** SQL `BOOLEAN` type; use `NUMBER(1)` or `CHAR(1)` with a CHECK constraint. 19c also has **no** native `JSON` type; use `CLOB`, `BLOB` or `VARCHAR2` with an `IS JSON` check.
```sql
CREATE TABLE t (flag NUMBER(1) DEFAULT 0 CHECK (flag IN (0,1)), payload CLOB CHECK (payload IS JSON));
```
**Business:** Store an `is_active` flag on products.
Source: [Data Types](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Types.html)

---

### Tier 2: Intermediate

Sources: [Joins](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Joins.html) · [SELECT (group_by_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html) · [Set operators](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/The-UNION-ALL-INTERSECT-MINUS-Operators.html) · [Using Subqueries](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Using-Subqueries.html) · [EXISTS](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/EXISTS-Condition.html) · [Comparison conditions (ANY/ALL/SOME)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Comparison-Conditions.html) · [Format Models](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Format-Models.html) · [Transaction statements](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Types-of-SQL-Statements.html)

#### I1. INNER JOIN … ON
**Use:** Return only the rows that match in both tables.
```sql
SELECT o.order_id, c.name FROM orders o JOIN customers c ON c.customer_id = o.customer_id;
```
**Business:** Orders with customer names.

#### I2. LEFT / RIGHT [OUTER] JOIN
**Use:** Keep every row from one side and fill missing matches with NULLs.
```sql
SELECT c.name, o.order_id FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id;
```
**Business:** Customers, including those who have never ordered.

#### I3. FULL [OUTER] JOIN
**Use:** Keep unmatched rows from both sides.
```sql
SELECT NVL(b.sku, s.sku) sku, b.qty book_qty, s.qty counted_qty
FROM book_stock b FULL JOIN stock_count s ON s.sku = b.sku AND s.wh = b.wh;
```
**Business:** Reconcile book inventory with a physical count.

#### I4. CROSS JOIN
**Use:** Cartesian product.
```sql
SELECT w.wh_id, p.sku FROM warehouses w CROSS JOIN products p;
```
**Business:** Generate a warehouse-by-SKU grid for a stocktake.

#### I5. NATURAL JOIN / JOIN … USING
**Use:** Join on columns with the same name. A `USING` column **must not** be qualified with a table alias anywhere in the query (ORA-25154).
```sql
SELECT order_id, customer_id, name FROM orders JOIN customers USING (customer_id);
```
**Business:** Quick order-to-customer join. Avoid NATURAL in application code because it is fragile when columns are added.

#### I6. Self join
**Use:** Join a table to itself.
```sql
SELECT e.last_name, m.last_name AS manager FROM employees e LEFT JOIN employees m ON m.emp_id = e.manager_id;
```
**Business:** Employee-to-manager report.

#### I7. Oracle legacy outer join `(+)`
**Use:** Pre-ANSI outer join syntax. It cannot express a FULL join and has restrictions. Read it in old code but prefer ANSI joins.
```sql
SELECT c.name, o.order_id FROM customers c, orders o WHERE o.customer_id(+) = c.customer_id;
```
**Business:** Found in legacy ERP reports.

#### I8. GROUP BY
**Use:** Aggregate per group. Every non-aggregated select item must appear in GROUP BY (ORA-00979). In 19c you **cannot** group by a column alias or position.
```sql
SELECT region, SUM(total) FROM orders GROUP BY region;
```
**Business:** Revenue by region.

#### I9. HAVING
**Use:** Filter groups after aggregation.
```sql
SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id HAVING SUM(total) > 100000;
```
**Business:** Identify key accounts.

#### I10. UNION / UNION ALL
**Use:** Stack result sets. UNION removes duplicates and sorts. UNION ALL keeps every row and is faster.
```sql
SELECT 'AR' src, doc_no, amount FROM invoices UNION ALL SELECT 'AP', doc_no, -amount FROM bills;
```
**Business:** A combined cash-flow ledger.

#### I11. INTERSECT / MINUS
**Use:** Set intersection and difference, both with duplicates removed. 19c has **no** `EXCEPT` and no `INTERSECT ALL` or `MINUS ALL`; those arrived in 21c.
```sql
SELECT sku FROM products MINUS SELECT sku FROM inventory WHERE qty > 0;
```
**Business:** List SKUs that are out of stock everywhere.

#### I12. Subquery in WHERE (single-row and multi-row)
**Use:** Filter by the result of another query. A single-row subquery that returns more than one row raises ORA-01427.
```sql
SELECT * FROM products WHERE list_price > (SELECT AVG(list_price) FROM products);
```
**Business:** Products priced above average.

#### I13. IN / NOT IN with a subquery
**Use:** Semi-join or anti-join. NOT IN returns nothing if the subquery yields a NULL (pitfall P1).
```sql
SELECT * FROM customers WHERE customer_id IN (SELECT customer_id FROM orders WHERE order_date >= DATE '2025-01-01');
```
**Business:** Customers active this year.

#### I14. EXISTS / NOT EXISTS
**Use:** Correlated existence test. It is NULL-safe and the preferred anti-join form.
```sql
SELECT * FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id);
```
**Business:** Dormant customers for a win-back campaign.

#### I15. Correlated subquery
**Use:** A subquery that refers to the outer row.
```sql
SELECT e.* FROM employees e WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.dept_id = e.dept_id);
```
**Business:** Employees paid above their department average.

#### I16. Scalar subquery (in the SELECT list)
**Use:** A subquery that returns one value per row, or NULL when there is no row.
```sql
SELECT c.name, (SELECT MAX(order_date) FROM orders o WHERE o.customer_id = c.customer_id) AS last_order FROM customers c;
```
**Business:** Each customer's last order date.

#### I17. Inline view (subquery in FROM)
**Use:** Treat a query as a table.
```sql
SELECT region, avg_total FROM (SELECT region, AVG(total) avg_total FROM orders GROUP BY region) WHERE avg_total > 500;
```
**Business:** Regions with a high average basket.

#### I18. ANY / SOME / ALL
**Use:** Compare a value with every value a list or subquery returns. `= ANY` is equivalent to `IN`. `<> ALL` is equivalent to `NOT IN`.
```sql
SELECT * FROM products WHERE list_price > ALL (SELECT list_price FROM products WHERE category = 'SNACK');
```
**Business:** Products dearer than every snack.

#### I19. WITH (subquery factoring / CTE)
**Use:** Name a subquery and reuse it. The `/*+ MATERIALIZE */` hint forces a temporary result.
```sql
WITH monthly AS (SELECT TRUNC(order_date,'MM') m, SUM(total) amt FROM orders GROUP BY TRUNC(order_date,'MM'))
SELECT m, amt FROM monthly WHERE amt > (SELECT AVG(amt) FROM monthly);
```
**Business:** Months with above-average sales.
Source: [SELECT (subquery_factoring_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

#### I20. FETCH FIRST n ROWS ONLY / OFFSET (row limiting; since 12.1)
**Use:** ANSI top-N and pagination.
```sql
SELECT * FROM orders ORDER BY order_date DESC, order_id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;
```
**Business:** Page 3 of the order list in the UI.
Note: Include a unique tie-breaker in ORDER BY so pages are deterministic. FETCH FIRST **cannot** be combined with `FOR UPDATE` (ORA-02014).

#### I21. FETCH … WITH TIES / PERCENT
**Use:** `WITH TIES` also returns rows that tie with the last row and requires ORDER BY. `PERCENT` returns a fraction of the rows.
```sql
SELECT * FROM employees ORDER BY salary DESC FETCH FIRST 5 PERCENT ROWS WITH TIES;
```
**Business:** The top 5% of earners for a compensation review.

#### I22. TO_CHAR (datetime)
**Use:** Format a date with a format model such as `YYYY-MM-DD HH24:MI:SS`, `fmDay`, `IW`, `IYYY`, `Q`, `FF3` or `TZR`.
```sql
SELECT TO_CHAR(order_date, 'YYYY-"Q"Q') AS fiscal_q, TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') FROM orders;
```
**Business:** Quarter labels for a report, or ISO-8601 timestamps for an API.

#### I23. TO_CHAR (number)
**Use:** Format numbers with format elements such as `9`, `0`, `FM`, `G`, `D`, `L` (currency), `MI`, `PR`, `S`, `EEEE` or `X` (hex).
```sql
SELECT TO_CHAR(1234567.891, 'FM9G999G990D00') , TO_CHAR(-50, '9990PR') FROM dual;
```
**Business:** Statement amounts printed with thousands separators, and negatives shown in brackets in accounting style.

#### I24. TO_DATE / TO_TIMESTAMP / TO_TIMESTAMP_TZ
**Use:** Parse a string into a datetime. `FX` requires an exact format match. `RR` and `YY` handle two-digit years differently.
```sql
SELECT TO_DATE('31/12/2025', 'DD/MM/YYYY'), TO_TIMESTAMP_TZ('2025-06-01 10:00 +02:00', 'YYYY-MM-DD HH24:MI TZH:TZM') FROM dual;
```
**Business:** Import dates from a bank statement file.

#### I25. TO_NUMBER
**Use:** Parse a string into a NUMBER. The optional third argument sets NLS parameters.
```sql
SELECT TO_NUMBER('1.234,56', '9G999D99', 'NLS_NUMERIC_CHARACTERS='',.''') FROM dual;
```
**Business:** Parse EU-formatted amounts from a supplier CSV.

#### I26. CAST
**Use:** ANSI type conversion.
```sql
SELECT CAST(order_date AS TIMESTAMP), CAST('42' AS NUMBER(5)), CAST(total AS VARCHAR2(20)) FROM orders;
```
**Business:** Normalise types in a reporting view.
Source: [CAST](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CAST.html)

#### I27. GREATEST / LEAST
**Use:** The maximum or minimum across arguments in one row. They return NULL if **any** argument is NULL.
```sql
SELECT GREATEST(ship_date, promised_date) - order_date AS lead_days FROM orders;
```
**Business:** The effective lead time.

#### I28. UPDATE with subqueries
**Use:** Set columns from a correlated subquery, including several columns at once.
```sql
UPDATE products p SET (list_price, cost) =
  (SELECT n.list_price, n.cost FROM price_updates n WHERE n.sku = p.sku)
WHERE EXISTS (SELECT 1 FROM price_updates n WHERE n.sku = p.sku);
```
**Business:** Apply a supplier price file. The `WHERE EXISTS` keeps unmatched rows from being set to NULL.

#### I29. UPDATE / DELETE through an inline view (key-preserved join)
**Use:** Update a joined result. 19c has no `UPDATE … FROM`. The updated table must be key-preserved (ORA-01779).
```sql
UPDATE (SELECT o.priority, c.tier FROM orders o JOIN customers c ON c.customer_id = o.customer_id)
SET priority = 1 WHERE tier = 'GOLD';
```
**Business:** Prioritise orders from gold-tier customers.

#### I30. DELETE with a subquery
**Use:** Delete rows that match another table.
```sql
DELETE FROM order_lines WHERE order_id IN (SELECT order_id FROM orders WHERE status = 'CANCELLED');
```
**Business:** Clean up the lines of cancelled orders.

#### I31. MERGE (upsert)
**Use:** Insert or update in one statement. The source must produce at most one row per target row (ORA-30926).
```sql
MERGE INTO inventory t
USING (SELECT sku, wh_id, SUM(qty) qty FROM stock_moves WHERE batch_id = :b GROUP BY sku, wh_id) s
ON (t.sku = s.sku AND t.wh_id = s.wh_id)
WHEN MATCHED THEN UPDATE SET t.qty = t.qty + s.qty
WHEN NOT MATCHED THEN INSERT (sku, wh_id, qty) VALUES (s.sku, s.wh_id, s.qty);
```
**Business:** Post goods receipts to stock.
Source: [MERGE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html)

#### I32. TRUNCATE TABLE
**Use:** Fast removal of every row. It is DDL: it commits implicitly, cannot be rolled back and fires no DML triggers. `CASCADE` (12.1+) also truncates child tables that reference the table through an `ON DELETE CASCADE` foreign key.
```sql
TRUNCATE TABLE stg_bank_lines REUSE STORAGE;
```
**Business:** Reset a staging table before the nightly import.
Source: [TRUNCATE TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/TRUNCATE-TABLE.html)

#### I33. SAVEPOINT / ROLLBACK TO SAVEPOINT
**Use:** Partial rollback within a transaction.
```sql
SAVEPOINT before_lines;
INSERT INTO order_lines ...;
ROLLBACK TO SAVEPOINT before_lines;
```
**Business:** Undo a failed line without losing the order header.
Source: [SAVEPOINT](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SAVEPOINT.html)

#### I34. SELECT … FOR UPDATE [OF col] [NOWAIT | WAIT n | SKIP LOCKED]
**Use:** Lock the selected rows for the transaction.
- `OF` chooses which table's rows to lock in a join.
- `NOWAIT` raises ORA-00054.
- `WAIT n` raises ORA-30006.
- `SKIP LOCKED` skips rows that other sessions hold, which is the job-queue pattern.
```sql
SELECT job_id FROM job_queue WHERE status = 'READY' ORDER BY job_id FOR UPDATE SKIP LOCKED;
```
**Business:** Several workers claim fulfilment jobs without blocking each other.
Note: To claim N rows, open a cursor and fetch N in PL/SQL or the driver. `ROWNUM <= N` is applied **before** rows are skipped, and `FETCH FIRST` combined with `FOR UPDATE` raises ORA-02014.
Source: [SELECT (for_update_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

#### I35. SET TRANSACTION
**Use:** Run a read-only consistent snapshot, or use SERIALIZABLE isolation (which can raise ORA-08177). The default is READ COMMITTED. This must be the first statement of the transaction.
```sql
SET TRANSACTION READ ONLY;
-- or
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```
**Business:** A month-end trial balance read from one point-in-time snapshot.
Source: [SET TRANSACTION](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SET-TRANSACTION.html)

#### I36. LOCK TABLE
**Use:** Take an explicit table lock in a mode such as ROW SHARE, ROW EXCLUSIVE, SHARE or EXCLUSIVE, with NOWAIT or WAIT n.
```sql
LOCK TABLE gl_periods IN EXCLUSIVE MODE NOWAIT;
```
**Business:** Block postings while closing a fiscal period.
Source: [LOCK TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/LOCK-TABLE.html)

#### I37. CREATE SEQUENCE / NEXTVAL / CURRVAL
**Use:** Generate unique numbers. Values are **not gapless**: caching, rollbacks and RAC all leave gaps. Since 12.1 a column DEFAULT can call `seq.NEXTVAL`.
```sql
CREATE SEQUENCE invoice_seq START WITH 1000 INCREMENT BY 1 CACHE 50;
INSERT INTO invoices (invoice_id, ...) VALUES (invoice_seq.NEXTVAL, ...);
```
**Business:** Invoice IDs. Statutory gapless invoice numbering needs a locked counter table instead.
Source: [CREATE SEQUENCE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-SEQUENCE.html)

#### I38. Identity columns (since 12.1)
**Use:** An auto-incrementing PK backed by a system sequence. `ALWAYS` rejects explicit values. `BY DEFAULT [ON NULL]` allows them.
```sql
CREATE TABLE orders (order_id NUMBER GENERATED BY DEFAULT ON NULL AS IDENTITY (START WITH 1 CACHE 100) PRIMARY KEY, ...);
```
**Business:** Order numbers.

#### I39. DEFAULT ON NULL (since 12.1)
**Use:** Apply the default when an INSERT supplies an explicit NULL. In 19c this applies to **INSERT only**.
```sql
ALTER TABLE orders MODIFY (status DEFAULT ON NULL 'NEW');
```
**Business:** Ensure every new order has a status.

#### I40. CHECK constraints
**Use:** Enforce a row-level rule. A row passes when the condition is TRUE **or UNKNOWN**, so NULLs pass.
```sql
ALTER TABLE order_lines ADD CONSTRAINT ol_qty_ck CHECK (qty > 0 AND discount_pct BETWEEN 0 AND 100);
```
**Business:** Prevent negative quantities.

#### I41. Foreign keys: ON DELETE CASCADE / SET NULL
**Use:** Referential integrity with an action on parent delete. There is no `ON UPDATE CASCADE` in Oracle.
```sql
ALTER TABLE order_lines ADD CONSTRAINT ol_ord_fk FOREIGN KEY (order_id) REFERENCES orders ON DELETE CASCADE;
```
**Business:** Deleting an order removes its lines.
Note: Index the FK column to avoid table locks and full scans.

#### I42. CREATE [OR REPLACE] VIEW [WITH CHECK OPTION | WITH READ ONLY]
**Use:** A stored query. `CREATE OR REPLACE` applies to views and PL/SQL, **not tables**.
```sql
CREATE OR REPLACE VIEW open_invoices AS SELECT * FROM invoices WHERE status = 'OPEN' WITH CHECK OPTION;
```
**Business:** The AR clerk's view of open invoices.
Source: [CREATE VIEW](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-VIEW.html)

#### I43. CREATE INDEX (B-tree, unique, composite, function-based, bitmap)
**Use:** Speed up access. A function-based index makes `UPPER(col)` or `TRUNC(date)` predicates indexable.
```sql
CREATE INDEX cust_email_ui ON customers (UPPER(email));
CREATE BITMAP INDEX ord_status_bx ON orders (status);  -- EE only; avoid on OLTP tables
```
**Business:** Fast case-insensitive login lookup.
Source: [CREATE INDEX](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-INDEX.html)

#### I44. ALTER TABLE (add, modify, rename or drop a column or constraint)
**Use:** Evolve a schema.
```sql
ALTER TABLE customers ADD (segment VARCHAR2(20) DEFAULT 'SMB' NOT NULL);
ALTER TABLE customers RENAME COLUMN segment TO cust_segment;
```
**Business:** Add customer segmentation.
Source: [ALTER TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ALTER-TABLE.html)

#### I45. CREATE TABLE AS SELECT (CTAS)
**Use:** Create and populate a table in one step. NOT NULL constraints are copied; other constraints are not.
```sql
CREATE TABLE sales_2024 AS SELECT * FROM orders WHERE order_date < DATE '2025-01-01';
```
**Business:** A year-end snapshot table.

#### I46. DROP TABLE [CASCADE CONSTRAINTS] [PURGE] / FLASHBACK TABLE … TO BEFORE DROP
**Use:** Drop a table, or restore it from the recycle bin.
```sql
DROP TABLE tmp_import PURGE;
FLASHBACK TABLE customers TO BEFORE DROP;
```
**Business:** Recover a table that was dropped by mistake.
Sources: [DROP TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/DROP-TABLE.html) · [FLASHBACK TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/FLASHBACK-TABLE.html)

#### I47. GRANT / REVOKE
**Use:** Grant or revoke object and system privileges, and roles.
```sql
GRANT SELECT, INSERT ON sales.orders TO app_rw;
REVOKE INSERT ON sales.orders FROM app_rw;
```
**Business:** Give the reporting role read-only access to sales.
Note: Schema-level `ON SCHEMA` grants are 23ai and are not available in 19c.
Sources: [GRANT](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/GRANT.html) · [REVOKE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/REVOKE.html)

#### I48. CREATE ROLE
**Use:** Group privileges.
```sql
CREATE ROLE finance_ro; GRANT SELECT ON gl_entries TO finance_ro; GRANT finance_ro TO alice;
```
**Business:** The auditor role.

#### I49. CREATE [PUBLIC] SYNONYM
**Use:** An alias for an object in another schema.
```sql
CREATE SYNONYM orders FOR sales.orders;
```
**Business:** Let the application schema reference the owner schema's tables without a prefix.
Source: [CREATE SYNONYM](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-SYNONYM.html)

#### I50. COMMENT ON
**Use:** Document tables and columns in the data dictionary.
```sql
COMMENT ON COLUMN invoices.amount_due IS 'Gross amount outstanding, in invoice currency';
```
**Business:** Data governance.

#### I51. ROWID (pseudocolumn)
**Use:** The physical row address. Fastest single-row access within one transaction. Do not persist it.
```sql
DELETE FROM customers a WHERE ROWID > (SELECT MIN(ROWID) FROM customers b WHERE b.email = a.email);
```
**Business:** Remove duplicate customer records.

#### I52. Basic analytic window: ROW_NUMBER / RANK / DENSE_RANK … OVER (PARTITION BY … ORDER BY …)
**Use:** Rank rows within groups without collapsing them.
```sql
SELECT * FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC) rn FROM employees e) WHERE rn <= 3;
```
**Business:** The top 3 earners per department.
Source: [Analytic Functions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html)

#### I53. LAG / LEAD
**Use:** Read a previous or next row's value. Arguments are offset and default; `IGNORE NULLS` is supported.
```sql
SELECT month, revenue, revenue - LAG(revenue, 1, 0) OVER (ORDER BY month) AS mom_change FROM monthly_sales;
```
**Business:** Month-over-month revenue change.

#### I54. SUM / AVG / COUNT … OVER (PARTITION BY)
**Use:** Group totals on detail rows.
```sql
SELECT order_id, total, total / SUM(total) OVER (PARTITION BY customer_id) AS share FROM orders;
```
**Business:** Each order's share of the customer's spend.

#### I55. LISTAGG (basic)
**Use:** Concatenate the values in a group. In 19c, write `WITHIN GROUP (ORDER BY …)`.
```sql
SELECT order_id, LISTAGG(sku, ', ') WITHIN GROUP (ORDER BY line_no) AS skus FROM order_lines GROUP BY order_id;
```
**Business:** A one-line summary of what was ordered.
Source: [LISTAGG](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/LISTAGG.html)

---

### Tier 3: Advanced

Sources: [SQL for Aggregation in Data Warehouses (ROLLUP/CUBE)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-aggregation-data-warehouses.html) · [SQL for Analysis and Reporting](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-analysis-reporting-data-warehouses.html) · [Hierarchical Queries](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Hierarchical-Queries.html) · [INSERT (multi_table_insert)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/INSERT.html) · [Pattern-matching (REGEXP) conditions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Pattern-matching-Conditions.html) · [Datetime Data Types and Time Zone Support](https://docs.oracle.com/en/database/oracle/oracle-database/19/nlspg/datetime-data-types-and-time-zone-support.html) · [Flashback Query](https://docs.oracle.com/en/database/oracle/oracle-database/19/adfns/flashback.html)

#### Grouping extensions

#### A1. ROLLUP
**Use:** Subtotals along a hierarchy plus a grand total.
```sql
SELECT region, country, SUM(total) FROM orders GROUP BY ROLLUP (region, country);
```
**Business:** A sales report with subtotals by region and country.

#### A2. CUBE
**Use:** Subtotals for every combination of the columns.
```sql
SELECT product_line, channel, SUM(total) FROM sales GROUP BY CUBE (product_line, channel);
```
**Business:** A product-by-channel cross-tab with every margin.

#### A3. GROUPING SETS
**Use:** List exactly the groupings you want.
```sql
SELECT region, channel, SUM(total) FROM sales GROUP BY GROUPING SETS ((region), (channel), ());
```
**Business:** Totals by region, totals by channel and a grand total in one pass.

#### A4. Composite and concatenated groupings
**Use:** Mix ROLLUP with plain columns, or treat several columns as one unit.
```sql
SELECT yr, region, country, SUM(total) FROM sales GROUP BY yr, ROLLUP (region, country);
```
**Business:** Regional subtotals within each year.

#### A5. GROUPING()
**Use:** Returns 1 when the column is a super-aggregate NULL, which separates subtotal rows from real NULLs.
```sql
SELECT DECODE(GROUPING(region),1,'ALL',region) region, SUM(total) FROM orders GROUP BY ROLLUP (region);
```
**Business:** Label the "All regions" row.

#### A6. GROUPING_ID()
**Use:** A bit vector of GROUPING() values for several columns.
```sql
SELECT region, channel, GROUPING_ID(region, channel) gid, SUM(total) FROM sales GROUP BY CUBE (region, channel) HAVING GROUPING_ID(region, channel) IN (0, 3);
```
**Business:** Keep only the detail rows and the grand total.

#### A7. GROUP_ID()
**Use:** Distinguish duplicate groups produced by overlapping grouping sets.
```sql
SELECT region, SUM(total) FROM sales GROUP BY region, ROLLUP(region) HAVING GROUP_ID() = 0;
```
**Business:** Remove duplicate subtotal rows from a generated report.

#### Analytic / window functions

#### A8. Windowing frames: ROWS / RANGE BETWEEN …
**Use:** Running and moving calculations. With ORDER BY, the default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Note that RANGE treats ORDER BY ties as **peers**.
```sql
SELECT acct, posting_date, amount,
       SUM(amount) OVER (PARTITION BY acct ORDER BY posting_date, entry_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_bal
FROM gl_entries;
```
**Business:** A running general-ledger balance.

#### A9. RANGE with INTERVAL (logical window)
**Use:** A time-based moving window.
```sql
SELECT sale_date, SUM(total) OVER (ORDER BY sale_date RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW) AS rolling_7d
FROM daily_sales;
```
**Business:** A rolling 7-day sales figure. It is correct even when days are missing.

#### A10. FIRST_VALUE / LAST_VALUE [IGNORE NULLS]
**Use:** The first or last value in the frame. LAST_VALUE needs an explicit frame, because the default frame ends at the current row.
```sql
SELECT sku, eff_date, LAST_VALUE(price IGNORE NULLS) OVER (PARTITION BY sku ORDER BY eff_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS carried_price
FROM price_history;
```
**Business:** Carry the last known price forward to fill gaps.

#### A11. NTH_VALUE (FROM FIRST/LAST, IGNORE NULLS)
**Use:** The nth value in the frame.
```sql
SELECT DISTINCT customer_id, NTH_VALUE(order_id, 2) OVER (PARTITION BY customer_id ORDER BY order_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS second_order FROM orders;
```
**Business:** Measure repeat-purchase behaviour.

#### A12. NTILE
**Use:** Split ordered rows into n roughly equal buckets.
```sql
SELECT customer_id, NTILE(4) OVER (ORDER BY lifetime_value DESC) AS quartile FROM customer_ltv;
```
**Business:** Customer value quartiles.

#### A13. CUME_DIST / PERCENT_RANK
**Use:** Relative position in the range 0 to 1.
```sql
SELECT emp_id, salary, PERCENT_RANK() OVER (PARTITION BY job_id ORDER BY salary) pr FROM employees;
```
**Business:** Pay-band positioning.

#### A14. RATIO_TO_REPORT
**Use:** A value divided by the sum of its partition.
```sql
SELECT region, revenue, RATIO_TO_REPORT(revenue) OVER () AS pct_of_total FROM region_sales;
```
**Business:** Revenue mix by region.

#### A15. KEEP (DENSE_RANK FIRST/LAST ORDER BY …)
**Use:** Aggregate only the rows ranked first or last. Also works as an analytic function.
```sql
SELECT sku, MAX(price) KEEP (DENSE_RANK LAST ORDER BY eff_date) AS current_price FROM price_history GROUP BY sku;
```
**Business:** The current price per SKU without a self-join.
Source: [FIRST](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/FIRST.html)

#### A16. LISTAGG DISTINCT and ON OVERFLOW (12.2 / 19c)
**Use:** Remove duplicates (DISTINCT is new in 19c) and handle a result that exceeds 4000 or 32767 bytes. The default is `ON OVERFLOW ERROR`, which raises ORA-01489.
```sql
SELECT customer_id,
       LISTAGG(DISTINCT sku, ',' ON OVERFLOW TRUNCATE '...' WITH COUNT) WITHIN GROUP (ORDER BY sku) skus
FROM order_lines GROUP BY customer_id;
```
**Business:** A "products bought" summary on the customer profile.

#### A17. PERCENTILE_CONT / PERCENTILE_DISC / MEDIAN
**Use:** Inverse-distribution functions. CONT interpolates; DISC returns an actual value.
```sql
SELECT dept_id, MEDIAN(salary), PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY salary) p90 FROM employees GROUP BY dept_id;
```
**Business:** Median and 90th-percentile salary per department.

#### A18. STATS_MODE
**Use:** The most frequent value.
```sql
SELECT store_id, STATS_MODE(payment_method) FROM payments GROUP BY store_id;
```
**Business:** The most popular payment method per store.

#### A19. STDDEV / VARIANCE / STDDEV_POP / STDDEV_SAMP / VAR_POP / VAR_SAMP
**Use:** Measures of spread.
```sql
SELECT sku, AVG(daily_qty), STDDEV_SAMP(daily_qty) FROM daily_demand GROUP BY sku;
```
**Business:** Demand variability for safety-stock calculations.

#### A20. CORR / COVAR_POP / COVAR_SAMP / REGR_* (SLOPE, INTERCEPT, R2, COUNT, AVGX, AVGY, SXX, SYY, SXY)
**Use:** Correlation and linear regression.
```sql
SELECT REGR_SLOPE(units, price) slope, REGR_INTERCEPT(units, price) icpt, REGR_R2(units, price) r2, CORR(units, price) FROM weekly_sales;
```
**Business:** Price-elasticity estimate.
Source: [REGR_ functions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/REGR_-Linear-Regression-Functions.html)

#### A21. APPROX_COUNT_DISTINCT / APPROX_PERCENTILE / APPROX_MEDIAN (12.1 / 12.2), and APPROX_COUNT / APPROX_SUM / APPROX_RANK (18c)
**Use:** Fast approximate aggregates over large data.
```sql
SELECT TRUNC(event_ts,'DD'), APPROX_COUNT_DISTINCT(visitor_id) FROM web_events GROUP BY TRUNC(event_ts,'DD');
```
**Business:** Daily unique visitors on a dashboard.

#### Hierarchies

#### A22. CONNECT BY / START WITH / PRIOR / LEVEL
**Use:** Oracle's hierarchical query syntax.
```sql
SELECT LEVEL, LPAD(' ', 2*(LEVEL-1)) || last_name AS org
FROM employees START WITH manager_id IS NULL CONNECT BY PRIOR emp_id = manager_id;
```
**Business:** An org chart.

#### A23. SYS_CONNECT_BY_PATH / CONNECT_BY_ROOT / CONNECT_BY_ISLEAF
**Use:** The path string, the root's value, and a leaf flag.
```sql
SELECT CONNECT_BY_ROOT account_code AS root_acct, SYS_CONNECT_BY_PATH(account_code, '/') path, CONNECT_BY_ISLEAF is_leaf
FROM coa START WITH parent_code IS NULL CONNECT BY PRIOR account_code = parent_code;
```
**Business:** Chart-of-accounts roll-up paths. Only leaf accounts are postable.

#### A24. NOCYCLE / CONNECT_BY_ISCYCLE
**Use:** Survive cycles in the data and flag them.
```sql
SELECT part_id, CONNECT_BY_ISCYCLE cyc FROM bom START WITH part_id = :top CONNECT BY NOCYCLE PRIOR component_id = part_id;
```
**Business:** Detect circular bill-of-materials references.

#### A25. ORDER SIBLINGS BY
**Use:** Sort the children of each parent while keeping the tree order.
```sql
SELECT LEVEL, name FROM departments START WITH parent_id IS NULL CONNECT BY PRIOR dept_id = parent_id ORDER SIBLINGS BY name;
```
**Business:** An alphabetical department tree.

#### A26. CONNECT BY row generator
**Use:** Generate N rows.
```sql
SELECT DATE '2025-01-01' + LEVEL - 1 AS cal_day FROM dual CONNECT BY LEVEL <= 365;
```
**Business:** Build a calendar dimension.

#### A27. Recursive WITH (since 11.2)
**Use:** ANSI recursion. The CTE **must** have a column alias list. The anchor and recursive members are joined with UNION ALL.
```sql
WITH org (emp_id, manager_id, lvl, path) AS (
  SELECT emp_id, manager_id, 1, CAST(last_name AS VARCHAR2(4000)) FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.emp_id, e.manager_id, o.lvl + 1, o.path || '/' || e.last_name
  FROM employees e JOIN org o ON e.manager_id = o.emp_id
)
SEARCH DEPTH FIRST BY emp_id SET ord
CYCLE emp_id SET is_cycle TO 'Y' DEFAULT 'N'
SELECT * FROM org ORDER BY ord;
```
**Business:** Approval chains and bill-of-materials explosion.
Note: `SEARCH BREADTH FIRST BY …` orders rows level by level.
Source: [SELECT (subquery_factoring_clause: search_clause, cycle_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

#### Joins (advanced)

#### A28. CROSS APPLY / OUTER APPLY (since 12.1)
**Use:** Join each row to a correlated table expression. OUTER APPLY keeps rows that produce no matches.
```sql
SELECT c.customer_id, x.order_id, x.total
FROM customers c
OUTER APPLY (SELECT o.order_id, o.total FROM orders o WHERE o.customer_id = c.customer_id ORDER BY o.total DESC FETCH FIRST 3 ROWS ONLY) x;
```
**Business:** The top 3 orders per customer.

#### A29. LATERAL inline view (since 12.1)
**Use:** An inline view that can refer to earlier FROM items.
```sql
SELECT d.name, l.max_sal FROM departments d, LATERAL (SELECT MAX(salary) max_sal FROM employees e WHERE e.dept_id = d.dept_id) l;
```
**Business:** The highest salary per department.

#### A30. Partitioned outer join (data densification)
**Use:** Fill gaps in sparse data for each partition.
```sql
SELECT s.product_id, c.cal_day, NVL(s.qty, 0) qty
FROM sales s PARTITION BY (s.product_id)
RIGHT OUTER JOIN calendar c ON (s.sale_date = c.cal_day);
```
**Business:** A daily sales series with zero-sale days per product.
Source: [Joins (partitioned outer joins)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Joins.html)

#### A31. Semi-join and anti-join hints and forms
**Use:** Oracle turns `EXISTS`/`IN` into semi-joins and `NOT EXISTS` into anti-joins. `NOT IN` becomes a null-aware anti-join.
```sql
SELECT * FROM products p WHERE NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.sku = p.sku);
```
**Business:** Find SKUs that never sold.

#### Multitable DML and DML extras

#### A32. Conditional INSERT ALL
**Use:** Insert each source row into **every** target whose WHEN condition is true.
```sql
INSERT ALL
  WHEN total >= 10000 THEN INTO large_orders (order_id, total) VALUES (order_id, total)
  WHEN country <> 'US' THEN INTO export_orders (order_id, country) VALUES (order_id, country)
  ELSE INTO std_orders (order_id) VALUES (order_id)
SELECT order_id, total, country FROM stg_orders;
```
**Business:** Route imported orders into review queues.

#### A33. INSERT FIRST
**Use:** Insert each source row into the **first** matching target only.
```sql
INSERT FIRST
  WHEN days_overdue > 90 THEN INTO collections_q VALUES (invoice_id, amount)
  WHEN days_overdue > 30 THEN INTO reminder_q VALUES (invoice_id, amount)
SELECT invoice_id, amount, days_overdue FROM ar_aging;
```
**Business:** Escalate each invoice to exactly one dunning level.

#### A34. MERGE with WHERE and DELETE WHERE
**Use:** Conditional update and insert. `DELETE WHERE` removes **only rows that this MERGE just updated**, and evaluates the post-update values.
```sql
MERGE INTO inventory t USING stock_count s ON (t.sku = s.sku AND t.wh_id = s.wh_id)
WHEN MATCHED THEN UPDATE SET t.qty = s.counted_qty WHERE t.qty <> s.counted_qty
  DELETE WHERE t.qty = 0
WHEN NOT MATCHED THEN INSERT (sku, wh_id, qty) VALUES (s.sku, s.wh_id, s.counted_qty) WHERE s.counted_qty > 0;
```
**Business:** Stocktake adjustment that drops zero-stock bins.
Note: A MERGE with only one branch is allowed. A column in the `ON` clause cannot be updated (ORA-38104).

#### A35. RETURNING … INTO
**Use:** Get generated or changed values back from DML. Use it with bind variables, or with `BULK COLLECT INTO` for many rows in PL/SQL. 19c has no `OLD`/`NEW` qualifiers here; those arrived in 23ai.
```sql
INSERT INTO orders (customer_id, total) VALUES (:c, :t) RETURNING order_id INTO :new_id;
```
**Business:** Get the identity value for the new order without a second query.
Note: In 19c, RETURNING works with INSERT … VALUES, UPDATE and DELETE. **It does not work with INSERT … SELECT or MERGE.**

#### A36. DML error logging: LOG ERRORS
**Use:** Write failing rows to an error table and continue the statement.
```sql
EXEC DBMS_ERRLOG.CREATE_ERROR_LOG('ORDERS');   -- creates ERR$_ORDERS
INSERT INTO orders SELECT * FROM stg_orders
LOG ERRORS INTO err$_orders ('batch-2025-06-30') REJECT LIMIT UNLIMITED;
```
**Business:** Bulk import that quarantines bad rows instead of failing the whole batch.
Note: Some errors are not logged, such as deferred constraint violations and certain unique violations under direct-path insert.
Source: [INSERT (error_logging_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/INSERT.html)

#### A37. Direct-path INSERT `/*+ APPEND */`
**Use:** Bulk load above the high-water mark. The table cannot be queried in the same transaction until commit (ORA-12838).
```sql
INSERT /*+ APPEND */ INTO sales_fact SELECT * FROM stg_sales; COMMIT;
```
**Business:** Nightly warehouse load.

#### Pivot

#### A38. PIVOT
**Use:** Turn rows into columns. The IN list must be literal values.
```sql
SELECT * FROM (SELECT region, quarter, total FROM sales)
PIVOT (SUM(total) AS amt FOR quarter IN ('Q1' AS q1, 'Q2' AS q2, 'Q3' AS q3, 'Q4' AS q4));
```
**Business:** A quarterly sales matrix.
Source: [SELECT (pivot_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

#### A39. UNPIVOT [INCLUDE | EXCLUDE NULLS]
**Use:** Turn columns into rows. The default is EXCLUDE NULLS.
```sql
SELECT * FROM budget UNPIVOT INCLUDE NULLS (amount FOR month IN (jan AS 1, feb AS 2, mar AS 3));
```
**Business:** Normalise a spreadsheet-shaped budget into monthly rows.

#### A40. PIVOT XML
**Use:** A dynamic pivot. Only the XML form allows `IN (ANY)` or a subquery in the IN list. It returns an XMLType column.
```sql
SELECT * FROM (SELECT region, product_line, total FROM sales) PIVOT XML (SUM(total) AS amt FOR product_line IN (ANY));
```
**Business:** A pivot where the product lines are not known in advance.

#### Regular expressions

#### A41. REGEXP_LIKE (condition)
**Use:** Filter by POSIX regex. The match parameter can be `'i'`, `'c'`, `'n'`, `'m'` or `'x'`.
```sql
SELECT * FROM customers WHERE NOT REGEXP_LIKE(email, '^[^@ ]+@[^@ ]+\.[a-z]{2,}$', 'i');
```
**Business:** Find invalid email addresses.

#### A42. REGEXP_SUBSTR
**Use:** Extract a match, optionally a subexpression.
```sql
SELECT REGEXP_SUBSTR(memo, 'INV-(\d+)', 1, 1, NULL, 1) AS invoice_no FROM bank_lines;
```
**Business:** Match bank receipts to invoices by reference.

#### A43. REGEXP_REPLACE
**Use:** Regex replace.
```sql
SELECT REGEXP_REPLACE(phone, '[^0-9+]', '') FROM customers;
```
**Business:** Clean phone numbers.

#### A44. REGEXP_INSTR / REGEXP_COUNT
**Use:** Position of a match, and number of matches.
```sql
SELECT REGEXP_COUNT(tags, ',') + 1 AS tag_count FROM products;
```
**Business:** Count the tags on a product.

#### A45. Split a delimited string into rows (regex combined with CONNECT BY)
**Use:** The classic 19c string-splitting idiom.
```sql
SELECT REGEXP_SUBSTR(:csv, '[^,]+', 1, LEVEL) val FROM dual CONNECT BY REGEXP_SUBSTR(:csv, '[^,]+', 1, LEVEL) IS NOT NULL;
```
**Business:** Expand a comma-separated SKU list from a promotion rule.

#### Date, time and time zones

#### A46. TIMESTAMP / TIMESTAMP WITH TIME ZONE / TIMESTAMP WITH LOCAL TIME ZONE
**Use:**
- `TIMESTAMP` has no zone.
- `TSTZ` stores the offset or region.
- `TSLTZ` is normalised to the database time zone on storage and shown in the session time zone.
```sql
CREATE TABLE audit_log (id NUMBER, at_utc TIMESTAMP(6), at_tz TIMESTAMP(6) WITH TIME ZONE, at_local TIMESTAMP WITH LOCAL TIME ZONE);
```
**Business:** Audit trails across global subsidiaries.
Note: TSTZ columns cannot be part of a PRIMARY KEY or UNIQUE constraint (use `SYS_EXTRACT_UTC` in an index instead). Region-name TSTZ data is affected by time-zone file (DST) upgrades.
Source: [Datetime and Interval Data Types](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Types.html)

#### A47. SYSTIMESTAMP / CURRENT_TIMESTAMP / LOCALTIMESTAMP / SYSDATE / CURRENT_DATE
**Use:** The current time. Each one differs in type and time zone:

| Function | Return type | Time zone |
|---|---|---|
| `SYSDATE` | DATE | DB **server OS** time zone |
| `SYSTIMESTAMP` | TSTZ | DB **server OS** time zone |
| `CURRENT_DATE` | DATE | **Session** time zone |
| `CURRENT_TIMESTAMP` | TSTZ | **Session** time zone |
| `LOCALTIMESTAMP` | TIMESTAMP (no zone) | **Session** time zone |

`DBTIMEZONE` and `SESSIONTIMEZONE` report the zone settings. `DBTIMEZONE` is used **only** for TSLTZ storage, not for SYSDATE.
```sql
SELECT SYSDATE, SYSTIMESTAMP, CURRENT_TIMESTAMP, LOCALTIMESTAMP, DBTIMEZONE, SESSIONTIMEZONE FROM dual;
```
**Business:** In a Docker container with a UTC OS clock and a Manila-zone client, `SYSDATE` and `CURRENT_DATE` differ by 8 hours. Choose one deliberately.

#### A48. AT TIME ZONE / AT LOCAL
**Use:** Convert a TSTZ value to another zone.
```sql
SELECT order_ts AT TIME ZONE 'Asia/Manila', order_ts AT TIME ZONE 'UTC', order_ts AT LOCAL FROM orders_tz;
```
**Business:** Show order time in the customer's local zone.

#### A49. FROM_TZ / SYS_EXTRACT_UTC / TZ_OFFSET / NEW_TIME
**Use:**
- `FROM_TZ` attaches a zone to a TIMESTAMP.
- `SYS_EXTRACT_UTC` normalises a value to UTC.
- `TZ_OFFSET` returns a zone's current offset.
```sql
SELECT SYS_EXTRACT_UTC(FROM_TZ(CAST(order_date AS TIMESTAMP), 'Europe/London')) FROM orders;
```
**Business:** Convert legacy local DATEs to UTC for an integration.

#### A50. INTERVAL types and NUMTODSINTERVAL / NUMTOYMINTERVAL / TO_DSINTERVAL / TO_YMINTERVAL
**Use:** Duration arithmetic.
```sql
SELECT shipped_ts - ordered_ts AS lead_time,                           -- INTERVAL DAY TO SECOND
       SYSTIMESTAMP + NUMTODSINTERVAL(:sla_hours, 'HOUR') AS sla_due
FROM orders_tz;
SELECT hire_date + NUMTOYMINTERVAL(1, 'YEAR') AS anniversary FROM employees;
```
**Business:** SLA deadlines for support tickets.
Note: `DATE + INTERVAL '1' MONTH` raises ORA-01839 on 31 January. Use `ADD_MONTHS` for month arithmetic.

#### A51. Extra format elements: IW / IYYY / WW / D / J / SSSSS / FF / TZR / TZD
**Use:** ISO week, Julian date, seconds after midnight and time-zone text.
```sql
SELECT TO_CHAR(order_date, 'IYYY-"W"IW') iso_week, COUNT(*) FROM orders GROUP BY TO_CHAR(order_date, 'IYYY-"W"IW');
```
**Business:** Weekly KPIs using ISO weeks.
Note: The `D` (day-of-week) element depends on `NLS_TERRITORY`.
Source: [Datetime Format Models](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Format-Models.html)

#### A52. VALIDATE_CONVERSION (since 12.2)
**Use:** Returns 1 if a value would convert, otherwise 0.
```sql
SELECT * FROM stg_lines WHERE VALIDATE_CONVERSION(amount_txt AS NUMBER, '999999D99') = 0;
```
**Business:** Pre-validate a CSV import and report bad amounts.
Source: [VALIDATE_CONVERSION](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/VALIDATE_CONVERSION.html)

#### A53. DEFAULT … ON CONVERSION ERROR (since 12.2)
**Use:** Supply a fallback value instead of raising ORA-01722 or ORA-01858. Supported by `CAST`, `TO_NUMBER`, `TO_DATE`, `TO_TIMESTAMP[_TZ]`, `TO_BINARY_*` and `TO_*INTERVAL`.
```sql
SELECT TO_DATE(due_txt DEFAULT '1900-01-01' ON CONVERSION ERROR, 'YYYY-MM-DD'),
       CAST(qty_txt AS NUMBER DEFAULT 0 ON CONVERSION ERROR) FROM stg_lines;
```
**Business:** A tolerant staging-to-core load.

#### Misc functions

#### A54. ORA_HASH
**Use:** A deterministic bucket hash. Arguments are expression, max bucket and seed.
```sql
SELECT * FROM customers WHERE ORA_HASH(customer_id, 9) = 0;  -- ~10% deterministic sample
```
**Business:** Split work across 10 parallel workers.

#### A55. STANDARD_HASH
**Use:** Cryptographic digest returned as RAW. Supports SHA1, SHA256, SHA384, SHA512 and MD5.
```sql
SELECT STANDARD_HASH(iban, 'SHA256') FROM suppliers;
```
**Business:** Detect bank-detail changes without storing extra copies of them.

#### A56. SYS_GUID
**Use:** A globally unique RAW(16) value.
```sql
CREATE TABLE documents (doc_id RAW(16) DEFAULT SYS_GUID() PRIMARY KEY, title VARCHAR2(200));
```
**Business:** Document IDs shared across systems.
Note: There is no `UUID()` function in 19c. SYS_GUID values are not RFC-4122 formatted.

#### A57. LNNVL
**Use:** Returns TRUE when a condition is FALSE **or UNKNOWN**. Allowed in a WHERE clause or a CASE `WHEN` condition, but not in the SELECT list as a bare expression.
```sql
SELECT * FROM products WHERE LNNVL(discontinued = 'Y');
```
**Business:** Include products whose discontinued flag is NULL.

#### A58. NANVL / IS NAN / IS INFINITE
**Use:** Handle the special values of BINARY_FLOAT and BINARY_DOUBLE.
```sql
SELECT NANVL(ratio_bd, 0) FROM kpi WHERE ratio_bd IS NOT INFINITE;
```
**Business:** Clean KPI ratios that come from scientific inputs.

#### A59. WIDTH_BUCKET
**Use:** Equi-width histogram bucket number.
```sql
SELECT WIDTH_BUCKET(total, 0, 1000, 10) bucket, COUNT(*) FROM orders GROUP BY WIDTH_BUCKET(total, 0, 1000, 10);
```
**Business:** Order-value distribution chart.

#### A60. Environment and identity: SYS_CONTEXT('USERENV', …) / USER / UID / ORA_INVOKING_USER
**Use:** Session metadata such as client identifier, module, DB name or IP.
```sql
SELECT SYS_CONTEXT('USERENV','CLIENT_IDENTIFIER'), SYS_CONTEXT('USERENV','CON_NAME') FROM dual;
```
**Business:** Stamp the application user on audit rows.

#### A61. DUMP / VSIZE / ASCIISTR / UNISTR / CHR / ASCII
**Use:** Inspect bytes and encode or decode characters.
```sql
SELECT DUMP(name, 1016), ASCIISTR(name) FROM customers WHERE name <> ASCIISTR(name);
```
**Business:** Find non-ASCII names that break a legacy bank file.

#### A62. BITAND / BIN_TO_NUM
**Use:** Bit operations on flag integers.
```sql
SELECT * FROM users WHERE BITAND(perm_mask, 4) = 4;
```
**Business:** Permission flags.

#### A63. Flashback Query: AS OF TIMESTAMP / SCN
**Use:** Read data as it was at a past point in time, within undo retention. Requires the `FLASHBACK` privilege on the table.
```sql
SELECT * FROM inventory AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '15' MINUTE) WHERE sku = 'A100';
```
**Business:** "What was the stock level before that bad posting?"
Source: [SELECT (flashback_query_clause)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

#### A64. Flashback Version Query: VERSIONS BETWEEN
**Use:** Every committed version of a row, with the pseudocolumns `VERSIONS_STARTTIME`, `VERSIONS_ENDTIME`, `VERSIONS_XID` and `VERSIONS_OPERATION`.
```sql
SELECT versions_starttime, versions_operation, qty FROM inventory
VERSIONS BETWEEN TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR AND SYSTIMESTAMP WHERE sku = 'A100';
```
**Business:** Forensic audit of stock changes.

#### A65. SAMPLE [BLOCK] (pct) [SEED n]
**Use:** Random sampling of a table.
```sql
SELECT * FROM gl_entries SAMPLE (1) SEED (42);
```
**Business:** Pick a random audit sample of journal lines.

#### A66. Deferrable constraints
**Use:** Check a constraint at COMMIT instead of after each statement.
```sql
ALTER TABLE order_lines ADD CONSTRAINT ol_ord_fk2 FOREIGN KEY (order_id) REFERENCES orders DEFERRABLE INITIALLY IMMEDIATE;
SET CONSTRAINT ol_ord_fk2 DEFERRED;
```
**Business:** Insert lines before the header, or swap primary keys, inside one transaction.
Source: [SET CONSTRAINT](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SET-CONSTRAINT.html)

#### A67. Virtual columns
**Use:** A computed column that is not stored. It can be indexed and used for partitioning.
```sql
ALTER TABLE order_lines ADD (line_total NUMBER GENERATED ALWAYS AS (qty * unit_price * (1 - NVL(discount_pct,0)/100)) VIRTUAL);
```
**Business:** A consistent line total everywhere.

#### A68. Invisible columns
**Use:** Columns hidden from `SELECT *` and from INSERT statements without a column list.
```sql
ALTER TABLE customers ADD (legacy_code VARCHAR2(20) INVISIBLE);
```
**Business:** Add a column without breaking legacy `SELECT *` code.

#### A69. Global temporary tables and private temporary tables (18c)
**Use:** Session- or transaction-private scratch data.
- A GTT has a permanent definition.
- A private temporary table (PTT) must use the `ORA$PTT_` prefix and is dropped at the end of the session or transaction.
```sql
CREATE GLOBAL TEMPORARY TABLE gtt_pick (sku VARCHAR2(30), qty NUMBER) ON COMMIT DELETE ROWS;
CREATE PRIVATE TEMPORARY TABLE ora$ptt_calc (id NUMBER) ON COMMIT DROP DEFINITION;
```
**Business:** A per-session pick-list calculation.

#### A70. Materialized views and refresh
**Use:** Store a query result. Refresh options:
- `COMPLETE` or `FAST` (needs MV logs) or `FORCE`.
- `ON DEMAND`, `ON COMMIT`, or `ON STATEMENT` (12.2).
- Query rewrite can be enabled.
- `ENABLE ON QUERY COMPUTATION` gives a real-time MV (12.2).
```sql
CREATE MATERIALIZED VIEW LOG ON orders WITH ROWID, SEQUENCE (customer_id, total) INCLUDING NEW VALUES;
CREATE MATERIALIZED VIEW mv_cust_sales REFRESH FAST ON COMMIT ENABLE QUERY REWRITE AS
  SELECT customer_id, COUNT(*) cnt, COUNT(total) cnt_total, SUM(total) sum_total FROM orders GROUP BY customer_id;
EXEC DBMS_MVIEW.REFRESH('MV_CUST_SALES', 'C');
```
**Business:** A pre-aggregated customer revenue table for dashboards.
Sources: [CREATE MATERIALIZED VIEW](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-MATERIALIZED-VIEW.html) · [DBMS_MVIEW](https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_MVIEW.html)

#### A71. Partitioning (RANGE / INTERVAL / LIST / AUTOMATIC LIST / HASH / reference)
**Use:** Split a large table. Partitioning is an EE option.
```sql
CREATE TABLE gl_entries (entry_id NUMBER, posting_date DATE, amount NUMBER)
PARTITION BY RANGE (posting_date) INTERVAL (NUMTOYMINTERVAL(1,'MONTH'))
(PARTITION p0 VALUES LESS THAN (DATE '2020-01-01'));
```
**Business:** Monthly GL partitions, so old periods can be archived with partition operations.

#### A72. ALTER TABLE … READ ONLY / READ WRITE
**Use:** Freeze a table.
```sql
ALTER TABLE gl_entries_2023 READ ONLY;
```
**Business:** Lock a closed fiscal year.

#### A73. EXPLAIN PLAN / DBMS_XPLAN
**Use:** Show the optimizer's plan. `DISPLAY_CURSOR` with the `GATHER_PLAN_STATISTICS` hint shows actual row counts.
```sql
EXPLAIN PLAN FOR SELECT * FROM orders WHERE customer_id = :c;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));
```
**Business:** Diagnose a slow order-search screen.
Sources: [EXPLAIN PLAN](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/EXPLAIN-PLAN.html) · [DBMS_XPLAN](https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_XPLAN.html)

#### A74. DBMS_STATS
**Use:** Gather optimizer statistics.
```sql
EXEC DBMS_STATS.GATHER_TABLE_STATS(ownname => USER, tabname => 'ORDERS', cascade => TRUE);
```
**Business:** Gather statistics after a bulk load so plans stay good.
Source: [DBMS_STATS](https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_STATS.html)

#### A75. Optimizer hints (brief)
**Use:** Steer the optimizer. Use them sparingly. Common ones are `INDEX`, `FULL`, `LEADING`, `USE_NL`, `USE_HASH`, `PARALLEL(n)`, `APPEND`, `MATERIALIZE`, `GATHER_PLAN_STATISTICS`, `RESULT_CACHE`, `NO_MERGE` and `FIRST_ROWS(n)`.
```sql
SELECT /*+ INDEX(o ord_cust_ix) FIRST_ROWS(20) */ * FROM orders o WHERE customer_id = :c;
```
**Business:** Pin the plan of a critical OLTP lookup.
Source: [Comments and hints](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Comments.html)

---

### Tier 4: Expert

Sources: [SQL for Modeling](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-modeling-data-warehouses.html) · [SQL for Pattern Matching](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-pattern-matching-data-warehouses.html) · [JSON Developer's Guide 19c](https://docs.oracle.com/en/database/oracle/oracle-database/19/adjsn/) · [XML DB Developer's Guide 19c](https://docs.oracle.com/en/database/oracle/oracle-database/19/adxdb/) · [Collection functions and multiset conditions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Multiset-Operators.html) · [SQL macros: PL/SQL Language Reference 19c](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/SQL_MACRO-clause.html)

#### MODEL and MATCH_RECOGNIZE

#### E1. MODEL clause
**Use:** Spreadsheet-style cell calculations over a result set.
```sql
SELECT region, yr, sales FROM annual_sales
MODEL PARTITION BY (region) DIMENSION BY (yr) MEASURES (sales)
RULES UPSERT (
  sales[2026] = sales[2025] * 1.08,
  sales[2027] = sales[2026] * 1.08
)
ORDER BY region, yr;
```
**Business:** A two-year sales forecast in SQL.
Note: `ITERATE (n) [UNTIL cond]`, `AUTOMATIC ORDER`, `CV()`, `FOR` loops, `PRESENTV`/`PRESENTNNV` and `IS PRESENT` are also available.

#### E2. MATCH_RECOGNIZE (row pattern matching, since 12.1)
**Use:** Detect regex-like patterns across ordered rows.
```sql
SELECT * FROM stock_prices MATCH_RECOGNIZE (
  PARTITION BY ticker ORDER BY trade_date
  MEASURES STRT.trade_date AS start_dt, LAST(DOWN.trade_date) AS bottom_dt, LAST(UP.trade_date) AS end_dt
  ONE ROW PER MATCH
  AFTER MATCH SKIP TO LAST UP
  PATTERN (STRT DOWN+ UP+)
  DEFINE DOWN AS DOWN.price < PREV(DOWN.price), UP AS UP.price > PREV(UP.price)
);
```
**Business:** Fraud and usage analytics: V-shaped price moves, sessionisation, or runs of three failed payments.
Note: `ALL ROWS PER MATCH`, `CLASSIFIER()`, `MATCH_NUMBER()`, `SUBSET`, `{n,m}` quantifiers, `PERMUTE` and `^`/`$` anchors are also available.

#### JSON (19c)

19c stores JSON in `VARCHAR2`, `CLOB` or `BLOB`, with an `IS JSON` check constraint. There is **no JSON data type** in 19c.

#### E3. IS JSON / IS NOT JSON (STRICT | LAX, WITH UNIQUE KEYS)
**Use:** Validate JSON text. The constraint also enables dot notation on the column.
```sql
CREATE TABLE po_docs (id NUMBER PRIMARY KEY, doc CLOB CONSTRAINT po_doc_json CHECK (doc IS JSON (STRICT)));
```
**Business:** Store purchase orders received as JSON.

#### E4. JSON_VALUE
**Use:** Extract a scalar value. The default return type is `VARCHAR2(4000)`, and the default error behaviour is **NULL ON ERROR**, which is silent.
```sql
SELECT JSON_VALUE(doc, '$.supplier.id' RETURNING NUMBER ERROR ON ERROR) supplier_id,
       JSON_VALUE(doc, '$.total' RETURNING NUMBER DEFAULT 0 ON EMPTY) total
FROM po_docs;
```
**Business:** Pull indexed fields out of PO documents.
Note: A function-based index on `JSON_VALUE` makes these filters fast.

#### E5. JSON_QUERY
**Use:** Extract an object or array fragment. `WITH [CONDITIONAL] WRAPPER` wraps scalars in an array. `PRETTY` formats the output.
```sql
SELECT JSON_QUERY(doc, '$.lines[*].sku' WITH WRAPPER) skus FROM po_docs;
```
**Business:** All SKUs on a PO as a JSON array.

#### E6. JSON_EXISTS (with filter expressions)
**Use:** A path existence test, which can include predicates and bind variables via `PASSING`.
```sql
SELECT id FROM po_docs WHERE JSON_EXISTS(doc, '$.lines?(@.qty > $min)' PASSING 100 AS "min");
```
**Business:** POs with any line over 100 units.

#### E7. JSON_TABLE (with NESTED PATH and FOR ORDINALITY)
**Use:** Turn JSON into relational rows.
```sql
SELECT p.id, jt.* FROM po_docs p,
JSON_TABLE(p.doc, '$' COLUMNS (
  po_no VARCHAR2(20) PATH '$.poNumber',
  NESTED PATH '$.lines[*]' COLUMNS (
    line_no FOR ORDINALITY,
    sku     VARCHAR2(30) PATH '$.sku',
    qty     NUMBER       PATH '$.qty' DEFAULT 0 ON EMPTY
  ))) jt;
```
**Business:** Load JSON PO lines into `order_lines`.
Source: [JSON_TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/JSON_TABLE.html)

#### E8. Simple dot notation
**Use:** `alias.col.field` access. Requires a table alias and an `IS JSON` constraint on the column. Returns VARCHAR2(4000), or NULL on error.
```sql
SELECT p.doc.supplier.name, p.doc.lines[0].sku FROM po_docs p;
```
**Business:** Quick ad-hoc queries on documents.
Note: Item methods such as `.number()`, `.string()`, `.size()` and `.type()` are available in path expressions.

#### E9. JSON_OBJECT / JSON_ARRAY (generation)
**Use:** Build JSON from relational data. Supports `KEY … VALUE`, the `'k' VALUE v` form, `ABSENT ON NULL` and `RETURNING CLOB`. 19c also allows `JSON_OBJECT(*)`.
```sql
SELECT JSON_OBJECT('id' VALUE customer_id, 'name' VALUE name, 'tags' VALUE JSON_ARRAY(segment, country) ABSENT ON NULL RETURNING CLOB) FROM customers;
```
**Business:** Build a customer API payload in SQL.

#### E10. JSON_ARRAYAGG / JSON_OBJECTAGG
**Use:** Aggregate rows into a JSON array or object.
```sql
SELECT o.order_id, JSON_ARRAYAGG(JSON_OBJECT('sku' VALUE l.sku, 'qty' VALUE l.qty) ORDER BY l.line_no RETURNING CLOB) lines
FROM orders o JOIN order_lines l ON l.order_id = o.order_id GROUP BY o.order_id;
```
**Business:** A nested order document for an integration feed. This is the core pattern for Mira document reads.
Note: The default return type is VARCHAR2(4000). Use `RETURNING CLOB` for large documents.

#### E11. JSON_MERGEPATCH (19c) / JSON_SERIALIZE (19c) / JSON_DATAGUIDE
**Use:** Apply an RFC 7396 patch, serialise or pretty-print JSON, or infer a schema from documents.
```sql
UPDATE po_docs SET doc = JSON_MERGEPATCH(doc, '{"status":"APPROVED","approver":null}') WHERE id = :id;
SELECT JSON_SERIALIZE(doc PRETTY) FROM po_docs WHERE id = :id;
```
**Business:** Partial document update on PO approval.
Note: Mira's `$set`/`$unset` map naturally to JSON_MERGEPATCH. Array operators such as `$push` and `$pull` have **no** 19c SQL function (JSON_TRANSFORM is 21c). They need read-modify-write or PL/SQL `JSON_OBJECT_T` / `JSON_ARRAY_T`.
Sources: [JSON_MERGEPATCH](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/JSON_MERGEPATCH.html) · [JSON_SERIALIZE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/JSON_SERIALIZE.html)

#### E12. JSON_EQUAL (condition)
**Use:** Compare JSON semantically, ignoring key order and whitespace.
```sql
SELECT * FROM po_docs a JOIN po_docs_backup b ON a.id = b.id WHERE NOT JSON_EQUAL(a.doc, b.doc);
```
**Business:** Detect real changes between document versions.
Source: [JSON_EQUAL condition](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/JSON_EQUAL-Condition.html)

#### E13. JSON search index
**Use:** A full-text and path index across JSON documents. Used by `JSON_EXISTS` and `JSON_TEXTCONTAINS`.
```sql
CREATE SEARCH INDEX po_docs_sx ON po_docs (doc) FOR JSON;
```
**Business:** Ad-hoc search across PO documents.

#### XML

#### E14. XMLELEMENT / XMLATTRIBUTES / XMLFOREST / XMLAGG / XMLSERIALIZE
**Use:** Generate XML.
```sql
SELECT XMLSERIALIZE(DOCUMENT XMLELEMENT("Invoice", XMLATTRIBUTES(i.invoice_id AS "id"),
         XMLAGG(XMLELEMENT("Line", XMLFOREST(l.sku AS "Sku", l.amount AS "Amt")) ORDER BY l.line_no)) AS CLOB INDENT)
FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.invoice_id GROUP BY i.invoice_id;
```
**Business:** An e-invoicing XML export.

#### E15. XMLAGG string-concatenation trick
**Use:** Concatenate more than 4000 bytes into a CLOB, which LISTAGG cannot do in 19c.
```sql
SELECT RTRIM(XMLAGG(XMLELEMENT(e, sku || ',') ORDER BY sku).EXTRACT('//text()').getClobVal(), ',') FROM products;
```
**Business:** Export the entire SKU list as one field.
Note: `XMLCAST(XMLAGG(...) AS CLOB)` is also valid, but escapes `&`, `<` and `>`.

#### E16. XMLTABLE / XMLQUERY / XMLEXISTS
**Use:** Shred or query XML with XQuery.
```sql
SELECT x.* FROM bank_stmt b, XMLTABLE('/Document/Stmt/Ntry' PASSING b.xml_doc COLUMNS amt NUMBER PATH 'Amt', ref VARCHAR2(50) PATH 'NtryRef') x;
```
**Business:** Parse ISO 20022 camt.053 bank statements.

#### Inline PL/SQL, collections and objects

#### E17. WITH FUNCTION / WITH PROCEDURE (inline PL/SQL, since 12.1)
**Use:** Define PL/SQL inside a query. In SQL*Plus, end the statement with `/`. When this is a subquery of a DML statement, use the `/*+ WITH_PLSQL */` hint.
```sql
WITH FUNCTION net(p_gross NUMBER, p_rate NUMBER) RETURN NUMBER IS
BEGIN RETURN ROUND(p_gross / (1 + p_rate/100), 2); END;
SELECT invoice_id, net(amount, vat_rate) FROM invoices
/
```
**Business:** A one-off VAT back-calculation without creating a schema object.

#### E18. PRAGMA UDF
**Use:** Optimise a schema PL/SQL function for calls from SQL.
```sql
CREATE OR REPLACE FUNCTION fx_rate(p_ccy VARCHAR2) RETURN NUMBER IS PRAGMA UDF; BEGIN RETURN 1; END;
```
**Business:** Faster per-row currency conversion.

#### E19. TABLE() collection unnesting
**Use:** Query a SQL collection or pipelined function as rows. Built-in types such as `SYS.ODCINUMBERLIST` and `SYS.ODCIVARCHAR2LIST` are convenient.
```sql
SELECT column_value AS sku FROM TABLE(sys.odcivarchar2list('A100','B200','C300'));
SELECT * FROM orders WHERE order_id IN (SELECT column_value FROM TABLE(:id_list));  -- bind a collection
```
**Business:** Pass an unlimited list of IDs as one bind variable, which avoids ORA-01795.

#### E20. CAST(MULTISET(…) AS type) / COLLECT
**Use:** Build a nested collection from a subquery or an aggregate.
```sql
CREATE TYPE sku_tab AS TABLE OF VARCHAR2(30);
/
SELECT o.order_id, CAST(MULTISET(SELECT sku FROM order_lines l WHERE l.order_id = o.order_id) AS sku_tab) skus FROM orders o;
SELECT customer_id, CAST(COLLECT(DISTINCT sku) AS sku_tab) FROM order_lines GROUP BY customer_id;
```
**Business:** Pass order line SKUs as one value to a pricing routine.

#### E21. Multiset operators and conditions (nested tables)
**Use:** Set algebra on collections. Operators are `MULTISET UNION | INTERSECT | EXCEPT [ALL|DISTINCT]`. Functions are `CARDINALITY`, `SET()`, `POWERMULTISET` and `POWERMULTISET_BY_CARDINALITY`. Conditions are `IS A SET`, `IS [NOT] EMPTY`, `MEMBER OF` and `SUBMULTISET OF`.
```sql
SELECT * FROM promo_rules r WHERE :cart_skus SUBMULTISET OF r.required_skus OR 'A100' MEMBER OF r.required_skus;
```
**Business:** Check whether a cart qualifies for a bundle promotion.
Note: `MULTISET EXCEPT` here is a collection operator, not the 21c query set operator `EXCEPT`.

#### E22. Object types, TREAT, IS OF, VALUE, REF/DEREF
**Use:** Object-relational features.
```sql
SELECT TREAT(VALUE(p) AS contractor_t).day_rate FROM persons p WHERE VALUE(p) IS OF (contractor_t);
```
**Business:** Model a subtype hierarchy of employees and contractors.

#### E23. Pipelined table functions
**Use:** PL/SQL that streams rows into SQL.
```sql
SELECT * FROM TABLE(fx_pkg.rates_for(DATE '2025-06-30'));
```
**Business:** An FX rate table built from an external feed.

#### E24. Polymorphic table functions (18c)
**Use:** Table functions whose output shape depends on their input table. Implemented through `DBMS_TF`.
```sql
SELECT * FROM mask_pii(customers COLUMNS(email, phone));
```
**Business:** Generic PII masking for non-production copies.
Source: [DBMS_TF](https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_TF.html)

#### E25. SQL table macros (19c, RU 19.6+, TABLE macros only)
**Use:** A function returns SQL text that the optimizer inlines as a parameterised view. Scalar macros are 21c.
```sql
CREATE OR REPLACE FUNCTION top_n(t DBMS_TF.TABLE_T, n NUMBER) RETURN VARCHAR2 SQL_MACRO IS
BEGIN RETURN 'SELECT * FROM t FETCH FIRST n ROWS ONLY'; END;
/
SELECT * FROM top_n(orders, 5);
```
**Business:** A reusable "current period" filter applied to any fact table.
Note: Verify the exact 19c RU before Mira relies on this.

#### Advanced aggregation and analytics

#### E26. Analytic functions combined with aggregates (nested)
**Use:** Run window functions over the grouped result.
```sql
SELECT region, SUM(total) rev, RANK() OVER (ORDER BY SUM(total) DESC) rnk,
       SUM(SUM(total)) OVER () grand_total FROM orders GROUP BY region;
```
**Business:** Rank regions and show the grand total in one query.

#### E27. Hypothetical rank and distribution: RANK/DENSE_RANK/CUME_DIST/PERCENT_RANK (expr) WITHIN GROUP (ORDER BY …)
**Use:** "Where would this value rank?"
```sql
SELECT RANK(85000) WITHIN GROUP (ORDER BY salary DESC) FROM employees WHERE job_id = 'DEV';
```
**Business:** Where a candidate's offer would rank among existing staff.

#### E28. Approximate aggregation materialisation: APPROX_COUNT_DISTINCT_DETAIL / _AGG / TO_APPROX_COUNT_DISTINCT
**Use:** Store approximate distinct-count sketches and roll them up later.
```sql
SELECT TO_APPROX_COUNT_DISTINCT(APPROX_COUNT_DISTINCT_AGG(detail)) FROM daily_visitor_sketch WHERE day BETWEEN :a AND :b;
```
**Business:** Monthly unique visitors computed from daily sketches.

#### E29. STATS_* tests (STATS_T_TEST_*, STATS_F_TEST, STATS_CROSSTAB, STATS_ONE_WAY_ANOVA, STATS_MW_TEST, STATS_KS_TEST, STATS_WSR_TEST, STATS_BINOMIAL_TEST)
**Use:** Statistical hypothesis tests in SQL.
```sql
SELECT STATS_T_TEST_INDEP(variant, conv_rate, 'STATISTIC', 'A') t_stat, STATS_T_TEST_INDEP(variant, conv_rate) p_value FROM ab_test;
```
**Business:** Significance testing for a price A/B experiment.

#### E30. Data-mining functions (PREDICTION, CLUSTER_ID, FEATURE_*)
**Use:** Score data with an Oracle Machine Learning model. Requires the OML option and a trained model.
```sql
SELECT customer_id, PREDICTION_PROBABILITY(churn_model, 1 USING *) p_churn FROM customers;
```
**Business:** Churn scoring.

#### Concurrency, transactions and integrity

#### E31. Autonomous transactions (PL/SQL)
**Use:** Commit independently of the caller.
```sql
CREATE OR REPLACE PROCEDURE log_err(p_msg VARCHAR2) IS PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN INSERT INTO app_log(msg) VALUES (p_msg); COMMIT; END;
```
**Business:** Keep error logs that survive the business transaction's rollback.

#### E32. DBMS_LOCK / DBMS_LOCK.ALLOCATE_UNIQUE (user locks)
**Use:** Application-level mutexes. Requires an EXECUTE grant.
```sql
DECLARE h VARCHAR2(128); r INTEGER; BEGIN DBMS_LOCK.ALLOCATE_UNIQUE('PERIOD_CLOSE', h); r := DBMS_LOCK.REQUEST(h, DBMS_LOCK.X_MODE, 10, TRUE); END;
```
**Business:** Allow only one month-end close job at a time.

#### E33. ORA_ROWSCN / SCN_TO_TIMESTAMP / TIMESTAMP_TO_SCN
**Use:** Approximate last-change SCN for optimistic locking. Block-level unless the table was created with `ROWDEPENDENCIES`.
```sql
SELECT ORA_ROWSCN, SCN_TO_TIMESTAMP(ORA_ROWSCN) FROM orders WHERE order_id = :id;
```
**Business:** Optimistic-concurrency check on order edits. A version column is more portable.

#### E34. FLASHBACK TABLE … TO TIMESTAMP and the Flashback Data Archive
**Use:** Rewind a table, which requires `ENABLE ROW MOVEMENT`. Flashback Data Archive provides long-term history.
```sql
ALTER TABLE prices ENABLE ROW MOVEMENT;
FLASHBACK TABLE prices TO TIMESTAMP SYSTIMESTAMP - INTERVAL '10' MINUTE;
```
**Business:** Undo a mistaken mass price update.

#### E35. Edition-based redefinition, and online DDL (`ONLINE`, `DBMS_REDEFINITION`)
**Use:** Zero-downtime schema changes.
```sql
ALTER TABLE orders MOVE ONLINE;
CREATE INDEX ord_date_ix ON orders(order_date) ONLINE;
```
**Business:** Reorganise the order table during business hours.

#### E36. Real-time materialized view and query rewrite
**Use:** Query rewrite against a stale MV combined with its logs gives fresh answers. Covered in A70; the expert form is the `FRESH_MV` hint.
```sql
SELECT /*+ FRESH_MV */ * FROM mv_cust_sales;
```
**Business:** Dashboard totals that are both fast and current.

#### E37. Result cache
**Use:** Cache query or function results in the SGA.
```sql
SELECT /*+ RESULT_CACHE */ ccy, rate FROM fx_rates WHERE rate_date = TRUNC(SYSDATE);
```
**Business:** Frequently read reference data.

#### E38. Blockchain / immutable tables (backported to 19.10 / 19.11 RUs)
**Use:** Insert-only, tamper-evident tables.
```sql
CREATE IMMUTABLE TABLE gl_audit (id NUMBER, entry CLOB) NO DROP UNTIL 365 DAYS IDLE NO DELETE UNTIL 365 DAYS AFTER INSERT;
```
**Business:** A tamper-proof audit ledger.
Note: These are RU-dependent and require `COMPATIBLE` to be set high enough. Treat them as **unavailable** unless the target RU is confirmed.

---

### Not in 19c: avoid these

Each feature below either does not exist in 19c or exists only in some 19c release updates. Generated SQL must not use them.

| # | Feature | Introduced | 19c alternative |
|---|---|---|---|
| 1 | SQL `BOOLEAN` data type, `TRUE`/`FALSE` literals in SQL, `IS [NOT] TRUE` | 23ai | `NUMBER(1)` or `CHAR(1)` with a CHECK constraint (BOOLEAN exists only in PL/SQL) |
| 2 | `SELECT` without `FROM` (`SELECT 1;`) | 23ai | `FROM dual` |
| 3 | `GROUP BY` column alias or position; alias in `HAVING` | 23ai | Repeat the expression, or wrap the query in an inline view |
| 4 | `IF [NOT] EXISTS` in CREATE, DROP or ALTER | 23ai | PL/SQL block that catches ORA-00955 / ORA-00942, or a dictionary check |
| 5 | Table value constructor: multi-row `INSERT … VALUES (..),(..)`, and `VALUES` in FROM, WITH or MERGE USING | 23ai | `INSERT ALL … SELECT FROM dual`, or `UNION ALL` of `SELECT … FROM dual` |
| 6 | SQL domains (`CREATE DOMAIN`, `DOMAIN_CHECK`, `DOMAIN_DISPLAY`) | 23ai | CHECK constraints and views |
| 7 | Schema annotations (`ANNOTATIONS (...)`) | 23ai | `COMMENT ON` |
| 8 | Direct joins in UPDATE or DELETE (`UPDATE t … FROM s`, `DELETE t FROM t JOIN s`) | 23ai | MERGE, a correlated subquery, or an updatable join view (I29) |
| 9 | `RETURNING OLD … / NEW …` in UPDATE or MERGE | 23ai | RETURNING with post-change values only (no RETURNING with MERGE in 19c) |
| 10 | `DEFAULT ON NULL FOR INSERT AND UPDATE` | 23ai | `DEFAULT ON NULL` (INSERT only), or a trigger |
| 11 | Schema-level privileges (`GRANT SELECT ANY TABLE ON SCHEMA s`), `DB_DEVELOPER_ROLE` | 23ai | Per-object grants and roles |
| 12 | Native `JSON` data type, `JSON_SCALAR`, OSON storage by default | 21c | CLOB, BLOB or VARCHAR2 with `IS JSON` |
| 13 | `JSON_TRANSFORM` (absent from the 19c function list; some later 19c RUs backport parts of it) | 21c | `JSON_MERGEPATCH`, PL/SQL `JSON_OBJECT_T`, or rebuilding the document |
| 14 | JSON Schema validation (`IS JSON VALIDATING`, `DBMS_JSON_SCHEMA`), JSON-relational duality views, `JSON_ID` | 23ai | Check constraints or application-side validation |
| 15 | Set operators `EXCEPT`, `EXCEPT ALL`, `INTERSECT ALL`, `MINUS ALL` | 21c | `MINUS` / `INTERSECT` (distinct), or `ROW_NUMBER` tricks to emulate ALL semantics |
| 16 | Window frame unit `GROUPS`, frame `EXCLUDE CURRENT ROW / GROUP / TIES / NO OTHERS`, named `WINDOW` clause | 21c | ROWS or RANGE frames; repeat the OVER clause |
| 17 | `ANY_VALUE` aggregate (absent from the 19c aggregate list; present in some 19c RUs) | 21c | `MIN()` / `MAX()` |
| 18 | `BIT_AND_AGG`, `BIT_OR_AGG`, `BIT_XOR_AGG`, `CHECKSUM` aggregate | 21c | PL/SQL, or `BITAND` over pre-aggregated values |
| 19 | `KURTOSIS_POP/SAMP`, `SKEWNESS_POP/SAMP` | 21c | Compute from moments with SUM and POWER |
| 20 | Scalar SQL macros | 21c | Table macros (19.6+) or PL/SQL functions |
| 21 | `CEIL`/`FLOOR`/`ROUND`/`TRUNC` on INTERVAL; `SUM`/`AVG` over INTERVAL values | 23ai | Convert to seconds or days with EXTRACT, then use NUMTODSINTERVAL |
| 22 | `TIME_BUCKET` | 23ai | `TRUNC(date, fmt)` or arithmetic on `date - epoch` |
| 23 | `VECTOR` data type, `VECTOR_DISTANCE`, `FETCH APPROX`, partitioned row limiting (`FETCH FIRST … PARTITION BY`) | 23ai | No equivalent; use `ROW_NUMBER() OVER (PARTITION BY …)` for per-group top-N |
| 24 | SQL property graphs (`CREATE PROPERTY GRAPH`, `GRAPH_TABLE`) | 23ai | Recursive WITH or CONNECT BY |
| 25 | Lock-free reservable columns (`RESERVABLE`) | 23ai | `SELECT … FOR UPDATE`, or a conditional `UPDATE … SET qty = qty - :n WHERE qty >= :n` |
| 26 | `UUID()` function | 23ai (later RU) | `SYS_GUID()` |
| 27 | Tables wider than 1000 columns (`MAX_COLUMNS=EXTENDED`, up to 4096) | 23ai | Split tables, or store extra attributes as JSON |
| 28 | `CREATE MLE MODULE` / JavaScript stored procedures | 21c (functions) / 23ai (modules) | PL/SQL |
| 29 | `TO_UTC_TIMESTAMP_TZ`, `FROM_VECTOR` and other 23ai helpers | 23ai | `SYS_EXTRACT_UTC(TO_TIMESTAMP_TZ(…))` |
| 30 | Blockchain and immutable tables (E38) | 21c (RU backports 19.10 / 19.11) | Treat as unavailable unless the RU is confirmed |
| 31 | SQL table macros (E25) | 19.6 RU | Inline views; confirm the RU first |
| 32 | `LISTAGG` returning CLOB, or with no length limit | Not available in any release (21c+ allows omitting WITHIN GROUP) | `ON OVERFLOW TRUNCATE`, the XMLAGG trick (E15), or `JSON_ARRAYAGG … RETURNING CLOB` |

Sources: [21c New Features](https://docs.oracle.com/en/database/oracle/oracle-database/21/nfcon/) · [23ai New Features](https://docs.oracle.com/en/database/oracle/oracle-database/23/nfcoa/) · [19c Aggregate Functions list](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Aggregate-Functions.html) · [19c Single-Row Functions list](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html)

---

### Common pitfalls

Sources: [Nulls](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Nulls.html) · [Data Type Comparison Rules / Implicit Conversion](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Type-Comparison-Rules.html) · [Expression lists](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Expression-Lists.html) · [ROWNUM](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROWNUM-Pseudocolumn.html) · [Datetime comparisons](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Types.html)

**P1. NULL in NOT IN.** `x NOT IN (1, NULL)` is never TRUE, so the query returns **no rows**. The same happens with a NOT IN subquery that yields any NULL. Use `NOT EXISTS`, or filter `WHERE col IS NOT NULL` inside the subquery. More generally, any comparison with NULL is UNKNOWN, and WHERE and CHECK treat UNKNOWN differently: WHERE rejects the row, CHECK accepts it.

**P2. ORA-01795: at most 1000 expressions in an IN list.** The limit applies to literal or bind lists. Workarounds:
- Bind a collection and use `IN (SELECT column_value FROM TABLE(:coll))` (E19).
- Use a GTT or a join.
- Use `JSON_TABLE` over a bound JSON array.
- Chunk the list with `OR col IN (…) OR col IN (…)`.

The tuple trick `(1, col) IN ((1,:a),(1,:b),…)` avoids the limit but performs poorly. Separately, a statement has a limit of 65535 bind variables.

**P3. Empty string is NULL.** In Oracle, `''` is NULL for VARCHAR2. `WHERE col = ''` matches nothing, `LENGTH('')` is NULL, and `'a' || NULL` is `'a'`. A MongoDB-style `{field: ""}` cannot be told apart from null or a missing field in a VARCHAR2 column. This is critical for Mira semantics.

**P4. Implicit conversion.**
- `WHERE varchar_col = 123` converts the **column** to a number. That disables the index and can raise ORA-01722 on non-numeric rows.
- `WHERE date_col = '2025-01-01'` depends on `NLS_DATE_FORMAT`.
- Fix: always use explicit `TO_DATE` or `TO_NUMBER`, ANSI literals, or binds of the correct type.
- Comparing a `NUMBER` bind to a `VARCHAR2` column, or an `NVARCHAR2` bind to a `VARCHAR2` column, also prevents index use.

**P5. DATE always has a time.**
- `WHERE order_date = DATE '2025-06-30'` misses rows with a non-midnight time.
- `BETWEEN DATE '2025-06-01' AND DATE '2025-06-30'` excludes 30 June after 00:00.
- Use a half-open range: `>= DATE '2025-06-01' AND < DATE '2025-07-01'`.
- `TRUNC(col) = …` disables a normal index; it needs a function-based index.

**P6. TIMESTAMP vs TIMESTAMP WITH TIME ZONE, and the session time zone.**
- Comparing a `TIMESTAMP` (no zone) with a `TSTZ` converts the TIMESTAMP using the **session** time zone. The same data can give different results for clients in different zones.
- `SYSDATE` and `SYSTIMESTAMP` use the DB server OS zone. `CURRENT_*` and `LOCALTIMESTAMP` use the session zone. `DBTIMEZONE` affects only TSLTZ.
- Drivers set the session time zone from the client. node-oracledb can use the client's TZ, so set `ORA_SDTZ` or `ALTER SESSION SET TIME_ZONE` explicitly.
- Store UTC in `TIMESTAMP`, or use TSTZ, and be consistent.
- `TSTZ` cannot be part of a PK or UNIQUE constraint.
- DST gaps raise ORA-01878 when constructing non-existent local times.

**P7. ROWNUM is assigned before ORDER BY.**
- `SELECT * FROM t WHERE ROWNUM <= 10 ORDER BY x` returns 10 arbitrary rows, then sorts them.
- Order inside an inline view first, or use `FETCH FIRST`.
- `WHERE ROWNUM > 1` or `ROWNUM = 2` never returns rows.

**P8. ORDER BY is not guaranteed without an explicit sort.** GROUP BY and DISTINCT do not sort. Paging is unstable without a unique tie-breaker.

**P9. ORA-30926 in MERGE.** The source has duplicate keys for one target row. Deduplicate the source with GROUP BY or ROW_NUMBER.

**P10. ORA-01427 and ORA-00937 / ORA-00979.** A single-row subquery returned more than one row, or a non-grouped column appears with an aggregate.

**P11. VARCHAR2 length is in bytes by default.** `VARCHAR2(10)` holds 10 **bytes**, so multibyte text can fail with ORA-12899. Use `VARCHAR2(10 CHAR)`. The maximum is 4000 bytes unless `MAX_STRING_SIZE=EXTENDED`.

**P12. CLOB restrictions.**
- CLOB columns cannot be used in `DISTINCT`, `GROUP BY`, `ORDER BY`, `UNION` (except `UNION ALL`), `IN` subqueries or joins with `=` (ORA-00932).
- Use `DBMS_LOB.SUBSTR` or `DBMS_LOB.COMPARE` instead.
- JSON in CLOB needs `RETURNING` for large results.

**P13. JSON functions fail silently by default.** `JSON_VALUE` and `JSON_QUERY` default to `NULL ON ERROR` and return `VARCHAR2(4000)`. Use `ERROR ON ERROR` in tests, and `RETURNING NUMBER`, `DATE` or `CLOB` as needed.

**P14. LISTAGG ORA-01489.** The result is limited to 4000 or 32767 bytes. Use `ON OVERFLOW TRUNCATE`, or the CLOB alternatives listed in "Not in 19c" #32.

**P15. Identifier case and length.**
- Unquoted identifiers are stored in UPPERCASE.
- `"camelCase"` must be quoted forever after it is created that way.
- The maximum identifier length is 128 bytes (12.2+). An older `COMPATIBLE` setting limits it to 30.
- Reserved words such as `DATE`, `LEVEL`, `SIZE`, `COMMENT`, `USER` and `ORDER` fail as unquoted column names. This matters when MongoDB field names are mapped to columns.

**P16. DDL commits implicitly.** CREATE, ALTER, DROP and TRUNCATE commit any pending transaction before and after they run. Do not mix DDL into business transactions.

**P17. Sequences have gaps and are not ordered across RAC nodes.** Never assume they are consecutive.

**P18. Number semantics.** `NUMBER` is decimal with up to 38 digits, while `BINARY_DOUBLE` is IEEE floating point. JavaScript numbers round-trip lossily above 2^53, so fetch large NUMBERs as strings. Integer division does not exist: `7/2 = 3.5`, so use `TRUNC(7/2)`.

**P19. Case-sensitive comparison by default.**
- `=`, `LIKE` and `ORDER BY` are binary comparisons, so they are case-sensitive.
- For case-insensitive behaviour, use `UPPER()` with a function-based index, or `NLS_COMP=LINGUISTIC` with `NLS_SORT=BINARY_CI` (per session), or a column `COLLATE BINARY_CI`.
- `COLLATE BINARY_CI` (12.2+) requires `MAX_STRING_SIZE=EXTENDED`.

**P20. SELECT FOR UPDATE combined with ROWNUM or FETCH FIRST.** `FETCH FIRST` with `FOR UPDATE` raises ORA-02014. `ROWNUM` with `SKIP LOCKED` can return fewer rows than requested.

**P21. NLS-dependent output.** `TO_CHAR(date, 'Day')`, `NEXT_DAY` and `D` depend on `NLS_DATE_LANGUAGE` or `NLS_TERRITORY`. The decimal separator depends on `NLS_NUMERIC_CHARACTERS`. Set NLS parameters explicitly in the function call or the session.

**P22. UNION removes duplicates and sorts.** Use `UNION ALL` unless de-duplication is intended.

**P23. `NULL = NULL` in DECODE vs CASE, and NULL sort order.** DECODE treats NULLs as equal; CASE does not. NULLs sort last in ASC and first in DESC order unless you specify `NULLS FIRST` or `NULLS LAST`.

**P24. Outer join filters.** Putting a right-table predicate in WHERE instead of ON turns a LEFT JOIN into an inner join.

**P25. Read consistency and ORA-01555.** Long-running queries can fail with "snapshot too old" when undo is overwritten. Flashback queries are limited by undo retention.

---

### Entry counts

- Basic: 41 (B1–B41)
- Intermediate: 55 (I1–I55)
- Advanced: 75 (A1–A75)
- Expert: 38 (E1–E38)
- **Total catalogued entries: 209**
- Not in 19c: 32 rows
- Common pitfalls: 25

---

# Part 3: Accounting and finance patterns

## Accounting and Finance SQL Patterns for Oracle 19c

A catalog of 35 real-world query patterns from general ledger, AR/AP, treasury, fixed assets and payroll systems, ordered Basic -> Expert. Each pattern lists: tier, business purpose, Oracle features, tables, a 19c-valid SQL example, how an in-memory JS model can verify it, and traps.

Every pattern is marked **verified on 19c** or **unverified**. All 35 are verified: each SQL block was executed on **Oracle Database 19c EE 19.19** (the local `oracle19c` container) against session-private temporary copies of the tables below with seeded sample data, and the results were checked by hand. See "Validation notes" at the end.

---

### 0. Conventions and shared schema

#### Conventions used everywhere

* **Money** is `NUMBER(14,2)`. FX rates are `NUMBER(18,8)`. Percent rates are `NUMBER(5,4)` (0.2500 = 25%).
* **Sign convention**: every stored line has non-negative `debit` and `credit`. Every *computed* balance is **debit-positive** (`debit - credit`). Presentation flips sign by `normal_side` (credit-normal accounts such as liabilities, equity and revenue show `credit - debit`).
* **Account types**: `A` asset, `L` liability, `E` equity, `R` revenue, `X` expense. `R` and `X` are the P&L ("temporary") accounts that are closed to retained earnings at year end.
* **Periods**: `period_id` is `YYYYMM` as a number, so `period_id <= :period_id` is a valid chronological comparison. That only holds while there are no adjustment periods (EBS has a 13th "ADJ" period, see trap notes).
* **Binds** used in the examples. Bind DATE parameters as dates, not strings.

| Bind | Type | Example value used in validation |
|---|---|---|
| `:period_id` | NUMBER | 202503 |
| `:fiscal_year` | NUMBER | 2025 |
| `:as_of`, `:from_date`, `:to_date` | DATE | 2025-03-31, 2025-01-01, 2025-03-31 |
| `:account_id` | NUMBER | 1110 (cash) |
| `:re_account_id` | NUMBER | 3200 (retained earnings) |
| `:base_ccy` | VARCHAR2 | 'USD' |
| `:approval_limit` | NUMBER | 5000 |
| `:closing_journal_id`, `:closing_journal_no`, `:line_id_base` | NUMBER | 8000, 8000, 800000 |
| `:accrual_period_id`, `:reversal_period_id`, `:rev_journal_id_base`, `:rev_line_id_base` | NUMBER | 202503, 202504, 7000, 700000 |

#### Shared schema

This is a minimal double-entry design. It is the same split EBS uses (`GL_JE_HEADERS`/`GL_JE_LINES` hold the journals, `GL_BALANCES` holds per-period summaries with begin balance and period net debit/credit). Foreign keys are left out to keep it short; add them in the simulation.

```sql
CREATE TABLE gl_account (
  account_id    NUMBER(10)    PRIMARY KEY,
  account_code  VARCHAR2(20)  NOT NULL,
  account_name  VARCHAR2(100) NOT NULL,
  account_type  VARCHAR2(1)   NOT NULL,      -- A L E R X
  normal_side   VARCHAR2(1)   NOT NULL,      -- D or C
  parent_id     NUMBER(10),                  -- NULL = root of the tree
  is_postable   VARCHAR2(1)   NOT NULL       -- Y = leaf you can post to, N = header
);

CREATE TABLE gl_period (
  period_id     NUMBER(6)     PRIMARY KEY,   -- YYYYMM
  fiscal_year   NUMBER(4)     NOT NULL,
  period_num    NUMBER(2)     NOT NULL,
  start_date    DATE          NOT NULL,
  end_date      DATE          NOT NULL,
  status        VARCHAR2(1)   NOT NULL       -- O open, C closed
);

CREATE TABLE gl_journal (
  journal_id    NUMBER(10)    PRIMARY KEY,
  journal_no    NUMBER(10)    NOT NULL,      -- gapless document number (audit)
  journal_date  DATE          NOT NULL,
  period_id     NUMBER(6)     NOT NULL,
  source        VARCHAR2(10)  NOT NULL,      -- SALES, CASH, PAYROLL, ACCRUAL, CLOSE ...
  status        VARCHAR2(1)   NOT NULL,      -- P posted, D draft
  reversal_of   NUMBER(10),                  -- journal_id this one reverses
  description   VARCHAR2(200)
);

CREATE TABLE gl_line (
  line_id       NUMBER(12)    PRIMARY KEY,
  journal_id    NUMBER(10)    NOT NULL,
  line_no       NUMBER(5)     NOT NULL,
  account_id    NUMBER(10)    NOT NULL,
  cost_center   VARCHAR2(10),
  debit         NUMBER(14,2)  DEFAULT 0 NOT NULL,
  credit        NUMBER(14,2)  DEFAULT 0 NOT NULL
);

CREATE TABLE gl_balance (                    -- PK (account_id, period_id)
  account_id    NUMBER(10)    NOT NULL,
  period_id     NUMBER(6)     NOT NULL,
  opening_bal   NUMBER(14,2)  NOT NULL,
  period_dr     NUMBER(14,2)  NOT NULL,
  period_cr     NUMBER(14,2)  NOT NULL,
  closing_bal   NUMBER(14,2)  NOT NULL
);

CREATE TABLE gl_budget (                     -- PK (account_id, cost_center, period_id)
  account_id    NUMBER(10)    NOT NULL,
  cost_center   VARCHAR2(10),
  period_id     NUMBER(6)     NOT NULL,
  amount        NUMBER(14,2)  NOT NULL       -- natural sign: expense and revenue both positive
);

CREATE TABLE customer (
  customer_id   NUMBER(10)    PRIMARY KEY,
  customer_name VARCHAR2(100) NOT NULL,
  terms_days    NUMBER(3)     NOT NULL
);

CREATE TABLE ar_invoice (
  invoice_id    NUMBER(10)    PRIMARY KEY,
  invoice_no    NUMBER(10)    NOT NULL,
  customer_id   NUMBER(10)    NOT NULL,
  invoice_date  DATE          NOT NULL,
  due_date      DATE          NOT NULL,
  currency_code VARCHAR2(3)   NOT NULL,
  amount        NUMBER(14,2)  NOT NULL
);

CREATE TABLE ar_receipt (
  receipt_id    NUMBER(10)    PRIMARY KEY,
  customer_id   NUMBER(10)    NOT NULL,
  receipt_date  DATE          NOT NULL,
  amount        NUMBER(14,2)  NOT NULL
);

CREATE TABLE ar_application (                -- cash applied to invoices
  receipt_id     NUMBER(10)   NOT NULL,
  invoice_id     NUMBER(10)   NOT NULL,
  applied_amount NUMBER(14,2) NOT NULL,
  applied_date   DATE         NOT NULL
);

CREATE TABLE vendor (
  vendor_id     NUMBER(10)    PRIMARY KEY,
  vendor_name   VARCHAR2(100) NOT NULL
);

CREATE TABLE purchase_order (
  po_id         NUMBER(10)    PRIMARY KEY,
  vendor_id     NUMBER(10)    NOT NULL,
  ordered_qty   NUMBER(12,3)  NOT NULL,
  unit_price    NUMBER(14,4)  NOT NULL
);

CREATE TABLE goods_receipt (
  gr_id         NUMBER(10)    PRIMARY KEY,
  po_id         NUMBER(10)    NOT NULL,
  received_qty  NUMBER(12,3)  NOT NULL,
  received_date DATE          NOT NULL
);

CREATE TABLE ap_invoice (
  ap_invoice_id     NUMBER(10)   PRIMARY KEY,
  vendor_id         NUMBER(10)   NOT NULL,
  vendor_invoice_no VARCHAR2(30) NOT NULL,
  invoice_date      DATE         NOT NULL,
  due_date          DATE         NOT NULL,
  amount            NUMBER(14,2) NOT NULL,
  po_id             NUMBER(10),
  invoiced_qty      NUMBER(12,3)
);

CREATE TABLE ap_payment (
  payment_id    NUMBER(10)    PRIMARY KEY,
  payment_no    NUMBER(10)    NOT NULL,
  vendor_id     NUMBER(10)    NOT NULL,
  ap_invoice_id NUMBER(10),
  payment_date  DATE          NOT NULL,
  amount        NUMBER(14,2)  NOT NULL
);

CREATE TABLE bank_txn (                      -- bank statement lines
  bank_txn_id   NUMBER(10)    PRIMARY KEY,
  value_date    DATE          NOT NULL,
  amount        NUMBER(14,2)  NOT NULL,      -- signed: + in, - out
  reference     VARCHAR2(40)
);

CREATE TABLE cash_book (                     -- the company's own cash records
  entry_id      NUMBER(10)    PRIMARY KEY,
  entry_date    DATE          NOT NULL,
  amount        NUMBER(14,2)  NOT NULL,      -- signed
  reference     VARCHAR2(40)
);

CREATE TABLE fx_rate (                       -- PK (from_ccy, to_ccy, rate_date)
  from_ccy      VARCHAR2(3)   NOT NULL,
  to_ccy        VARCHAR2(3)   NOT NULL,
  rate_date     DATE          NOT NULL,
  rate          NUMBER(18,8)  NOT NULL       -- 1 from_ccy = rate to_ccy
);

CREATE TABLE fa_asset (
  asset_id        NUMBER(10)   PRIMARY KEY,
  asset_name      VARCHAR2(100) NOT NULL,
  cost            NUMBER(14,2) NOT NULL,
  salvage_value   NUMBER(14,2) NOT NULL,
  life_months     NUMBER(4)    NOT NULL,
  in_service_date DATE         NOT NULL,
  method          VARCHAR2(3)  NOT NULL      -- SL or DDB
);

CREATE TABLE prepaid_contract (
  contract_id   NUMBER(10)    PRIMARY KEY,
  start_date    DATE          NOT NULL,
  months        NUMBER(3)     NOT NULL,
  total_amount  NUMBER(14,2)  NOT NULL
);

CREATE TABLE loan (
  loan_id       NUMBER(10)    PRIMARY KEY,
  principal     NUMBER(14,2)  NOT NULL,
  annual_rate   NUMBER(7,5)   NOT NULL,      -- 0.06500 = 6.5%
  term_months   NUMBER(4)     NOT NULL,
  start_date    DATE          NOT NULL
);

CREATE TABLE alloc_pool (
  pool_id       NUMBER(10)    PRIMARY KEY,
  amount        NUMBER(14,2)  NOT NULL
);

CREATE TABLE alloc_driver (                  -- PK (pool_id, cost_center)
  pool_id       NUMBER(10)    NOT NULL,
  cost_center   VARCHAR2(10)  NOT NULL,
  weight        NUMBER(12,4)  NOT NULL       -- headcount, m2, revenue ...
);

CREATE TABLE employee (
  employee_id   NUMBER(10)    PRIMARY KEY,
  emp_name      VARCHAR2(100) NOT NULL,
  monthly_gross NUMBER(14,2)  NOT NULL,
  pension_rate  NUMBER(5,4)   NOT NULL
);

CREATE TABLE tax_bracket (                   -- annual, progressive
  bracket_id    NUMBER(5)     PRIMARY KEY,
  lower_bound   NUMBER(14,2)  NOT NULL,      -- exclusive lower edge
  upper_bound   NUMBER(14,2),                -- inclusive upper edge; NULL = top bracket
  rate          NUMBER(5,4)   NOT NULL
);
```

Sources: [EBS GL balances tables (Oracle Fusion data model, same column family BEGIN_BALANCE_DR/CR, PERIOD_NET_DR/CR)](https://docs.oracle.com/en/cloud/saas/financials/24c/oedmf/glofsaabalancesv-6754.html) - [Double-entry bookkeeping](https://en.wikipedia.org/wiki/Double-entry_bookkeeping) - [Chart of accounts](https://en.wikipedia.org/wiki/Chart_of_accounts) - [Oracle 19c data types](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Types.html)

#### 19c feature boundary (read this before writing new patterns)

Available in 19c and used below: analytic functions with ROWS/RANGE frames, `KEEP (DENSE_RANK FIRST|LAST)`, `LISTAGG ... WITHIN GROUP` (+ `ON OVERFLOW` since 12.2, `DISTINCT` **new in 19c**), `PIVOT`/`UNPIVOT`, `MATCH_RECOGNIZE` (12c), `LATERAL` / `CROSS APPLY` (12c), recursive `WITH` with `SEARCH` / `CYCLE`, `MODEL`, partitioned outer join, `MERGE`, `ROLLUP`/`CUBE`/`GROUPING SETS`/`GROUPING_ID`, `FETCH FIRST` (12c), `APPROX_COUNT_DISTINCT`, and table SQL macros (`SQL_MACRO(TABLE)`, from the 19.6 RU on; this container is 19.19).

**NOT available in 19c, do not use**: `BOOLEAN` SQL column type (23ai); `GROUP BY` alias or position (23ai); `IF [NOT] EXISTS` in DDL (23ai); `SELECT` without `FROM` (23ai); `FROM (VALUES ...)` table value constructor (23ai); `ANY_VALUE` (21c, use `MIN`/`MAX` instead); scalar SQL macros (21c); window frame `GROUPS` and `EXCLUDE` (21c); `CHECKSUM`, `BIT_AND_AGG`/`BIT_OR_AGG` (21c); `QUALIFY` (not in Oracle at all); `DATE_TRUNC`/`DATEADD` (not Oracle).

---

## BASIC

### 1. Chart of accounts tree - Basic

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Show the account hierarchy (indentation, path, leaf flag) for maintenance screens and as the backbone of every financial statement.

**Features**: `CONNECT BY PRIOR`, `START WITH`, `LEVEL`, `SYS_CONNECT_BY_PATH`, `CONNECT_BY_ISLEAF`, `CONNECT_BY_ROOT`, `ORDER SIBLINGS BY`. Alternative: recursive `WITH` with `SEARCH DEPTH FIRST` and `CYCLE`.

**Tables**: `gl_account(account_id, account_code, account_name, parent_id)`.

```sql
SELECT LPAD(' ', 2 * (LEVEL - 1)) || a.account_code || ' ' || a.account_name AS account_label,
       LEVEL                                  AS depth,
       SYS_CONNECT_BY_PATH(a.account_code, '/') AS code_path,
       CONNECT_BY_ISLEAF                      AS is_leaf,
       CONNECT_BY_ROOT a.account_code         AS root_code
FROM gl_account a
START WITH a.parent_id IS NULL
CONNECT BY PRIOR a.account_id = a.parent_id
ORDER SIBLINGS BY a.account_code;
```

Here is the ANSI recursive-WITH equivalent. It is portable and lets you detect cycles without `NOCYCLE`:

```sql
WITH tree (account_id, account_code, parent_id, depth, code_path) AS (
  SELECT account_id, account_code, parent_id, 1, CAST('/' || account_code AS VARCHAR2(4000))
  FROM gl_account
  WHERE parent_id IS NULL
  UNION ALL
  SELECT c.account_id, c.account_code, c.parent_id, t.depth + 1, t.code_path || '/' || c.account_code
  FROM gl_account c
  JOIN tree t ON c.parent_id = t.account_id
)
SEARCH DEPTH FIRST BY account_code SET ord
CYCLE account_id SET is_cycle TO 'Y' DEFAULT 'N'
SELECT account_id, account_code, depth, code_path, is_cycle
FROM tree
ORDER BY ord;
```

**Verify (JS)**: Build `children` maps keyed by `parent_id`. Run a DFS from the roots, sorting siblings by `account_code` (use a binary string comparison, matching Oracle's `BINARY` NLS_SORT). Emit depth, path and leaf flag (`children.get(id)?.length === 0`). Row order must match the DFS order exactly.

**Traps**:
* A trailing `ORDER BY` destroys the hierarchical order. Use `ORDER SIBLINGS BY`, or `ORDER BY ord` with `SEARCH`.
* Orphans (a `parent_id` that points to a missing row) are silently left out of both forms. Detect them separately with an anti-join.
* A cycle raises ORA-01436 in `CONNECT BY` unless you add `NOCYCLE` (then flag rows with `CONNECT_BY_ISCYCLE`). In recursive WITH, `CYCLE` marks the repeated row.
* In recursive WITH, the anchor fixes the column type. Without `CAST(... AS VARCHAR2(4000))` the path is truncated to the anchor's length, giving ORA-01489 or ORA-12899.
* String sort: `'1000' < '200'`. Codes must be fixed width or zero-padded.

Sources: [Hierarchical Queries (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Hierarchical-Queries.html) - [SYS_CONNECT_BY_PATH](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SYS_CONNECT_BY_PATH.html) - [SELECT: subquery_factoring_clause, SEARCH/CYCLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

---

### 2. Double-entry validation: unbalanced journals - Basic

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Each journal must satisfy sum(debits) = sum(credits). Each line must be one-sided and non-negative. Posting must reject anything else. This is the core integrity check of every ledger.

**Features**: `GROUP BY ... HAVING`, `NOT EXISTS` anti-join, compound predicates.

**Tables**: `gl_journal`, `gl_line(journal_id, debit, credit)`.

```sql
-- (a) journals whose debits and credits do not agree, or that have fewer than 2 lines
SELECT j.journal_id, j.journal_no, j.status,
       SUM(l.debit)                 AS total_dr,
       SUM(l.credit)                AS total_cr,
       SUM(l.debit) - SUM(l.credit) AS imbalance,
       COUNT(*)                     AS line_count
FROM gl_journal j
JOIN gl_line l ON l.journal_id = j.journal_id
GROUP BY j.journal_id, j.journal_no, j.status
HAVING SUM(l.debit) <> SUM(l.credit) OR COUNT(*) < 2
ORDER BY j.journal_id;

-- (b) malformed lines: both sides set, neither side set, or negative
SELECT line_id, journal_id, debit, credit
FROM gl_line
WHERE (debit <> 0 AND credit <> 0)
   OR (debit = 0 AND credit = 0)
   OR debit < 0 OR credit < 0;

-- (c) journal headers with no lines at all (the inner join in (a) hides them)
SELECT j.journal_id, j.journal_no
FROM gl_journal j
WHERE NOT EXISTS (SELECT 1 FROM gl_line l WHERE l.journal_id = j.journal_id);
```

**Verify (JS)**: Group lines by `journal_id` and compare integer-cent sums (`Math.round(x*100)`). Emit the journals with `dr !== cr || n < 2`. For (c), take the set difference of header ids minus line journal ids.

**Traps**:
* Never compare JS floating-point sums. Convert to integer cents first, or 0.1 + 0.2 will "unbalance" a good journal.
* If `debit`/`credit` were nullable, `SUM` ignores NULL but `debit - credit` becomes NULL for the whole line. Keep them `NOT NULL DEFAULT 0` (as here), or wrap them in `NVL`.
* Query (a) cannot see a header-only journal, so (c) is required.
* Balancing applies per journal **and per currency** in a multi-currency ledger. Group by `(journal_id, currency)` if you store entered amounts.

Sources: [Double-entry bookkeeping](https://en.wikipedia.org/wiki/Double-entry_bookkeeping) - [Trial balance](https://en.wikipedia.org/wiki/Trial_balance)

---

### 3. Account activity per period (natural sign) - Basic

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Period debits, credits and net movement per account, shown in the account's natural sign (revenue positive, expense positive). This is the building block for every report.

**Features**: Joins, `GROUP BY`, a `CASE` sign multiplier applied to an aggregate.

**Tables**: `gl_line`, `gl_journal(status, period_id)`, `gl_account(normal_side)`.

```sql
SELECT a.account_code, a.account_name, j.period_id,
       SUM(l.debit)  AS period_dr,
       SUM(l.credit) AS period_cr,
       SUM(l.debit - l.credit) * CASE a.normal_side WHEN 'D' THEN 1 ELSE -1 END AS net_natural
FROM gl_line l
JOIN gl_journal j ON j.journal_id = l.journal_id
JOIN gl_account a ON a.account_id = l.account_id
WHERE j.status = 'P'
GROUP BY a.account_code, a.account_name, a.normal_side, j.period_id
ORDER BY a.account_code, j.period_id;
```

**Verify (JS)**: Filter posted lines, group by `(account, period)`, sum the cents, and multiply by `normal_side === 'D' ? 1 : -1`.

**Traps**:
* `normal_side` must be in `GROUP BY` because it is used outside the aggregate. Oracle raises ORA-00979 otherwise. There is no "functional dependency" relaxation in 19c.
* Draft or unposted journals must be excluded (`status = 'P'`). This is the most common real-world bug.
* Contra accounts (accumulated depreciation is type `A` with normal side `C`) show positive in natural sign but reduce assets. Base the sign on `normal_side` for display and on `account_type` for statement grouping.

Sources: [Oracle 19c SELECT / GROUP BY](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

---

### 4. Open invoice balances (AR/AP subledger) - Basic

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Find what is still owed on each invoice after applied cash. It feeds aging, statements and dunning.

**Features**: Pre-aggregated derived table + `LEFT JOIN`, `NVL`.

**Tables**: `ar_invoice(invoice_id, amount)`, `ar_application(invoice_id, applied_amount)`.

```sql
SELECT i.invoice_id, i.invoice_no, i.customer_id, i.amount,
       NVL(ap.applied, 0)            AS applied,
       i.amount - NVL(ap.applied, 0) AS open_amount
FROM ar_invoice i
LEFT JOIN (SELECT invoice_id, SUM(applied_amount) AS applied
           FROM ar_application
           GROUP BY invoice_id) ap
  ON ap.invoice_id = i.invoice_id
WHERE i.amount - NVL(ap.applied, 0) <> 0
ORDER BY i.invoice_id;
```

**Verify (JS)**: Build `appliedByInvoice = Map<invoice_id, cents>`. Then `open = amount - (applied ?? 0)`, and keep `open !== 0`.

**Traps**:
* **Fan-out**: joining `ar_application` directly and then `SUM(i.amount)` multiplies the invoice amount by the number of applications. Aggregate before joining.
* Over-application gives a negative open amount. Decide whether `<> 0` or `> 0` is the right filter, and report credits separately.
* Without `NVL`, an invoice with no applications gives `amount - NULL = NULL` and drops out of `<> 0`.

---

### 5. AR aging buckets as of a date - Basic

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Classify open receivables by days past due (Current, 1-30, 31-60, 61-90, 90+) per customer, for collections and the bad-debt allowance.

**Features**: Date arithmetic (`DATE - DATE` = days), `TRUNC(date)`, `CASE` conditional aggregation, correlated scalar subquery that respects the as-of cutoff.

**Tables**: `ar_invoice(invoice_date, due_date, amount)`, `ar_application(applied_amount, applied_date)`, `customer`.

```sql
WITH open_inv AS (
  SELECT i.customer_id, i.invoice_id, i.due_date,
         i.amount - NVL((SELECT SUM(a.applied_amount)
                         FROM ar_application a
                         WHERE a.invoice_id = i.invoice_id
                           AND a.applied_date <= :as_of), 0) AS open_amt
  FROM ar_invoice i
  WHERE i.invoice_date <= :as_of
)
SELECT c.customer_id, c.customer_name,
       SUM(CASE WHEN TRUNC(:as_of) - TRUNC(o.due_date) <= 0             THEN o.open_amt ELSE 0 END) AS current_amt,
       SUM(CASE WHEN TRUNC(:as_of) - TRUNC(o.due_date) BETWEEN 1  AND 30 THEN o.open_amt ELSE 0 END) AS d001_030,
       SUM(CASE WHEN TRUNC(:as_of) - TRUNC(o.due_date) BETWEEN 31 AND 60 THEN o.open_amt ELSE 0 END) AS d031_060,
       SUM(CASE WHEN TRUNC(:as_of) - TRUNC(o.due_date) BETWEEN 61 AND 90 THEN o.open_amt ELSE 0 END) AS d061_090,
       SUM(CASE WHEN TRUNC(:as_of) - TRUNC(o.due_date) > 90             THEN o.open_amt ELSE 0 END) AS d090_plus,
       SUM(o.open_amt) AS total_open
FROM open_inv o
JOIN customer c ON c.customer_id = o.customer_id
WHERE o.open_amt <> 0
GROUP BY c.customer_id, c.customer_name
ORDER BY c.customer_id;
```

**Verify (JS)**: For each invoice with `invoice_date <= asOf`, compute open = amount minus applications dated `<= asOf`, and `days = (asOf - due) / 86400000` using UTC midnight dates. Bucket by the same inclusive bounds. The five bucket columns must sum to `total_open`.

**Traps**:
* **Time components**: an Oracle `DATE` carries a time. `30.5` days falls through `BETWEEN 1 AND 30` *and* `BETWEEN 31 AND 60`, so the row lands in no bucket. Hence the `TRUNC` on both sides.
* **As-of correctness**: applications dated after `:as_of` must not reduce the balance. A "current state" open amount gives the wrong historical aging.
* Bucket by **due date** (past due) or by **invoice date** (age)? Both are used in practice. Name the columns clearly.
* JS `Date` and DST: compute day differences from `Date.UTC(y, m, d)` values, never local midnight.
* Credit memos (negative open) reduce the bucket they fall in. Some shops report them in a separate column.

Sources: [DSO and receivables aging context](https://en.wikipedia.org/wiki/Days_sales_outstanding) - [Oracle datetime arithmetic (19c SQL Ref, Data Types)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Data-Types.html)

---

### 6. Duplicate payment detection - Basic

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Audit test. Catch the same vendor invoice paid twice: exact duplicates, and "near" duplicates where the invoice number is formatted differently, or the same amount is paid to the same vendor within N days.

**Features**: `COUNT(*) OVER (PARTITION BY ...)`, `ROW_NUMBER`, `REGEXP_REPLACE` normalization, self-join with a date window.

**Tables**: `ap_payment(payment_id, vendor_id, ap_invoice_id, payment_date, amount)`, `ap_invoice(vendor_invoice_no)`.

```sql
-- (a) same vendor + normalized vendor invoice number + amount, paid more than once
SELECT *
FROM (
  SELECT p.payment_id, p.vendor_id, i.vendor_invoice_no, p.amount, p.payment_date,
         COUNT(*) OVER (PARTITION BY p.vendor_id,
                                     UPPER(REGEXP_REPLACE(i.vendor_invoice_no, '[^A-Za-z0-9]', '')),
                                     p.amount) AS dup_count,
         ROW_NUMBER() OVER (PARTITION BY p.vendor_id,
                                         UPPER(REGEXP_REPLACE(i.vendor_invoice_no, '[^A-Za-z0-9]', '')),
                                         p.amount
                            ORDER BY p.payment_date, p.payment_id) AS occurrence
  FROM ap_payment p
  JOIN ap_invoice i ON i.ap_invoice_id = p.ap_invoice_id
)
WHERE dup_count > 1
ORDER BY vendor_id, amount, occurrence;

-- (b) same vendor, same amount, within 7 days (catches re-keyed invoice numbers)
SELECT p1.payment_id AS first_payment, p2.payment_id AS second_payment,
       p1.vendor_id, p1.amount, p1.payment_date, p2.payment_date AS second_date
FROM ap_payment p1
JOIN ap_payment p2
  ON  p2.vendor_id = p1.vendor_id
  AND p2.amount    = p1.amount
  AND p2.payment_id > p1.payment_id
  AND p2.payment_date BETWEEN p1.payment_date AND p1.payment_date + 7
ORDER BY p1.vendor_id, p1.payment_date;
```

**Verify (JS)**: Normalize the key the same way: `no.replace(/[^A-Za-z0-9]/g,'').toUpperCase()`, where **the empty string must map to `null`**. Group, keep groups with size > 1, and number the members by `(date, id)`. For (b), use a nested loop over each vendor's payments sorted by date.

**Traps**:
* `REGEXP_REPLACE` of an all-punctuation string returns `''`, which **is NULL in Oracle**. All such payments then share a NULL partition key and are reported as "duplicates" of each other. The JS model must reproduce this, or the SQL must exclude NULL keys.
* (b) with `p2.payment_id > p1.payment_id` reports each pair once. Three identical payments give 3 pairs, not 2.
* `BETWEEN d AND d + 7` is inclusive on both ends, and `DATE` time parts matter.

Sources: [Analytic functions (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html) - [Three-way match / AP controls](https://en.wikipedia.org/wiki/Three-way_match)

---

## INTERMEDIATE

### 7. Trial balance as of a period (with prior-year P&L folded into retained earnings) - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: List every account's cumulative balance in debit and credit columns. Total debits must equal total credits. Like EBS, P&L accounts show only **year-to-date** activity, and prior years' P&L appears in retained earnings even before a closing entry exists.

**Features**: CTE, `CASE` account remapping, `CROSS JOIN` to a one-row parameter CTE, aggregate inside a window (`SUM(SUM(x)) OVER ()`), `HAVING`.

**Tables**: `gl_line`, `gl_journal`, `gl_period(fiscal_year, end_date)`, `gl_account(account_type)`.

```sql
WITH target AS (
  SELECT fiscal_year, end_date FROM gl_period WHERE period_id = :period_id
),
bal AS (
  SELECT CASE WHEN a.account_type IN ('R', 'X') AND p.fiscal_year < t.fiscal_year
              THEN :re_account_id ELSE l.account_id END AS account_id,
         l.debit - l.credit AS net
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  JOIN gl_period  p ON p.period_id  = j.period_id
  JOIN gl_account a ON a.account_id = l.account_id
  CROSS JOIN target t
  WHERE j.status = 'P'
    AND p.end_date <= t.end_date
)
SELECT a.account_code, a.account_name,
       CASE WHEN SUM(b.net) > 0 THEN  SUM(b.net) ELSE 0 END AS debit_balance,
       CASE WHEN SUM(b.net) < 0 THEN -SUM(b.net) ELSE 0 END AS credit_balance,
       SUM(SUM(b.net)) OVER ()                               AS out_of_balance  -- must be 0
FROM bal b
JOIN gl_account a ON a.account_id = b.account_id
GROUP BY a.account_code, a.account_name
HAVING SUM(b.net) <> 0
ORDER BY a.account_code;
```

**Verify (JS)**: Map each posted line to the RE account if it is a P&L account from an earlier fiscal year. Sum the cents by account, then split each balance into a debit or credit column. Assert `sum(debit_balance) === sum(credit_balance)` and that `out_of_balance` is 0 on every row.

**Traps**:
* If a year-end closing journal **has** been posted (pattern 26), the remap still holds. The closing lines simply net the prior-year P&L to zero, so nothing is counted twice. If you remap *and* also roll RE through a balance table, you count twice.
* `HAVING` runs before the window, so the window total covers only non-zero accounts. That is fine because zero rows add 0.
* The total only balances if **every** journal in the range balances. One unbalanced *posted* journal shows up as a non-zero `out_of_balance`, which makes this a good second-line check after pattern 2.
* Adjustment periods (period 13) share the year-end date. `p.end_date <= t.end_date` includes them, which is usually what you want for an "after adjustments" TB.

Sources: [Trial balance](https://en.wikipedia.org/wiki/Trial_balance) - [EBS-style balances (begin + period net)](https://docs.oracle.com/en/cloud/saas/financials/24c/oedmf/glofsaabalancesv-6754.html) - [Aggregate functions nested in analytics (19c Analytic Functions)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html)

---

### 8. Roll-up of balances up the account tree - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Give header accounts (Current Assets, Total Expenses ...) the sum of all descendant leaf balances. Statements are printed from this.

**Features**: `CONNECT BY` **without** `START WITH` plus `CONNECT_BY_ROOT` to produce every (ancestor, descendant) pair, a hierarchical query joined to aggregates, and `ORDER SIBLINGS BY`.

**Tables**: `gl_account(parent_id)`, `gl_line`, `gl_journal`.

```sql
WITH leaf_bal AS (
  SELECT l.account_id, SUM(l.debit - l.credit) AS net
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  WHERE j.status = 'P' AND j.period_id <= :period_id
  GROUP BY l.account_id
),
anc AS (                       -- every (ancestor, descendant) pair, including (x, x)
  SELECT CONNECT_BY_ROOT a.account_id AS ancestor_id,
         a.account_id                 AS descendant_id
  FROM gl_account a
  CONNECT BY PRIOR a.account_id = a.parent_id
),
rolled AS (
  SELECT anc.ancestor_id, SUM(NVL(b.net, 0)) AS rolled_net, COUNT(b.account_id) AS posting_accounts
  FROM anc
  LEFT JOIN leaf_bal b ON b.account_id = anc.descendant_id
  GROUP BY anc.ancestor_id
)
SELECT LPAD(' ', 2 * (LEVEL - 1)) || a.account_code AS account_code,
       a.account_name,
       r.rolled_net,
       r.rolled_net * CASE a.normal_side WHEN 'D' THEN 1 ELSE -1 END AS rolled_natural
FROM gl_account a
JOIN rolled r ON r.ancestor_id = a.account_id
START WITH a.parent_id IS NULL
CONNECT BY PRIOR a.account_id = a.parent_id
ORDER SIBLINGS BY a.account_code;
```

**Verify (JS)**: Compute leaf balances, then a post-order DFS: `rolled(node) = own(node) + sum(rolled(child))`. Compare by node.

**Traps**:
* In a query with both a join and `CONNECT BY`, Oracle evaluates the **join first** and the hierarchy afterwards. The join must not remove intermediate nodes, or their subtrees disappear. Here `rolled` has a row for every account, so the inner join is safe.
* Postings to header accounts (`is_postable = 'N'`) are included through the `(x, x)` self pair. Flag them as a data-quality error rather than hiding them.
* The all-pairs `CONNECT BY` has O(n x depth) rows. That is fine for chart-of-accounts sizes, but don't run it on million-row trees.
* Mixed-type roots (a single root over A, L and E) roll up to about 0. Keep one root per statement section.

Sources: [Hierarchical Queries (CONNECT_BY_ROOT, join-then-connect evaluation order)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Hierarchical-Queries.html)

---

### 9. Account statement with running balance (ledger card) - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: The classic GL account inquiry or bank-style statement: opening balance, each transaction, and a running balance, plus the previous and next transaction dates.

**Features**: `SUM() OVER (ORDER BY ... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, `LAG`, `LEAD`, an opening-balance CTE.

**Tables**: `gl_line`, `gl_journal(journal_date, journal_no, description)`.

```sql
WITH opening AS (
  SELECT NVL(SUM(l.debit - l.credit), 0) AS bal
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  WHERE l.account_id = :account_id AND j.status = 'P'
    AND j.journal_date < :from_date
),
movements AS (
  SELECT j.journal_date, j.journal_no, l.line_id, j.description, l.debit, l.credit
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  WHERE l.account_id = :account_id AND j.status = 'P'
    AND j.journal_date >= :from_date
    AND j.journal_date <  :to_date + 1
)
SELECT m.journal_date, m.journal_no, m.description, m.debit, m.credit,
       o.bal AS opening_balance,
       o.bal + SUM(m.debit - m.credit) OVER (ORDER BY m.journal_date, m.journal_no, m.line_id
                                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance,
       LAG(m.journal_date)  OVER (ORDER BY m.journal_date, m.journal_no, m.line_id) AS prev_txn_date,
       LEAD(m.journal_date) OVER (ORDER BY m.journal_date, m.journal_no, m.line_id) AS next_txn_date
FROM movements m
CROSS JOIN opening o
ORDER BY m.journal_date, m.journal_no, m.line_id;
```

**Verify (JS)**: Sort the movements by `(date, journal_no, line_id)` and keep a cumulative cents sum seeded with the opening balance. The last row's running balance must equal the opening balance plus the period net, and also equal an independent closing-balance query.

**Traps**:
* **RANGE vs ROWS**: `SUM() OVER (ORDER BY journal_date)` without a frame defaults to `RANGE UNBOUNDED PRECEDING`. Every row on the same date then gets the *same* (end-of-day) running balance. Use `ROWS` and a unique tiebreaker.
* `< :to_date + 1` (half-open) includes lines time-stamped during the last day. `<= :to_date` misses them.
* An account with no movements in range returns zero rows, so the opening balance disappears. UNION an "Opening balance" row if the report must always print it.

Sources: [Oracle SQL blog: running totals and the default RANGE frame](https://blogs.oracle.com/sql/?p=387) - [SQL for Analysis and Reporting (19c DWH Guide)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-analysis-reporting-data-warehouses.html)

---

### 10. Opening / closing balance for every account and period (dense, with year reset) - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: A per-period roll-forward (`opening + dr - cr = closing`) that includes periods with **no activity**. P&L accounts restart at zero each fiscal year and balance-sheet accounts carry forward.

**Features**: **Partitioned outer join** (`PARTITION BY (...) RIGHT OUTER JOIN`), which densifies the data; windowed `SUM` with `ROWS ... 1 PRECEDING`; a `CASE` expression inside `PARTITION BY`.

**Tables**: `gl_line`, `gl_journal`, `gl_period`, `gl_account`.

```sql
WITH activity AS (
  SELECT l.account_id, j.period_id, SUM(l.debit) AS dr, SUM(l.credit) AS cr
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  WHERE j.status = 'P'
  GROUP BY l.account_id, j.period_id
),
dense AS (
  SELECT act.account_id, p.period_id, p.fiscal_year,
         NVL(act.dr, 0) AS dr, NVL(act.cr, 0) AS cr
  FROM activity act PARTITION BY (act.account_id)
  RIGHT OUTER JOIN gl_period p ON p.period_id = act.period_id
)
SELECT d.account_id, a.account_type, d.period_id,
       NVL(SUM(d.dr - d.cr) OVER (PARTITION BY d.account_id,
                                               CASE WHEN a.account_type IN ('R', 'X') THEN d.fiscal_year END
                                  ORDER BY d.period_id
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_bal,
       d.dr AS period_dr,
       d.cr AS period_cr,
       SUM(d.dr - d.cr) OVER (PARTITION BY d.account_id,
                                           CASE WHEN a.account_type IN ('R', 'X') THEN d.fiscal_year END
                              ORDER BY d.period_id
                              ROWS UNBOUNDED PRECEDING) AS closing_bal
FROM dense d
JOIN gl_account a ON a.account_id = d.account_id
ORDER BY d.account_id, d.period_id;
```

**Verify (JS)**: For each account x each period (Cartesian product, periods sorted), compute activity (0 when missing). Carry the closing balance forward, resetting to 0 when `account_type in (R, X)` and the fiscal year changes. Assert `opening(p) === closing(p-1)` within the partition.

**Traps**:
* A plain outer join to `gl_period` densifies only **once overall**, not once per account. The `PARTITION BY (act.account_id)` is what produces one dense series per account.
* The first period's `... 1 PRECEDING` frame is empty and returns NULL. Hence the `NVL`.
* This densifies across **all** periods, including those before the account existed. Restrict the range if that matters.
* Balance-sheet carry-forward never resets, but retained earnings only picks up prior-year P&L via a closing entry or the remap from pattern 7.

Sources: [Partitioned outer join / data densification (19c DWH Guide, SQL for Analysis and Reporting)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-analysis-reporting-data-warehouses.html)

---

### 11. Period balance maintenance with MERGE (GL_BALANCES style upsert) - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: The posting process keeps a summary table (`gl_balance`) per account and period: opening from the prior period's closing, plus this period's activity. Re-running it must be idempotent.

**Features**: `MERGE ... WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT`, `WITH` inside `USING`, `UNION` of account sets, `MAX` over periods to find the previous period.

**Tables**: `gl_balance`, `gl_line`, `gl_journal`, `gl_period`.

```sql
MERGE INTO gl_balance b
USING (
  WITH prevp AS (
    SELECT MAX(period_id) AS prev_id FROM gl_period WHERE period_id < :period_id
  ),
  act AS (
    SELECT l.account_id, SUM(l.debit) AS dr, SUM(l.credit) AS cr
    FROM gl_line l
    JOIN gl_journal j ON j.journal_id = l.journal_id
    WHERE j.status = 'P' AND j.period_id = :period_id
    GROUP BY l.account_id
  ),
  accts AS (
    SELECT gb.account_id FROM gl_balance gb CROSS JOIN prevp WHERE gb.period_id = prevp.prev_id
    UNION
    SELECT account_id FROM act
  )
  SELECT x.account_id, :period_id AS period_id,
         NVL(pb.closing_bal, 0) AS opening_bal,
         NVL(act.dr, 0) AS dr,
         NVL(act.cr, 0) AS cr
  FROM accts x
  CROSS JOIN prevp
  LEFT JOIN gl_balance pb ON pb.account_id = x.account_id AND pb.period_id = prevp.prev_id
  LEFT JOIN act          ON act.account_id = x.account_id
) s
ON (b.account_id = s.account_id AND b.period_id = s.period_id)
WHEN MATCHED THEN UPDATE
  SET b.opening_bal = s.opening_bal,
      b.period_dr   = s.dr,
      b.period_cr   = s.cr,
      b.closing_bal = s.opening_bal + s.dr - s.cr
WHEN NOT MATCHED THEN INSERT (account_id, period_id, opening_bal, period_dr, period_cr, closing_bal)
  VALUES (s.account_id, s.period_id, s.opening_bal, s.dr, s.cr, s.opening_bal + s.dr - s.cr);
```

Run it once per period in ascending order. Then reconcile the summary against the detail:

```sql
SELECT b.account_id, b.period_id, b.closing_bal,
       (SELECT NVL(SUM(l.debit - l.credit), 0)
        FROM gl_line l JOIN gl_journal j ON j.journal_id = l.journal_id
        WHERE j.status = 'P' AND l.account_id = b.account_id AND j.period_id <= b.period_id) AS detail_bal
FROM gl_balance b
WHERE b.closing_bal <> (SELECT NVL(SUM(l.debit - l.credit), 0)
                        FROM gl_line l JOIN gl_journal j ON j.journal_id = l.journal_id
                        WHERE j.status = 'P' AND l.account_id = b.account_id AND j.period_id <= b.period_id);
```

**Verify (JS)**: Replay the periods in order with a `Map<account, closing>`. After each MERGE, compare the table to the model. Run the MERGE twice and assert the row count and values are unchanged (idempotence).

**Traps**:
* MERGE raises **ORA-30926** if the source has two rows for one target key. That is why `accts` uses `UNION`, not `UNION ALL`.
* You cannot `UPDATE` columns referenced in the `ON` clause (ORA-38104).
* A late posting to an already-summarized earlier period makes every later period stale. Real systems re-run from the earliest changed period.
* This simple version carries P&L forward across years. Reset P&L openings at fiscal-year start (as EBS does) if the table feeds statements.

Sources: [MERGE (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html) - [GL balances begin/period-net model](https://docs.oracle.com/en/cloud/saas/financials/24c/oedmf/glofsaabalancesv-6754.html)

---

### 12. Budget vs actual variance (YTD, by account and cost center) - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Management reporting. Compare actual against budget, with absolute and % variance and a favorable/unfavorable flag that depends on account type.

**Features**: `FULL OUTER JOIN`, `COALESCE` of the join keys, `NULLIF` guard against divide-by-zero, `NVL` key sentinel for nullable join columns.

**Tables**: `gl_budget(account_id, cost_center, period_id, amount)`, `gl_line`, `gl_journal`, `gl_period`, `gl_account`.

```sql
WITH actual AS (
  SELECT l.account_id, NVL(l.cost_center, '~') AS cc,
         SUM(l.debit - l.credit) * CASE MIN(a.normal_side) WHEN 'D' THEN 1 ELSE -1 END AS amt
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  JOIN gl_period  p ON p.period_id  = j.period_id
  JOIN gl_account a ON a.account_id = l.account_id
  WHERE j.status = 'P' AND p.fiscal_year = :fiscal_year AND p.period_id <= :period_id
    AND a.account_type IN ('R', 'X')
  GROUP BY l.account_id, NVL(l.cost_center, '~')
),
budget AS (
  SELECT g.account_id, NVL(g.cost_center, '~') AS cc, SUM(g.amount) AS amt
  FROM gl_budget g
  JOIN gl_period p ON p.period_id = g.period_id
  WHERE p.fiscal_year = :fiscal_year AND p.period_id <= :period_id
  GROUP BY g.account_id, NVL(g.cost_center, '~')
),
cmp AS (
  SELECT COALESCE(ac.account_id, bu.account_id) AS account_id,
         COALESCE(ac.cc, bu.cc)                 AS cc,
         NVL(bu.amt, 0) AS budget_amt,
         NVL(ac.amt, 0) AS actual_amt
  FROM actual ac
  FULL OUTER JOIN budget bu ON bu.account_id = ac.account_id AND bu.cc = ac.cc
)
SELECT a.account_code, NULLIF(c.cc, '~') AS cost_center,
       c.budget_amt, c.actual_amt,
       c.actual_amt - c.budget_amt AS variance,
       ROUND(100 * (c.actual_amt - c.budget_amt) / NULLIF(c.budget_amt, 0), 1) AS variance_pct,
       CASE
         WHEN c.actual_amt = c.budget_amt THEN 'ON BUDGET'
         WHEN (a.account_type = 'R' AND c.actual_amt > c.budget_amt)
           OR (a.account_type = 'X' AND c.actual_amt < c.budget_amt) THEN 'FAVORABLE'
         ELSE 'UNFAVORABLE'
       END AS assessment
FROM cmp c
JOIN gl_account a ON a.account_id = c.account_id
ORDER BY a.account_code, c.cc;
```

**Verify (JS)**: Use the composite key `${account}|${cc ?? '~'}`. Take the union of keys from both maps, fill missing sides with 0, and compute the variance. `variance_pct` is null when the budget is 0. Round the percentage half away from zero to 1 dp.

**Traps**:
* **NULL keys never match** in a join. Without the `'~'` sentinel, a NULL-cost-center budget and the matching actual come out as two half-empty rows.
* `variance_pct` is undefined when the budget is 0 (`NULLIF` gives NULL instead of ORA-01476).
* `CASE MIN(a.normal_side)` is used because `normal_side` is not in the `GROUP BY`. It is constant per account, and `ANY_VALUE` is 21c-only.
* Oracle `ROUND` is half away from zero, but JS `Math.round(-2.5) === -2`. Use a symmetric rounding helper in the model.

Sources: [SELECT joins (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html) - [ROUND (number)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROUND-number.html)

---

### 13. Month-over-month, year-over-year, YTD and rolling averages - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Revenue trend analysis: MoM change, same month last year, YTD cumulative and a 3-month moving average.

**Features**: `LAG(x)`, `LAG(x, 12)`, `SUM OVER (PARTITION BY fiscal_year ORDER BY ...)`, `AVG OVER (ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)`, outer joins from the period calendar for density.

**Tables**: `gl_period`, `gl_journal`, `gl_line`, `gl_account`.

```sql
WITH monthly AS (
  SELECT p.period_id, p.fiscal_year, p.period_num,
         NVL(SUM(CASE WHEN a.account_type = 'R' THEN l.credit - l.debit END), 0) AS revenue
  FROM gl_period p
  LEFT JOIN gl_journal j ON j.period_id = p.period_id AND j.status = 'P'
  LEFT JOIN gl_line    l ON l.journal_id = j.journal_id
  LEFT JOIN gl_account a ON a.account_id = l.account_id
  GROUP BY p.period_id, p.fiscal_year, p.period_num
)
SELECT period_id, revenue,
       LAG(revenue) OVER (ORDER BY period_id)                       AS prev_month,
       revenue - LAG(revenue) OVER (ORDER BY period_id)             AS mom_change,
       ROUND(100 * (revenue / NULLIF(LAG(revenue) OVER (ORDER BY period_id), 0) - 1), 2) AS mom_pct,
       LAG(revenue, 12) OVER (ORDER BY period_id)                   AS same_month_last_year,
       ROUND(100 * (revenue / NULLIF(LAG(revenue, 12) OVER (ORDER BY period_id), 0) - 1), 2) AS yoy_pct,
       SUM(revenue) OVER (PARTITION BY fiscal_year ORDER BY period_num
                          ROWS UNBOUNDED PRECEDING)                 AS ytd_revenue,
       ROUND(AVG(revenue) OVER (ORDER BY period_id
                                ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS rolling_3m_avg
FROM monthly
ORDER BY period_id;
```

**Verify (JS)**: Build the dense monthly array from the period calendar, then use index arithmetic: `prev = arr[i-1]`, `ly = arr[i-12]`. YTD resets when the year changes. The rolling average divides by `min(3, i+1)` (the early rows average over fewer months, which Oracle also does).

**Traps**:
* `LAG(x, 12)` is **positional**. It means "same month last year" only if the series is dense and has exactly 12 periods per year. A 13th adjustment period or a missing month breaks it silently. The robust alternative is a self-join on `(fiscal_year - 1, period_num)`.
* The calendar must drive the query (`gl_period LEFT JOIN ...`) so that months with no activity still appear. Grouping the fact table alone drops them.
* The first rolling-average rows cover fewer than 3 months. Return NULL instead if the model requires a full window (`CASE WHEN COUNT(*) OVER (...) = 3`).

Sources: [LAG/LEAD and windowing (19c DWH Guide)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-analysis-reporting-data-warehouses.html)

---

### 14. Subtotals with ROLLUP / CUBE / GROUPING SETS - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: One query returns detail, subtotal and grand-total rows for P&L by account type x cost center. This is the classic finance "report with totals".

**Features**: `CUBE`, `GROUPING_ID`, `GROUPING()` to tell a subtotal NULL from a real NULL, `GROUPING SETS`, `ORDER BY GROUPING_ID(...)`.

**Tables**: `gl_line(cost_center)`, `gl_journal`, `gl_period`, `gl_account`.

```sql
SELECT CASE GROUPING(a.account_type) WHEN 1 THEN '*ALL*' ELSE a.account_type END AS account_type,
       CASE GROUPING(l.cost_center)  WHEN 1 THEN '*ALL*' ELSE NVL(l.cost_center, '(none)') END AS cost_center,
       SUM(l.credit - l.debit)                  AS net_credit,     -- revenue +, expense -
       GROUPING_ID(a.account_type, l.cost_center) AS grouping_level -- 0 detail, 1 per type, 2 per cc, 3 grand
FROM gl_line l
JOIN gl_journal j ON j.journal_id = l.journal_id
JOIN gl_period  p ON p.period_id  = j.period_id
JOIN gl_account a ON a.account_id = l.account_id
WHERE j.status = 'P' AND p.fiscal_year = :fiscal_year AND a.account_type IN ('R', 'X')
GROUP BY CUBE (a.account_type, l.cost_center)
ORDER BY GROUPING_ID(a.account_type, l.cost_center), a.account_type, l.cost_center;
```

Equivalent explicit sets. `ROLLUP(a, b)` = `GROUPING SETS ((a, b), (a), ())`, and `CUBE(a, b)` adds `(b)`:

```sql
SELECT a.account_type, l.cost_center, SUM(l.credit - l.debit) AS net_credit,
       GROUPING(a.account_type) AS g_type, GROUPING(l.cost_center) AS g_cc
FROM gl_line l
JOIN gl_journal j ON j.journal_id = l.journal_id
JOIN gl_period  p ON p.period_id  = j.period_id
JOIN gl_account a ON a.account_id = l.account_id
WHERE j.status = 'P' AND p.fiscal_year = :fiscal_year AND a.account_type IN ('R', 'X')
GROUP BY GROUPING SETS ((a.account_type, l.cost_center), (a.account_type), ())
ORDER BY g_type, a.account_type, g_cc, l.cost_center;
```

The grand-total row (`grouping_level = 3`) is **net income** for the year.

**Verify (JS)**: Compute the detail groups. For each grouping set, re-aggregate the detail by the kept keys. Expected row count = |detail| + |types| + |cc values| + 1 for CUBE. Match rows on `(gType, gCc, type, cc)`, not on display strings.

**Traps**:
* A real NULL cost center and a subtotal NULL look identical without `GROUPING()`. That is why the label uses `GROUPING`, not `NVL`.
* `ORDER BY` may use the select alias (`g_type`), but **`GROUP BY` may not** (aliases in GROUP BY are 23ai).
* `GROUPING_ID` bit order follows its argument order. The left-most argument is the most significant bit.

Sources: [SQL for Aggregation in Data Warehouses (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-aggregation-data-warehouses.html) - [GROUPING](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/GROUPING.html)

---

### 15. Income statement by quarter with PIVOT - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: The P&L laid out with accounts as rows and Q1-Q4 plus FY as columns, the format finance teams expect.

**Features**: `PIVOT (SUM(...) FOR col IN (...))`, `CEIL(period_num/3)`, `NVL` on the pivoted columns.

**Tables**: `gl_line`, `gl_journal`, `gl_period(period_num)`, `gl_account`.

```sql
SELECT account_code, account_name, account_type,
       NVL(q1, 0) AS q1, NVL(q2, 0) AS q2, NVL(q3, 0) AS q3, NVL(q4, 0) AS q4,
       NVL(q1, 0) + NVL(q2, 0) + NVL(q3, 0) + NVL(q4, 0) AS fy_total
FROM (
  SELECT a.account_code, a.account_name, a.account_type,
         'Q' || TO_CHAR(CEIL(p.period_num / 3)) AS qtr,
         (l.credit - l.debit) * CASE a.account_type WHEN 'X' THEN -1 ELSE 1 END AS amt  -- natural sign
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  JOIN gl_period  p ON p.period_id  = j.period_id
  JOIN gl_account a ON a.account_id = l.account_id
  WHERE j.status = 'P' AND p.fiscal_year = :fiscal_year AND a.account_type IN ('R', 'X')
)
PIVOT (SUM(amt) FOR qtr IN ('Q1' AS q1, 'Q2' AS q2, 'Q3' AS q3, 'Q4' AS q4))
ORDER BY account_type DESC, account_code;
```

**Verify (JS)**: Group by `(account, quarter)` and fill a 4-slot array per account with 0 defaults. FY equals the array sum. Net income = sum of R totals minus sum of X totals, which must equal pattern 14's grand total.

**Traps**:
* PIVOT implicitly groups by **every column of the source that is not pivoted or aggregated**. An extra column (say `line_id`) in the inline view silently yields one row per line. Keep the inline view minimal.
* The `IN` list is static. Values outside it, such as an adjustment period mapped to 'Q5', are silently dropped. Dynamic pivots need `PIVOT XML` (returns XML) or generated SQL.
* Empty cells are NULL, not 0.

Sources: [SELECT pivot_clause (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html) - [Pivoting operations (19c DWH Guide, SQL for Analysis)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-analysis-reporting-data-warehouses.html)

---

### 16. Balance sheet and accounting-equation check (conditional aggregation) - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Show totals for Assets, Liabilities and Equity as of a period, and prove `Assets = Liabilities + Equity + current-year earnings`.

**Features**: Conditional aggregation `SUM(CASE ...)` in a single pass, plus a derived-table wrapper so the computed columns can be reused (aliases can't be referenced at the same level).

**Tables**: `gl_line`, `gl_journal`, `gl_account(account_type)`.

```sql
SELECT t.*,
       t.total_assets - (t.total_liabilities + t.total_equity + t.current_earnings) AS equation_diff  -- must be 0
FROM (
  SELECT SUM(CASE WHEN a.account_type = 'A'          THEN l.debit - l.credit ELSE 0 END) AS total_assets,
         SUM(CASE WHEN a.account_type = 'L'          THEN l.credit - l.debit ELSE 0 END) AS total_liabilities,
         SUM(CASE WHEN a.account_type = 'E'          THEN l.credit - l.debit ELSE 0 END) AS total_equity,
         SUM(CASE WHEN a.account_type IN ('R', 'X')  THEN l.credit - l.debit ELSE 0 END) AS current_earnings
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  JOIN gl_account a ON a.account_id = l.account_id
  WHERE j.status = 'P' AND j.period_id <= :period_id
) t;
```

**Verify (JS)**: Run one pass over the posted lines with four accumulators (cents). `equation_diff` must be exactly 0. If it is not, either a posted journal is unbalanced or an account has an invalid `account_type`.

**Traps**:
* `current_earnings` here is **cumulative since inception**, because no closing entries are assumed. After pattern 26 posts closing entries, it becomes the current year's earnings only. The equation holds either way.
* Contra-assets (accumulated depreciation, type `A`, credit-normal) correctly reduce `total_assets` because the sign is `debit - credit` for type A.
* An account with a type outside `A/L/E/R/X` silently drops out and breaks the equation, which is a good thing to assert on.

Sources: [Balance sheet / accounting equation](https://en.wikipedia.org/wiki/Double-entry_bookkeeping)

---

### 17. Gaps and duplicates in document number sequences - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Audit control. Journal, invoice and check numbers must be gapless and unique (many jurisdictions require this for invoices). Report each missing range, each missing number, and each "island" of consecutive numbers.

**Features**: `LAG`, `CONNECT BY LEVEL` row generator, `MINUS`, the Tabibitosan trick (`n - ROW_NUMBER()`) for islands.

**Tables**: `gl_journal(journal_no)` (the same works for `ar_invoice.invoice_no` and `ap_payment.payment_no`).

```sql
-- (a) gap ranges using LAG
SELECT prev_no + 1               AS gap_from,
       journal_no - 1            AS gap_to,
       journal_no - prev_no - 1  AS missing_count
FROM (SELECT journal_no, LAG(journal_no) OVER (ORDER BY journal_no) AS prev_no
      FROM gl_journal)
WHERE journal_no - prev_no > 1
ORDER BY gap_from;

-- (b) every missing number: generated series MINUS actual
WITH bounds AS (
  SELECT MIN(journal_no) AS lo, MAX(journal_no) AS hi FROM gl_journal
)
SELECT lo + LEVEL - 1 AS missing_no
FROM bounds
WHERE lo IS NOT NULL
CONNECT BY LEVEL <= hi - lo + 1
MINUS
SELECT journal_no FROM gl_journal
ORDER BY 1;

-- (c) islands of consecutive numbers (Tabibitosan)
SELECT MIN(journal_no) AS island_from, MAX(journal_no) AS island_to, COUNT(*) AS docs
FROM (SELECT journal_no, journal_no - ROW_NUMBER() OVER (ORDER BY journal_no) AS grp
      FROM gl_journal)
GROUP BY grp
ORDER BY island_from;

-- (d) duplicates
SELECT journal_no, COUNT(*) AS occurrences
FROM gl_journal
GROUP BY journal_no
HAVING COUNT(*) > 1;
```

**Verify (JS)**: Sort the unique numbers. Gaps are the pairs where `b - a > 1`. Missing numbers = `range(lo, hi)` minus the set. Islands come from one linear scan. Duplicates come from a count map.

**Traps**:
* Duplicates distort (a) (diff 0, harmless) and (c). A duplicated number increments `ROW_NUMBER` twice, which **splits an island**. Use `DENSE_RANK()` in (c) if duplicates are possible.
* **Empty table**: without `WHERE lo IS NOT NULL`, `CONNECT BY` still returns the single root row with `NULL + 1 - 1 = NULL`, so (b) reports one missing number, NULL.
* Number sequences usually restart per series (prefix, year, entity). Add `PARTITION BY series` to every window and generate per series.
* VARCHAR document numbers sort lexically (`'10' < '9'`). Extract the numeric part with `TO_NUMBER(REGEXP_SUBSTR(...))`.
* Oracle sequences are **not** gapless (cache, rollback). Gaps in surrogate keys are normal and are not audit findings. Only test business document numbers.

Sources: [Hierarchical queries / CONNECT BY LEVEL generator](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Hierarchical-Queries.html) - [Stew Ashton on Tabibitosan and gaps/islands in Oracle](https://stewashton.wordpress.com/)

---

### 18. Subledger to GL control-account reconciliation - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Month-end check that the AR subledger (open invoices) equals the GL accounts-receivable control account balance at each period end. Any difference points to manual GL postings to a control account or to unposted subledger batches.

**Features**: Correlated scalar subqueries per period, `LISTAGG` (with `ON OVERFLOW TRUNCATE`, 12.2+) to list the contributing journals.

**Tables**: `gl_period`, `ar_invoice`, `ar_application`, `gl_line`, `gl_journal`.

```sql
SELECT p.period_id,
       (SELECT NVL(SUM(i.amount), 0) FROM ar_invoice i WHERE i.invoice_date <= p.end_date)
     - (SELECT NVL(SUM(a.applied_amount), 0) FROM ar_application a WHERE a.applied_date <= p.end_date)
         AS subledger_open,
       (SELECT NVL(SUM(l.debit - l.credit), 0)
        FROM gl_line l JOIN gl_journal j ON j.journal_id = l.journal_id
        WHERE l.account_id = 1120 AND j.status = 'P' AND j.journal_date <= p.end_date)
         AS gl_control_balance,
       (SELECT LISTAGG(DISTINCT j.source, ',' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY j.source)
        FROM gl_line l JOIN gl_journal j ON j.journal_id = l.journal_id
        WHERE l.account_id = 1120 AND j.status = 'P' AND j.period_id = p.period_id)
         AS sources_this_period
FROM gl_period p
ORDER BY p.period_id;
```

(Account 1120 is the AR control account in the sample chart. In production, read it from configuration.)

**Verify (JS)**: For each period end, compute both sides independently from the model. The difference column tells you whether the simulation's GL posting logic and subledger logic agree. That makes it a strong cross-check of Mira's write paths.

**Traps**:
* `LISTAGG(DISTINCT ...)` is **19c-new**. On 18c and older it raises ORA-30482.
* Without `ON OVERFLOW TRUNCATE`, `LISTAGG` over 4000 bytes raises ORA-01489.
* Cut-off: the subledger uses document dates while the GL uses journal or period dates. A receipt dated 31-Mar but posted in April creates a timing difference that is not an error.
* Multi-currency invoices must be converted at the **booking** rate to tie to the GL, not at today's rate.

Sources: [LISTAGG (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/LISTAGG.html)

---

### 19. Three-way match (PO / goods receipt / vendor invoice) with tolerances - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: AP control. Pay only what was ordered **and** received, at the PO price, within a tolerance. Each PO gets a match status.

**Features**: Independent pre-aggregation of each child table (avoids fan-out), `LEFT JOIN`, `CASE` with ordered rules, `GREATEST` for an absolute/percent tolerance.

**Tables**: `purchase_order(ordered_qty, unit_price)`, `goods_receipt(received_qty)`, `ap_invoice(po_id, invoiced_qty, amount)`.

```sql
WITH rcv AS (
  SELECT po_id, SUM(received_qty) AS received_qty FROM goods_receipt GROUP BY po_id
),
inv AS (
  SELECT po_id, SUM(invoiced_qty) AS invoiced_qty, SUM(amount) AS invoiced_amt, COUNT(*) AS invoice_count
  FROM ap_invoice WHERE po_id IS NOT NULL GROUP BY po_id
)
SELECT po.po_id, po.vendor_id, po.ordered_qty,
       NVL(r.received_qty, 0) AS received_qty,
       NVL(i.invoiced_qty, 0) AS invoiced_qty,
       po.unit_price,
       NVL(i.invoiced_amt, 0) AS invoiced_amt,
       ROUND(NVL(i.invoiced_qty, 0) * po.unit_price, 2) AS expected_amt,
       CASE
         WHEN i.po_id IS NULL                                  THEN 'NOT INVOICED'
         WHEN NVL(i.invoiced_qty, 0) > NVL(r.received_qty, 0)  THEN 'BILLED > RECEIVED'
         WHEN NVL(r.received_qty, 0) > po.ordered_qty          THEN 'OVER-RECEIPT'
         WHEN ABS(i.invoiced_amt - ROUND(i.invoiced_qty * po.unit_price, 2))
              > GREATEST(1, 0.02 * ROUND(i.invoiced_qty * po.unit_price, 2)) THEN 'PRICE VARIANCE'
         ELSE 'MATCHED'
       END AS match_status
FROM purchase_order po
LEFT JOIN rcv r ON r.po_id = po.po_id
LEFT JOIN inv i ON i.po_id = po.po_id
ORDER BY po.po_id;
```

**Verify (JS)**: Build the per-PO sums of receipts and invoices, then apply the same ordered rule list (first match wins). The tolerance is `max(1.00, 2% of expected)`.

**Traps**:
* Joining receipts and invoices **both** directly to the PO before aggregating multiplies the quantities (receipts x invoices). Always pre-aggregate.
* Rule order matters: a PO can be both over-billed and price-variant, and `CASE` reports only the first.
* Quantity `NUMBER(12,3)` x price `NUMBER(14,4)` must be rounded to cents *before* comparing with the invoice amount.

Sources: [Three-way match](https://en.wikipedia.org/wiki/Three-way_match)

---

### 20. Automatic reversal of accruals into the next period - Intermediate

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Month-end accruals (estimates for expenses not yet invoiced) are reversed on day 1 of the next period. Generate the reversing journals for every accrual not yet reversed.

**Features**: `NOT EXISTS` anti-join (idempotency), `INSERT ... SELECT` with `ROW_NUMBER()` for new keys, debit/credit swap.

**Tables**: `gl_journal(source, reversal_of)`, `gl_line`, `gl_period`.

```sql
-- headers: one reversal per unreversed posted accrual journal
INSERT INTO gl_journal (journal_id, journal_no, journal_date, period_id, source, status, reversal_of, description)
SELECT :rev_journal_id_base + ROW_NUMBER() OVER (ORDER BY j.journal_id),
       :rev_journal_id_base + ROW_NUMBER() OVER (ORDER BY j.journal_id),
       (SELECT start_date FROM gl_period WHERE period_id = :reversal_period_id),
       :reversal_period_id, 'ACCRUAL', 'P', j.journal_id,
       'Reversal of ' || j.journal_no
FROM gl_journal j
WHERE j.source = 'ACCRUAL' AND j.status = 'P' AND j.reversal_of IS NULL
  AND j.period_id = :accrual_period_id
  AND NOT EXISTS (SELECT 1 FROM gl_journal r WHERE r.reversal_of = j.journal_id);

-- lines: copy with debit and credit swapped
INSERT INTO gl_line (line_id, journal_id, line_no, account_id, cost_center, debit, credit)
SELECT :rev_line_id_base + ROW_NUMBER() OVER (ORDER BY r.journal_id, l.line_no),
       r.journal_id, l.line_no, l.account_id, l.cost_center,
       l.credit, l.debit
FROM gl_journal r
JOIN gl_line l ON l.journal_id = r.reversal_of
WHERE r.period_id = :reversal_period_id
  AND r.reversal_of IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM gl_line x WHERE x.journal_id = r.journal_id);
```

**Verify (JS)**: For each accrual journal in period P that has no reversal, expect one reversal journal in P+1 whose lines mirror the original with sides swapped. The net effect of original + reversal on every account is 0. Running the inserts a second time must insert 0 rows.

**Traps**:
* Without the anti-join the procedure is not idempotent, and a re-run double-reverses.
* Using `-amount` instead of swapping columns breaks the "non-negative debit/credit" invariant from pattern 2.
* The reversal date must be the first day of the **next open** period. If that period is closed, real systems redirect to the first open period.
* Fresh keys from `bind + ROW_NUMBER()` are only safe single-session. Production uses a sequence or an identity column.

Sources: [Accrual](https://en.wikipedia.org/wiki/Accrual) - [INSERT (19c SQL Ref)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

---

## ADVANCED

### 21. Multi-currency conversion with effective-dated rates - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Convert foreign-currency documents into the functional currency at the rate in effect **on or before** the document date. This is the most common FX lookup in every ERP.

**Features**: `MAX(rate) KEEP (DENSE_RANK LAST ORDER BY rate_date)` (correlated), `LEAD(..., 1, DATE '9999-12-31')` for validity ranges, `ROW_NUMBER` join alternative.

**Tables**: `fx_rate(from_ccy, to_ccy, rate_date, rate)`, `ar_invoice(currency_code, invoice_date, amount)`.

```sql
-- (a) KEEP DENSE_RANK LAST: latest rate on or before the invoice date
SELECT x.invoice_id, x.currency_code, x.amount, x.invoice_date, x.rate_used,
       ROUND(x.amount * x.rate_used, 2) AS amount_base
FROM (
  SELECT i.invoice_id, i.currency_code, i.amount, i.invoice_date,
         CASE WHEN i.currency_code = :base_ccy THEN 1
              ELSE (SELECT MAX(r.rate) KEEP (DENSE_RANK LAST ORDER BY r.rate_date)
                    FROM fx_rate r
                    WHERE r.from_ccy = i.currency_code
                      AND r.to_ccy   = :base_ccy
                      AND r.rate_date <= i.invoice_date)
         END AS rate_used
  FROM ar_invoice i
) x
ORDER BY x.invoice_id;

-- (b) validity ranges with LEAD, then a range join (better for bulk conversion)
WITH rate_ranges AS (
  SELECT from_ccy, to_ccy, rate,
         rate_date AS valid_from,
         LEAD(rate_date, 1, DATE '9999-12-31') OVER (PARTITION BY from_ccy, to_ccy ORDER BY rate_date) AS valid_to
  FROM fx_rate
)
SELECT i.invoice_id, i.currency_code, i.amount, rr.rate,
       ROUND(i.amount * rr.rate, 2) AS amount_base
FROM ar_invoice i
JOIN rate_ranges rr
  ON  rr.from_ccy = i.currency_code
  AND rr.to_ccy   = :base_ccy
  AND i.invoice_date >= rr.valid_from
  AND i.invoice_date <  rr.valid_to
ORDER BY i.invoice_id;

-- (c) missing-rate exceptions: must be reported, never converted at 0
SELECT i.invoice_id, i.currency_code, i.invoice_date
FROM ar_invoice i
WHERE i.currency_code <> :base_ccy
  AND NOT EXISTS (SELECT 1 FROM fx_rate r
                  WHERE r.from_ccy = i.currency_code AND r.to_ccy = :base_ccy
                    AND r.rate_date <= i.invoice_date);
```

**Verify (JS)**: Sort the rates per pair by date. For each document, binary-search the last rate with `rate_date <= doc_date`, then `round2(amount * rate)` using a half-away-from-zero helper on a decimal library or scaled integers. Query (b) must return the same rows as (a) **minus** the base-currency rows (inner join) and minus missing-rate rows. Query (c) must equal the set where (a) gives a NULL rate.

**Traps**:
* `KEEP (DENSE_RANK LAST ...)` with **two rates on the same date** returns `MAX(rate)` among the tied rows. The model must apply the same tie rule (or the table must enforce uniqueness).
* No rate on or before the date gives NULL. `ROUND(amount * NULL)` is NULL and silently drops out of sums. Run query (c).
* **Rounding position**: summing rounded line conversions does not equal converting the rounded total. Decide (and model) which one the ledger stores. Pennies of difference are normal and are posted to a rounding account.
* `rate_date` with a time component: `<= invoice_date` (midnight) excludes a rate stamped 09:00 the same day. `TRUNC` both sides.
* `NUMBER(18,8)` x `NUMBER(14,2)` is exact in Oracle but not as a JS double. Use integer micro-units or a decimal library in the model.

Sources: [FIRST/LAST (KEEP DENSE_RANK) (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/FIRST.html) - [LEAD/LAG (19c Analytic Functions)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html)

---

### 22. Bank reconciliation (1:1 matching with duplicates, then reconciling statement) - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Match bank statement lines to cash-book entries. Unmatched bank items (fees, interest) need booking. Unmatched book items are outstanding checks and deposits in transit. Then prove the adjusted balances agree.

**Features**: `ROW_NUMBER() OVER (PARTITION BY amount, reference ...)` to pair duplicates **1:1**, `NOT EXISTS` anti-joins in both directions, `UNION ALL`, a reconciliation identity.

**Tables**: `bank_txn(value_date, amount, reference)`, `cash_book(entry_date, amount, reference)`.

```sql
-- (a) unmatched items on each side
WITH b AS (
  SELECT bank_txn_id, value_date, amount, NVL(reference, '~') AS ref,
         ROW_NUMBER() OVER (PARTITION BY amount, NVL(reference, '~') ORDER BY value_date, bank_txn_id) AS rn
  FROM bank_txn WHERE value_date <= :as_of
),
c AS (
  SELECT entry_id, entry_date, amount, NVL(reference, '~') AS ref,
         ROW_NUMBER() OVER (PARTITION BY amount, NVL(reference, '~') ORDER BY entry_date, entry_id) AS rn
  FROM cash_book WHERE entry_date <= :as_of
)
SELECT 'BANK ONLY' AS side, b.bank_txn_id AS item_id, b.value_date AS txn_date, b.amount, b.ref
FROM b
WHERE NOT EXISTS (SELECT 1 FROM c WHERE c.amount = b.amount AND c.ref = b.ref AND c.rn = b.rn)
UNION ALL
SELECT 'BOOK ONLY', c.entry_id, c.entry_date, c.amount, c.ref
FROM c
WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.amount = c.amount AND b.ref = c.ref AND b.rn = c.rn)
ORDER BY 3, 1, 2;

-- (b) reconciliation statement: both adjusted balances must be equal
WITH b AS (
  SELECT amount, NVL(reference, '~') AS ref,
         ROW_NUMBER() OVER (PARTITION BY amount, NVL(reference, '~') ORDER BY value_date, bank_txn_id) AS rn
  FROM bank_txn WHERE value_date <= :as_of
),
c AS (
  SELECT amount, NVL(reference, '~') AS ref,
         ROW_NUMBER() OVER (PARTITION BY amount, NVL(reference, '~') ORDER BY entry_date, entry_id) AS rn
  FROM cash_book WHERE entry_date <= :as_of
)
SELECT bank_balance, book_balance, bank_only, book_only,
       bank_balance + book_only AS adjusted_bank,   -- add deposits in transit, subtract outstanding checks
       book_balance + bank_only AS adjusted_book,   -- add interest, subtract bank fees
       (bank_balance + book_only) - (book_balance + bank_only) AS difference  -- must be 0
FROM (
  SELECT (SELECT NVL(SUM(amount), 0) FROM b) AS bank_balance,
         (SELECT NVL(SUM(amount), 0) FROM c) AS book_balance,
         (SELECT NVL(SUM(b.amount), 0) FROM b
           WHERE NOT EXISTS (SELECT 1 FROM c WHERE c.amount = b.amount AND c.ref = b.ref AND c.rn = b.rn)) AS bank_only,
         (SELECT NVL(SUM(c.amount), 0) FROM c
           WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.amount = c.amount AND b.ref = c.ref AND b.rn = c.rn)) AS book_only
  FROM dual
);
```

**Verify (JS)**: Group each side by `amount|ref`, sort each group by `(date, id)`, and pair by index. The leftovers are the unmatched items. The identity `bank - bankOnly === book - bookOnly` always holds, so `difference` is exactly 0 whatever the data. That makes it a self-check of the matching itself.

**Traps**:
* A plain `NOT EXISTS` on `(amount, reference)` treats two identical $500 checks as matched by **one** bank line. The `rn` pairing makes matching 1:1.
* `reference` NULL never equals NULL. Use the `'~'` sentinel, or match NULL-reference items on `(amount, date +/- n days)` in a second pass.
* Cut-off: an item in the book on 31-Mar that clears the bank on 2-Apr is *correctly* "book only" as of 31-Mar.
* Bank sign convention (+ is a deposit to the company) must match the cash book. A flipped sign makes nothing match.

Sources: [Bank reconciliation](https://en.wikipedia.org/wiki/Bank_reconciliation) - [ROW_NUMBER / analytic functions (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html)

---

### 23. DSO (days sales outstanding), monthly and rolling 3-month - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Track how fast customers pay: `DSO = AR balance / credit sales x days`. A trailing 3-month version smooths out seasonality.

**Features**: Correlated scalar subqueries per period, a moving window with shorthand `ROWS 2 PRECEDING`, `NULLIF`.

**Tables**: `gl_period(start_date, end_date)`, `ar_invoice`, `ar_application`.

```sql
WITH m AS (
  SELECT p.period_id, p.end_date,
         p.end_date - p.start_date + 1 AS days_in_period,
         (SELECT NVL(SUM(i.amount), 0) FROM ar_invoice i
          WHERE i.invoice_date BETWEEN p.start_date AND p.end_date) AS credit_sales,
         (SELECT NVL(SUM(i.amount), 0) FROM ar_invoice i WHERE i.invoice_date <= p.end_date)
       - (SELECT NVL(SUM(a.applied_amount), 0) FROM ar_application a WHERE a.applied_date <= p.end_date)
           AS ar_end
  FROM gl_period p
)
SELECT period_id, credit_sales, ar_end,
       ROUND(ar_end / NULLIF(credit_sales, 0) * days_in_period, 1) AS dso_month,
       ROUND(ar_end / NULLIF(SUM(credit_sales) OVER (ORDER BY period_id ROWS 2 PRECEDING), 0)
                    * SUM(days_in_period) OVER (ORDER BY period_id ROWS 2 PRECEDING), 1) AS dso_rolling_3m
FROM m
ORDER BY period_id;
```

**Verify (JS)**: Per period, compute sales in `[start, end]` and the AR balance at the end, then the same formula. For the rolling version, sum sales and days over indexes `i-2..i`. Compare to 1 dp after the same rounding.

**Traps**:
* `BETWEEN start_date AND end_date` misses invoices time-stamped during the last day. Use `< end_date + 1` if dates carry times.
* A month with no sales gives an undefined DSO (NULL), not infinity.
* There are several definitions (average AR vs ending AR, 360 vs 365 days, countback method). State which one the simulation implements.
* Multi-currency AR must be converted first (pattern 21).

Sources: [Days sales outstanding](https://en.wikipedia.org/wiki/Days_sales_outstanding) - [Windowing clause (19c Analytic Functions)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html)

---

### 24. Prepaid / deferral amortization schedule (row generator) - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Spread a prepaid contract (insurance, software subscription) evenly over its months. The last month absorbs the rounding, so the schedule sums exactly to the contract amount. The same shape covers deferred revenue recognition.

**Features**: `CROSS JOIN LATERAL (SELECT LEVEL ... CONNECT BY LEVEL <= c.months)` (12c+), `ADD_MONTHS`, `TRUNC(date, 'MM')`, running `SUM OVER`.

**Tables**: `prepaid_contract(start_date, months, total_amount)`.

```sql
SELECT c.contract_id, n.k AS month_no,
       ADD_MONTHS(TRUNC(c.start_date, 'MM'), n.k - 1) AS month_start,
       CASE WHEN n.k < c.months THEN ROUND(c.total_amount / c.months, 2)
            ELSE c.total_amount - ROUND(c.total_amount / c.months, 2) * (c.months - 1)
       END AS expense,
       SUM(CASE WHEN n.k < c.months THEN ROUND(c.total_amount / c.months, 2)
                ELSE c.total_amount - ROUND(c.total_amount / c.months, 2) * (c.months - 1) END)
         OVER (PARTITION BY c.contract_id ORDER BY n.k ROWS UNBOUNDED PRECEDING) AS amortized_to_date,
       c.total_amount
       - SUM(CASE WHEN n.k < c.months THEN ROUND(c.total_amount / c.months, 2)
                  ELSE c.total_amount - ROUND(c.total_amount / c.months, 2) * (c.months - 1) END)
         OVER (PARTITION BY c.contract_id ORDER BY n.k ROWS UNBOUNDED PRECEDING) AS prepaid_remaining
FROM prepaid_contract c
CROSS JOIN LATERAL (SELECT LEVEL AS k FROM dual CONNECT BY LEVEL <= c.months) n
ORDER BY c.contract_id, n.k;
```

Pre-12c-compatible variant (one shared generator, joined by range):

```sql
SELECT c.contract_id, g.k AS month_no, ADD_MONTHS(TRUNC(c.start_date, 'MM'), g.k - 1) AS month_start
FROM prepaid_contract c
JOIN (SELECT LEVEL AS k FROM dual
      CONNECT BY LEVEL <= (SELECT MAX(months) FROM prepaid_contract)) g
  ON g.k <= c.months
ORDER BY c.contract_id, g.k;
```

**Verify (JS)**: `base = round2(total / months)`, the last row = `total - base*(months-1)`, `sum(rows) === total` in cents, and the final `prepaid_remaining === 0`.

**Traps**:
* **ADD_MONTHS end-of-month rule**: if the input is the last day of its month, the result is the last day of the target month. `ADD_MONTHS(DATE '2025-01-31', 1) = 2025-02-28`, and `ADD_MONTHS(DATE '2025-02-28', 1) = 2025-03-31` (not 03-28). JS `setMonth` overflows instead (Jan 31 + 1 month = Mar 3). The model must replicate Oracle's rule, which is why this example anchors on `TRUNC(start, 'MM')`.
* The last-month plug can be **negative** when the rounding direction accumulates, for example 0.05 over 3 months = 0.02, 0.02, 0.01 (fine), but 0.10 over 6 = 0.02 x 5 + 0.00. Test tiny amounts.
* Mid-month starts usually need daily proration of the first and last months. That is a different formula, so state the convention.
* `CONNECT BY LEVEL <= c.months` inside `LATERAL` is correlated per row. Without `LATERAL` (or the shared-generator form), the CONNECT BY runs over the whole table and explodes combinatorially.

Sources: [ADD_MONTHS (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ADD_MONTHS.html) - [SELECT LATERAL / CROSS APPLY (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html) - [Accrual / deferral](https://en.wikipedia.org/wiki/Accrual)

---

### 25. Straight-line depreciation schedule (monthly) - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Generate the monthly depreciation, accumulated depreciation and net book value (NBV) for each straight-line asset. The last month plugs to salvage value exactly.

**Features**: A shared row generator (`CONNECT BY LEVEL` up to `MAX(life_months)`), `ADD_MONTHS`, `LAST_DAY`, running `SUM OVER`.

**Tables**: `fa_asset(cost, salvage_value, life_months, in_service_date, method)`.

```sql
WITH gen AS (
  SELECT LEVEL AS k FROM dual
  CONNECT BY LEVEL <= (SELECT MAX(life_months) FROM fa_asset WHERE method = 'SL')
),
sched AS (
  SELECT a.asset_id, a.cost, a.salvage_value, g.k AS month_no,
         LAST_DAY(ADD_MONTHS(TRUNC(a.in_service_date, 'MM'), g.k - 1)) AS period_end,
         CASE WHEN g.k < a.life_months
              THEN ROUND((a.cost - a.salvage_value) / a.life_months, 2)
              ELSE (a.cost - a.salvage_value)
                   - ROUND((a.cost - a.salvage_value) / a.life_months, 2) * (a.life_months - 1)
         END AS depreciation
  FROM fa_asset a
  JOIN gen g ON g.k <= a.life_months
  WHERE a.method = 'SL'
)
SELECT asset_id, month_no, period_end, depreciation,
       SUM(depreciation) OVER (PARTITION BY asset_id ORDER BY month_no ROWS UNBOUNDED PRECEDING) AS accumulated,
       cost - SUM(depreciation) OVER (PARTITION BY asset_id ORDER BY month_no ROWS UNBOUNDED PRECEDING) AS nbv
FROM sched
ORDER BY asset_id, month_no;
```

**Verify (JS)**: `base = round2((cost - salvage) / life)`, the last month is the plug, the final `nbv === salvage`, and `accumulated` is monotonic.

**Traps**:
* Conventions differ: full month in the month placed in service (used here), mid-month, or half-year (US MACRS). The model must pick the same one.
* Disposals and impairments truncate or re-base the schedule. This pattern covers the base case only.
* Salvage > cost gives negative depreciation. Validate inputs.
* The generator size is `MAX(life_months)`. One 600-month asset makes every query generate 600 rows, which is harmless but worth knowing.

Sources: [Depreciation](https://en.wikipedia.org/wiki/Depreciation) - [IRS Publication 946 (How to Depreciate Property)](https://www.irs.gov/publications/p946) - [LAST_DAY](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/LAST_DAY.html)

---

### 26. Year-end close: closing entries to retained earnings, and RE roll-forward - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: At fiscal year end, zero every P&L account and move net income into retained earnings with one balanced closing journal. Then show the RE roll-forward: opening + net income = closing.

**Features**: `INSERT ... SELECT` with `UNION ALL` (detail plus offset line), `HAVING`, `GREATEST` to split a signed amount into debit/credit, `ROW_NUMBER` for line numbers, `MAX` to find the year-end period.

**Tables**: `gl_journal`, `gl_line`, `gl_period`, `gl_account`.

```sql
-- header in the last period of the year
INSERT INTO gl_journal (journal_id, journal_no, journal_date, period_id, source, status, reversal_of, description)
SELECT :closing_journal_id, :closing_journal_no, MAX(end_date),
       MAX(period_id), 'CLOSE', 'P', NULL, 'Year-end close ' || :fiscal_year
FROM gl_period
WHERE fiscal_year = :fiscal_year;

-- lines: reverse each P&L balance (by account and cost center) and offset to retained earnings
INSERT INTO gl_line (line_id, journal_id, line_no, account_id, cost_center, debit, credit)
SELECT :line_id_base + ROW_NUMBER() OVER (ORDER BY x.account_id, x.cost_center),
       :closing_journal_id,
       ROW_NUMBER() OVER (ORDER BY x.account_id, x.cost_center),
       x.account_id, x.cost_center,
       GREATEST(x.post, 0)  AS debit,
       GREATEST(-x.post, 0) AS credit
FROM (
  SELECT l.account_id, l.cost_center, -SUM(l.debit - l.credit) AS post
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  JOIN gl_period  p ON p.period_id  = j.period_id
  JOIN gl_account a ON a.account_id = l.account_id
  WHERE j.status = 'P' AND p.fiscal_year = :fiscal_year
    AND a.account_type IN ('R', 'X') AND j.source <> 'CLOSE'
  GROUP BY l.account_id, l.cost_center
  HAVING SUM(l.debit - l.credit) <> 0
  UNION ALL
  SELECT :re_account_id, NULL, SUM(l.debit - l.credit)        -- net income credited to RE
  FROM gl_line l
  JOIN gl_journal j ON j.journal_id = l.journal_id
  JOIN gl_period  p ON p.period_id  = j.period_id
  JOIN gl_account a ON a.account_id = l.account_id
  WHERE j.status = 'P' AND p.fiscal_year = :fiscal_year
    AND a.account_type IN ('R', 'X') AND j.source <> 'CLOSE'
  HAVING SUM(l.debit - l.credit) <> 0
) x;

-- retained earnings roll-forward for the year
SELECT :fiscal_year AS fiscal_year,
       -SUM(CASE WHEN p.fiscal_year <  :fiscal_year THEN l.debit - l.credit ELSE 0 END) AS re_opening,
       -SUM(CASE WHEN p.fiscal_year =  :fiscal_year AND j.source =  'CLOSE' THEN l.debit - l.credit ELSE 0 END) AS net_income_closed,
       -SUM(CASE WHEN p.fiscal_year =  :fiscal_year AND j.source <> 'CLOSE' THEN l.debit - l.credit ELSE 0 END) AS other_movements,  -- dividends, prior-period adj.
       -SUM(CASE WHEN p.fiscal_year <= :fiscal_year THEN l.debit - l.credit ELSE 0 END) AS re_closing
FROM gl_line l
JOIN gl_journal j ON j.journal_id = l.journal_id
JOIN gl_period  p ON p.period_id  = j.period_id
WHERE l.account_id = :re_account_id AND j.status = 'P';
```

**Verify (JS)**: After the close, every R/X account's balance for the fiscal year is 0. The closing journal balances (pattern 2). The RE line equals the year's net income (pattern 14 grand total, sign flipped to credit-positive). `re_closing = re_opening + net_income_closed + other_movements`. Re-running the close must be blocked (check for an existing `source = 'CLOSE'` journal for that year) or must yield zero lines because of `j.source <> 'CLOSE'` plus `HAVING <> 0`.

**Traps**:
* Exclude the closing journal itself (`source <> 'CLOSE'`). Otherwise a re-run reverses the reversal.
* The second `UNION ALL` branch is an aggregate **without** `GROUP BY`. It always returns one row, even with no data, which is why it carries `HAVING ... <> 0`, so a year with no P&L inserts nothing.
* The RE line could also be split per cost center or entity. Keep it consistent with how pattern 7 remaps prior-year P&L, or the trial balance double counts.
* The year-end period must be **open** to post. Real systems close all periods except the last, post, then close it.

Sources: [Retained earnings](https://en.wikipedia.org/wiki/Retained_earnings) - [Trial balance / closing entries](https://en.wikipedia.org/wiki/Trial_balance)

---

### 27. FIFO application of customer receipts to invoices (interval overlap) - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Auto cash application. Allocate each customer's receipts to their oldest invoices first, including partial payments and one receipt spanning several invoices, **without procedural code**.

**Features**: Two running sums per customer (`SUM OVER ... ROWS UNBOUNDED PRECEDING`) that turn amounts into intervals `[from, to)`, an interval-overlap join, `LEAST`/`GREATEST`, `LISTAGG`.

**Tables**: `ar_invoice(customer_id, invoice_date, amount)`, `ar_receipt(customer_id, receipt_date, amount)`.

```sql
WITH inv AS (
  SELECT invoice_id, customer_id, invoice_date, amount,
         SUM(amount) OVER (PARTITION BY customer_id ORDER BY invoice_date, invoice_id
                           ROWS UNBOUNDED PRECEDING) - amount AS inv_from,
         SUM(amount) OVER (PARTITION BY customer_id ORDER BY invoice_date, invoice_id
                           ROWS UNBOUNDED PRECEDING)          AS inv_to
  FROM ar_invoice
),
rcp AS (
  SELECT receipt_id, customer_id, receipt_date, amount,
         SUM(amount) OVER (PARTITION BY customer_id ORDER BY receipt_date, receipt_id
                           ROWS UNBOUNDED PRECEDING) - amount AS rcp_from,
         SUM(amount) OVER (PARTITION BY customer_id ORDER BY receipt_date, receipt_id
                           ROWS UNBOUNDED PRECEDING)          AS rcp_to
  FROM ar_receipt
),
alloc AS (
  SELECT r.customer_id, r.receipt_id, i.invoice_id,
         GREATEST(r.receipt_date, i.invoice_date) AS applied_date,
         LEAST(r.rcp_to, i.inv_to) - GREATEST(r.rcp_from, i.inv_from) AS applied_amount
  FROM rcp r
  JOIN inv i
    ON  i.customer_id = r.customer_id
    AND r.rcp_from < i.inv_to
    AND i.inv_from < r.rcp_to
)
SELECT a.customer_id, a.invoice_id, i.amount AS invoice_amount,
       SUM(a.applied_amount) AS applied,
       i.amount - SUM(a.applied_amount) AS remaining,
       LISTAGG(a.receipt_id || ':' || a.applied_amount, ', ') WITHIN GROUP (ORDER BY a.receipt_id) AS paid_by
FROM alloc a
JOIN ar_invoice i ON i.invoice_id = a.invoice_id
GROUP BY a.customer_id, a.invoice_id, i.amount
ORDER BY a.customer_id, a.invoice_id;
```

Unapplied cash (receipts beyond the total invoiced) per customer:

```sql
SELECT r.customer_id,
       SUM(r.amount) - NVL((SELECT SUM(i.amount) FROM ar_invoice i WHERE i.customer_id = r.customer_id), 0) AS unapplied_cash
FROM ar_receipt r
GROUP BY r.customer_id
HAVING SUM(r.amount) > NVL((SELECT SUM(i.amount) FROM ar_invoice i WHERE i.customer_id = r.customer_id), 0);
```

**Verify (JS)**: Run the classic two-pointer greedy per customer. Sort invoices by `(date, id)` and receipts by `(date, id)`, then repeatedly apply `min(invRemaining, rcpRemaining)` and advance whichever pointer hits zero. Each emitted `(receipt, invoice, amount)` triple must equal a row of `alloc`. Also check `sum(alloc) = min(total invoices, total receipts)` per customer.

**Traps**:
* Invoices with nothing applied do not appear at all (inner join). LEFT JOIN from `ar_invoice` if you need fully open invoices too.
* **Credit memos and negative receipts** break the interval model, because intervals must be non-decreasing. Net them out first, or handle them in a separate pass.
* **Ties** (same date) need a deterministic tiebreaker (`invoice_id`), or the allocation is non-deterministic between runs and between SQL and JS.
* The strict `<` in the overlap predicate excludes zero-length touches (an interval ending exactly where the next starts). Using `<=` creates spurious 0.00 rows.
* This is "FIFO by date" across all invoices. Real cash application first honors remittance advice (explicit invoice references) and FIFOs only the remainder.

Sources: [Oracle forums / StackOverflow: running-sum + LAG payment distribution](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/24438805/oracle-sql-query-for-distributing-payments) - [Red Gate: FIFO with window functions](https://www.red-gate.com/simple-talk/databases/sql-server/t-sql-window-function-speed-phreakery-the-fifo-stock-inventory-problem/) - [Oracle forum: knock-off invoices](https://forums.oracle.com/ords/apexds/post/knockoff-invoices-8221)

---

### 28. Penny-exact allocation by weights (largest remainder method) - Advanced

**Status: verified on 19c** (Oracle 19.19 EE). The working query is verified; the first query is an intentional failure (ORA-30483) kept as a trap.

**Purpose**: Allocate a shared cost (rent, IT) to cost centers by a driver (headcount, m2) so that the parts **sum exactly** to the pool. The leftover cents go to the lines with the largest fractional remainders.

**Features**: `RATIO`-style weighting with `SUM OVER (PARTITION BY)`, `FLOOR`, `ROW_NUMBER() OVER (ORDER BY remainder DESC, ...)` inside `CASE`, integer-cent arithmetic.

**Tables**: `alloc_pool(pool_id, amount)`, `alloc_driver(pool_id, cost_center, weight)`.

```sql
WITH d AS (
  SELECT ad.pool_id, ad.cost_center, ad.weight, ap.amount,
         ap.amount * 100 * ad.weight / NULLIF(SUM(ad.weight) OVER (PARTITION BY ad.pool_id), 0) AS exact_cents
  FROM alloc_driver ad
  JOIN alloc_pool ap ON ap.pool_id = ad.pool_id
),
f AS (
  SELECT d.*,
         FLOOR(exact_cents)                  AS floor_cents,
         exact_cents - FLOOR(exact_cents)    AS remainder,
         amount * 100 - SUM(FLOOR(exact_cents)) OVER (PARTITION BY pool_id) AS leftover_cents
  FROM d
)
SELECT pool_id, cost_center, weight, amount AS pool_amount,
       (floor_cents
        + CASE WHEN ROW_NUMBER() OVER (PARTITION BY pool_id
                                       ORDER BY remainder DESC, weight DESC, cost_center)
                    <= leftover_cents
               THEN 1 ELSE 0 END) / 100 AS allocated,
       SUM((floor_cents
            + CASE WHEN ROW_NUMBER() OVER (PARTITION BY pool_id
                                           ORDER BY remainder DESC, weight DESC, cost_center)
                        <= leftover_cents
                   THEN 1 ELSE 0 END) / 100) OVER (PARTITION BY pool_id) AS check_total
FROM f
ORDER BY pool_id, cost_center;
```

> The `check_total` column nests `ROW_NUMBER` inside `SUM() OVER`. **Oracle does not allow nested analytic functions (ORA-30483).** It is shown as a deliberate trap and is not part of the working query. Use the corrected query below.

Working version (compute the extra cent in a CTE, then total it):

```sql
WITH d AS (
  SELECT ad.pool_id, ad.cost_center, ad.weight, ap.amount,
         ap.amount * 100 * ad.weight / NULLIF(SUM(ad.weight) OVER (PARTITION BY ad.pool_id), 0) AS exact_cents
  FROM alloc_driver ad
  JOIN alloc_pool ap ON ap.pool_id = ad.pool_id
),
f AS (
  SELECT d.*,
         FLOOR(exact_cents)               AS floor_cents,
         exact_cents - FLOOR(exact_cents) AS remainder,
         amount * 100 - SUM(FLOOR(exact_cents)) OVER (PARTITION BY pool_id) AS leftover_cents
  FROM d
),
r AS (
  SELECT f.*,
         ROW_NUMBER() OVER (PARTITION BY pool_id ORDER BY remainder DESC, weight DESC, cost_center) AS rk
  FROM f
)
SELECT pool_id, cost_center, weight, amount AS pool_amount,
       (floor_cents + CASE WHEN rk <= leftover_cents THEN 1 ELSE 0 END) / 100 AS allocated,
       SUM((floor_cents + CASE WHEN rk <= leftover_cents THEN 1 ELSE 0 END) / 100)
         OVER (PARTITION BY pool_id) AS check_total      -- must equal pool_amount
FROM r
ORDER BY pool_id, cost_center;
```

**Verify (JS)**: Work in integer cents with exact rationals: `exact = cents * w / W`. Computing `floor` as `Math.floor((cents * w) / W)` over BigInt avoids float error. `leftover = cents - sum(floor)`. Sort by `(remainder desc, weight desc, cc asc)` using the remainder numerator `(cents*w) mod W` for exact comparison, then give +1 cent to the first `leftover` rows. Assert `sum === pool`.

**Traps**:
* `FLOOR`, not `TRUNC`. For **negative** pools (credits), `TRUNC` rounds toward zero, the leftover becomes negative, and no row receives it. With `FLOOR` the leftover is always in `[0, n)`.
* All weights 0 gives NULL from `NULLIF` and every allocation is NULL. Decide on a fallback (equal split).
* Oracle NUMBER division is precise to ~38 digits, so `1/3` is not exact. Remainder ties that should be exact ties (e.g. weights 1, 1, 1) are still equal in Oracle because the same expression is computed identically. JS doubles may differ, so use exact integer arithmetic in the model.
* The tiebreaker must be total (`cost_center` last), or the cent lands on a random line.

Sources: [Largest remainder method](https://en.wikipedia.org/wiki/Largest_remainder_method) - [RATIO_TO_REPORT (alternative weighting)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/RATIO_TO_REPORT.html) - [Analytic function restrictions (no nesting)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html)

---

### 29. Payroll gross-to-net with progressive tax brackets, and the payroll journal via UNPIVOT - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Compute each employee's pension deduction, progressive income tax (annualized and spread over 12 months) and net pay. Then produce the balanced payroll journal.

**Features**: **Range join** (`income > lower_bound`), `LEAST`/`GREATEST` per bracket slice, `NVL(upper_bound, income)` for the open top bracket, `LEAD` to validate bracket contiguity, `UNPIVOT` to turn columns into journal lines.

**Tables**: `employee(monthly_gross, pension_rate)`, `tax_bracket(lower_bound, upper_bound, rate)`.

```sql
-- (a) gross to net
WITH base AS (
  SELECT e.employee_id, e.emp_name, e.monthly_gross,
         ROUND(e.monthly_gross * e.pension_rate, 2)                             AS pension,
         (e.monthly_gross - ROUND(e.monthly_gross * e.pension_rate, 2)) * 12    AS annual_taxable
  FROM employee e
),
tax AS (
  SELECT b.employee_id,
         SUM((LEAST(b.annual_taxable, NVL(t.upper_bound, b.annual_taxable)) - t.lower_bound) * t.rate) AS annual_tax,
         MAX(t.rate) AS marginal_rate
  FROM base b
  JOIN tax_bracket t ON b.annual_taxable > t.lower_bound
  GROUP BY b.employee_id
)
SELECT b.employee_id, b.emp_name, b.monthly_gross, b.pension,
       ROUND(NVL(t.annual_tax, 0) / 12, 2)                                  AS income_tax,
       b.monthly_gross - b.pension - ROUND(NVL(t.annual_tax, 0) / 12, 2)    AS net_pay,
       NVL(t.marginal_rate, 0)                                              AS marginal_rate,
       ROUND(NVL(t.annual_tax, 0) / NULLIF(b.annual_taxable, 0), 4)         AS effective_rate
FROM base b
LEFT JOIN tax t ON t.employee_id = b.employee_id
ORDER BY b.employee_id;

-- (b) bracket table sanity: contiguous, no overlaps, exactly one open top bracket
SELECT bracket_id, lower_bound, upper_bound, next_lower
FROM (SELECT bracket_id, lower_bound, upper_bound,
             LEAD(lower_bound) OVER (ORDER BY lower_bound) AS next_lower
      FROM tax_bracket)
WHERE (next_lower IS NOT NULL AND (upper_bound IS NULL OR upper_bound <> next_lower))
   OR (next_lower IS NULL AND upper_bound IS NOT NULL);

-- (c) payroll journal lines via UNPIVOT: Dr salary expense / Cr pension, tax and net-pay payables
WITH pay AS (
  SELECT e.employee_id,
         e.monthly_gross,
         ROUND(e.monthly_gross * e.pension_rate, 2) AS pension,
         ROUND(NVL((SELECT SUM((LEAST((e.monthly_gross - ROUND(e.monthly_gross * e.pension_rate, 2)) * 12,
                                      NVL(t.upper_bound, (e.monthly_gross - ROUND(e.monthly_gross * e.pension_rate, 2)) * 12))
                                - t.lower_bound) * t.rate)
                    FROM tax_bracket t
                    WHERE (e.monthly_gross - ROUND(e.monthly_gross * e.pension_rate, 2)) * 12 > t.lower_bound), 0) / 12, 2) AS income_tax
  FROM employee e
),
totals AS (
  SELECT SUM(monthly_gross) AS gross, SUM(pension) AS pension, SUM(income_tax) AS tax,
         SUM(monthly_gross - pension - income_tax) AS net
  FROM pay
)
SELECT component, account_id,
       CASE WHEN component = 'GROSS' THEN amt ELSE 0 END AS debit,
       CASE WHEN component = 'GROSS' THEN 0 ELSE amt END AS credit
FROM totals
UNPIVOT (amt FOR component IN (gross AS 'GROSS', pension AS 'PENSION', tax AS 'TAX', net AS 'NET'))
JOIN (SELECT 'GROSS' AS comp, 5100 AS account_id FROM dual UNION ALL
      SELECT 'PENSION', 2300 FROM dual UNION ALL
      SELECT 'TAX',     2200 FROM dual UNION ALL
      SELECT 'NET',     2500 FROM dual) m
  ON m.comp = component
ORDER BY CASE component WHEN 'GROSS' THEN 1 WHEN 'PENSION' THEN 2 WHEN 'TAX' THEN 3 ELSE 4 END;
```

**Verify (JS)**: `tax = sum over brackets of max(0, min(income, upper ?? income) - lower) * rate`, then `round2(tax / 12)`. `net = gross - pension - tax`. For the journal: `debit total === credit total` by construction (gross = pension + tax + net). Check this against the employee-level rounding, not a recomputation on totals.

**Traps**:
* **Bracket edges**: is income exactly at the boundary in the lower or the upper bracket? Here `lower` is exclusive and `upper` inclusive, and the slice formula is edge-safe either way because a zero-width slice contributes 0.
* **Rounding order**: rounding tax per employee and summing is not the same as rounding the total. Payroll journals must equal the sum of payslips. This is why (c) sums per-employee rounded values.
* `UNPIVOT` drops NULL values by default (`EXCLUDE NULLS`). A NULL tax row would vanish from the journal. Use `INCLUDE NULLS` or `NVL` first.
* Real tax uses effective-dated brackets, filing status and YTD cumulative withholding. Add `effective_from` / `effective_to` and join on the pay date.

Sources: [IRS federal income tax rates and brackets](https://www.irs.gov/filing/federal-income-tax-rates-and-brackets) - [Progressive tax](https://en.wikipedia.org/wiki/Progressive_tax) - [SELECT unpivot_clause (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

---

### 30. Benford's law first-digit test - Advanced

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Forensic accounting. Naturally occurring amounts have leading digit d with probability `log10(1 + 1/d)`. Large deviations (chi-square, MAD) flag possibly fabricated payments.

**Features**: String-based first significant digit (`LTRIM(TO_CHAR(ABS(x)), '0.,')`), `LOG(10, ...)`, a `CONNECT BY LEVEL <= 9` generator for the expected distribution, `RATIO_TO_REPORT`, `SUM OVER ()`.

**Tables**: `ap_payment(amount)` (or any amount column).

```sql
WITH d AS (
  SELECT TO_NUMBER(SUBSTR(LTRIM(TO_CHAR(ABS(amount)), '0.,'), 1, 1)) AS first_digit
  FROM ap_payment
  WHERE amount <> 0
),
expected AS (
  SELECT LEVEL AS digit, LOG(10, 1 + 1 / LEVEL) AS p FROM dual CONNECT BY LEVEL <= 9
),
observed AS (
  SELECT first_digit, COUNT(*) AS n FROM d GROUP BY first_digit
)
SELECT e.digit,
       NVL(o.n, 0)                                         AS observed_count,
       ROUND(RATIO_TO_REPORT(NVL(o.n, 0)) OVER (), 4)      AS observed_pct,
       ROUND(e.p, 4)                                       AS expected_pct,
       ROUND(POWER(NVL(o.n, 0) - e.p * SUM(NVL(o.n, 0)) OVER (), 2)
             / NULLIF(e.p * SUM(NVL(o.n, 0)) OVER (), 0), 3) AS chi_sq_term,   -- sum > 15.507 => reject at 5% (8 df)
       ROUND(ABS(RATIO_TO_REPORT(NVL(o.n, 0)) OVER () - e.p), 4) AS abs_deviation  -- mean over digits = MAD
FROM expected e
LEFT JOIN observed o ON o.first_digit = e.digit
ORDER BY e.digit;
```

**Verify (JS)**: `firstDigit = String(Math.abs(x)).replace(/^[0.]+/, '')[0]`. Count, then compute `p = Math.log10(1 + 1/d)` and the chi-square terms. Compare with tolerance 1e-3 (the values are rounded).

**Traps**:
* The math approach `TRUNC(x / POWER(10, FLOOR(LOG(10, x))))` fails at exact powers of ten: `LOG(10, 1000)` can be `2.9999...`, which yields "digit" 10. The string method avoids this.
* `TO_CHAR(0.45)` is `'.45'` (no leading zero), and with NLS decimal comma it is `',45'`. Hence `'0.,'` in `LTRIM`.
* Benford needs data spanning several orders of magnitude and no imposed min/max. Fixed-price items (subscriptions) legitimately fail. Exclude amounts < 10 per common audit practice.
* Small samples (n < ~300) make chi-square unreliable.

Sources: [Benford's law](https://en.wikipedia.org/wiki/Benford%27s_law) - [RATIO_TO_REPORT (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/RATIO_TO_REPORT.html)

---

## EXPERT

### 31. Declining-balance depreciation with switch to straight-line (recursive WITH) - Expert

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: The double-declining-balance (DDB) method depreciates `2/life x NBV` each year. It switches to straight-line over the remaining life once that gives more, and never depreciates below salvage value. Each year depends on the previous year's NBV, which is a natural fit for recursion.

**Features**: Recursive subquery factoring (`WITH dep (...) AS (anchor UNION ALL recursive)`), `GREATEST`/`LEAST`, `ROUND`, running `SUM OVER` on the result.

**Tables**: `fa_asset(cost, salvage_value, life_months, method = 'DDB')`.

```sql
WITH dep (asset_id, yr, life_years, salvage_value, opening_nbv, depreciation) AS (
  SELECT asset_id, 1, life_months / 12, salvage_value, cost,
         CASE WHEN life_months / 12 = 1 THEN cost - salvage_value
              ELSE ROUND(LEAST(cost - salvage_value,
                               GREATEST(cost * 2 / (life_months / 12),
                                        (cost - salvage_value) / (life_months / 12))), 2)
         END
  FROM fa_asset
  WHERE method = 'DDB'
  UNION ALL
  SELECT d.asset_id, d.yr + 1, d.life_years, d.salvage_value,
         d.opening_nbv - d.depreciation,
         CASE WHEN d.yr + 1 = d.life_years
              THEN d.opening_nbv - d.depreciation - d.salvage_value          -- final year plugs to salvage
              ELSE ROUND(LEAST(d.opening_nbv - d.depreciation - d.salvage_value,
                               GREATEST((d.opening_nbv - d.depreciation) * 2 / d.life_years,
                                        (d.opening_nbv - d.depreciation - d.salvage_value)
                                          / (d.life_years - d.yr))), 2)
         END
  FROM dep d
  WHERE d.yr < d.life_years
)
SELECT asset_id, yr, opening_nbv, depreciation,
       opening_nbv - depreciation AS closing_nbv,
       SUM(depreciation) OVER (PARTITION BY asset_id ORDER BY yr ROWS UNBOUNDED PRECEDING) AS accumulated,
       CASE WHEN yr = life_years THEN 'FINAL'
            WHEN depreciation > ROUND(opening_nbv * 2 / life_years, 2) THEN 'SL'
            ELSE 'DDB' END AS method_used
FROM dep
ORDER BY asset_id, yr;
```

**Verify (JS)**:
```
nbv = cost
for y in 1..L:
  dep = (y == L) ? nbv - salvage : round2(min(nbv - salvage, max(nbv*2/L, (nbv - salvage)/(L - y + 1))))
  nbv -= dep
```
The final NBV must equal salvage, and depreciation is never negative.

**Traps**:
* `life_months / 12` must be an integer for annual DDB. Partial first years (mid-year convention) need a first-year fraction factor.
* Recursive WITH column types come from the anchor. Here they are all NUMBER, which is fine. Character columns need `CAST`.
* Rounding inside the recursion compounds. Oracle and JS must round at exactly the same step, half away from zero.
* Oracle reports ORA-32044 (cycle) only with a `CYCLE` clause. Termination here relies on `yr < life_years`, so a NULL `life_months` row would recurse zero times (the predicate is NULL), not infinitely.

Sources: [Depreciation (declining balance, switch to SL)](https://en.wikipedia.org/wiki/Depreciation) - [IRS Pub 946](https://www.irs.gov/publications/p946) - [Recursive subquery factoring (19c SELECT)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html)

---

### 32. Loan amortization schedule (recursive WITH, final-payment true-up) - Expert

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Treasury and lending. Produce the installment schedule for an annuity loan: interest on the opening balance, principal = payment - interest, and a last installment that clears the balance exactly.

**Features**: Annuity formula with `POWER`, recursive WITH carrying the balance forward, `ADD_MONTHS`.

**Tables**: `loan(principal, annual_rate, term_months, start_date)`.

```sql
WITH params AS (
  SELECT loan_id, principal, start_date, term_months,
         annual_rate / 12 AS r,
         ROUND(principal * (annual_rate / 12)
               / (1 - POWER(1 + annual_rate / 12, -term_months)), 2) AS pmt
  FROM loan
  WHERE annual_rate > 0
),
sched (loan_id, k, n, r, pmt, start_date, opening_bal, interest, principal_paid) AS (
  SELECT loan_id, 1, term_months, r, pmt, start_date, principal,
         ROUND(principal * r, 2),
         CASE WHEN term_months = 1 THEN principal ELSE pmt - ROUND(principal * r, 2) END
  FROM params
  UNION ALL
  SELECT s.loan_id, s.k + 1, s.n, s.r, s.pmt, s.start_date,
         s.opening_bal - s.principal_paid,
         ROUND((s.opening_bal - s.principal_paid) * s.r, 2),
         CASE WHEN s.k + 1 = s.n THEN s.opening_bal - s.principal_paid
              ELSE s.pmt - ROUND((s.opening_bal - s.principal_paid) * s.r, 2) END
  FROM sched s
  WHERE s.k < s.n
)
SELECT loan_id, k AS installment,
       ADD_MONTHS(start_date, k)        AS due_date,
       opening_bal, interest, principal_paid,
       interest + principal_paid        AS payment,
       opening_bal - principal_paid     AS closing_bal
FROM sched
ORDER BY loan_id, k;
```

**Verify (JS)**: Compute `pmt = round2(P*r / (1 - (1+r)^-n))` with a decimal library, iterate n times with the same rounding, true up the last installment, and assert `closing_bal[n] === 0` and `sum(principal_paid) === P`.

**Traps**:
* `annual_rate = 0` divides by zero, which is why it is filtered. A 0% loan is simply `P/n` with a plug.
* `r = annual_rate/12` is a repeating decimal. Oracle keeps ~38 digits while JS doubles keep ~16, so `ROUND(x, 2)` can differ at an exact half-cent. Model with a decimal library and assert with a +/- 0.01 tolerance only on `pmt`, or precompute `pmt` in SQL and feed it to the model.
* `ADD_MONTHS` end-of-month behavior (see pattern 24): a loan starting 31-Jan has its due dates on the month's last day, which is correct for most lenders but differs from JS date math.
* The last installment differs from `pmt` by a few cents. That is expected, not a bug.

Sources: [Amortization calculator (annuity formula)](https://en.wikipedia.org/wiki/Amortization_calculator) - [POWER / ADD_MONTHS (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ADD_MONTHS.html)

---

### 33. Split-payment / approval-threshold avoidance with MATCH_RECOGNIZE - Expert

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: A fraud red flag: several payments to the same vendor in a short window, each **below** the approval limit, that together **exceed** it ("structuring" or "split purchases").

**Features**: `MATCH_RECOGNIZE` with `PARTITION BY`, `ORDER BY`, `MEASURES` (`FIRST`, `LAST`, `COUNT`, `SUM`), quantifier `{2,}`, a `DEFINE` that references `FIRST(...)` of the running match, `AFTER MATCH SKIP PAST LAST ROW`, and a `WHERE` on the measures.

**Tables**: `ap_payment(vendor_id, payment_date, payment_id, amount)`.

```sql
SELECT vendor_id, first_payment_id, last_payment_id, window_start, window_end, payment_count, total_amount
FROM ap_payment
MATCH_RECOGNIZE (
  PARTITION BY vendor_id
  ORDER BY payment_date, payment_id
  MEASURES FIRST(payment_id)   AS first_payment_id,
           LAST(payment_id)    AS last_payment_id,
           FIRST(payment_date) AS window_start,
           LAST(payment_date)  AS window_end,
           COUNT(*)            AS payment_count,
           SUM(amount)         AS total_amount
  ONE ROW PER MATCH
  AFTER MATCH SKIP PAST LAST ROW
  PATTERN (s{2,})
  DEFINE s AS s.amount < :approval_limit
          AND s.payment_date <= FIRST(s.payment_date) + 7
)
WHERE total_amount >= :approval_limit
ORDER BY vendor_id, window_start;
```

**Verify (JS)**: For each vendor, sort by `(date, id)`. Scan greedily: start a run at row i if `amount < limit`, then extend while `amount < limit && date <= runStart + 7`. If the run length is >= 2, emit it and continue after the run. Otherwise advance one row. Keep the runs whose sum >= limit. This reproduces greedy matching with `SKIP PAST LAST ROW`.

**Traps**:
* **Greedy semantics**: `s{2,}` takes the *longest* run. A qualifying 2-payment sub-run inside a longer run is reported as part of the long one, never on its own.
* With `SKIP PAST LAST ROW`, a run whose total stays *under* the limit still consumes its rows, so an overlapping later window starting inside it is never tested. Use `SKIP TO NEXT ROW` for exhaustive (overlapping) detection, and mirror that choice in the model.
* In `DEFINE`, `FIRST(s.payment_date)` while evaluating the first row refers to that row itself (running semantics).
* The pattern variable must not share a name with a column. `s` is safe, `amount` would not be.

Sources: [SQL for Pattern Matching (19c DWH Guide)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-pattern-matching-data-warehouses.html) - [Oracle LiveSQL: matching payments to invoices with MATCH_RECOGNIZE](https://livesql.oracle.com/apex/livesql/s/io4uidgg65nceud0whu98wrlg)

---

### 34. Round-trip (kiting) transfers and late-payment streaks with MATCH_RECOGNIZE - Expert

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Two treasury and credit signals. (a) An outflow followed within 3 days by an inflow of the **same amount** (a round trip, a possible kiting or window-dressing at period end). (b) A customer paying late 3+ times in a row, which triggers a credit hold.

**Features**: `MATCH_RECOGNIZE` with a reluctant quantifier `*?`, an undefined pattern variable (always true), navigation to another variable's value in `DEFINE` (`-out_tx.amount`), `AFTER MATCH SKIP TO NEXT ROW`, `CLASSIFIER()`, `MATCH_NUMBER()`, `ALL ROWS PER MATCH`.

**Tables**: `bank_txn(value_date, amount)`, `ar_application(applied_date)` + `ar_invoice(due_date, customer_id)`.

```sql
-- (a) round trips in the bank statement
SELECT out_id, in_id, out_amount, out_date, in_date, days_apart
FROM bank_txn
MATCH_RECOGNIZE (
  ORDER BY value_date, bank_txn_id
  MEASURES out_tx.bank_txn_id AS out_id,
           in_tx.bank_txn_id  AS in_id,
           out_tx.amount      AS out_amount,
           out_tx.value_date  AS out_date,
           in_tx.value_date   AS in_date,
           in_tx.value_date - out_tx.value_date AS days_apart
  ONE ROW PER MATCH
  AFTER MATCH SKIP TO NEXT ROW
  PATTERN (out_tx other*? in_tx)
  DEFINE out_tx AS out_tx.amount < 0,
         in_tx  AS in_tx.amount = -out_tx.amount
               AND in_tx.value_date <= out_tx.value_date + 3
)
ORDER BY out_date;

-- (b) 3+ consecutive late payments per customer, listing each payment in the streak
SELECT customer_id, streak_no, invoice_id, due_date, applied_date, days_late, cls
FROM (
  SELECT i.customer_id, i.invoice_id, i.due_date, a.applied_date,
         TRUNC(a.applied_date) - TRUNC(i.due_date) AS days_late
  FROM ar_application a
  JOIN ar_invoice i ON i.invoice_id = a.invoice_id
)
MATCH_RECOGNIZE (
  PARTITION BY customer_id
  ORDER BY applied_date, invoice_id
  MEASURES MATCH_NUMBER() AS streak_no,
           CLASSIFIER()   AS cls
  ALL ROWS PER MATCH
  AFTER MATCH SKIP PAST LAST ROW
  PATTERN (late{3,})
  DEFINE late AS late.days_late > 0
)
ORDER BY customer_id, streak_no, applied_date;
```

**Verify (JS)**: (a) For each negative transaction (sorted), find the **first** later transaction with `amount === -out.amount` and `date <= out.date + 3` that comes after it in sort order. The reluctant `*?` makes the nearest match win, and `SKIP TO NEXT ROW` means every outflow is tried as a start. (b) Group by customer, sort, find maximal runs of `days_late > 0` with length >= 3, number the runs 1..k per customer, and emit every row.

**Traps**:
* In (a), an inflow row can be matched by more than one outflow (`SKIP TO NEXT ROW` allows overlap). Deduplicate on `in_id` if each inflow should count once.
* `other*?` can scan far ahead before `in_tx` fails. The 3-day bound is checked only at `in_tx`, so on large tables add `other` with a date bound (`DEFINE other AS other.value_date <= FIRST(out_tx.value_date) + 3`) to prune.
* `MATCH_NUMBER()` restarts per partition.
* `ALL ROWS PER MATCH` outputs the partition and order columns plus the measures. Selecting a column that is neither (and not in the input) raises ORA-00904.

Sources: [SQL for Pattern Matching (19c)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-pattern-matching-data-warehouses.html) - [Stew Ashton's MATCH_RECOGNIZE articles](https://stewashton.wordpress.com/)

---

### 35. Cash-flow forecast with the MODEL clause - Expert

**Status: verified on 19c** (Oracle 19.19 EE, every SQL block executed against seeded data, results checked by hand)

**Purpose**: Treasury. Extend actual monthly cash inflows and outflows 3 months forward, each forecast month being the average of the previous 3 months (actual **or forecast**), and roll the cumulative cash position through actuals and forecast. This is a spreadsheet-like inter-row calculation done in SQL.

**Features**: `MODEL DIMENSION BY / MEASURES / RULES SEQUENTIAL ORDER`, `FOR ... FROM ... TO ... INCREMENT` (UPSERT of new cells), `CV()`, an aggregate over a cell range (`AVG(x)[m BETWEEN CV()-3 AND CV()-1]`), rule-level `ORDER BY`, `ANY`.

**Tables**: `cash_book(entry_date, amount)`.

```sql
WITH monthly AS (
  SELECT TRUNC(entry_date, 'MM') AS mth,
         SUM(CASE WHEN amount > 0 THEN amount  ELSE 0 END) AS cash_in,
         SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS cash_out
  FROM cash_book
  GROUP BY TRUNC(entry_date, 'MM')
),
numbered AS (    -- m = 0 is the last actual month, earlier months are negative
  SELECT ROW_NUMBER() OVER (ORDER BY mth) - COUNT(*) OVER () AS m, mth, cash_in, cash_out
  FROM monthly
)
SELECT m, mth, cash_in, cash_out, net_flow, cumulative_cash, is_forecast
FROM numbered
MODEL
  DIMENSION BY (m)
  MEASURES (mth, cash_in, cash_out, 0 AS net_flow, 0 AS cumulative_cash, CAST('N' AS VARCHAR2(1)) AS is_forecast)
  RULES SEQUENTIAL ORDER (
    mth[FOR m FROM 1 TO 3 INCREMENT 1] ORDER BY m         = ADD_MONTHS(mth[CV() - 1], 1),
    cash_in[FOR m FROM 1 TO 3 INCREMENT 1] ORDER BY m     = ROUND(AVG(cash_in)[m BETWEEN CV() - 3 AND CV() - 1], 2),
    cash_out[FOR m FROM 1 TO 3 INCREMENT 1] ORDER BY m    = ROUND(AVG(cash_out)[m BETWEEN CV() - 3 AND CV() - 1], 2),
    is_forecast[FOR m FROM 1 TO 3 INCREMENT 1]            = 'Y',
    net_flow[ANY]                                          = cash_in[CV()] - cash_out[CV()],
    cumulative_cash[ANY] ORDER BY m                        = NVL(cumulative_cash[CV() - 1], 0) + net_flow[CV()]
  )
ORDER BY m;
```

**Verify (JS)**: Build the actual monthly array (sorted). Append 3 forecast entries, where `in[i] = round2(avg(in[i-3..i-1]))`, using **already-forecast** values for i > 1. Then compute `net = in - out` and a cumulative running sum. Compare all rows.

**Traps**:
* Without `ORDER BY m` on the forecast rules, Oracle may evaluate the cells in any order, so forecast month 2 might average over an *uncomputed* month 1 (a NULL, which `AVG` skips). The result changes silently.
* `FOR m FROM 1 TO 3` creates the cells (UPSERT). `ANY` is a symbolic reference, which only **updates existing** cells. It works here only because the FOR rules ran first (SEQUENTIAL ORDER).
* With fewer than 3 actual months, `AVG` covers fewer cells. Months with no cash activity are **missing** (not zero) in `monthly`, so densify first (pattern 10) if gaps are possible.
* Measure types come from the first row. A literal `'N'` would be CHAR(1); the `CAST` documents the intent.
* `cumulative_cash` starts at 0, so it is "net cash since the first month in the data", not the bank balance. Add the opening balance if you need the real position.

Sources: [SQL for Modeling (19c DWH Guide)](https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-modeling-data-warehouses.html)

---

### Summary matrix

| # | Pattern | Tier | Key Oracle features |
|---|---|---|---|
| 1 | Chart of accounts tree | Basic | CONNECT BY, SYS_CONNECT_BY_PATH, ORDER SIBLINGS BY, recursive WITH SEARCH/CYCLE |
| 2 | Unbalanced journal detection | Basic | GROUP BY/HAVING, NOT EXISTS |
| 3 | Account activity per period | Basic | GROUP BY, CASE sign |
| 4 | Open invoice balances | Basic | pre-aggregated LEFT JOIN, NVL |
| 5 | AR aging buckets | Basic | date arithmetic, TRUNC, conditional SUM |
| 6 | Duplicate payments | Basic | COUNT/ROW_NUMBER OVER, REGEXP_REPLACE, self-join window |
| 7 | Trial balance (with RE remap) | Intermediate | SUM(SUM()) OVER (), CASE remap |
| 8 | Tree roll-up | Intermediate | CONNECT_BY_ROOT all-pairs, hierarchical join |
| 9 | Running-balance statement | Intermediate | SUM OVER ROWS, LAG/LEAD |
| 10 | Dense opening/closing balances | Intermediate | partitioned outer join, windowed SUM with 1 PRECEDING |
| 11 | GL balance upsert | Intermediate | MERGE with WITH in USING |
| 12 | Budget vs actual | Intermediate | FULL OUTER JOIN, NULLIF, sentinel keys |
| 13 | MoM / YoY / YTD / rolling | Intermediate | LAG(x,12), moving AVG |
| 14 | Subtotals | Intermediate | CUBE, GROUPING SETS, GROUPING_ID |
| 15 | P&L by quarter | Intermediate | PIVOT |
| 16 | Balance sheet equation | Intermediate | conditional aggregation |
| 17 | Sequence gaps / islands / dups | Intermediate | LAG, CONNECT BY LEVEL + MINUS, Tabibitosan |
| 18 | Subledger to GL recon | Intermediate | scalar subqueries, LISTAGG DISTINCT (19c) |
| 19 | Three-way match | Intermediate | pre-aggregation, ordered CASE rules |
| 20 | Accrual auto-reversal | Intermediate | INSERT...SELECT, anti-join idempotency |
| 21 | FX effective-dated rates | Advanced | KEEP (DENSE_RANK LAST), LEAD ranges |
| 22 | Bank reconciliation | Advanced | ROW_NUMBER 1:1 pairing, bidirectional anti-join |
| 23 | DSO | Advanced | moving-window SUM |
| 24 | Prepaid amortization | Advanced | LATERAL + CONNECT BY LEVEL, ADD_MONTHS |
| 25 | Straight-line depreciation | Advanced | shared generator, LAST_DAY |
| 26 | Year-end close + RE roll-forward | Advanced | INSERT...SELECT UNION ALL, GREATEST split |
| 27 | FIFO cash application | Advanced | running-sum intervals, overlap join, LISTAGG |
| 28 | Largest-remainder allocation | Advanced | FLOOR, ROW_NUMBER by remainder |
| 29 | Payroll gross-to-net + journal | Advanced | range join, LEAD sanity check, UNPIVOT |
| 30 | Benford's law | Advanced | LOG, RATIO_TO_REPORT, generator |
| 31 | DDB depreciation | Expert | recursive WITH |
| 32 | Loan amortization | Expert | recursive WITH, POWER |
| 33 | Split-payment detection | Expert | MATCH_RECOGNIZE, {2,}, FIRST() in DEFINE |
| 34 | Round trips and late streaks | Expert | MATCH_RECOGNIZE reluctant *?, ALL ROWS PER MATCH, CLASSIFIER, MATCH_NUMBER |
| 35 | Cash-flow forecast | Expert | MODEL, FOR UPSERT, CV(), range aggregates |

### Cross-cutting traps for the JS verification model

1. **Money in integer cents** (or a decimal library) everywhere. Never sum JS floats.
2. **Rounding**: Oracle `ROUND(n, d)` on NUMBER is half **away from zero**, while JS `Math.round` is half toward +infinity (`Math.round(-0.5) === -0`). Also `ROUND` on `BINARY_DOUBLE` uses banker's rounding. Keep money columns as NUMBER.
3. **Empty string is NULL** in Oracle (`'' IS NULL` is true). Any JS normalization producing `''` must map to `null`.
4. **NULLs**: `SUM` of no rows is NULL (not 0), `NULL = NULL` is unknown in joins, and NULLs sort **last** in ascending order by default (`NULLS FIRST` in DESC).
5. **Dates**: Oracle `DATE` has seconds and no timezone. Build JS dates with `Date.UTC` and compare day numbers. Replicate `ADD_MONTHS` end-of-month semantics and `TRUNC(d, 'MM')`.
6. **Default window frame** with `ORDER BY` is `RANGE UNBOUNDED PRECEDING`, so ties share a value. Use `ROWS` plus a unique tiebreaker wherever the model computes row-by-row.
7. **String ordering**: the default `NLS_SORT = BINARY` compares bytes, so `'B' < 'a'`. JS `localeCompare` does not match. Use `<`/`>` on strings (UTF-16 code units, which equal bytes for ASCII).
8. **Deterministic tiebreakers** in every `ROW_NUMBER`, `LAG` and FIFO order, or SQL and JS legitimately disagree.

### Validation notes

* **Method**: Each pattern ran in its **own** SQL*Plus session on Oracle 19c EE 19.19 (container `oracle19c`, connected as `MIRA_SIM`). The session created only the tables that pattern references, as session-private temporary tables (`CREATE PRIVATE TEMPORARY TABLE ora$ptt_<name> ... ON COMMIT PRESERVE DEFINITION`), loaded seed rows, and ran every statement of the pattern with the binds from section 0 inlined as literals. No persistent object was created, and no real MIRA or MIRA_SIM table was read or written. The PTTs vanished when each session ended.
* **PTT limitations found** (relevant if the simulation ever uses PTTs): they reject inline constraints and defaults (`PRIMARY KEY`, `NOT NULL`, `DEFAULT` all raise ORA-14451), so these were stripped for validation. A session can hold at most **16 PTTs** (ORA-32460), which is why each pattern got its own session.
* **Results**: 56 statements, 0 unexpected errors. The single error is the intentional ORA-30483 (nested analytic function) in pattern 28.
* **Spot-checked results**:
  * Pattern 2 flagged only the seeded unbalanced draft.
  * Pattern 7's debits equal its credits (161,198.95) and `out_of_balance` = 0.
  * Pattern 16's `equation_diff` = 0.
  * Pattern 17 found the voided journal no. 138 in all three forms.
  * Pattern 6 reproduced the NULL-key trap: `'---'` and `'//'` were reported as duplicates.
  * Pattern 21 returned NULL for the GBP invoice that has no rate.
  * Pattern 22's `difference` = 0.
  * Pattern 24's last month plugs to `prepaid_remaining` = 0.
  * Pattern 27's FIFO split receipts across invoices correctly.
  * Pattern 28 allocated 1000.00 as 333.34/333.33/333.33 and the negative pool -100.00 as -70/-30.
  * Pattern 29's journal balances (21,800.00 = 1,170.00 + 3,722.01 + 16,907.99).
  * Pattern 31 ends at NBV = salvage.
  * Pattern 32 shows due dates 31-Jan, 28-Feb, 31-Mar (the ADD_MONTHS end-of-month rule).
  * Pattern 33 caught the 3 split payments totalling 9,500.
  * Pattern 34 found the round trip and the 4-payment late streak.
  * Pattern 35's month-2 forecast averages in the month-1 forecast, which confirms the rule ordering.
* **Expected "failure" worth knowing**: running pattern 11's MERGE for a single period, without running the earlier periods first, makes its reconciliation query flag every account with prior history. That is the intended detection behavior.
* **Seed data**: a 2-year chart of accounts with monthly journals, one unbalanced draft, a voided journal number, USD/EUR/GBP invoices with weekly EUR rates (no GBP rate), partial and late applications, duplicate vendor payments (including the NULL-normalized-key case), split payments under the approval limit, bank-only and book-only items, duplicate identical checks, a round-trip transfer, SL and DDB assets, a 31-Jan prepaid start and a 0.10 contract, an annuity loan plus a 0% loan, positive and negative allocation pools, and four employees across four tax brackets. The generator scripts are in a local validation harness (not committed) (`seed.py`, `build.py`).

---

# Part 4: Inventory and supply-chain patterns

## Inventory / Supply-Chain SQL Pattern Catalog for Oracle 19c

Status: every query executed on Oracle 19c EE 19.3 (see 0.3). Purpose: realistic ERP inventory, WMS, procurement and light manufacturing (BOM/MRP) queries for the Mira simulation. They are ordered Basic -> Expert, and each comes with an independent in-memory (JS) verification recipe.

33 patterns: Basic 1-7, Intermediate 8-18, Advanced 19-29, Expert 30-33.

---

### 0. Ground rules

#### 0.1 19c compatibility checklist (what NOT to use)
Every example below avoids features that are 21c/23ai only:

| Avoid (21c / 23ai only) | 19c-safe replacement used here |
|---|---|
| `SELECT 1` without FROM | `FROM dual` |
| `VALUES (...), (...)` table value constructor | `SELECT ... FROM dual UNION ALL ...` |
| SQL `BOOLEAN` columns / `TRUE`/`FALSE` | `CHAR(1)` `'Y'/'N'` or `NUMBER(1)` |
| `GROUP BY` column alias / position | repeat the expression (or wrap in an inline view) |
| `CREATE TABLE IF NOT EXISTS` / `DROP ... IF EXISTS` | PL/SQL block catching ORA-00955 / ORA-00942 |
| `QUALIFY`, SQL/PGQ, `JSON_TRANSFORM` extras, `GRAPH_TABLE` | inline view + `WHERE` on analytic column |
| Window `GROUPS` frame / `EXCLUDE` (21c) | `ROWS` / `RANGE` only |
| `UPDATE ... RETURNING OLD/NEW` (23ai), `UPDATE ... FROM` join (23ai) | `MERGE` or correlated subquery |
| `CHECK` constraints referencing other tables (never allowed) | guarded `UPDATE ... WHERE qty >= :n` + rowcount |

Features used and their 19c status. None of these needs an extra-cost Enterprise option (Partitioning, In-Memory, OLAP, Advanced Compression). They are core SQL, and the dialect is the same in SE2 and EE. Confirm against the Licensing Information User Manual if you care about the edition:
- Analytic functions, `RATIO_TO_REPORT`, `KEEP (DENSE_RANK ...)`, `PERCENTILE_CONT`, `MEDIAN`: 8i-10g+
- `CONNECT BY`, `NOCYCLE`, `CONNECT_BY_ISCYCLE`, `CONNECT_BY_ISLEAF`, `CONNECT_BY_ROOT`, `SYS_CONNECT_BY_PATH`: 10g+
- `PARTITION BY ... RIGHT OUTER JOIN` (partitioned outer join): 10g+
- `MODEL` clause: 10g+
- `PIVOT` / `UNPIVOT`: 11g+
- Recursive `WITH` (subquery factoring) with `SEARCH` / `CYCLE`: 11gR2+
- `MATCH_RECOGNIZE`, identity columns, `FETCH FIRST`, `LATERAL`: 12c+
- `LISTAGG(DISTINCT ...)`: 19c

Sources: 19c licensing manual https://docs.oracle.com/en/database/oracle/oracle-database/19/dblic/ ; 19c SQL Reference SELECT https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html

#### 0.2 Traps that affect almost every pattern (read once)
1. **Default window frame.** An analytic `SUM(x) OVER (ORDER BY d)` with no frame means `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Rows with the same `d` all get the *same* running total. Use `ROWS UNBOUNDED PRECEDING` plus a unique tiebreaker (`ORDER BY move_date, move_id`) whenever you want a per-row running balance.
2. **Decimal vs binary.** Oracle `NUMBER` is decimal with up to 38 significant digits, and JS `number` is IEEE double. In the model, keep quantities as integer milli-units (x1000) and money as integer cents. For divisions (averages, ratios, sqrt), compare after rounding to a fixed scale with a tolerance, or use a decimal library in test code.
3. **ROUND semantics.** Oracle `ROUND(-2.5) = -3` (half away from zero). JS `Math.round(-2.5) = -2`. Write a `roundHalfAway(x, n)` helper in the model.
4. **STDDEV family.** Oracle `STDDEV` is the sample deviation but returns **0** for a single row. `STDDEV_SAMP` returns **NULL** for one row. `STDDEV_POP` divides by N. Pick one on purpose and mirror it exactly. (https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/STDDEV.html)
5. **DATE has a time part.** Use `TRUNC(d)` for days and `TRUNC(d,'IW')` for ISO weeks (Monday, NLS-independent). `'D'`, `'DAY'` and `'WW'` depend on NLS or the calendar. DATE minus DATE gives a number of days (fractional if times differ).
6. **`''` is NULL** in Oracle. Empty strings in the model must become `null`.
7. **Division by zero** raises ORA-01476. Wrap denominators in `NULLIF(x,0)`. The model must produce `null` in the same places.
8. **Aggregate before you join.** Joining PO lines to receipts *and* invoices before aggregating multiplies rows (fan-out). Every procurement pattern aggregates each child table in its own CTE first.
9. **Sparse time series.** Averages, stddev, moving windows and gap detection are wrong unless zero-activity periods exist as rows. See Pattern 8.


#### 0.3 How this catalog was verified
Every SQL block in P1-P33 was executed on the local **Oracle Database 19c Enterprise Edition 19.3** container (`oracle19c`, PDB `ORCLPDB1`). Every table was recreated as a **session-private temporary table** (`ORA$PTT_<name>`, `ON COMMIT PRESERVE DEFINITION`) seeded with synthetic data. Nothing persistent was created, and no table in MIRA or MIRA_SIM was read or written. All 39 SQL blocks ran with zero ORA-/SP2- errors after fixes. Fragments (P8 alt, P22, P24 PIVOT, P31 recursive, P32 explosion) were run combined with their parent CTEs.

Limits of that method:
1. **DDL in section 1 is unverified.** The harness created the PTTs with plain columns of the same types. The CHECK, PK, FK, identity and index definitions were not executed, because creating real tables was out of bounds.
2. **Multi-session behaviour is unverified.** PTTs are visible only to their session, so SKIP LOCKED contention, deadlock ordering and race guards (P19, P20) could not be exercised.
3. Each pattern carries a **Verification** line saying whether the output was matched against hand-computed values or only run and spot-checked.

Facts checked directly on 19.3 (used in the traps):
- `FETCH FIRST ... FOR UPDATE` raises ORA-02014.
- A `GROUPS` window frame is rejected (ORA-00907), so it is 21c+.
- `SELECT 1` without FROM fails.
- `SHARE` cannot be a column alias (ORA-00923).
- `RATIO_TO_REPORT` over all zeros returns NULL.
- `STDDEV`/`STDDEV_POP` of one row = 0, and `STDDEV_SAMP` = NULL.
- `ROUND(-2.5) = -3`.
- `MEDIAN(1..4) = 2.5` and `PERCENTILE_CONT(0.9)` = 3.7.
- A recursive WITH cycle without a CYCLE clause raises ORA-32044.
- CONNECT BY without NOCYCLE raises ORA-01436.
- An analytic function in the recursive member is allowed.
- A recursive WITH whose anchor is typed narrower than its recursive values did not error or truncate.

Citations: the web search quota ran out partway through. Oracle 19c documentation links follow the standard `docs.oracle.com/en/database/oracle/oracle-database/19/...` layout but were not all fetched individually. Uncertain third-party links were removed and replaced with "concept" notes.

---

### 1. Shared schema (19c DDL)
**Verification:** unverified as DDL. Only the column names and types were exercised, as private temporary tables.

Quantities use `NUMBER(14,3)` and money uses `NUMBER(14,2)`. Every pattern lists only the tables and columns it touches. Extra tables are introduced where needed.

```sql
CREATE TABLE branch (
  branch_id  NUMBER(10)   PRIMARY KEY,
  name       VARCHAR2(60) NOT NULL
);

CREATE TABLE item (
  item_id        NUMBER(10)    PRIMARY KEY,
  sku            VARCHAR2(30)  NOT NULL UNIQUE,
  name           VARCHAR2(100) NOT NULL,
  category       VARCHAR2(30)  NOT NULL,
  uom            VARCHAR2(10)  DEFAULT 'EA' NOT NULL,
  std_cost       NUMBER(14,2)  NOT NULL,
  reorder_point  NUMBER(14,3)  DEFAULT 0 NOT NULL,
  reorder_qty    NUMBER(14,3)  DEFAULT 0 NOT NULL,
  safety_stock   NUMBER(14,3)  DEFAULT 0 NOT NULL,
  lead_time_days NUMBER(5)     DEFAULT 0 NOT NULL,
  shelf_life_days NUMBER(5),
  is_purchased   CHAR(1)       DEFAULT 'Y' NOT NULL CHECK (is_purchased IN ('Y','N'))
);

-- Snapshot (current on-hand per branch). Maintained transactionally next to the ledger.
CREATE TABLE stock (
  branch_id  NUMBER(10)   NOT NULL REFERENCES branch,
  item_id    NUMBER(10)   NOT NULL REFERENCES item,
  on_hand    NUMBER(14,3) DEFAULT 0 NOT NULL,
  allocated  NUMBER(14,3) DEFAULT 0 NOT NULL,      -- reserved for open orders / picks
  CONSTRAINT stock_pk     PRIMARY KEY (branch_id, item_id),
  CONSTRAINT stock_nonneg CHECK (on_hand >= 0 AND allocated >= 0 AND allocated <= on_hand)
);

-- Movement journal / stock ledger. Signed qty: + into the branch, - out of it.
CREATE TABLE stock_move (
  move_id    NUMBER(12)   GENERATED BY DEFAULT ON NULL AS IDENTITY PRIMARY KEY,
  branch_id  NUMBER(10)   NOT NULL REFERENCES branch,
  item_id    NUMBER(10)   NOT NULL REFERENCES item,
  move_date  DATE         NOT NULL,                -- includes time of day
  move_type  VARCHAR2(3)  NOT NULL,
  qty        NUMBER(14,3) NOT NULL,
  unit_cost  NUMBER(14,2),                         -- RCV: purchase price; TRI: cost carried from source
  lot_id     NUMBER(12),
  ref_doc    VARCHAR2(30),                         -- PO no., order no., transfer no., count no.
  CONSTRAINT move_type_ck CHECK (move_type IN ('RCV','ISS','TRI','TRO','ADJ')),
  CONSTRAINT move_sign_ck CHECK (
       (move_type IN ('RCV','TRI') AND qty > 0)
    OR (move_type IN ('ISS','TRO') AND qty < 0)
    OR (move_type = 'ADJ'          AND qty <> 0))
);
CREATE INDEX stock_move_ix1 ON stock_move (branch_id, item_id, move_date, move_id);

-- Procurement
CREATE TABLE supplier  (supplier_id NUMBER(10) PRIMARY KEY, name VARCHAR2(100) NOT NULL);
CREATE TABLE po_header (
  po_id       NUMBER(12) PRIMARY KEY,
  supplier_id NUMBER(10) NOT NULL REFERENCES supplier,
  branch_id   NUMBER(10) NOT NULL REFERENCES branch,       -- ship-to
  order_date  DATE       NOT NULL,
  status      VARCHAR2(10) NOT NULL CHECK (status IN ('OPEN','CLOSED','CANCELLED'))
);
CREATE TABLE po_line (
  po_id         NUMBER(12)   NOT NULL REFERENCES po_header,
  line_no       NUMBER(5)    NOT NULL,
  item_id       NUMBER(10)   NOT NULL REFERENCES item,
  qty_ordered   NUMBER(14,3) NOT NULL CHECK (qty_ordered > 0),
  unit_price    NUMBER(14,2) NOT NULL,
  promised_date DATE         NOT NULL,
  CONSTRAINT po_line_pk PRIMARY KEY (po_id, line_no)
);
CREATE TABLE receipt_line (
  receipt_id   NUMBER(12)   NOT NULL,
  po_id        NUMBER(12)   NOT NULL,
  line_no      NUMBER(5)    NOT NULL,
  receipt_date DATE         NOT NULL,
  qty_received NUMBER(14,3) NOT NULL CHECK (qty_received > 0),
  CONSTRAINT receipt_line_pk PRIMARY KEY (receipt_id, po_id, line_no),
  CONSTRAINT receipt_po_fk FOREIGN KEY (po_id, line_no) REFERENCES po_line
);
CREATE TABLE invoice_line (
  invoice_id   NUMBER(12)   NOT NULL,
  inv_line_no  NUMBER(5)    NOT NULL,
  po_id        NUMBER(12)   NOT NULL,
  line_no      NUMBER(5)    NOT NULL,
  qty_invoiced NUMBER(14,3) NOT NULL,
  unit_price   NUMBER(14,2) NOT NULL,
  CONSTRAINT invoice_line_pk PRIMARY KEY (invoice_id, inv_line_no),
  CONSTRAINT invoice_po_fk FOREIGN KEY (po_id, line_no) REFERENCES po_line
);
```

Tables added later: `sales_order_line` (P7), `stock_policy` (P10, P33), `item_cost_history` (P16), `cycle_count` (P17), `pick_task` (P20), `lot` (P26), `bom` (P27), `gross_req` (P32), `item_period_cost` (P6).

Deterministic data tip for the simulation: generate `move_date` with distinct seconds per row (or rely on `move_id` as the tiebreaker everywhere). Use `GENERATED BY DEFAULT ON NULL` so the generator can supply ids and the model knows them up front.

---

## BASIC

### P1. On-hand derived from the movement ledger (+ breakdown by movement type)
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): PIVOT, and the broken-transfer check found the planted one-legged TR2.
**Purpose:** The ledger is the source of truth. On-hand is the sum of signed movements. A breakdown by movement type feeds the stock card report, and a pairing check finds broken transfers.
**Features:** `GROUP BY`, conditional aggregation `SUM(CASE ...)`, `PIVOT`, `HAVING`.
**Tables:** `stock_move(branch_id, item_id, move_type, qty, ref_doc)`.

```sql
-- (a) conditional aggregation
SELECT branch_id, item_id,
       SUM(CASE WHEN move_type = 'RCV' THEN  qty ELSE 0 END)           AS received,
       SUM(CASE WHEN move_type = 'ISS' THEN -qty ELSE 0 END)           AS issued,
       SUM(CASE WHEN move_type IN ('TRI','TRO') THEN qty ELSE 0 END)   AS net_transfer,
       SUM(CASE WHEN move_type = 'ADJ' THEN  qty ELSE 0 END)           AS adjusted,
       SUM(qty)                                                         AS on_hand
FROM   stock_move
GROUP  BY branch_id, item_id
ORDER  BY branch_id, item_id;

-- (b) same thing with PIVOT (only feed PIVOT the columns you want grouped!)
SELECT *
FROM  (SELECT branch_id, item_id, move_type, qty FROM stock_move)
PIVOT (SUM(qty) FOR move_type IN ('RCV' AS rcv, 'ISS' AS iss, 'TRI' AS tri, 'TRO' AS tro, 'ADJ' AS adj))
ORDER BY branch_id, item_id;

-- (c) integrity: every transfer document must have exactly one TRO and one TRI per item netting to zero
SELECT ref_doc, item_id, COUNT(*) AS legs, SUM(qty) AS net
FROM   stock_move
WHERE  move_type IN ('TRI','TRO')
GROUP  BY ref_doc, item_id
HAVING COUNT(*) <> 2 OR SUM(qty) <> 0
    OR COUNT(CASE WHEN move_type = 'TRI' THEN 1 END) <> 1;
```
**Verify in JS:** Group moves by `branch|item` and sum `qty` (as integer milli-units). Bucket by type. PIVOT cells with no rows are **NULL**, not 0, so the model must return `null` for "no TRI rows" in (b).
**Edge cases / traps:** PIVOT implicitly groups by every column of its input that is not pivoted or aggregated, so passing `move_id` or `move_date` in gives one row per move. The `IN` list must be constants (dynamic needs `PIVOT XML` or generated SQL). Items with no movements at all are absent, so LEFT JOIN from `item` if the report needs them.
**Sources:** PIVOT https://oracle-base.com/articles/11g/pivot-and-unpivot-operators-11gr1 ; SELECT pivot_clause https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html

---

### P2. Running balance (stock card), on-hand as of a date, negative-balance detection
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output was spot-checked for plausibility, not compared with an independent model).
**Purpose:** The stock card shows the balance after every movement. The as-of query is for period-end reporting. The negative check catches posting-order bugs: stock must never dip below zero at any point in time.
**Features:** `SUM() OVER (PARTITION BY ... ORDER BY ... ROWS UNBOUNDED PRECEDING)`, `ROW_NUMBER`, `KEEP (DENSE_RANK FIRST)`.
**Tables:** `stock_move(move_id, branch_id, item_id, move_date, move_type, qty)`.

```sql
-- (a) stock card
SELECT m.move_id, m.branch_id, m.item_id, m.move_date, m.move_type, m.qty,
       SUM(m.qty) OVER (PARTITION BY m.branch_id, m.item_id
                        ORDER BY m.move_date, m.move_id
                        ROWS UNBOUNDED PRECEDING) AS running_bal
FROM   stock_move m
WHERE  m.branch_id = 1 AND m.item_id = 42
ORDER  BY m.move_date, m.move_id;

-- (b) on-hand as of end of day 2026-10-31 (all branch/items)
SELECT branch_id, item_id, SUM(qty) AS on_hand_asof
FROM   stock_move
WHERE  move_date < DATE '2026-10-31' + 1
GROUP  BY branch_id, item_id;

-- (c) first moment each branch/item went negative
SELECT branch_id, item_id,
       MIN(move_id)     KEEP (DENSE_RANK FIRST ORDER BY move_date, move_id) AS first_bad_move,
       MIN(running_bal) KEEP (DENSE_RANK FIRST ORDER BY move_date, move_id) AS bal_after,
       COUNT(*) AS negative_rows
FROM  (SELECT m.*,
              SUM(qty) OVER (PARTITION BY branch_id, item_id
                             ORDER BY move_date, move_id ROWS UNBOUNDED PRECEDING) AS running_bal
       FROM stock_move m)
WHERE  running_bal < 0
GROUP  BY branch_id, item_id;
```
**Verify in JS:** Sort by `(move_date, move_id)`, fold with an accumulator per key, and record every row where `acc < 0`.
**Edge cases / traps:** Drop `ROWS` and two moves at the same timestamp share a balance (see 0.2-1). Identity values are not guaranteed monotonic with commit time under concurrency, so `move_date` must be the primary sort and `move_id` only the tiebreak. An as-of on `move_date <= DATE '2026-10-31'` silently loses movements after 00:00 that day. Use `< day + 1`.
**Sources:** Analytic functions https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html ; FIRST/LAST https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/FIRST.html

---

### P3. Ledger vs snapshot reconciliation (and repair with MERGE)
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): the planted +1 drift found by both the FULL OUTER JOIN and MINUS forms, then repaired by MERGE.
**Purpose:** The `stock` snapshot is maintained incrementally, so it can drift from the ledger through bugs or manual edits. This is a nightly control: list differences, then optionally rebuild the snapshot.
**Features:** `FULL OUTER JOIN`, `NVL`, `MINUS`, `MERGE ... WHEN MATCHED ... WHERE`.
**Tables:** `stock(branch_id, item_id, on_hand)`, `stock_move(branch_id, item_id, qty)`.

```sql
WITH ledger AS (
  SELECT branch_id, item_id, SUM(qty) AS ledger_qty
  FROM   stock_move
  GROUP  BY branch_id, item_id
)
SELECT NVL(s.branch_id, l.branch_id) AS branch_id,
       NVL(s.item_id,  l.item_id)    AS item_id,
       s.on_hand, l.ledger_qty,
       NVL(s.on_hand,0) - NVL(l.ledger_qty,0) AS diff,
       CASE WHEN s.item_id IS NULL THEN 'MISSING_SNAPSHOT'
            WHEN l.item_id IS NULL THEN 'NO_LEDGER'
            ELSE 'QTY_MISMATCH' END       AS issue
FROM   stock s
FULL OUTER JOIN ledger l
       ON l.branch_id = s.branch_id AND l.item_id = s.item_id
WHERE  NVL(s.on_hand,0) <> NVL(l.ledger_qty,0)
   OR (s.item_id IS NULL AND l.ledger_qty <> 0);

-- Set-difference variant (both directions)
(SELECT branch_id, item_id, on_hand FROM stock
 MINUS
 SELECT branch_id, item_id, SUM(qty) FROM stock_move GROUP BY branch_id, item_id)
UNION ALL
(SELECT branch_id, item_id, SUM(qty) FROM stock_move GROUP BY branch_id, item_id
 MINUS
 SELECT branch_id, item_id, on_hand FROM stock);

-- Repair: rebuild snapshot from ledger
MERGE INTO stock s
USING (SELECT branch_id, item_id, SUM(qty) AS q FROM stock_move GROUP BY branch_id, item_id) l
ON (s.branch_id = l.branch_id AND s.item_id = l.item_id)
WHEN MATCHED THEN UPDATE SET s.on_hand = l.q WHERE s.on_hand <> l.q
WHEN NOT MATCHED THEN INSERT (branch_id, item_id, on_hand, allocated) VALUES (l.branch_id, l.item_id, l.q, 0);
```
**Verify in JS:** Build two maps (snapshot, ledger sums), take the union of keys, and diff with missing treated as 0. The model should return the same set of keys as the query.
**Edge cases / traps:** A snapshot row with `on_hand = 0` and no ledger is *not* a mismatch, but a naive `s.on_hand <> l.ledger_qty` misses NULL comparisons in the other direction. `MINUS` is set-based: it removes duplicates and treats NULLs as equal. The MERGE fails on the `stock_nonneg` check if the ledger sum is negative (useful) or if `allocated > ledger qty`. You cannot update a column used in the `ON` clause (ORA-38104), and duplicate source keys raise ORA-30926.
**Sources:** MERGE https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html ; Joins https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Joins.html

---

### P4. Open PO quantities (aggregate-then-join)
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): over-receipt clamp, CANCELLED header excluded.
**Purpose:** Shows what is still on order per PO line and per item/branch, which feeds the inventory position (P5) and MRP (P32). It also flags late lines.
**Features:** CTE pre-aggregation, `LEFT JOIN`, `GREATEST`, `CASE`.
**Tables:** `po_header(po_id, supplier_id, branch_id, order_date, status)`, `po_line(po_id, line_no, item_id, qty_ordered, unit_price, promised_date)`, `receipt_line(po_id, line_no, qty_received)`.

```sql
WITH rcv AS (
  SELECT po_id, line_no, SUM(qty_received) AS qty_rcv
  FROM   receipt_line
  GROUP  BY po_id, line_no
)
SELECT ph.po_id, pl.line_no, ph.supplier_id, ph.branch_id, pl.item_id,
       pl.qty_ordered,
       NVL(r.qty_rcv, 0)                                AS qty_received,
       GREATEST(pl.qty_ordered - NVL(r.qty_rcv, 0), 0)  AS open_qty,
       GREATEST(pl.qty_ordered - NVL(r.qty_rcv, 0), 0) * pl.unit_price AS open_value,
       pl.promised_date,
       CASE WHEN pl.promised_date < DATE '2026-11-24' THEN 'LATE' ELSE 'ON_TIME' END AS due_status
FROM   po_header ph
JOIN   po_line   pl ON pl.po_id = ph.po_id
LEFT   JOIN rcv  r  ON r.po_id = pl.po_id AND r.line_no = pl.line_no
WHERE  ph.status = 'OPEN'
AND    pl.qty_ordered > NVL(r.qty_rcv, 0)
ORDER  BY pl.promised_date, ph.po_id, pl.line_no;
```
**Verify in JS:** For each line, received = sum of receipts on that line and open = max(ordered - received, 0). Keep only open headers with open > 0.
**Edge cases / traps:** Over-receipt makes the raw difference negative, so clamp it. Without clamping, the item-level on-order sum gets understated by other lines. A `CLOSED` header with an open remainder (short-closed) must not count. Joining `receipt_line` without pre-aggregation duplicates `qty_ordered` across multiple receipts.

---

### P5. Below-reorder alert using inventory position
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): branch x item grid surfaces items with no stock row.
**Purpose:** The classic replenishment trigger. **Inventory position = on hand - allocated + on order**. Alert when position <= reorder point, and suggest a quantity.
**Features:** CTEs, `LEFT JOIN`, `CROSS JOIN` for missing stock rows, `GREATEST`, `CEIL`.
**Tables:** `stock`, `item(reorder_point, reorder_qty)`, plus the open-PO CTE from P4.

```sql
WITH rcv AS (
  SELECT po_id, line_no, SUM(qty_received) AS q FROM receipt_line GROUP BY po_id, line_no
),
on_order AS (
  SELECT ph.branch_id, pl.item_id, SUM(GREATEST(pl.qty_ordered - NVL(r.q,0), 0)) AS q
  FROM   po_header ph JOIN po_line pl ON pl.po_id = ph.po_id
  LEFT   JOIN rcv r ON r.po_id = pl.po_id AND r.line_no = pl.line_no
  WHERE  ph.status = 'OPEN'
  GROUP  BY ph.branch_id, pl.item_id
),
grid AS (                               -- every branch x stocked item, even with no stock row yet
  SELECT b.branch_id, i.item_id, i.reorder_point, i.reorder_qty
  FROM   branch b CROSS JOIN item i
  WHERE  i.reorder_point > 0
)
SELECT g.branch_id, g.item_id,
       NVL(s.on_hand,0) AS on_hand, NVL(s.allocated,0) AS allocated, NVL(o.q,0) AS on_order,
       NVL(s.on_hand,0) - NVL(s.allocated,0) + NVL(o.q,0) AS position,
       g.reorder_point,
       GREATEST(g.reorder_qty,
                g.reorder_point - (NVL(s.on_hand,0) - NVL(s.allocated,0) + NVL(o.q,0))) AS suggested_qty
FROM   grid g
LEFT   JOIN stock    s ON s.branch_id = g.branch_id AND s.item_id = g.item_id
LEFT   JOIN on_order o ON o.branch_id = g.branch_id AND o.item_id = g.item_id
WHERE  NVL(s.on_hand,0) - NVL(s.allocated,0) + NVL(o.q,0) <= g.reorder_point
ORDER  BY g.branch_id, g.item_id;
```
**Verify in JS:** Loop over branches x items with ROP > 0, compute position, and filter `<=`.
**Edge cases / traps:** Use `<=`, not `<` (the convention is "at or below"). Using on_hand alone (ignoring on-order) re-orders every night until the PO arrives. A per-branch policy table usually replaces the item-level ROP (see P10). Pack-size rounding: `CEIL(x / pack) * pack`.
**Sources:** Reorder point / inventory position https://en.wikipedia.org/wiki/Reorder_point

---

### P6. Periodic weighted-average cost (WAC)
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): (100*2.05+1602)/820 = 2.2037.
**Purpose:** Monthly costing: (opening value + receipts value) / (opening qty + receipts qty). Simpler than perpetual moving average (P30) and used by many small ERPs.
**Features:** CTEs, `NULLIF`, `LEFT JOIN`, a parameters CTE.
**Tables:** `stock_move(item_id, move_type, qty, unit_cost, move_date)`, `item_period_cost(item_id NUMBER(10), period_start DATE, closing_qty NUMBER(14,3), avg_cost NUMBER(14,4), PRIMARY KEY(item_id, period_start))`.

```sql
WITH params AS (SELECT DATE '2026-10-01' AS d_from, DATE '2026-11-01' AS d_to FROM dual),
opening AS (
  SELECT item_id, closing_qty AS q, avg_cost AS c
  FROM   item_period_cost
  WHERE  period_start = DATE '2026-09-01'
),
rcpt AS (
  SELECT m.item_id, SUM(m.qty) AS q, SUM(m.qty * m.unit_cost) AS v
  FROM   stock_move m CROSS JOIN params p
  WHERE  m.move_type = 'RCV' AND m.move_date >= p.d_from AND m.move_date < p.d_to
  GROUP  BY m.item_id
)
SELECT i.item_id,
       NVL(o.q,0) AS open_qty, NVL(o.c,0) AS open_cost,
       NVL(r.q,0) AS rcv_qty,  NVL(r.v,0) AS rcv_value,
       ROUND((NVL(o.q,0) * NVL(o.c,0) + NVL(r.v,0)) / NULLIF(NVL(o.q,0) + NVL(r.q,0), 0), 4) AS period_wac
FROM   item i
LEFT   JOIN opening o ON o.item_id = i.item_id
LEFT   JOIN rcpt    r ON r.item_id = i.item_id
ORDER  BY i.item_id;
```
**Verify in JS:** `(oq*oc + sum(q*c)) / (oq + sum q)`. Compute the numerator in cents x milli-units exactly (BigInt is fine), then divide and round half away from zero to 4 dp.
**Edge cases / traps:** Negative opening qty gives a nonsensical WAC, so clamp it or flag it. When there is no opening and no receipts, the result is NULL, not 0: carry the previous cost forward. Decide whether WAC is per branch or company-wide, since mixing them breaks transfers. Rounding the stored cost to 4 dp each period accumulates drift compared with an unrounded model, so round both the same way.
**Sources:** https://en.wikipedia.org/wiki/Average_cost_method

---

### P7. Order fill rate (line, unit, order level)
**Tier:** Basic
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values).
**Purpose:** Service KPIs. Line fill means the line was shipped complete. Unit fill is the share of units shipped. Order fill means every line was complete.
**Features:** `AVG(CASE ...)`, `LEAST`, `GROUP BY ROLLUP`, `GROUPING`, nested aggregation via inline view.
**Tables:** `sales_order_line(order_id NUMBER(12), line_no NUMBER(5), branch_id NUMBER(10), item_id NUMBER(10), order_date DATE, qty_ordered NUMBER(14,3), qty_shipped NUMBER(14,3) DEFAULT 0, PRIMARY KEY(order_id,line_no))`.

```sql
-- line + unit fill, per branch with a grand total row
SELECT CASE WHEN GROUPING(branch_id) = 1 THEN 'ALL' ELSE TO_CHAR(branch_id) END AS branch,
       COUNT(*) AS lines,
       ROUND(100 * AVG(CASE WHEN qty_shipped >= qty_ordered THEN 1 ELSE 0 END), 2) AS line_fill_pct,
       ROUND(100 * SUM(LEAST(qty_shipped, qty_ordered)) / NULLIF(SUM(qty_ordered), 0), 2) AS unit_fill_pct
FROM   sales_order_line
WHERE  order_date >= DATE '2026-10-01' AND order_date < DATE '2026-11-01'
GROUP  BY ROLLUP(branch_id)
ORDER  BY GROUPING(branch_id), branch_id;

-- order fill (all lines complete)
SELECT branch_id,
       ROUND(100 * AVG(complete), 2) AS order_fill_pct
FROM  (SELECT order_id, MIN(branch_id) AS branch_id,
              MIN(CASE WHEN qty_shipped >= qty_ordered THEN 1 ELSE 0 END) AS complete
       FROM   sales_order_line
       WHERE  order_date >= DATE '2026-10-01' AND order_date < DATE '2026-11-01'
       GROUP  BY order_id)
GROUP  BY branch_id;
```
**Verify in JS:** Straight counts. Over-shipments are capped by `LEAST`, so mirror that cap.
**Edge cases / traps:** Cancelled lines must be excluded, not counted as unfilled. Orders spanning branches need a decision. Lines still open (not yet due) should be excluded from the denominator, or they bias the KPI down.

---

## INTERMEDIATE

### P8. Calendar densification (zero-sales days per product)
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): 8 items x 31 days = 248 rows.
**Purpose:** Turn sparse "days with sales" into one row per item per day, with zeros. This is required before moving averages, stddev, XYZ, gap detection and charts.
**Features:** Row generator `CONNECT BY LEVEL`, **partitioned outer join** `PARTITION BY (...) RIGHT OUTER JOIN`, `NVL`.
**Tables:** `stock_move(branch_id, item_id, move_type, move_date, qty)`.

```sql
WITH cal AS (
  SELECT DATE '2026-01-01' + LEVEL - 1 AS d
  FROM   dual
  CONNECT BY LEVEL <= DATE '2026-01-31' - DATE '2026-01-01' + 1
),
sales AS (
  SELECT item_id, TRUNC(move_date) AS d, SUM(-qty) AS qty_sold
  FROM   stock_move
  WHERE  move_type = 'ISS' AND branch_id = 1
  AND    move_date >= DATE '2026-01-01' AND move_date < DATE '2026-02-01'
  GROUP  BY item_id, TRUNC(move_date)
)
SELECT s.item_id, c.d, NVL(s.qty_sold, 0) AS qty_sold
FROM   sales s PARTITION BY (s.item_id)
RIGHT  OUTER JOIN cal c ON (s.d = c.d)
ORDER  BY s.item_id, c.d;
```
Equivalent and more explicit (also covers items with **no** sales in the window):
```sql
SELECT i.item_id, c.d, NVL(s.qty_sold, 0) AS qty_sold
FROM   item i CROSS JOIN cal c
LEFT   JOIN sales s ON s.item_id = i.item_id AND s.d = c.d;
```
**Verify in JS:** For each item in the partition set and each day in `[from, to]`, look up the sum or use 0. Expect `items x days` rows.
**Edge cases / traps:** A partitioned outer join only creates partitions for items that have **at least one** row in `sales`. Items with zero sales in the whole window vanish, so use the cross-join form when "never sold" matters (XYZ, dead stock). The partition column (`s.item_id`) is filled in for generated rows, but other `s.*` columns are NULL. `FULL OUTER JOIN` cannot be partitioned. `CONNECT BY LEVEL` on `dual` is fine for thousands of rows. Prefer TRUNC'ed `DATE` over `TIMESTAMP` for the join key.
**Sources:** https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-analysis-reporting-data-warehouses.html (section "Data Densification for Reporting") ; Oracle tutorial https://www.oracle.com/ocom/groups/public/@otn/documents/webcontent/270646.htm ; https://oracle-developer.net/display.php?id=312

---

### P9. Moving-average demand forecast
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output was spot-checked for plausibility, not compared with an independent model).
**Purpose:** The simplest forecast. The next day's demand is the mean of the last N days. A trailing 7-day window and a "forecast for today = mean of the 7 days before today" are both shown.
**Features:** `AVG() OVER (... ROWS BETWEEN n PRECEDING AND ...)`, `COUNT() OVER` (to expose partial windows), `LAG`.
**Tables:** densified daily sales from P8 (`item_id, d, qty_sold`).

```sql
WITH cal AS (
  SELECT DATE '2026-01-01' + LEVEL - 1 AS d FROM dual
  CONNECT BY LEVEL <= DATE '2026-03-31' - DATE '2026-01-01' + 1
),
sales AS (
  SELECT item_id, TRUNC(move_date) AS d, SUM(-qty) AS q
  FROM   stock_move
  WHERE  move_type = 'ISS' AND branch_id = 1
  AND    move_date >= DATE '2026-01-01' AND move_date < DATE '2026-04-01'
  GROUP  BY item_id, TRUNC(move_date)
),
daily AS (
  SELECT i.item_id, c.d, NVL(s.q, 0) AS q
  FROM   item i CROSS JOIN cal c
  LEFT   JOIN sales s ON s.item_id = i.item_id AND s.d = c.d
)
SELECT item_id, d, q,
       ROUND(AVG(q) OVER (PARTITION BY item_id ORDER BY d
                          ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 3) AS ma7_trailing,
       COUNT(*)     OVER (PARTITION BY item_id ORDER BY d
                          ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)     AS ma7_n,
       ROUND(AVG(q) OVER (PARTITION BY item_id ORDER BY d
                          ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING), 3) AS fcst_today,
       q - LAG(q, 7) OVER (PARTITION BY item_id ORDER BY d)              AS wow_change
FROM   daily
ORDER  BY item_id, d;
```
**Verify in JS:** For index k, average `q[max(0,k-6)..k]`. The first window is partial (N<7). `fcst_today` is NULL at k=0 because the window is empty, so AVG of nothing is NULL.
**Edge cases / traps:** On *sparse* data, `RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW` divides by the number of days that had sales, not by 7, which overstates demand. Densify first, or use `SUM(...)/7`. Partial windows at the start give an optimistic or noisy forecast, so filter `ma7_n = 7` if needed. A forecast that includes the current day is not a forecast (leakage).
**Sources:** windowing clause https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html

---

### P10. Safety stock, reorder point and EOQ (persisted with MERGE)
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output was spot-checked for plausibility, not compared with an independent model). The MERGE with a WITH inside USING runs.
**Purpose:** Derive policy from history.
- `SS = z * sigma_d * sqrt(LT)`
- `ROP = d_avg * LT + SS`
- `EOQ = sqrt(2 * D_annual * S / H)`, with `H = holding_rate * unit_cost`

The extended SS formula also covers lead-time variability: `z * sqrt(LT * sigma_d^2 + d_avg^2 * sigma_LT^2)`.
**Features:** Densified daily demand, `AVG`, `STDDEV_SAMP`, `SQRT`, `POWER`, `MERGE` into a policy table.
**Tables:** `stock_policy(branch_id NUMBER(10), item_id NUMBER(10), safety_stock NUMBER(14,3), reorder_point NUMBER(14,3), eoq NUMBER(14,3), target_qty NUMBER(14,3), computed_at DATE, PRIMARY KEY(branch_id,item_id))`, `item(lead_time_days, std_cost)`, `stock_move`.

```sql
MERGE INTO stock_policy t
USING (
  WITH params AS (
    SELECT DATE '2026-08-26' AS d_from, DATE '2026-11-23' AS d_to,
           1.645 AS z,                -- 95% cycle service level
           50    AS order_cost,       -- S per order
           0.25  AS hold_rate         -- H = 25% of unit cost per year
    FROM dual
  ),
  cal AS (SELECT p.d_from + LEVEL - 1 AS d FROM params p CONNECT BY LEVEL <= p.d_to - p.d_from + 1),
  dem AS (
    SELECT m.branch_id, m.item_id, TRUNC(m.move_date) AS d, SUM(-m.qty) AS q
    FROM   stock_move m CROSS JOIN params p
    WHERE  m.move_type = 'ISS' AND m.move_date >= p.d_from AND m.move_date < p.d_to + 1
    GROUP  BY m.branch_id, m.item_id, TRUNC(m.move_date)
  ),
  daily AS (
    SELECT s.branch_id, s.item_id, c.d, NVL(dm.q, 0) AS q
    FROM   stock s CROSS JOIN cal c
    LEFT   JOIN dem dm ON dm.branch_id = s.branch_id AND dm.item_id = s.item_id AND dm.d = c.d
  ),
  st AS (
    SELECT branch_id, item_id, AVG(q) AS avg_d, NVL(STDDEV_SAMP(q), 0) AS sd_d
    FROM   daily GROUP BY branch_id, item_id
  )
  SELECT st.branch_id, st.item_id,
         ROUND(p.z * st.sd_d * SQRT(i.lead_time_days), 3)                          AS ss,
         ROUND(st.avg_d * i.lead_time_days + p.z * st.sd_d * SQRT(i.lead_time_days), 3) AS rop,
         CASE WHEN st.avg_d > 0 AND i.std_cost > 0
              THEN ROUND(SQRT(2 * st.avg_d * 365 * p.order_cost / (p.hold_rate * i.std_cost)), 3)
         END                                                                         AS eoq
  FROM   st JOIN item i ON i.item_id = st.item_id CROSS JOIN params p
) src
ON (t.branch_id = src.branch_id AND t.item_id = src.item_id)
WHEN MATCHED THEN UPDATE SET t.safety_stock = src.ss, t.reorder_point = src.rop,
                             t.eoq = src.eoq, t.computed_at = SYSDATE
WHEN NOT MATCHED THEN INSERT (branch_id, item_id, safety_stock, reorder_point, eoq, target_qty, computed_at)
                      VALUES (src.branch_id, src.item_id, src.ss, src.rop, src.eoq, src.rop + NVL(src.eoq,0), SYSDATE);
```
(The `WITH` inside the `USING (...)` subquery is valid in 19c.)
**Verify in JS:** For each `stock` key, build an array of `days` daily totals (zeros included). mean = sum/n. Sample sd = sqrt(sum((x-mean)^2)/(n-1)), which is null for n=1, coalesced to 0. Then apply the formulas and round half away from zero to 3 dp. Compare with a tolerance of 0.001 because SQRT is computed in different precision.
**Edge cases / traps:** Without densification, sigma comes only from days with sales and is wildly wrong. `STDDEV` versus `STDDEV_SAMP` versus `STDDEV_POP` (0.2-4). The `z` factor must match the service level definition (cycle service level, not fill rate). `lead_time_days = 0` gives SS = 0. Days versus years units in EOQ (`avg_d*365`). A division by zero is guarded with CASE. Normal-distribution assumptions break for intermittent demand (Z class in P12).
**Sources:** https://en.wikipedia.org/wiki/Safety_stock ; https://en.wikipedia.org/wiki/Economic_order_quantity ; MERGE https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html

---

### P11. ABC analysis (Pareto by annual usage value)
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): crossing item classed A. A bug was found and fixed during verification: the alias `share` is a reserved word (ORA-00923).
**Purpose:** Classify items as A (top ~80% of consumption value), B (next ~15%) or C (the rest), to set count frequency, service levels and buyer attention.
**Features:** `RATIO_TO_REPORT() OVER ()`, cumulative `SUM() OVER (ORDER BY ... ROWS UNBOUNDED PRECEDING)`, grand total `SUM() OVER ()`.
**Tables:** `item(item_id, std_cost)`, `stock_move(item_id, move_type, qty, move_date)`.

```sql
WITH usage AS (
  SELECT i.item_id, NVL(SUM(-m.qty), 0) * i.std_cost AS usage_value
  FROM   item i
  LEFT   JOIN stock_move m
         ON  m.item_id = i.item_id AND m.move_type = 'ISS'
         AND m.move_date >= DATE '2025-12-01' AND m.move_date < DATE '2026-12-01'
  GROUP  BY i.item_id, i.std_cost
),
ranked AS (
  SELECT item_id, usage_value,
         RATIO_TO_REPORT(usage_value) OVER ()                                         AS share_ratio,  -- SHARE is reserved
         SUM(usage_value) OVER (ORDER BY usage_value DESC, item_id ROWS UNBOUNDED PRECEDING) AS cum_value,
         SUM(usage_value) OVER ()                                                     AS total_value
  FROM   usage
)
SELECT item_id, usage_value,
       ROUND(100 * share_ratio, 2)                            AS pct,
       ROUND(100 * cum_value / NULLIF(total_value, 0), 2)     AS cum_pct,
       CASE WHEN usage_value = 0                              THEN 'C'
            WHEN cum_value - usage_value < 0.80 * total_value THEN 'A'   -- class by share BEFORE this item
            WHEN cum_value - usage_value < 0.95 * total_value THEN 'B'
            ELSE 'C' END                                      AS abc_class
FROM   ranked
ORDER  BY usage_value DESC, item_id;
```
**Verify in JS:** Sort by `(value desc, item_id asc)`. Running sum `before`. Class A if `before*100 < 80*total` (integer cents arithmetic, so no float thresholds), B if `< 95*total`, else C.
**Edge cases / traps:**
- **The convention matters.** "Cumulative share *before* the item < 80%" puts the item that crosses 80% into A. "Cumulative *after* <= 80%" puts it into B. Pick one and document it.
- Ties in value need a deterministic tiebreak (`item_id`), or the class at the boundary flips between runs.
- Compare without dividing, as shown, so binary/decimal differences cannot flip boundary items.
- When the total is 0 (no usage at all), `RATIO_TO_REPORT` returns **NULL** for every row, not an error (verified on 19c). The model must emit `null` for `pct`.
- Alternatives: classify by count share (e.g. top 20% of SKUs) or by margin. Consumption value uses `std_cost` here, and actual cost (P23) is the alternative.
**Sources:** RATIO_TO_REPORT https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/RATIO_TO_REPORT.html ; https://en.wikipedia.org/wiki/ABC_analysis

---

### P12. XYZ demand variability + ABC/XYZ matrix
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output was spot-checked for plausibility, not compared with an independent model).
**Purpose:** X = steady, Y = fluctuating, Z = erratic, measured by the coefficient of variation (CV = sigma/mean) of weekly demand. Crossing with ABC gives a 9-cell policy matrix (e.g. AX gets tight min/max, CZ gets make-to-order).
**Features:** ISO week `TRUNC(d,'IW')`, densified week grid, `STDDEV_POP`, `AVG`, `PIVOT` with `COUNT`.
**Tables:** as P11.

```sql
WITH weeks AS (
  SELECT DATE '2026-01-05' + 7 * (LEVEL - 1) AS wk     -- 2026-01-05 is a Monday
  FROM dual CONNECT BY LEVEL <= 26
),
dem AS (
  SELECT item_id, TRUNC(move_date, 'IW') AS wk, SUM(-qty) AS q
  FROM   stock_move
  WHERE  move_type = 'ISS'
  AND    move_date >= DATE '2026-01-05' AND move_date < DATE '2026-01-05' + 26 * 7
  GROUP  BY item_id, TRUNC(move_date, 'IW')
),
grid AS (
  SELECT i.item_id, w.wk, NVL(d.q, 0) AS q
  FROM   item i CROSS JOIN weeks w
  LEFT   JOIN dem d ON d.item_id = i.item_id AND d.wk = w.wk
),
xyz AS (
  SELECT item_id, AVG(q) AS mean_q, STDDEV_POP(q) AS sd_q,
         STDDEV_POP(q) / NULLIF(AVG(q), 0) AS cv,
         CASE WHEN AVG(q) = 0                  THEN 'Z'
              WHEN STDDEV_POP(q) <= 0.5 * AVG(q) THEN 'X'
              WHEN STDDEV_POP(q) <= 1.0 * AVG(q) THEN 'Y'
              ELSE 'Z' END AS xyz_class
  FROM   grid GROUP BY item_id
),
abc AS (            -- P11 condensed
  SELECT item_id,
         CASE WHEN v = 0 THEN 'C'
              WHEN SUM(v) OVER (ORDER BY v DESC, item_id ROWS UNBOUNDED PRECEDING) - v < 0.80 * SUM(v) OVER () THEN 'A'
              WHEN SUM(v) OVER (ORDER BY v DESC, item_id ROWS UNBOUNDED PRECEDING) - v < 0.95 * SUM(v) OVER () THEN 'B'
              ELSE 'C' END AS abc_class
  FROM  (SELECT g.item_id, SUM(g.q) * i.std_cost AS v
         FROM grid g JOIN item i ON i.item_id = g.item_id
         GROUP BY g.item_id, i.std_cost)
)
SELECT *
FROM  (SELECT a.abc_class, x.xyz_class, a.item_id
       FROM abc a JOIN xyz x ON x.item_id = a.item_id)
PIVOT (COUNT(item_id) FOR xyz_class IN ('X' AS x, 'Y' AS y, 'Z' AS z))
ORDER BY abc_class;
```
**Verify in JS:** Build 26 weekly buckets per item with zeros. mean = sum/26. pop sd = sqrt(sum((q-mean)^2)/26). Classify by `sd <= 0.5*mean` and so on, with the same `mean=0 -> Z` rule. Then count the matrix cells. PIVOT `COUNT` gives **0** (not NULL) for empty cells.
**Edge cases / traps:** Thresholds differ by source (0.5/1.0 is common, 0.1/0.25 on monthly data is also used), so make them parameters. Missing zero weeks make erratic items look steady. Items launched mid-window should use only weeks since launch. `TRUNC(d,'WW')` is not ISO and `'D'` is NLS-dependent. Square roots inside comparisons are fine in Oracle, but the model comparing `sd <= 0.5*mean` in floats can flip exactly at boundaries, so compare variance: `sum((q-mean)^2)/n <= 0.25*mean^2`.
**Sources:** https://en.wikipedia.org/wiki/Coefficient_of_variation ; ROUND/TRUNC date formats https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROUND-and-TRUNC-Date-Functions.html

---

### P13. Slow-moving and dead stock
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): a received-but-never-issued item falls back to first_in.
**Purpose:** Find stock with no consumption for 90 days (slow) or 365 days (dead) and value it for write-down or markdown.
**Features:** `MAX(CASE ...)` per key, `GREATEST` with NULLs, `LEFT JOIN`, `CASE` bucketing.
**Tables:** `stock(branch_id, item_id, on_hand)`, `stock_move`, `item(std_cost)`.

```sql
WITH act AS (
  SELECT branch_id, item_id,
         MAX(CASE WHEN move_type = 'ISS' THEN move_date END)                  AS last_issue,
         MIN(CASE WHEN move_type IN ('RCV','TRI') THEN move_date END)         AS first_in
  FROM   stock_move
  GROUP  BY branch_id, item_id
)
SELECT s.branch_id, s.item_id, s.on_hand, s.on_hand * i.std_cost AS value,
       a.last_issue, a.first_in,
       TRUNC(DATE '2026-11-24' - NVL(a.last_issue, a.first_in))              AS idle_days,
       CASE WHEN DATE '2026-11-24' - NVL(a.last_issue, a.first_in) > 365 THEN 'DEAD'
            WHEN DATE '2026-11-24' - NVL(a.last_issue, a.first_in) > 90  THEN 'SLOW'
            ELSE 'ACTIVE' END                                                 AS status
FROM   stock s
JOIN   item  i ON i.item_id = s.item_id
LEFT   JOIN act a ON a.branch_id = s.branch_id AND a.item_id = s.item_id
WHERE  s.on_hand > 0
ORDER  BY idle_days DESC NULLS FIRST;
```
**Verify in JS:** For each key, track the max ISS date and min inbound date. idle = asOf - (lastIssue ?? firstIn), in days.
**Edge cases / traps:** An item received yesterday and never issued is *not* dead. That is why the query falls back to `first_in`, while a naive `last_issue IS NULL -> DEAD` is wrong. Transfers out (TRO) are not consumption. Negative adjustments are shrink, not demand. `GREATEST(NULL, x)` is NULL in Oracle, so use `NVL`/`COALESCE` explicitly. If `stock` has no ledger rows (seeded snapshot), `idle_days` is NULL. DATE minus DATE is fractional, so `TRUNC` it, or a stock at 90.4 days is "SLOW" in SQL and the model disagrees.

---

### P14. Supplier lead-time statistics and on-time / OTIF rate
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): STDDEV_SAMP of one line is NULL, unreceived late line counts as not on time, CANCELLED excluded.
**Purpose:** Measure supplier reliability (mean, median, p90 and stddev of lead time, on-time %, OTIF %) to feed safety stock (P10) and supplier scorecards.
**Features:** `MEDIAN`, `PERCENTILE_CONT ... WITHIN GROUP`, `STDDEV_SAMP`, `AVG(CASE)`, `LEFT JOIN` to count unreceived late lines.
**Tables:** `po_header`, `po_line`, `receipt_line`.

```sql
WITH line_rcpt AS (
  SELECT ph.supplier_id, pl.po_id, pl.line_no, ph.order_date, pl.promised_date, pl.qty_ordered,
         MIN(r.receipt_date) AS first_rcpt,
         MAX(r.receipt_date) AS last_rcpt,
         NVL(SUM(r.qty_received), 0) AS qty_rcv
  FROM   po_header ph
  JOIN   po_line   pl ON pl.po_id = ph.po_id
  LEFT   JOIN receipt_line r ON r.po_id = pl.po_id AND r.line_no = pl.line_no
  WHERE  ph.status <> 'CANCELLED'
  AND    pl.promised_date < DATE '2026-11-24'           -- only lines already due
  GROUP  BY ph.supplier_id, pl.po_id, pl.line_no, ph.order_date, pl.promised_date, pl.qty_ordered
)
SELECT supplier_id,
       COUNT(*)                                                                          AS due_lines,
       COUNT(first_rcpt)                                                                 AS received_lines,
       ROUND(AVG(TRUNC(first_rcpt) - TRUNC(order_date)), 2)                              AS avg_lt_days,
       MEDIAN(TRUNC(first_rcpt) - TRUNC(order_date))                                     AS median_lt,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY TRUNC(first_rcpt) - TRUNC(order_date)) AS p90_lt,
       ROUND(STDDEV_SAMP(TRUNC(first_rcpt) - TRUNC(order_date)), 2)                      AS sd_lt,
       ROUND(100 * AVG(CASE WHEN TRUNC(first_rcpt) <= promised_date THEN 1 ELSE 0 END), 2) AS on_time_pct,
       ROUND(100 * AVG(CASE WHEN qty_rcv >= qty_ordered
                             AND TRUNC(last_rcpt) <= promised_date THEN 1 ELSE 0 END), 2) AS otif_pct
FROM   line_rcpt
GROUP  BY supplier_id
ORDER  BY otif_pct;
```
**Verify in JS:** Implement `percentileCont(sorted, p)`: `rn = 1 + p*(n-1)`, then interpolate linearly between floor and ceil. Median = percentileCont 0.5. Statistics are computed over received lines only, because aggregates skip NULLs. On-time counts an unreceived due line as 0, because the `CASE` turns NULL into 0.
**Edge cases / traps:** An inner join to receipts drops late, never-received lines and inflates on-time %, so this example uses a LEFT JOIN with a due-date filter. Measure from first receipt (responsiveness) or last receipt (completion), and say which. Promised dates that get changed need history. `MEDIAN` and `PERCENTILE_CONT` ignore NULLs. `PERCENTILE_DISC` returns an actual value rather than an interpolation.
**Sources:** PERCENTILE_CONT https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/PERCENTILE_CONT.html ; MEDIAN https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MEDIAN.html ; OTIF is a standard supply-chain KPI (concept, no URL verified)

---

### P15. Three-way match (PO vs receipt vs invoice)
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): MATCHED, PRICE_VARIANCE, INVOICED_EXCEEDS_RECEIPT and OPEN statuses all produced.
**Purpose:** Accounts-payable control. Pay an invoice line only if invoiced qty <= received qty and the invoiced price is within tolerance of the PO price.
**Features:** Three independent pre-aggregations, `LEFT JOIN`, an ordered `CASE` rule chain, a tolerance parameters CTE.
**Tables:** `po_line`, `receipt_line`, `invoice_line`.

```sql
WITH params AS (SELECT 0.02 AS price_tol, 0.00 AS qty_tol FROM dual),
rc AS (SELECT po_id, line_no, SUM(qty_received) AS qty_rcv FROM receipt_line GROUP BY po_id, line_no),
iv AS (SELECT po_id, line_no, SUM(qty_invoiced) AS qty_inv, SUM(qty_invoiced * unit_price) AS amt_inv
       FROM invoice_line GROUP BY po_id, line_no)
SELECT pl.po_id, pl.line_no, pl.item_id,
       pl.qty_ordered, NVL(rc.qty_rcv,0) AS qty_rcv, NVL(iv.qty_inv,0) AS qty_inv,
       pl.unit_price AS po_price,
       ROUND(iv.amt_inv / NULLIF(iv.qty_inv,0), 4) AS inv_avg_price,
       CASE
         WHEN NVL(iv.qty_inv,0) = 0 AND NVL(rc.qty_rcv,0) = 0                     THEN 'OPEN'
         WHEN NVL(iv.qty_inv,0) = 0                                               THEN 'RECEIVED_NOT_INVOICED'
         WHEN iv.qty_inv > NVL(rc.qty_rcv,0) * (1 + p.qty_tol)                    THEN 'INVOICED_EXCEEDS_RECEIPT'
         WHEN NVL(rc.qty_rcv,0) > pl.qty_ordered * (1 + p.qty_tol)                THEN 'OVER_RECEIVED'
         WHEN ABS(iv.amt_inv - iv.qty_inv * pl.unit_price)
              > iv.qty_inv * pl.unit_price * p.price_tol                          THEN 'PRICE_VARIANCE'
         WHEN iv.qty_inv < NVL(rc.qty_rcv,0)                                      THEN 'PARTIALLY_INVOICED'
         ELSE 'MATCHED'
       END AS match_status,
       iv.amt_inv - iv.qty_inv * pl.unit_price AS price_variance_amt
FROM   po_line pl
CROSS  JOIN params p
LEFT   JOIN rc ON rc.po_id = pl.po_id AND rc.line_no = pl.line_no
LEFT   JOIN iv ON iv.po_id = pl.po_id AND iv.line_no = pl.line_no
ORDER  BY pl.po_id, pl.line_no;
```
**Verify in JS:** Three maps keyed by `po|line`. Apply the same rule chain **in the same order**, since the first match wins. Compute amounts in cents x milli-units, so they are integers scaled by 10^5.
**Edge cases / traps:** The order of the CASE branches is business logic, because a line can be both over-received and price-mismatched. Credit notes (negative `qty_invoiced`) net out in the sum. Tolerance can be percent and/or absolute (`LEAST`/`GREATEST` of both). Joining `receipt_line` and `invoice_line` directly to each other gives an m x n fan-out. Match per receipt vs per line is a design decision (many ERPs match per receipt).
**Sources:** standard AP control (PO / receiving / invoice matching, as in Oracle Payables and SAP MIRO). Concept only, no URL verified.

---

### P16. Standard cost: purchase price variance (PPV) using the cost effective at receipt date
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): PPV 16.00 using the as-of standard (1.90 vs 2.00), missing-standard rows counted.
**Purpose:** Under standard costing, inventory is carried at standard. PPV = (PO price - standard cost) x qty received. A positive value is unfavourable. The standard is time-versioned.
**Features:** Scalar subquery with `MAX(...) KEEP (DENSE_RANK LAST ORDER BY ...)` (an "as-of" lookup), `GROUP BY ROLLUP`, `GROUPING_ID`.
**Tables:** `item_cost_history(item_id NUMBER(10), effective_date DATE, std_cost NUMBER(14,2), PRIMARY KEY(item_id, effective_date))`, `receipt_line`, `po_line`, `po_header`, `item(category)`.

```sql
WITH rc AS (
  SELECT ph.supplier_id, i.category, r.receipt_date, r.qty_received, pl.unit_price,
         (SELECT MAX(h.std_cost) KEEP (DENSE_RANK LAST ORDER BY h.effective_date)
          FROM   item_cost_history h
          WHERE  h.item_id = pl.item_id AND h.effective_date <= r.receipt_date) AS std_at_rcpt
  FROM   receipt_line r
  JOIN   po_line   pl ON pl.po_id = r.po_id AND pl.line_no = r.line_no
  JOIN   po_header ph ON ph.po_id = pl.po_id
  JOIN   item      i  ON i.item_id = pl.item_id
  WHERE  r.receipt_date >= DATE '2026-10-01' AND r.receipt_date < DATE '2026-11-01'
)
SELECT GROUPING_ID(supplier_id, category) AS gid, supplier_id, category,
       SUM(qty_received)                               AS qty,
       SUM(qty_received * unit_price)                  AS actual_value,
       SUM(qty_received * std_at_rcpt)                 AS std_value,
       SUM(qty_received * (unit_price - std_at_rcpt))  AS ppv,
       COUNT(*) - COUNT(std_at_rcpt)                   AS rows_without_std
FROM   rc
GROUP  BY ROLLUP(supplier_id, category)
ORDER  BY supplier_id NULLS LAST, category NULLS LAST;

-- Revaluation when a new standard takes effect: on_hand * (new - old)
SELECT s.branch_id, s.item_id, s.on_hand,
       s.on_hand * (n.std_cost - o.std_cost) AS revaluation
FROM   stock s
JOIN   item_cost_history n ON n.item_id = s.item_id AND n.effective_date = DATE '2026-11-01'
JOIN   item_cost_history o ON o.item_id = s.item_id
     AND o.effective_date = (SELECT MAX(effective_date) FROM item_cost_history
                             WHERE item_id = s.item_id AND effective_date < DATE '2026-11-01');
```
**Verify in JS:** For each receipt, binary-search the cost history for the last effective_date <= receipt_date. Rollup levels: (supplier, category), (supplier), (). Rows with no standard at that date get a NULL std. `SUM` ignores NULLs, so the PPV for those rows is silently missing, which is why the query counts them in `rows_without_std`.
**Edge cases / traps:** `effective_date` with a time part versus a receipt at midnight. A standard changed mid-day. The ROLLUP subtotal rows have NULL in the rolled-up columns and can be confused with genuine NULL keys, so use `GROUPING_ID` to tell them apart. A scalar subquery per row is fine for simulation volumes. `LATERAL` (12c) or an analytic `LAST_VALUE ... IGNORE NULLS` over a union is the set-based alternative.
**Sources:** FIRST/LAST (KEEP) https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/LAST.html ; ROLLUP/GROUPING_ID https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-aggregation-data-warehouses.html ; PPV is a standard cost-accounting definition (concept)

---

### P17. Cycle count variance, inventory accuracy and shrinkage by category (+ posting)
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): the posting INSERT, MERGE and UPDATE also execute.
**Purpose:** Compare counted qty with frozen system qty. Report accuracy % within tolerance, net and absolute variance value, and shrinkage (negative variance only) by category and branch with subtotals. Then post the adjustments.
**Features:** `GROUP BY ROLLUP(a, b)`, `GROUPING()`, `LEAST`, `ABS`, `INSERT ... SELECT`, `MERGE ... WHEN MATCHED`.
**Tables:** `cycle_count(count_id NUMBER(12) PK, count_batch NUMBER(10), branch_id NUMBER(10), item_id NUMBER(10), count_date DATE, system_qty NUMBER(14,3), counted_qty NUMBER(14,3), posted CHAR(1) DEFAULT 'N', UNIQUE(count_batch, branch_id, item_id))`.

```sql
SELECT CASE WHEN GROUPING(i.category) = 1 THEN 'ALL' ELSE i.category END                 AS category,
       CASE WHEN GROUPING(c.branch_id) = 1 THEN 'ALL' ELSE TO_CHAR(c.branch_id) END      AS branch,
       COUNT(*)                                                                         AS counted_skus,
       ROUND(100 * AVG(CASE WHEN ABS(c.counted_qty - c.system_qty) <= 0.02 * c.system_qty
                            THEN 1 ELSE 0 END), 2)                                      AS accuracy_pct,
       SUM((c.counted_qty - c.system_qty) * i.std_cost)                                 AS net_var_value,
       SUM(ABS(c.counted_qty - c.system_qty) * i.std_cost)                              AS abs_var_value,
       SUM(LEAST(c.counted_qty - c.system_qty, 0) * i.std_cost)                         AS shrink_value
FROM   cycle_count c
JOIN   item i ON i.item_id = c.item_id
WHERE  c.count_date >= DATE '2026-10-01' AND c.count_date < DATE '2026-11-01'
GROUP  BY ROLLUP(i.category, c.branch_id)
ORDER  BY GROUPING(i.category), i.category, GROUPING(c.branch_id), c.branch_id;

-- Posting a batch: ledger first, then snapshot (same transaction)
INSERT INTO stock_move (branch_id, item_id, move_date, move_type, qty, ref_doc)
SELECT branch_id, item_id, count_date, 'ADJ', counted_qty - system_qty, 'CC' || count_id
FROM   cycle_count
WHERE  count_batch = 7 AND posted = 'N' AND counted_qty <> system_qty;

MERGE INTO stock s
USING (SELECT branch_id, item_id, counted_qty - system_qty AS delta
       FROM cycle_count WHERE count_batch = 7 AND posted = 'N' AND counted_qty <> system_qty) c
ON (s.branch_id = c.branch_id AND s.item_id = c.item_id)
WHEN MATCHED THEN UPDATE SET s.on_hand = s.on_hand + c.delta;

UPDATE cycle_count SET posted = 'Y' WHERE count_batch = 7 AND posted = 'N';
```
**Verify in JS:** Group by `category|branch`, then by `category`, then the grand total. Five aggregates each. Accuracy compares `abs(diff) <= 0.02*system`, which with integer milli-units becomes `50*abs(diff) <= system`.
**Edge cases / traps:**
- `system_qty = 0` with any counted qty is inaccurate under a percentage tolerance. Use an absolute tolerance for low quantities.
- Post the **delta** (counted - frozen system), not `on_hand := counted`. Stock moved between freezing and posting, so overwriting double-counts those movements.
- A duplicate (batch, branch, item) source raises ORA-30926 in MERGE. The UNIQUE constraint prevents it.
- The `stock_nonneg` check can fire if delta drives on-hand below allocated.
- In the ROLLUP ordering, `GROUPING()` sorts subtotals after detail rows.
**Sources:** https://en.wikipedia.org/wiki/Cycle_count ; GROUPING https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/GROUPING.html

---

### P18. Inventory turnover, days of inventory and sell-through by branch (PIVOT + ROLLUP)
**Tier:** Intermediate
**Verification:** verified on 19c (it executes, and the output was spot-checked for plausibility, not compared with an independent model).
**Purpose:** Management KPIs, all per category (with an ALL row) and pivoted per branch:
- Turnover = COGS / average inventory value
- DIO = days in period / turnover
- Sell-through = units sold / (opening + units received)
**Features:** Conditional aggregation for opening/closing/flows, `GROUP BY branch, ROLLUP(category)`, multi-aggregate `PIVOT`, ratio-of-sums.
**Tables:** `stock_move`, `item(category, std_cost)`.

```sql
WITH params AS (SELECT DATE '2026-01-01' AS d_from, DATE '2026-07-01' AS d_to FROM dual),
bal AS (
  SELECT m.branch_id, m.item_id,
         SUM(CASE WHEN m.move_date <  p.d_from THEN m.qty ELSE 0 END)                         AS open_qty,
         SUM(m.qty)                                                                            AS close_qty,
         SUM(CASE WHEN m.move_type = 'ISS' AND m.move_date >= p.d_from THEN -m.qty ELSE 0 END) AS sold_qty,
         SUM(CASE WHEN m.move_type = 'RCV' AND m.move_date >= p.d_from THEN  m.qty ELSE 0 END) AS rcv_qty
  FROM   stock_move m CROSS JOIN params p
  WHERE  m.move_date < p.d_to
  GROUP  BY m.branch_id, m.item_id
),
agg AS (
  SELECT b.branch_id,
         CASE WHEN GROUPING(i.category) = 1 THEN '(ALL)' ELSE i.category END AS category,
         SUM(b.sold_qty * i.std_cost)                              AS cogs,
         SUM((b.open_qty + b.close_qty) / 2 * i.std_cost)          AS avg_inv,
         SUM(b.sold_qty)                                           AS sold,
         SUM(b.open_qty + b.rcv_qty)                               AS available
  FROM   bal b JOIN item i ON i.item_id = b.item_id
  GROUP  BY b.branch_id, ROLLUP(i.category)
)
SELECT category,
       ROUND(b1_cogs / NULLIF(b1_inv, 0), 2)                                   AS b1_turns,
       ROUND(b1_inv * (DATE '2026-07-01' - DATE '2026-01-01') / NULLIF(b1_cogs, 0), 1) AS b1_dio,
       ROUND(100 * b1_sold / NULLIF(b1_avail, 0), 1)                           AS b1_sell_through_pct,
       ROUND(b2_cogs / NULLIF(b2_inv, 0), 2)                                   AS b2_turns,
       ROUND(b2_inv * (DATE '2026-07-01' - DATE '2026-01-01') / NULLIF(b2_cogs, 0), 1) AS b2_dio,
       ROUND(100 * b2_sold / NULLIF(b2_avail, 0), 1)                           AS b2_sell_through_pct,
       ROUND(b3_cogs / NULLIF(b3_inv, 0), 2)                                   AS b3_turns,
       ROUND(b3_inv * (DATE '2026-07-01' - DATE '2026-01-01') / NULLIF(b3_cogs, 0), 1) AS b3_dio,
       ROUND(100 * b3_sold / NULLIF(b3_avail, 0), 1)                           AS b3_sell_through_pct
FROM   agg
PIVOT (SUM(cogs) AS cogs, SUM(avg_inv) AS inv, SUM(sold) AS sold, SUM(available) AS avail
       FOR branch_id IN (1 AS b1, 2 AS b2, 3 AS b3))
ORDER  BY CASE WHEN category = '(ALL)' THEN 2 ELSE 1 END, category;
```
**Verify in JS:** Compute per branch/item opening, closing, sold and received. Value them at std_cost. Sum numerators and denominators per (branch, category) and per (branch, ALL), and **only then** divide.
**Edge cases / traps:**
- Never sum or average ratios. The `(ALL)` row must be Σcogs/Σinv, which is why both are pivoted separately.
- Average inventory as (open+close)/2 is crude. A daily average from P21's balance grid is better and changes results.
- Branches with transfers in but no receipts get a sell-through denominator that excludes TRI. Decide whether transfers count as supply.
- The pivot column names are `<IN alias>_<agg alias>` (`B1_COGS`). A missing branch gives NULL columns.
- The sentinel `'(ALL)'` must not collide with a real category.
**Sources:** https://en.wikipedia.org/wiki/Inventory_turnover ; https://en.wikipedia.org/wiki/Days_in_inventory ; PIVOT multiple aggregates https://oracle-base.com/articles/11g/pivot-and-unpivot-operators-11gr1

---

## ADVANCED

### P19. Inter-branch stock transfer as one transaction (negative stock prevention, deadlock-safe)
**Tier:** Advanced
**Verification:** partly verified on 19c. The statement sequence executes in one session, and MERGE with only WHEN NOT MATCHED created the missing destination row. The concurrency claims (lock ordering prevents ORA-00060, guard under races) are **unverified**: private temporary tables are session-private, so two sessions could not be tested.
**Purpose:** Move qty of an item from branch A to B atomically. Either both snapshot rows and both ledger legs change, or nothing does. It must never go negative, even under concurrency.
**Features:** Guarded `UPDATE ... WHERE on_hand - allocated >= :q` with a rowcount check, `MERGE ... WHEN NOT MATCHED` only (19c allows omitting a branch), `SELECT ... FOR UPDATE` in deterministic order, a CHECK constraint as backstop, `COMMIT`/`ROLLBACK`.
**Tables:** `stock`, `stock_move` (shared schema).

```sql
-- binds: :src, :dst, :item, :q (q > 0), :doc (transfer number), :cost (carried unit cost)

-- 0) make sure the destination row exists (no-op if it does). Concurrent first-time creators
--    can hit ORA-00001 on stock_pk -> catch and continue (the row now exists).
MERGE INTO stock t
USING (SELECT :dst AS branch_id, :item AS item_id FROM dual) s
ON (t.branch_id = s.branch_id AND t.item_id = s.item_id)
WHEN NOT MATCHED THEN INSERT (branch_id, item_id, on_hand, allocated) VALUES (s.branch_id, s.item_id, 0, 0);

-- 1) lock both rows in ascending branch_id order (two statements -> fixed lock order,
--    so A->B and B->A transfers cannot deadlock each other)
SELECT on_hand FROM stock WHERE branch_id = LEAST(:src, :dst)    AND item_id = :item FOR UPDATE;
SELECT on_hand FROM stock WHERE branch_id = GREATEST(:src, :dst) AND item_id = :item FOR UPDATE;

-- 2) guarded decrement; rowsAffected must be 1, else ROLLBACK ("insufficient available stock")
UPDATE stock SET on_hand = on_hand - :q
WHERE  branch_id = :src AND item_id = :item AND on_hand - allocated >= :q;

-- 3) increment destination
UPDATE stock SET on_hand = on_hand + :q WHERE branch_id = :dst AND item_id = :item;

-- 4) two ledger legs (two INSERTs, not INSERT ALL - see traps)
INSERT INTO stock_move (branch_id, item_id, move_date, move_type, qty, unit_cost, ref_doc)
VALUES (:src, :item, SYSDATE, 'TRO', -:q, :cost, :doc);
INSERT INTO stock_move (branch_id, item_id, move_date, move_type, qty, unit_cost, ref_doc)
VALUES (:dst, :item, SYSDATE, 'TRI',  :q, :cost, :doc);

COMMIT;
```
**Verify in JS:** The model applies the transfer only if `onHand - allocated >= q`, otherwise there is no change and the expected error is raised. After the run, P1(c) (transfer pairing) and P3 (reconciliation) must both return zero rows. Fire concurrent opposite transfers and assert there is no ORA-00060 and that the sum across branches is conserved.
**Edge cases / traps:**
- `:src = :dst` must be rejected up front, or the two locks hit the same row (harmless) and the ledger has a zero-net pair.
- The CHECK `on_hand >= 0` is the last line of defence. It raises ORA-02290 and rolls back the *statement*, not the transaction, so the app must roll back.
- **Do not** read on_hand, test it in JS, then `UPDATE SET on_hand = :newValue`. That is a lost-update race. Always use relative updates with a guard.
- `INSERT ALL ... SELECT FROM dual` evaluates a sequence `NEXTVAL` once per source row, so both legs get the same id if ids come from a sequence. That is fine with identity, but a known trap.
- `SYSDATE` is the DB server clock. The model must not use the JS clock for ordering assertions.
- Statement-level atomicity: on any error, roll back the whole transaction explicitly.
**Sources:** SELECT FOR UPDATE https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html ; INSERT multitable + sequences https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/INSERT.html ; Constraints https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/constraint.html

---

### P20. Picking queue with `FOR UPDATE SKIP LOCKED`
**Tier:** Advanced
**Verification:** partly verified on 19c. Both queries execute, `ORDER BY ... FOR UPDATE SKIP LOCKED` is accepted, and `FETCH FIRST ... FOR UPDATE` raises ORA-02014 (verified). The multi-session behaviour (skipping, ROWNUM-before-skip, lock-on-fetch, driver prefetch locking) is **unverified**, for the same session-private reason.
**Purpose:** Several pickers (workers or sessions) pull the next open pick tasks without blocking each other or double-picking.
**Features:** `SELECT ... ORDER BY ... FOR UPDATE SKIP LOCKED`, fetch-limited cursor, the join-back ROWNUM variant, `UPDATE ... WHERE task_id IN (...)`.
**Tables:** `pick_task(task_id NUMBER(12) PK, branch_id NUMBER(10), order_id NUMBER(12), item_id NUMBER(10), lot_id NUMBER(12), qty NUMBER(14,3), priority NUMBER(3), created_at DATE, status VARCHAR2(10) CHECK (status IN ('OPEN','PICKING','DONE','CANCELLED')), picker_id NUMBER(10))`, index `(branch_id, status, priority, created_at)`.

```sql
-- (a) Canonical: open a cursor and fetch only N rows. With SKIP LOCKED, rows are locked
--     as they are fetched, so only fetched rows are claimed.
SELECT task_id, item_id, lot_id, qty
FROM   pick_task
WHERE  branch_id = :b AND status = 'OPEN'
ORDER  BY priority, created_at, task_id
FOR UPDATE SKIP LOCKED;
-- fetch N rows, then:
UPDATE pick_task SET status = 'PICKING', picker_id = :picker
-- :t1..:t3 = the fetched ids
WHERE  task_id IN (:t1, :t2, :t3);
COMMIT;

-- (b) Single-statement alternative (join-back). Returns <= N rows, possibly fewer
--     (even 0) if the top-N candidates are locked by others.
SELECT t.task_id, t.item_id, t.qty
FROM   pick_task t
WHERE  t.task_id IN (SELECT task_id
                     FROM  (SELECT task_id FROM pick_task
                            WHERE branch_id = :b AND status = 'OPEN'
                            ORDER BY priority, created_at, task_id)
                     WHERE ROWNUM <= 5)
FOR UPDATE SKIP LOCKED;
```
**Does NOT work on 19c:** `... FETCH FIRST 5 ROWS ONLY FOR UPDATE [SKIP LOCKED]` raises **ORA-02014** because FETCH FIRST is rewritten into an inline view with a window function. `WHERE ROWNUM <= 5 ... FOR UPDATE SKIP LOCKED` on the same block applies ROWNUM *before* the lock is skipped, so it can return 0 rows while free tasks exist.
**Verify in JS:** Run K concurrent claimers. Assert that the union of claimed ids has no duplicates, that every claimed id was OPEN, and that the claimed set equals the K x N highest-priority tasks when there is no contention. With contention, only assert disjointness and priority monotonicity per claimer.
**Edge cases / traps:**
- **Driver prefetch.** node-oracledb's `prefetchRows` and `fetchArraySize` pull rows to the client in batches, and with SKIP LOCKED every row fetched to the client is locked. Set `fetchArraySize = N` and `prefetchRows = N` (or 0) on that cursor, or one picker silently grabs 100 tasks.
- The locks are released only at COMMIT or ROLLBACK. Rows you fetched but did not update stay locked until then.
- `ORDER BY` + `FOR UPDATE` is allowed (no ORA-02014). DISTINCT, GROUP BY, aggregates and set operators are not.
- SKIP LOCKED is not documented in old releases but has been in the 19c reference since 11g.
**Sources:** SELECT for_update_clause https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html ; forum threads on FETCH FIRST + FOR UPDATE ORA-02014 https://forums.oracle.com/ords/apexds/post/select-for-update-and-fetch-first-in-single-query-1527 and https://forums.oracle.com/ords/apexds/post/return-first-n-rows-with-skip-locked-5086 ; node-oracledb fetch tuning https://node-oracledb.readthedocs.io/en/latest/user_guide/tuning.html

---

### P21. Gaps-and-islands: stock-out periods per item (consecutive days at zero)
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): planted series gave islands 03-06 Jan (4 days) and 12-14 Jan (3 days).
**Purpose:** Turn daily closing balances into stock-out episodes (from, to, length) for lost-sales and service KPIs.
**Features:** Densified daily balance (opening + running SUM), the **Tabibitosan** grouping key `d - ROW_NUMBER()`, `GROUP BY` the island key.
**Tables:** `stock_move`.

```sql
WITH params AS (SELECT DATE '2026-01-01' AS d_from, DATE '2026-03-31' AS d_to FROM dual),
cal AS (SELECT p.d_from + LEVEL - 1 AS d FROM params p CONNECT BY LEVEL <= p.d_to - p.d_from + 1),
keys AS (
  SELECT DISTINCT m.branch_id, m.item_id
  FROM   stock_move m CROSS JOIN params p
  WHERE  m.move_date < p.d_to + 1
),
opening AS (
  SELECT m.branch_id, m.item_id, SUM(m.qty) AS q
  FROM   stock_move m CROSS JOIN params p
  WHERE  m.move_date < p.d_from
  GROUP  BY m.branch_id, m.item_id
),
daily AS (
  SELECT m.branch_id, m.item_id, TRUNC(m.move_date) AS d, SUM(m.qty) AS net
  FROM   stock_move m CROSS JOIN params p
  WHERE  m.move_date >= p.d_from AND m.move_date < p.d_to + 1
  GROUP  BY m.branch_id, m.item_id, TRUNC(m.move_date)
),
bal AS (
  SELECT k.branch_id, k.item_id, c.d,
         NVL(o.q, 0) + SUM(NVL(dl.net, 0)) OVER (PARTITION BY k.branch_id, k.item_id
                                                ORDER BY c.d ROWS UNBOUNDED PRECEDING) AS close_qty
  FROM   keys k
  CROSS  JOIN cal c
  LEFT   JOIN opening o ON o.branch_id = k.branch_id AND o.item_id = k.item_id
  LEFT   JOIN daily  dl ON dl.branch_id = k.branch_id AND dl.item_id = k.item_id AND dl.d = c.d
),
zero_days AS (
  SELECT branch_id, item_id, d,
         d - ROW_NUMBER() OVER (PARTITION BY branch_id, item_id ORDER BY d) AS grp
  FROM   bal
  WHERE  close_qty <= 0
)
SELECT branch_id, item_id, MIN(d) AS out_from, MAX(d) AS out_to, COUNT(*) AS days_out
FROM   zero_days
GROUP  BY branch_id, item_id, grp
ORDER  BY branch_id, item_id, out_from;
```
**Verify in JS:** Per key, walk the days with a running balance seeded by the opening balance. Start an island when `bal <= 0` and the previous day was not, and close it otherwise. Islands still open at `d_to` end at `d_to`.
**Edge cases / traps:**
- This is **closing** balance semantics: an item out from 10:00 to 15:00 on the same day is not detected. For intraday episodes, run the islands over the movement sequence (P2 running balance) with timestamps.
- Items that have never had a movement are absent from `keys`. Islands touching the window edges are truncated.
- `DATE - NUMBER` is a DATE, so the `grp` key is a date value (fine for grouping).
- An item whose opening balance is not computed shows false stock-outs on day 1, so movements before `d_from` must be in `opening`.
**Sources:** the "Tabibitosan" technique (Aketi Jyuuzou, Oracle Community forums) and the generic gaps-and-islands technique. No URL verified. ROW_NUMBER https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ROW_NUMBER.html

---

### P22. `MATCH_RECOGNIZE`: stock-out patterns and "late replenishment" detection
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): warning 10-11 Jan, out 12-14 Jan, recovered 15 Jan with qty 10. The no-warning outage was correctly not matched.
**Purpose:** Find stock-outs of 3+ days, and the sequence *below ROP -> stock-out -> recovered* that shows a late reorder. Report warning days, out days and the recovery date.
**Features:** `MATCH_RECOGNIZE` with `PARTITION BY`, `ORDER BY`, `MEASURES` (`FIRST`, `LAST`, `COUNT(var.*)`), `PATTERN` quantifiers `{3,}`, `+`, `ONE ROW PER MATCH`, `AFTER MATCH SKIP PAST LAST ROW`.
**Tables:** the `bal` CTE from P21 joined with `item(reorder_point)` (or `stock_policy`).

```sql
-- assume bal_rop(branch_id, item_id, d, close_qty, rop) = P21's bal joined to item.reorder_point
SELECT *
FROM   bal_rop
MATCH_RECOGNIZE (
  PARTITION BY branch_id, item_id
  ORDER BY d
  MEASURES FIRST(warn.d)       AS below_rop_from,
           FIRST(stockout.d)   AS out_from,
           LAST(stockout.d)    AS out_to,
           COUNT(warn.*)       AS warning_days,
           COUNT(stockout.*)   AS out_days,
           FIRST(recov.d)      AS recovered_on,
           FIRST(recov.close_qty) AS recovered_qty
  ONE ROW PER MATCH
  AFTER MATCH SKIP PAST LAST ROW
  PATTERN (warn+ stockout+ recov)
  DEFINE warn     AS close_qty > 0 AND close_qty <= rop,
         stockout AS close_qty <= 0,
         recov    AS close_qty > 0
)
ORDER BY branch_id, item_id, out_from;

-- Simple variant: stock-outs lasting at least 3 days
SELECT *
FROM   bal_rop
MATCH_RECOGNIZE (
  PARTITION BY branch_id, item_id ORDER BY d
  MEASURES FIRST(z.d) AS out_from, LAST(z.d) AS out_to, COUNT(*) AS days_out
  ONE ROW PER MATCH
  PATTERN (z{3,})
  DEFINE z AS close_qty <= 0
);
```
To build `bal_rop` inline, append to P21's WITH list:
`bal_rop AS (SELECT b.branch_id, b.item_id, b.d, b.close_qty, i.reorder_point AS rop FROM bal b JOIN item i ON i.item_id = b.item_id)`.
**Verify in JS:** A small regex-like state machine per key: scan the days, keep a run of `warn` days, then `stockout` days, and require one `recov` day. A match needs at least one `warn` day directly before the stockout. If the item went from above ROP straight to 0, the pattern does not match, and that case is itself a finding ("no warning").
**Edge cases / traps:**
- Greedy quantifiers plus `recov` defined as `> 0` means recovery is the first positive day after the outage. A `recov` that lands back *below* ROP still counts, so tighten it to `close_qty > rop` if needed.
- An outage still running at the window end does not match the first pattern because `recov` is missing. Add `PATTERN (warn+ stockout+ recov?)` to report it.
- Pattern variables are case-insensitive identifiers. Avoid reserved words, such as an `OUT` variable name.
- `COUNT(*)` in MEASURES counts all rows of the match, while `COUNT(var.*)` counts one variable.
- `MATCH_RECOGNIZE` needs the input to be ordered and dense per day (P21 output).
**Sources:** https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-pattern-matching-data-warehouses.html ; https://oracle-base.com/articles/12c/pattern-matching-in-oracle-database-12cr1

---

### P23. FIFO consumption of cost layers by issues (cumulative ranges + overlap join)
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): issues cost 10@2+5@3 = 35 and 5@3+5@4 = 35.
**Purpose:** Each inbound movement is a cost layer. Issues consume the oldest layers first. Produce, for each issue, which layers it consumed, how much and at what cost (COGS under FIFO), set-based with no loops.
**Features:** Two running `SUM() OVER (ROWS UNBOUNDED PRECEDING)` (one for supply, one for demand) turned into half-open ranges `[cum-qty, cum)`. A non-equi **range overlap join** `a.from < b.to AND b.from < a.to`. Overlap length `LEAST(to) - GREATEST(from)`. `LEFT JOIN` + aggregation to find unmatched quantity.
**Tables:** `stock_move(branch_id, item_id, move_id, move_date, qty, unit_cost)`. Inbound = `qty > 0` (RCV, TRI, positive ADJ); outbound = `qty < 0`.

```sql
WITH ins AS (
  SELECT item_id, move_id, move_date, qty, unit_cost,
         SUM(qty) OVER (PARTITION BY item_id ORDER BY move_date, move_id ROWS UNBOUNDED PRECEDING) AS cum_to
  FROM   stock_move
  WHERE  branch_id = 1 AND qty > 0
),
outs AS (
  SELECT item_id, move_id, move_date, -qty AS qty,
         SUM(-qty) OVER (PARTITION BY item_id ORDER BY move_date, move_id ROWS UNBOUNDED PRECEDING) AS cum_to
  FROM   stock_move
  WHERE  branch_id = 1 AND qty < 0
),
alloc AS (
  SELECT o.item_id, o.move_id AS issue_id, o.move_date AS issue_date, o.qty AS issue_qty,
         i.move_id AS layer_id, i.move_date AS layer_date, i.unit_cost,
         LEAST(o.cum_to, i.cum_to) - GREATEST(o.cum_to - o.qty, i.cum_to - i.qty) AS qty_from_layer
  FROM   outs o
  LEFT   JOIN ins i
         ON  i.item_id = o.item_id
         AND i.cum_to - i.qty < o.cum_to          -- layer starts before issue ends
         AND o.cum_to - o.qty < i.cum_to          -- issue starts before layer ends
)
-- detail rows: replace the final SELECT with  SELECT * FROM alloc ORDER BY item_id, issue_id, layer_id
SELECT item_id, issue_id, issue_date, issue_qty,
       NVL(SUM(qty_from_layer), 0)                     AS qty_costed,
       issue_qty - NVL(SUM(qty_from_layer), 0)         AS qty_uncosted,      -- > 0 => issued more than ever received
       SUM(qty_from_layer * unit_cost)                 AS fifo_cogs,
       COUNT(layer_id)                                 AS layers_touched,
       MAX(issue_date - layer_date)                    AS oldest_layer_age_days
FROM   alloc
GROUP  BY item_id, issue_id, issue_date, issue_qty
ORDER  BY item_id, issue_date, issue_id;
```
**Verify in JS:** Keep a queue of layers `{id, remaining, cost}` per item. For each outbound in `(date, id)` order, pop from the front while needed and record `(issue, layer, take)`. Leftover need becomes `qty_uncosted`. The SQL and the queue simulation must produce *identical* detail rows.
**Edge cases / traps:**
- The set-based version is **quantity-ordered, not time-aware**. If stock went negative (issue before its receipt), the SQL still matches that issue to the future receipt, while a perpetual system would cost it at a provisional cost and true it up later. Enforce non-negative stock (P19) or detect it (P2c) first.
- Customer returns and positive adjustments become new layers at their own `unit_cost`, which is NULL for ADJ, so the cost goes NULL and SUM ignores it. Give them a cost (e.g. the current average) or exclude them.
- Both cumulative sums need the same deterministic tiebreak.
- Half-open interval logic: use `<`, never `<=`, or zero-length overlaps appear as 0-qty rows.
- The join is O(n*m) per item in the worst case, which is fine for simulation volumes. In production, add a band (`i.cum_to - i.qty < o.cum_to`) with an index, or use MATCH_RECOGNIZE/MODEL.
- `TRO` legs carry cost to the destination: the destination's `TRI.unit_cost` should equal the FIFO cost of the source issue, which is a two-pass problem.
**Sources:** running-total range matching for FIFO https://www.red-gate.com/simple-talk/databases/sql-server/t-sql-window-function-speed-phreakery-the-fifo-stock-inventory-problem/ (SQL Server, same algorithm) ; FIFO costing https://www.ibm.com/docs/en/SSGTJF/productconcepts/c_InventoryCostingMethod2FirstInFirstOutFIFO.html

---

### P24. FIFO inventory valuation and stock aging buckets
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): the remaining 5@4 = 20, both the SUM(CASE) and PIVOT forms.
**Purpose:** Value remaining on-hand at the cost of the *newest* layers (under FIFO, the oldest were consumed), and age the remaining stock by layer receipt date (0-30 / 31-60 / 61-90 / 90+).
**Features:** Cumulative layer ranges (as P23) vs total outbound qty, `GREATEST`, conditional `SUM(CASE)` buckets, `ROLLUP`, plus an alternative with `PIVOT`.
**Tables:** `stock_move`.

```sql
WITH ins AS (
  SELECT item_id, move_id, move_date, qty, unit_cost,
         SUM(qty) OVER (PARTITION BY item_id ORDER BY move_date, move_id ROWS UNBOUNDED PRECEDING) AS cum_to
  FROM   stock_move
  WHERE  branch_id = 1 AND qty > 0 AND move_date < DATE '2026-11-30' + 1
),
tot_out AS (
  SELECT item_id, SUM(-qty) AS q
  FROM   stock_move
  WHERE  branch_id = 1 AND qty < 0 AND move_date < DATE '2026-11-30' + 1
  GROUP  BY item_id
),
layers AS (
  SELECT i.item_id, i.move_id, i.move_date, i.unit_cost,
         i.cum_to - GREATEST(i.cum_to - i.qty, NVL(t.q, 0)) AS remaining,
         TRUNC(DATE '2026-11-30') - TRUNC(i.move_date)     AS age_days
  FROM   ins i
  LEFT   JOIN tot_out t ON t.item_id = i.item_id
  WHERE  i.cum_to > NVL(t.q, 0)
)
SELECT item_id,
       SUM(remaining)                                                  AS qty_on_hand,
       SUM(remaining * unit_cost)                                      AS fifo_value,
       SUM(CASE WHEN age_days <= 30               THEN remaining END)  AS age_0_30,
       SUM(CASE WHEN age_days BETWEEN 31 AND 60   THEN remaining END)  AS age_31_60,
       SUM(CASE WHEN age_days BETWEEN 61 AND 90   THEN remaining END)  AS age_61_90,
       SUM(CASE WHEN age_days > 90                THEN remaining END)  AS age_90_plus
FROM   layers
GROUP  BY ROLLUP(item_id)
ORDER  BY item_id NULLS LAST;
```
PIVOT alternative for the buckets:
```sql
SELECT * FROM (
  SELECT item_id, remaining,
         CASE WHEN age_days <= 30 THEN 'B0' WHEN age_days <= 60 THEN 'B1'
              WHEN age_days <= 90 THEN 'B2' ELSE 'B3' END AS bucket
  FROM layers)
PIVOT (SUM(remaining) FOR bucket IN ('B0' AS d0_30, 'B1' AS d31_60, 'B2' AS d61_90, 'B3' AS d90p));
```
**Verify in JS:** Run the P23 queue simulation to the as-of date. The remaining layer quantities *are* the answer. Bucket by `asOf - layerDate` and sum. `qty_on_hand` must equal the P2 as-of on-hand whenever stock never went negative.
**Edge cases / traps:**
- If total outbound exceeds total inbound, every layer is consumed and the item has no rows, while the true on-hand is negative. Report that separately.
- Empty buckets are NULL in both forms, not 0, so the model must mirror that or wrap with `NVL`.
- Aging by layer date is the FIFO-consistent definition. Aging by "last receipt date" is a different, cruder KPI.
- `BETWEEN` is inclusive, so the boundaries must not overlap.
**Sources:** P23 sources ; https://en.wikipedia.org/wiki/FIFO_and_LIFO_accounting

---

### P25. Periodic LIFO valuation
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): 5@2 = 10.
**Purpose:** Under LIFO, the latest costs flow to COGS and the remaining stock sits at the **oldest** layers. Under *periodic* LIFO, the closing on-hand is valued by taking layers oldest-first until the on-hand qty is covered.
**Features:** Cumulative layer ranges, `LEAST`, a join to on-hand.
**Tables:** `stock_move`.

```sql
WITH oh AS (
  SELECT item_id, SUM(qty) AS q
  FROM   stock_move
  WHERE  branch_id = 1 AND move_date < DATE '2026-12-31' + 1
  GROUP  BY item_id
),
ins AS (
  SELECT item_id, move_id, move_date, qty, unit_cost,
         SUM(qty) OVER (PARTITION BY item_id ORDER BY move_date, move_id ROWS UNBOUNDED PRECEDING) AS cum_to
  FROM   stock_move
  WHERE  branch_id = 1 AND qty > 0 AND move_date < DATE '2026-12-31' + 1
)
SELECT i.item_id, i.move_id AS layer_id, i.move_date, i.unit_cost,
       LEAST(i.cum_to, o.q) - (i.cum_to - i.qty)                 AS qty_in_closing,
       (LEAST(i.cum_to, o.q) - (i.cum_to - i.qty)) * i.unit_cost AS value
FROM   ins i
JOIN   oh  o ON o.item_id = i.item_id
WHERE  i.cum_to - i.qty < o.q            -- layer starts below the on-hand level
ORDER  BY i.item_id, i.move_date, i.move_id;
```
**Verify in JS:** Sort the layers oldest-first and fill up to the on-hand qty.
**Edge cases / traps:**
- **Perpetual** LIFO (consume the newest layer at each issue) gives a *different* result whenever stock was drawn down and rebuilt mid-period. It needs a stack simulation, either sequential (JS or PL/SQL) or a recursive WITH carrying the stack as a string or collection, which is not practical. Do not claim the set-based query is perpetual LIFO.
- LIFO is prohibited under IFRS (IAS 2) and allowed under US GAAP, so it is a reporting choice.
- Classic periodic LIFO tracks *annual* layers (base year + increments) rather than individual receipts. This query uses receipt-level layers.
**Sources:** https://en.wikipedia.org/wiki/FIFO_and_LIFO_accounting ; IAS 2 https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/

---

### P26. Lots, expiry and FEFO picking allocation
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): near-expiry lot excluded, picks 8 + 7 + 10, expired value 7.60.
**Purpose:** For perishables (a canteen!), pick from the lot that **expires first** (First-Expired-First-Out), skip expired or nearly expired lots, and report what is about to expire.
**Features:** Running `SUM() OVER (ORDER BY expiry_date, lot_id)` producing "cumulative before", `LEAST(lot_qty, need - cum_before)`, a filter on `cum_before < need`, `SELECT ... FOR UPDATE` on lots, a guarded `UPDATE`.
**Tables:** `lot(lot_id NUMBER(12) PK, branch_id NUMBER(10), item_id NUMBER(10), received_date DATE, expiry_date DATE NOT NULL, qty_on_hand NUMBER(14,3) CHECK (qty_on_hand >= 0), unit_cost NUMBER(14,2))`.

```sql
-- (a) FEFO allocation for one demand line
WITH req AS (
  SELECT 1 AS branch_id, 42 AS item_id, 25 AS need_qty,
         DATE '2026-11-24' AS asof, 2 AS min_days_left
  FROM dual
),
avail AS (
  SELECT l.lot_id, l.expiry_date, l.qty_on_hand, r.need_qty,
         SUM(l.qty_on_hand) OVER (ORDER BY l.expiry_date, l.lot_id ROWS UNBOUNDED PRECEDING)
           - l.qty_on_hand AS cum_before
  FROM   lot l
  JOIN   req r ON r.branch_id = l.branch_id AND r.item_id = l.item_id
  WHERE  l.qty_on_hand > 0
  AND    l.expiry_date >= r.asof + r.min_days_left
)
SELECT lot_id, expiry_date, qty_on_hand,
       LEAST(qty_on_hand, need_qty - cum_before) AS pick_qty
FROM   avail
WHERE  cum_before < need_qty
ORDER  BY expiry_date, lot_id;
-- shortfall = need_qty - SUM(pick_qty)  (0 if fully allocated)

-- (b) apply (same transaction): lock the candidate lots first, in FEFO order
SELECT lot_id FROM lot
WHERE  branch_id = 1 AND item_id = 42 AND qty_on_hand > 0
ORDER  BY expiry_date, lot_id
FOR UPDATE;
-- recompute (a) now that rows are locked, then for each (lot_id, pick_qty):
UPDATE lot SET qty_on_hand = qty_on_hand - :pick WHERE lot_id = :lot AND qty_on_hand >= :pick;

-- (c) expiry exposure: expired and expiring within 7 days, valued
SELECT branch_id, item_id,
       SUM(CASE WHEN expiry_date <  DATE '2026-11-24'     THEN qty_on_hand END)             AS expired_qty,
       SUM(CASE WHEN expiry_date <  DATE '2026-11-24'     THEN qty_on_hand * unit_cost END) AS expired_value,
       SUM(CASE WHEN expiry_date >= DATE '2026-11-24'
                 AND expiry_date <  DATE '2026-11-24' + 7 THEN qty_on_hand END)             AS expiring_7d_qty
FROM   lot
WHERE  qty_on_hand > 0
GROUP  BY branch_id, item_id
HAVING SUM(CASE WHEN expiry_date < DATE '2026-11-24' + 7 THEN qty_on_hand END) > 0;
```
**Verify in JS:** Sort eligible lots by `(expiry, lot_id)` and take greedily until the need is met. The model and the SQL must agree on the lot list and quantities. Also check that sum(lot.qty) per branch/item equals `stock.on_hand`, which is a lot-to-snapshot reconciliation like P3.
**Edge cases / traps:**
- An expiry "on date X" usually means usable through X, so decide between `>=` and `>`.
- Lots with the same expiry need a tiebreak (lot_id or FIFO by received_date).
- **Multi-order allocation** (many demand lines competing for lots in priority order) is the P23 overlap join: demand ranges vs lot ranges, both cumulative.
- Concurrency: without the `FOR UPDATE` (or SKIP LOCKED for parallel pickers), two pickers allocate the same lot. The guarded UPDATE is the safety net.
- Expired stock must be excluded from availability and from ATP, but still counted in on-hand (pending write-off).
**Sources:** FEFO is standard WMS practice for perishables (concept) ; analytic functions (19c) https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html

---

### P27. Multi-level BOM explosion with `CONNECT BY` (indented BOM, paths, leaves, cycles)
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): the XQuery product trick works on 19.3, and the cycle semantics were checked on a planted 2-node cycle.
**Purpose:** The indented bill of materials for a finished item (e.g. "Chicken Meal Set" -> "Rice Bowl" -> rice, ...), with level, path, leaf flags and cycle detection for bad data.
**Features:** `START WITH`, `CONNECT BY NOCYCLE PRIOR`, `LEVEL`, `SYS_CONNECT_BY_PATH`, `CONNECT_BY_ROOT`, `CONNECT_BY_ISLEAF`, `CONNECT_BY_ISCYCLE`, `ORDER SIBLINGS BY`, `LPAD` for indentation.
**Tables:** `bom(parent_item_id NUMBER(10) REFERENCES item, component_item_id NUMBER(10) REFERENCES item, qty_per NUMBER(14,3) NOT NULL CHECK (qty_per > 0), scrap_pct NUMBER(5,2) DEFAULT 0, PRIMARY KEY(parent_item_id, component_item_id), CHECK (parent_item_id <> component_item_id))`.

```sql
SELECT LEVEL                                             AS lvl,
       LPAD(' ', 2 * (LEVEL - 1)) || i.name               AS tree,
       b.parent_item_id, b.component_item_id, b.qty_per,
       CONNECT_BY_ROOT b.parent_item_id                   AS end_item,
       CONNECT_BY_ROOT b.parent_item_id
         || SYS_CONNECT_BY_PATH(b.component_item_id, '/') AS path,
       CONNECT_BY_ISLEAF                                  AS is_leaf,
       CONNECT_BY_ISCYCLE                                 AS is_cycle
FROM   bom b
JOIN   item i ON i.item_id = b.component_item_id
START  WITH b.parent_item_id = 100
CONNECT BY NOCYCLE PRIOR b.component_item_id = b.parent_item_id
ORDER  SIBLINGS BY b.component_item_id;
```
Extended (multiplied-down) quantity in CONNECT BY: there is no product aggregate along the path. One known 19c-valid trick evaluates the path as an XQuery arithmetic expression:
```sql
SELECT b.component_item_id, LEVEL,
       XMLCAST(XMLQUERY(SUBSTR(SYS_CONNECT_BY_PATH(TO_CHAR(b.qty_per, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), '*'), 2)
                        RETURNING CONTENT) AS NUMBER) AS ext_qty_per_unit
FROM   bom b
START  WITH b.parent_item_id = 100
CONNECT BY NOCYCLE PRIOR b.component_item_id = b.parent_item_id;
```
This ran correctly on 19.3 (e.g. `1*.01 = .01` at level 2). Prefer the recursive WITH in P28, which is clearer, more portable and does not re-parse an XQuery per row. Use this trick only to exercise the feature.
**Verify in JS:** DFS from the root over an adjacency list sorted by component_item_id (to match `ORDER SIBLINGS BY`). Emit rows in pre-order with level, path and leaf flag (no children).
- **Cycle semantics differ by construct (verified on 19c).** In CONNECT BY, rows are BOM *edges*. With `60->61, 61->60` and a start at parent 60, Oracle returns `60->61` (lvl 1, iscycle 0) and `61->60` (lvl 2, `CONNECT_BY_ISCYCLE=1` **and** `CONNECT_BY_ISLEAF=1`). The model flags an edge as a cycle when expanding it would revisit an edge already on the current path, and treats that edge as a leaf. Recursive WITH (P28) on the same data returns 3 rows (`60->61` N, `61->60` N, `60->61` Y).
**Edge cases / traps:**
- `SYS_CONNECT_BY_PATH` raises ORA-30004 if the separator occurs in a value, and the path is capped at 4000 bytes (VARCHAR2).
- `CONNECT_BY_ISCYCLE` is only allowed with `NOCYCLE`.
- Without NOCYCLE, a cycle raises ORA-01436.
- A shared subassembly used in two places is **not** a cycle and appears twice (correct for an indented BOM). Summarize separately (P28).
- Joining `item` in the same query block applies the join *before* the hierarchy (the join is evaluated first, then CONNECT BY, then WHERE), so put filters in WHERE carefully: WHERE prunes individual rows, not subtrees.
- With `ORDER SIBLINGS BY`, any outer `ORDER BY` destroys the hierarchy order.
- The XQuery trick depends on the number format: force a `.` decimal separator as shown, or `0,5` breaks it.
**Sources:** https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Hierarchical-Queries.html ; https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SYS_CONNECT_BY_PATH.html ; https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CONNECT_BY_ISCYCLE-Pseudocolumn.html

---

### P28. BOM explosion with recursive WITH: quantity roll-up, summarized requirements, standard cost roll-up
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): 10 builds gives egg 10*1*1.10 = 11, total cost 12.15. A bug was found and fixed during verification: `SUM(qty)*std_cost` was NULL on the ROLLUP total.
**Purpose:** For a build quantity of a finished item, compute extended quantities (multiplied down levels, with scrap), the summarized purchased-part requirements (a pick list or purchase need) and the rolled-up material cost.
**Features:** Recursive subquery factoring with a column list, `SEARCH DEPTH FIRST BY ... SET`, `CYCLE ... SET ... TO 'Y' DEFAULT 'N'`, `CAST(... AS VARCHAR2(4000))` in the anchor, `NOT EXISTS` for leaves, `GROUP BY ROLLUP((a,b))` for a grand total.
**Tables:** `bom`, `item(std_cost, is_purchased)`.

```sql
WITH x (lvl, root_id, parent_id, component_id, qty_per, ext_qty, path) AS (
  SELECT 1, b.parent_item_id, b.parent_item_id, b.component_item_id, b.qty_per,
         CAST(10 * b.qty_per * (1 + b.scrap_pct / 100) AS NUMBER),               -- build 10 units
         CAST('/' || b.parent_item_id || '/' || b.component_item_id AS VARCHAR2(4000))
  FROM   bom b
  WHERE  b.parent_item_id = 100
  UNION ALL
  SELECT x.lvl + 1, x.root_id, b.parent_item_id, b.component_item_id, b.qty_per,
         x.ext_qty * b.qty_per * (1 + b.scrap_pct / 100),
         x.path || '/' || b.component_item_id
  FROM   x
  JOIN   bom b ON b.parent_item_id = x.component_id
)
SEARCH DEPTH FIRST BY component_id SET ord
CYCLE component_id SET is_cycle TO 'Y' DEFAULT 'N',
leaves AS (
  SELECT x.*
  FROM   x
  WHERE  x.is_cycle = 'N'
  AND    NOT EXISTS (SELECT 1 FROM bom c WHERE c.parent_item_id = x.component_id)
)
SELECT l.component_id, i.name, i.std_cost,
       SUM(l.ext_qty)              AS total_qty,
       SUM(l.ext_qty * i.std_cost) AS ext_cost      -- NOT SUM(qty)*std_cost: that is NULL on the ROLLUP total row
FROM   leaves l
JOIN   item i ON i.item_id = l.component_id
GROUP  BY ROLLUP((l.component_id, i.name, i.std_cost))
ORDER  BY l.component_id NULLS LAST;
-- indented view instead: SELECT * FROM x ORDER BY ord;
```
**Verify in JS:** A recursive function `explode(parent, mult, ancestors)` loops over the children, computing `ext = mult*qty_per*(1+scrap/100)`. If the child is in `ancestors` (the components on this path), emit it with `is_cycle='Y'` and do not recurse. Leaves accumulate into a `Map<component, qty>`. Grand total = Σ qty x std_cost. Compare quantities after rounding to 6 dp, because NUMBER multiplication chains are exact in Oracle but not in doubles. Better, use scaled BigInt.
**Edge cases / traps:**
- **Anchor typing.** In theory the column types come from the anchor. On 19.3 EE we checked this directly: a `CHAR(1)` or `VARCHAR2(10)` anchor growing past its size in the recursive member, and a `NUMBER(14,3)` anchor receiving `v/3`, neither raised an error nor truncated. The CASTs are kept as explicit, portable typing, not because 19c requires them. Strings past 4000 bytes still fail (ORA-01489).
- **CYCLE semantics.** A row is a cycle if an *ancestor row* has the same cycle-column values. The cycle row **is output** (flagged 'Y') and not expanded. The root item itself is not in the ancestor set here, because the anchor rows are its children. So `100 -> 5 -> 100` is flagged on the row whose component is 5 the second time, one level later than you might expect. To make the root count, seed the anchor with a pseudo-row for the root (`SELECT 0, 100, NULL, 100, 1, 10, '/100' FROM dual`).
- Without the CYCLE clause, a cycle raises ORA-32044.
- `SEARCH DEPTH FIRST BY component_id` orders siblings by component_id (matches P27's `ORDER SIBLINGS BY`).
- A shared subassembly is not a cycle, and its leaves are summed once per usage, which is correct.
- Restrictions on the recursive member: no aggregate, `DISTINCT`, `GROUP BY` or `MODEL`. Analytic functions are allowed.
**Sources:** SELECT subquery_factoring_clause (search_clause / cycle_clause) https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html ; https://oracle-base.com/articles/11g/recursive-subquery-factoring-11gr2 ; ORA-32044 https://docs.oracle.com/error-help/db/ora-32044

---

### P29. Where-used (reverse BOM / implosion) and low-level codes
**Tier:** Advanced
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values). A bug was found and fixed during verification: the CONNECT BY path printed the current component instead of the root (`CONNECT_BY_ROOT` added).
**Purpose:** "If supplier X can't deliver soy sauce, which menu items are affected?" walks up the BOM. The low-level code (deepest level an item appears at) orders MRP processing (P32).
**Features:** `CONNECT BY` in reverse (`PRIOR parent = component`), `CONNECT_BY_ISLEAF` as "top-level item", `MAX(LEVEL)`, `START WITH ... IN (subquery)`.
**Tables:** `bom`, `item`.

```sql
-- (a) where-used for component 7, with the quantity of 7 per unit of each ancestor
WITH u (lvl, component_id, used_in, qty_per_unit, path) AS (
  SELECT 1, b.component_item_id, b.parent_item_id, CAST(b.qty_per AS NUMBER),
         CAST(b.component_item_id || '<' || b.parent_item_id AS VARCHAR2(4000))
  FROM   bom b WHERE b.component_item_id = 7
  UNION ALL
  SELECT u.lvl + 1, b.component_item_id, b.parent_item_id, u.qty_per_unit * b.qty_per,
         u.path || '<' || b.parent_item_id
  FROM   u JOIN bom b ON b.component_item_id = u.used_in
)
CYCLE used_in SET is_cycle TO 'Y' DEFAULT 'N'
SELECT u.*,
       CASE WHEN NOT EXISTS (SELECT 1 FROM bom p WHERE p.component_item_id = u.used_in)
            THEN 'Y' ELSE 'N' END AS is_end_item
FROM   u
ORDER  BY path;

-- (b) same with CONNECT BY
SELECT LEVEL AS lvl, b.parent_item_id AS used_in, b.qty_per,
       CONNECT_BY_ROOT b.component_item_id || SYS_CONNECT_BY_PATH(b.parent_item_id, '<') AS path,
       CONNECT_BY_ISLEAF AS is_end_item
FROM   bom b
START  WITH b.component_item_id = 7
CONNECT BY NOCYCLE PRIOR b.parent_item_id = b.component_item_id;

-- (c) low-level code: end items = 0, otherwise deepest level of use
SELECT i.item_id,
       NVL(MAX(h.lvl), 0) AS low_level_code
FROM   item i
LEFT   JOIN (SELECT b.component_item_id, LEVEL AS lvl
             FROM   bom b
             START  WITH b.parent_item_id IN (SELECT i2.item_id FROM item i2
                                             WHERE NOT EXISTS (SELECT 1 FROM bom x WHERE x.component_item_id = i2.item_id))
             CONNECT BY NOCYCLE PRIOR b.component_item_id = b.parent_item_id) h
       ON h.component_item_id = i.item_id
GROUP  BY i.item_id
ORDER  BY low_level_code, i.item_id;
```
**Verify in JS:** Build the reverse adjacency (component -> parents) and DFS upward. For LLC, do a DFS from each end item recording the max depth per component. Items in no BOM at all get LLC 0.
**Edge cases / traps:**
- An item used both directly in an end item (level 1) and deep inside a subassembly (level 3) has LLC 3. MRP must process it only after *all* of its parents, which is the reason LLC exists.
- In a cyclic BOM, LLC is undefined, so reject the data first (P27/P28 cycle flags). Verified: items that are only in a cycle with no end item above them get LLC 0 from query (c), because no START WITH root reaches them.
- In the CONNECT BY version, `CONNECT_BY_ISLEAF` means "no further parent", i.e. an end item.
**Sources:** Hierarchical queries https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Hierarchical-Queries.html ; Low-level code https://en.wikipedia.org/wiki/Material_requirements_planning

---

## EXPERT

### P30. Perpetual moving-average cost recomputed at every receipt (MODEL clause and recursive WITH)
**Tier:** Expert
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): the MODEL and recursive WITH forms agree (avg 2 -> 2.5 -> 3.5, issue values 37.5 and 35).
**Purpose:** Perpetual weighted average, as in SAP "V" price control and many ERPs. A receipt sets `avg = (oh*avg + q*cost)/(oh+q)`. An issue takes `avg` as its unit cost and leaves `avg` unchanged. This is inherently sequential, since each row depends on the previous result, so neither a plain window function nor a single aggregate works.
**Features:** `MODEL PARTITION BY ... DIMENSION BY ... MEASURES ... RULES SEQUENTIAL ORDER`, `cell[ANY] ORDER BY n`, `CV()`, reference to a non-existent cell (returns NULL). Alternatively a recursive WITH that iterates row by row.
**Tables:** `stock_move(branch_id, item_id, move_id, move_date, qty, unit_cost)`.

```sql
-- MODEL version
SELECT item_id, n, move_id, qty, unit_cost, oh, avg_cost, issue_value
FROM  (SELECT item_id, move_id, qty, unit_cost,
              ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY move_date, move_id) AS n
       FROM   stock_move
       WHERE  branch_id = 1)
MODEL
  PARTITION BY (item_id)
  DIMENSION BY (n)
  MEASURES (move_id, qty, unit_cost, 0 AS oh, 0 AS avg_cost, 0 AS issue_value)
  RULES SEQUENTIAL ORDER (
    -- running on-hand
    oh[ANY] ORDER BY n = NVL(oh[CV() - 1], 0) + qty[CV()],
    -- moving average: only priced inbound moves change it; negative prior stock is treated as 0
    avg_cost[ANY] ORDER BY n =
      CASE WHEN qty[CV()] > 0 AND unit_cost[CV()] IS NOT NULL
                AND GREATEST(NVL(oh[CV() - 1], 0), 0) + qty[CV()] > 0
           THEN (GREATEST(NVL(oh[CV() - 1], 0), 0) * NVL(avg_cost[CV() - 1], 0)
                 + qty[CV()] * unit_cost[CV()])
                / (GREATEST(NVL(oh[CV() - 1], 0), 0) + qty[CV()])
           ELSE NVL(avg_cost[CV() - 1], 0)
      END,
    -- cost of each issue at the average in force *before* it
    issue_value[ANY] ORDER BY n =
      CASE WHEN qty[CV()] < 0 THEN -qty[CV()] * NVL(avg_cost[CV() - 1], 0) ELSE 0 END
  )
ORDER BY item_id, n;
```
```sql
-- Recursive WITH version (same semantics)
WITH mv AS (
  SELECT /*+ MATERIALIZE */ item_id, move_id, qty, unit_cost,
         ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY move_date, move_id) AS n
  FROM   stock_move WHERE branch_id = 1
),
r (item_id, n, move_id, qty, unit_cost, oh, avg_cost) AS (
  SELECT item_id, n, move_id, qty, unit_cost,
         CAST(qty AS NUMBER),
         CAST(CASE WHEN qty > 0 THEN NVL(unit_cost, 0) ELSE 0 END AS NUMBER)
  FROM   mv WHERE n = 1
  UNION ALL
  SELECT m.item_id, m.n, m.move_id, m.qty, m.unit_cost,
         r.oh + m.qty,
         CASE WHEN m.qty > 0 AND m.unit_cost IS NOT NULL AND GREATEST(r.oh, 0) + m.qty > 0
              THEN (GREATEST(r.oh, 0) * r.avg_cost + m.qty * m.unit_cost) / (GREATEST(r.oh, 0) + m.qty)
              ELSE r.avg_cost END
  FROM   r JOIN mv m ON m.item_id = r.item_id AND m.n = r.n + 1
)
SELECT * FROM r ORDER BY item_id, n;
```
**Verify in JS:** A straightforward fold per item in `(date, id)` order with the same three rules. Compare `avg_cost` rounded to 6 dp and `issue_value` to 2 dp. The Oracle results are 38-digit decimals, so a double fold drifts after hundreds of steps. Use a decimal library in the model, or compare with a relative tolerance of 1e-9.
**Edge cases / traps:**
- **Rounding policy.** ERPs typically *store* the average rounded (2-4 dp) after each receipt, and the next receipt uses the rounded value. If the simulation's business layer does that, wrap the rule in `ROUND(..., 4)`, or the SQL and the ledger diverge over time.
- With `SEQUENTIAL ORDER`, rules run in listed order and each rule sweeps all cells (in `ORDER BY n`) before the next starts. `avg_cost` can reference `oh[CV()-1]` because `oh` is already fully computed. With `AUTOMATIC ORDER`, Oracle derives the dependency order but rejects cyclic dependencies.
- `oh[0]` does not exist and reads as NULL, hence the `NVL`.
- MODEL output includes **all** partition, dimension and measure columns, and the select list can only use those.
- Negative stock: the formula above resets the weighting to 0 when the prior on-hand is negative. Systems differ (some keep the negative value and produce absurd averages), so match the business rule.
- The recursive version re-scans `mv` once per level. The depth is the longest per-item history. Each iteration joins all items at once, which is fine for the simulation.
**Sources:** MODEL clause https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-modeling-data-warehouses.html ; SELECT model_clause https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SELECT.html ; moving average price concept https://en.wikipedia.org/wiki/Average_cost_method

---

### P31. Exponential smoothing forecast (MODEL clause and recursive WITH)
**Tier:** Expert
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): the MODEL and recursive WITH forms agree to 1e-6, and the next-period forecast .3*56 + .7*66.4567 = 63.32.
**Purpose:** Simple exponential smoothing `F[t] = a*A[t-1] + (1-a)*F[t-1]` over densified weekly demand, with the next-period forecast. It is sequential by nature, like P30.
**Features:** MODEL with `fcst[1] = qty[1]` and a positional or symbolic rule with `ORDER BY`. A recursive WITH alternative. Weekly densification as in P12.
**Tables:** weekly demand grid from P12 (`item_id, wk, q`).

```sql
WITH weeks AS (SELECT DATE '2026-01-05' + 7 * (LEVEL - 1) AS wk FROM dual CONNECT BY LEVEL <= 26),
dem AS (
  SELECT item_id, TRUNC(move_date, 'IW') AS wk, SUM(-qty) AS q
  FROM   stock_move
  WHERE  move_type = 'ISS' AND move_date >= DATE '2026-01-05' AND move_date < DATE '2026-01-05' + 182
  GROUP  BY item_id, TRUNC(move_date, 'IW')
),
grid AS (
  SELECT i.item_id, w.wk, NVL(d.q, 0) AS q,
         ROW_NUMBER() OVER (PARTITION BY i.item_id ORDER BY w.wk) AS n
  FROM   item i CROSS JOIN weeks w
  LEFT   JOIN dem d ON d.item_id = i.item_id AND d.wk = w.wk
)
SELECT item_id, n, wk, q, ROUND(fcst, 3) AS fcst, ROUND(abs_err, 3) AS abs_err
FROM   grid
MODEL
  PARTITION BY (item_id)
  DIMENSION BY (n)
  MEASURES (wk, q, CAST(NULL AS NUMBER) AS fcst, CAST(NULL AS NUMBER) AS abs_err)
  RULES SEQUENTIAL ORDER (
    fcst[1] = q[1],                                                       -- initialisation convention
    fcst[n > 1] ORDER BY n = 0.3 * q[CV() - 1] + 0.7 * fcst[CV() - 1],    -- alpha = 0.3
    fcst[27] = 0.3 * q[26] + 0.7 * fcst[26],                              -- UPSERT: next period
    wk[27]   = wk[26] + 7,
    abs_err[n BETWEEN 2 AND 26] = ABS(q[CV()] - fcst[CV()])               -- for MAD
  )
ORDER BY item_id, n;
```
```sql
-- Recursive WITH equivalent (append to the same WITH list as `grid` above)
es (item_id, n, wk, q, fcst) AS (
  SELECT item_id, n, wk, q, CAST(q AS NUMBER) FROM grid WHERE n = 1
  UNION ALL
  SELECT g.item_id, g.n, g.wk, g.q, 0.3 * e.q + 0.7 * e.fcst
  FROM   es e JOIN grid g ON g.item_id = e.item_id AND g.n = e.n + 1
)
SELECT * FROM es ORDER BY item_id, n;
```
**Verify in JS:** `f[0] = a[0]` and `f[t] = 0.3*a[t-1] + 0.7*f[t-1]`, with the next forecast from the last row. Optional MAD = mean |a-f| over t >= 2. Compare to 6 dp. Because 0.3 and 0.7 are exact in decimal but not in binary, use decimals or a tolerance.
**Edge cases / traps:**
- Rule `fcst[27] = ...` uses a positional reference on the left, so with default UPSERT semantics it **creates** a new row (n=27, `q` NULL). Symbolic references (`fcst[n > 1]`) only update existing cells. Mixing them up is the classic MODEL bug.
- The hard-coded 26/27 belong in a parameter. `MAX(n)` is not usable in the dimension expression without `FOR` or a reference model.
- The initialization convention (first actual, or mean of the first k periods) changes every later value.
- Alpha must be in (0, 1).
- Intermittent demand (many zeros) is better served by Croston's method, which is out of scope.
**Sources:** MODEL rules and UPSERT/UPDATE semantics https://docs.oracle.com/en/database/oracle/oracle-database/19/dwhsg/sql-modeling-data-warehouses.html ; https://en.wikipedia.org/wiki/Exponential_smoothing

---

### P32. MRP time-phased netting (gross -> net requirements, planned orders, lead-time offset)
**Tier:** Expert
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): with a planted shortage, net 10 in week 2 and 40 in week 4, projected on-hand held at SS 5, and a later PO lifted it to 105 (matches the sequential algorithm). Dependent-demand INSERT exploded 20 bowls into 3 rice, 0.2 soy, 22 eggs.
**Purpose:** For each component and each weekly bucket: gross requirements, scheduled receipts (open POs), projected on-hand, **net requirements** (lot-for-lot, respecting safety stock) and planned-order release dates.
**Features:** Bucket grid (`CROSS JOIN` periods), past-due bucketing with `GREATEST(TRUNC(d,'IW'), p0)`, running `SUM() OVER`, running `MAX() OVER` (the closed form of lot-for-lot netting), `LAG`.
**Key identity** (lot-for-lot with safety stock SS):
- `POH0[t] = OH + Σ_{s<=t}(SR[s] - GR[s])`, the projected on-hand *without* planned orders
- `CumPlanned[t] = max(0, max_{s<=t}(SS - POH0[s]))`
- `Net[t] = CumPlanned[t] - CumPlanned[t-1]`

This is exactly what the sequential algorithm produces (`avail += SR - GR; if avail < SS: plan = SS - avail; avail += plan`), so it can be written set-based.

**Tables:** `gross_req(item_id NUMBER(10), due_date DATE, qty NUMBER(14,3), source VARCHAR2(10))` (independent demand from forecast or orders, plus dependent demand written by the previous LLC pass), `po_header`, `po_line`, `receipt_line`, `stock`, `item(safety_stock, lead_time_days)`.

```sql
WITH params AS (SELECT TRUNC(DATE '2026-11-30', 'IW') AS p0, 8 AS n_periods FROM dual),
periods AS (SELECT p.p0 + 7 * (LEVEL - 1) AS p_start FROM params p CONNECT BY LEVEL <= p.n_periods),
plan_items AS (SELECT item_id, safety_stock, lead_time_days FROM item WHERE is_purchased = 'Y'),
gr AS (                                                  -- past-due demand lands in the first bucket
  SELECT g.item_id, GREATEST(TRUNC(g.due_date, 'IW'), p.p0) AS p_start, SUM(g.qty) AS q
  FROM   gross_req g CROSS JOIN params p
  WHERE  g.due_date < p.p0 + 7 * p.n_periods
  GROUP  BY g.item_id, GREATEST(TRUNC(g.due_date, 'IW'), p.p0)
),
rcv AS (SELECT po_id, line_no, SUM(qty_received) AS q FROM receipt_line GROUP BY po_id, line_no),
sr AS (                                                  -- open PO remainder = scheduled receipts
  SELECT pl.item_id, GREATEST(TRUNC(pl.promised_date, 'IW'), p.p0) AS p_start,
         SUM(GREATEST(pl.qty_ordered - NVL(r.q, 0), 0)) AS q
  FROM   po_header ph
  JOIN   po_line pl ON pl.po_id = ph.po_id
  LEFT   JOIN rcv r ON r.po_id = pl.po_id AND r.line_no = pl.line_no
  CROSS  JOIN params p
  WHERE  ph.status = 'OPEN' AND pl.promised_date < p.p0 + 7 * p.n_periods
  GROUP  BY pl.item_id, GREATEST(TRUNC(pl.promised_date, 'IW'), p.p0)
),
oh AS (SELECT item_id, SUM(on_hand - allocated) AS q FROM stock GROUP BY item_id),
grid AS (
  SELECT i.item_id, i.safety_stock, i.lead_time_days, pr.p_start,
         NVL(gr.q, 0) AS gross, NVL(sr.q, 0) AS sched, NVL(oh.q, 0) AS oh0
  FROM   plan_items i
  CROSS  JOIN periods pr
  LEFT   JOIN gr ON gr.item_id = i.item_id AND gr.p_start = pr.p_start
  LEFT   JOIN sr ON sr.item_id = i.item_id AND sr.p_start = pr.p_start
  LEFT   JOIN oh ON oh.item_id = i.item_id
),
poh AS (
  SELECT g.*,
         g.oh0 + SUM(g.sched - g.gross) OVER (PARTITION BY g.item_id ORDER BY g.p_start
                                              ROWS UNBOUNDED PRECEDING) AS poh_unplanned
  FROM   grid g
),
cum AS (
  SELECT x.*,
         GREATEST(0, MAX(x.safety_stock - x.poh_unplanned)
                       OVER (PARTITION BY x.item_id ORDER BY x.p_start ROWS UNBOUNDED PRECEDING)) AS cum_planned
  FROM   poh x
)
SELECT item_id, p_start, gross, sched,
       poh_unplanned,
       cum_planned - NVL(LAG(cum_planned) OVER (PARTITION BY item_id ORDER BY p_start), 0) AS net_req,
       poh_unplanned + cum_planned                                                       AS projected_oh,
       p_start - lead_time_days                                                          AS release_date,
       CASE WHEN p_start - lead_time_days < DATE '2026-11-24' THEN 'EXPEDITE' END         AS flag
FROM   cum
ORDER  BY item_id, p_start;
```
**Multi-level MRP:** Process items in ascending low-level code (P29c). For LLC = k, run the netting above for the items at that level. Then explode their planned orders one level down into `gross_req` for the components:
```sql
INSERT INTO gross_req (item_id, due_date, qty, source)
SELECT b.component_item_id, n.release_date, n.net_req * b.qty_per * (1 + b.scrap_pct / 100), 'DEP'
FROM   mrp_net_result n                       -- the netting output for LLC = k (temp table / CTE)
JOIN   bom b ON b.parent_item_id = n.item_id
WHERE  n.net_req > 0;
```
Then repeat for k+1. Dependent demand must come from *planned orders of the parent* (after the parent is netted), not from exploding the MPS gross quantities. Exploding gross through the BOM in one recursive query ignores parent on-hand, which is the classic wrong shortcut. (`plan_items` should then include manufactured items at that LLC, not only `is_purchased = 'Y'`.)

**Verify in JS:** For each item, `avail = oh0`, then for each bucket `avail += sched - gross; plan = max(0, ss - avail); avail += plan`. Assert that `net_req == plan` and `projected_oh == avail` for every bucket. Multi-level: loop LLC 0..max with the same explosion rule.
**Edge cases / traps:**
- The closed form holds **only for lot-for-lot**. Minimum order qty, order multiples and fixed period quantity make each planned order depend on the previous rounding, so use MODEL (P30-style sequential rules) or iterate in the app.
- `on_hand - allocated` vs `on_hand` must match what demand already includes, or allocated stock is double-counted.
- Past-due supply and demand are pulled into bucket 1, which is the standard convention.
- A release date before today is an expedite message, not something to silently shift.
- Lead time in working days needs a calendar table, not `date - n`.
- Scheduled receipts for cancelled or closed POs must be excluded.
**Sources:** https://en.wikipedia.org/wiki/Material_requirements_planning ; analytic MAX/SUM windows https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html

---

### P33. Inter-branch rebalancing: match surplus to shortage (greedy range overlap)
**Tier:** Expert
**Verification:** verified on 19c (it executes, and the output matched hand-computed expected values): surpluses +620/+566 vs shortage -660 gave 620 (b3 to b2) and 40 (b1 to b2).
**Purpose:** Before buying, move stock from branches above target to branches below it. The output is transfer suggestions `(from, to, qty)`, largest surplus to largest shortage. Each suggestion is then executed as a P19 transaction.
**Features:** Signed delta vs target, two cumulative ranges (surplus and shortage), the **overlap join** from P23 reused for allocation, `LEAST`/`GREATEST`.
**Tables:** `stock`, `stock_policy(branch_id, item_id, target_qty)` (from P10).

```sql
WITH pos AS (
  SELECT s.branch_id, s.item_id,
         (s.on_hand - s.allocated) - p.target_qty AS delta
  FROM   stock s
  JOIN   stock_policy p ON p.branch_id = s.branch_id AND p.item_id = s.item_id
),
surplus AS (
  SELECT item_id, branch_id, delta AS qty,
         SUM(delta) OVER (PARTITION BY item_id ORDER BY delta DESC, branch_id ROWS UNBOUNDED PRECEDING) AS cum_to
  FROM   pos WHERE delta > 0
),
shortage AS (
  SELECT item_id, branch_id, -delta AS qty,
         SUM(-delta) OVER (PARTITION BY item_id ORDER BY delta ASC, branch_id ROWS UNBOUNDED PRECEDING) AS cum_to
  FROM   pos WHERE delta < 0
)
SELECT su.item_id,
       su.branch_id AS from_branch,
       sh.branch_id AS to_branch,
       LEAST(su.cum_to, sh.cum_to) - GREATEST(su.cum_to - su.qty, sh.cum_to - sh.qty) AS transfer_qty
FROM   surplus su
JOIN   shortage sh
       ON  sh.item_id = su.item_id
       AND su.cum_to - su.qty < sh.cum_to
       AND sh.cum_to - sh.qty < su.cum_to
ORDER  BY su.item_id, from_branch, to_branch;
```
**Verify in JS:** Two queues per item (surpluses sorted desc by delta then branch_id, shortages sorted by most negative delta then branch_id). Two-pointer merge emitting `min(remainingSurplus, remainingShortage)`. Afterwards, for every item: Σtransfer = min(Σsurplus, Σshortage), and no donor ends below target.
**Edge cases / traps:**
- Transfers in transit (TRO posted, TRI not yet) must count in the receiver's position, or the next run suggests the same transfer again.
- Pack-size rounding breaks the exact overlap, so round down per suggestion and re-run for the remainder.
- Branch distance or cost is ignored by the greedy order (a transportation-problem LP is out of SQL's scope).
- The ordering tiebreak by `branch_id` is required for determinism.
- Rows with `delta = 0` are in neither set (correct).
**Sources:** same overlap technique as P23 ; https://en.wikipedia.org/wiki/Transportation_theory_(mathematics) (why greedy is only a heuristic)

---

### Appendix A. Suggested simulation scenarios that exercise these patterns
1. **Daily cycle (per simulated day):** receipts against POs (P4), sales issues (P1), FEFO lot picks (P26), occasional cycle counts with shrink (P17), nightly reconciliation (P3) and reorder alerts (P5). Each alert creates a PO.
2. **Weekly:** XYZ/ABC re-classification (P11-P12), policy refresh via MERGE (P10), rebalancing suggestions executed as transfers (P33 -> P19), MRP for the kitchen BOM (P27-P29, P32).
3. **Month-end:** FIFO COGS (P23), FIFO valuation and aging (P24), periodic WAC (P6), moving average (P30) cross-checked so that Σ issue_value from P30 plus closing value equals opening plus receipts value (a conservation invariant), PPV (P16), turnover/DIO (P18), supplier scorecard (P14), 3-way match (P15).
4. **Concurrency stress:** N parallel pickers on SKIP LOCKED (P20) and opposing transfers (P19). Invariants: no duplicate claims, no deadlocks, Σ on_hand across branches is conserved, P1(c) and P3 return nothing.

### Appendix B. Cross-pattern invariants (cheap, high-value assertions)
- `P2(b) as-of on-hand == P24 FIFO remaining qty == Σ lot.qty_on_hand (P26) == stock.on_hand (P3)` when stock never goes negative.
- `Σ FIFO COGS (P23) + FIFO closing value (P24) == Σ inbound qty x cost` (value conservation, exact in cents x milli-units).
- `Σ issue_value (P30) + closing oh x avg_cost == Σ receipt value`, within rounding, when stock never goes negative.
- `MRP projected_oh[t] >= safety_stock` for all t (P32), by construction.
- `Σ transfer_qty (P33) == min(Σ surplus, Σ shortage)` per item.
- ABC: count(A) >= 1 if any usage exists, and the class is monotone in rank (no A below a B).

---

# Part 5: Mira capability map

## Mira oracle-mongo-wrapper: what Oracle SQL the API can generate

Library root: `src/utils/oracle-mongo-wrapper/`.
All `file:line` references below are relative to that folder.
Scope: SQL the API **generates**. Raw-SQL escape hatches are listed separately: `Session.execute`, string inputs to `createView`, `createMaterializedView` and `explainPlan`, and the raw-string `$inSelect`. They are not counted as capability.

Conventions used throughout:
- `quoteIdentifier` always double-quotes and never upper-cases (`utils.ts:41-45`). Identifiers are therefore **case-sensitive**: `{name:1}` becomes `"name"`, not `NAME`.
- Literal values are bound (`:where_*`, `:upd_*`, `:agg_*`, ...). A few things are spliced into the SQL text and validated first: limit/skip, window `n`/`offset`/frame, PIVOT IN values, SAMPLE %, AS OF SCN, `$substr` positions, and the `$dateToString` format.
- A string value is never read as a column reference **in filters or updates**. In pipeline expressions, `"$col"` is a column and any other string is a bind. So there is no field-to-field comparison in filters (see section 9).

---

### 1. Filter operators (`parsers/filterParser.ts`)

Entry point: `parseFilter(filter, tableAlias?)` at `filterParser.ts:596-700`. Top-level keys are ANDed (`:697-698`). This parser is used by `find`, `findOne`, `count*`, `distinct`, `update*`, `delete*`, `$match`, `merge.whenMatchedDelete`, and `connectBy.startWith`.

| Operator | Generated SQL | Cite |
|---|---|---|
| `{f: v}` (scalar or Date) | `"f" = :where_f_n` | `:230-244` |
| `{f: null}` / `undefined` | `"f" IS NULL` | `:236-237` |
| `$eq $ne $gt $gte $lt $lte` | `"f" = / <> / > / >= / < / <= :b` | `:143-150, :252-275` |
| `$eq` etc. with `{ $subquery: {...} }` | `"f" > (SELECT AGG("x") FROM "t" WHERE "k" = t0."c" AND "k2" = :b)`. Agg is allow-listed: SUM AVG MIN MAX COUNT | `:254-268, :508-543, :80` |
| `$eq` etc. with `{ $now: true }` | `"f" < SYSTIMESTAMP` | `:269-270, :168` |
| `{ $now: { minus\|plus: { days\|hours\|minutes\|seconds: n } } }` | `SYSTIMESTAMP - NUMTODSINTERVAL(:b,'DAY') ...`. Only DAY/HOUR/MINUTE/SECOND units; there are no months or years | `:154, :167-191` |
| `$in: [..]` | `"f" IN (:b1, ...)`. An empty list becomes `1=0`. More than 1000 values become a collection bind `IN (SELECT COLUMN_VALUE FROM TABLE(:b))` using SYS.ODCINUMBERLIST / ODCIDATELIST / ODCIVARCHAR2LIST. Mixed types fall back to OR-ed groups of 1000 | `:276-301, :91-96` |
| `$nin` | `NOT IN (...)`. An empty list becomes `1=1`. Large lists use the same collection bind; the fallback uses AND-ed groups | `:302-325` |
| `$between: [a,b]` / `$notBetween` | `"f" [NOT] BETWEEN :min AND :max` | `:326-337` |
| `$exists: bool` (field level) | `IS NOT NULL` / `IS NULL` | `:338-339` |
| `$regex` (+ `$options` sibling) | `REGEXP_LIKE("f", :p[, :opts])`. The options string is bound as passed (i, c, n, m, x) and not validated. A JS `RegExp` object is not converted | `:340-353` |
| `$like` | `"f" LIKE :p`. There is no ESCAPE clause | `:354-357` |
| `$any: [..]` / `$all: [..]` | `"f" = ANY(:a, :b)` / `"f" = ALL(...)`. Equality only | `:358-371` |
| `$gtAny $ltAny $gteAny $lteAny: {collection, field}` | `"f" > ANY (SELECT "field" FROM "coll")`. The subquery has no WHERE | `:438-450` |
| `$gtAll ... $lteAll` | `"f" > ALL (SELECT "field" FROM "coll")` | `:451-463` |
| `$case: [{when, then}], $else` | `CASE WHEN <filter> THEN :b ... ELSE :b END`, emitted **as a bare predicate** (see quirk Q-F1) | `:372-395` |
| `$coalesce: [...]` | `COALESCE(...)`: `"$x"` is a column, any other string is a bind. Emitted as a bare predicate (Q-F1) | `:396-408` |
| `$nullif: [col, v]` | `NULLIF("col", :b)`, bare predicate (Q-F1) | `:409-413` |
| `$subquery: {...}` (as operator) | the scalar subquery alone, as a bare predicate | `:414-418` |
| `$inSelect: QueryBuilder` | `"f" IN (<qb SQL>)`, with the sub-query's binds merged in by `Object.assign` (Q-F3) | `:425-430` |
| `$inSelect: Array` | the same as `$in` | `:421-424` |
| `$inSelect: string` | `"f" IN (<raw sql>)` (raw passthrough) | `:431-437` |
| `$and` / `$or` | `( a AND b )` / `( a OR b )` | `:612-633` |
| `$nor` | `NOT ( a OR b )` | `:634-644` |
| `$not` (**top level only**) | `NOT ( ... )` | `:645-652` |
| `$exists: {collection, match}` (top level) | `EXISTS (SELECT 1 FROM "c" WHERE "k" = t0."col" AND "k2" = :b)`. A `"$col"` value is an outer reference; anything else is bound; equality only | `:653-672` |
| `$notExists: {collection, match}` | `NOT EXISTS (...)` | `:673-691` |
| anything else | throws `FILTER_UNSUPPORTED_OPERATOR` | `:464-465` |

Not available: field-level `$not`, `$expr`, `$elemMatch`, `$size`, `$type`, `$mod`, `$text`, field-to-field comparison, and functions on the column side (UPPER(col), TRUNC(date)).

### 2. Update operators (`parsers/updateParser.ts`)

Each update produces `SET ...`, with binds prefixed `upd_` (`:109-192`).

| Operator | SQL | Cite |
|---|---|---|
| `$set` | `"c" = :upd_c_n`. The value is always a bind, so you cannot set one column from another or from an expression | `:123-128` |
| `$unset` | `"c" = NULL` | `:129-132` |
| `$inc` | `"c" = "c" + :b` | `:133-140` |
| `$mul` | `"c" = "c" * :b` | `:141-148` |
| `$min` | `"c" = LEAST("c", :b)` | `:149-156` |
| `$max` | `"c" = GREATEST("c", :b)` | `:157-164` |
| `$currentDate: {c: true \| {$type:"date"}}` | `"c" = SYSDATE` | `:165-177` |
| `$currentDate: {c: {$type:"timestamp"}}` | `"c" = SYSTIMESTAMP` | `:178` |
| `$rename` | throws | `:181-182` |
| other (`$setOnInsert`, `$push`, ...) | throws | `:183-184` |

### 3. Aggregation pipeline (`pipeline/aggregatePipeline.ts`)

Shape: each stage becomes CTE `"stage_N"`, and the last stage is the outer SELECT (`:354-364`). Adjacent `$match` stages are merged into one `$and` (`:138-146`). `$having` is attached to the `$group` immediately before it (`:127-133`); a stray `$having` throws (`:340-342`). Unknown stages throw (`:344-346`). The entry point is called through `OracleCollection.aggregate` (`core/OracleCollection.ts:1623-1657`).

#### 3a. Stages

| Stage | Generated SQL | Cite / limits |
|---|---|---|
| `$match` | `SELECT * FROM prev WHERE <parseFilter>`. Column names are not upper-cased, so after `$group`/`$project` you must use the UPPER-CASE alias | `:153-161` |
| `$group` | `SELECT <keys>, AGG(..) AS "ALIAS" FROM prev GROUP BY ...` [HAVING]. Aliases are upper-cased | `:163-173, :389-486` |
| `$group._id: null` | no GROUP BY | `:397` |
| `$group._id: "$col"` | `GROUP BY "col"`; the key is selected without an alias | `:399-402` |
| `$group._id: {alias:"$col",...}` | `"col" AS "ALIAS"`, `GROUP BY "col"`. Values must be plain column references, not expressions | `:429-439` |
| `$group._id: {$rollup:[..]}` | `GROUP BY ROLLUP("a","b")` | `:405-408` |
| `$group._id: {$cube:[..]}` | `GROUP BY CUBE(...)` | `:409-412` |
| `$group._id: {$groupingSets:[[..],[..],[]]}` | `GROUP BY GROUPING SETS(("a"),("b"),())` | `:413-427` |
| `$having: {alias: {$gt:..}}` | `HAVING SUM("x") > :having_n`, using the aggregate expression for that alias. Operators: gt gte lt lte eq ne; an unknown operator silently becomes `=`. Only object conditions are read; AND only | `:458-483` |
| `$sort` | `SELECT * FROM prev ORDER BY "COL" ASC\|DESC`. Keys are **upper-cased**; `-1` means DESC and any other value means ASC; no NULLS FIRST/LAST | `:175-182, :670-677` |
| `$limit` | `... FETCH FIRST n ROWS ONLY` (its own CTE) | `:184-190` |
| `$skip` | `... OFFSET n ROWS` (its own CTE) | `:192-198` |
| `$count: "name"` | `SELECT COUNT(*) AS "NAME" FROM prev` | `:200-206` |
| `$project` | `{c:1}` gives `"c"`. `{a:"$c"}` gives `"c" AS "A"`. `{a:{expr}}` gives `<expr> AS "A"`. There is no exclusion mode (`{c:0}` is ignored) | `:208-219, :687-703` |
| `$addFields` | `SELECT prev.*, <expr> AS "A" ...`. A literal becomes a bind column | `:221-232, :709-727` |
| `$lookup` | joinBuilder SQL (section 5) | `:234-239` |
| `$lateralJoin: {subquery: QueryBuilder, as}` | `SELECT prev.*, "as".* FROM prev, LATERAL (<qb sql>) "as"`. Binds whose value is `"$outer.COL"` are rewritten to `prev."COL"`. Inner (CROSS APPLY-like) only | `:241-253, :735-754` |
| `$out: "T"` | `INSERT INTO "T" <pipeline SQL>`. There is no column list, so it needs an exact column match | `:255-260, :368` |
| `$merge: {into, on:{tgt:src}, fields:[..], whenMatched:"merge"\|"keepExisting", whenNotMatched:"insert"\|"discard"}` | `MERGE INTO "into" tgt USING (<pipeline>) src ON (...) WHEN MATCHED THEN UPDATE SET tgt.c=src.c ... WHEN NOT MATCHED THEN INSERT (...) VALUES (src...)`. Must be the last stage. No DELETE clause, no conditional WHERE, and target and source columns must have the same names | `:262-269, :770-792` |
| `$bucket: {groupBy, boundaries, default?, output?}` | `SELECT CASE WHEN c>=:lo AND c<:hi THEN :lbl ... [ELSE :def] END AS bucket, <aggs>\|COUNT(*) AS count FROM prev GROUP BY CASE ...` | `:271-276, :800-846` |
| `$facet: {name: [pipeline],...}` | `SELECT 'name' AS "facet_name", sub.* FROM (<sub-pipeline>) sub UNION ALL ...`. Binds are renamed per facet. All facets must return the same columns | `:278-308` |
| `$replaceRoot: {newRoot:"$x"}` | `SELECT "x".* FROM prev`, which is not valid SQL for a column (Q-P5) | `:310-329` |
| `$unwind` | no-op passthrough `SELECT * FROM prev` | `:331-338` |
| `$window` | not a stage; it is an expression inside `$addFields`/`$project` (section 4) | `:583-586` |

#### 3b. Expression operators (`_buildAggExpr`, `:502-593`)

These are used in `$group`, `$project`, `$addFields` and `$bucket.output`. **The arguments of the aggregate operators go through `_fieldRef` only (a column, `*`, or a number)**, so expressions cannot be nested inside SUM/AVG/... (`:601-608`). Arithmetic, concat and coalesce arguments go through `_fieldRefOrBind`, so they can be columns or binds, but a nested object becomes the text `[object Object]` (`:615-630`).

| Operator | SQL | Cite |
|---|---|---|
| `$sum` `$avg` `$min` `$max` | `SUM("x")` etc. | `:506-513` |
| `$count: "*" \| "$x"` | `COUNT(*)` / `COUNT("x")`. There is no DISTINCT | `:514-515` |
| `$first` / `$last` | **`MIN("x")` / `MAX("x")`**, not positional first/last (no KEEP) | `:516-519` |
| `$add` `$subtract` `$divide` | `(a + b)` / `(a - b)` / `(a / b)`, n-ary | `:528-545` |
| `$mul` | `a * b`, **not parenthesised** | `:520-527` |
| `$concat` | `a \|\| b \|\| :lit` | `:546-552` |
| `$toUpper` / `$toLower` | `UPPER("x")` / `LOWER("x")` | `:553-556` |
| `$substr: [col, start, len]` | `SUBSTR("col", n, n)`. The numbers are spliced in | `:557-562` |
| `$dateToString: {format, date}` | `TO_CHAR("d", 'fmt')`. The format is spliced in with `'` escaped; default `YYYY-MM-DD` | `:563-566` |
| `$cond: {if, then, else}` | `CASE WHEN <one cond> THEN x ELSE y END`. `if` handles exactly **one** `{field: {op: v}}` (gt gte lt lte eq ne; unknown op becomes `=`). No AND/OR, no nesting, no multiple WHEN branches | `:567-573, :636-664` |
| `$ifNull: [..]` | `COALESCE(a, b, :lit)` | `:574-580` |
| `$size` | `JSON_ARRAY_LENGTH("x")` (Q-P3) | `:581-582` |
| `$window` | analytic expression (section 4) | `:583-586` |
| **any other `$op`** | **falls through silently to the bare column `_fieldRef(val)`** (Q-P1) | `:587-588` |

Not allow-listed and not expressible: STDDEV, VARIANCE, MEDIAN, PERCENTILE_*, LISTAGG, COUNT(DISTINCT), KEEP (DENSE_RANK FIRST/LAST), GROUPING()/GROUPING_ID(), ROUND, TRUNC, MOD, ABS, CEIL/FLOOR, NVL2, DECODE, GREATEST/LEAST, ADD_MONTHS, EXTRACT, TRUNC(date), CAST, TO_NUMBER, TO_DATE, REGEXP_SUBSTR/REPLACE, INSTR, LENGTH, TRIM, LPAD, REPLACE, JSON_VALUE/JSON_TABLE.

### 4. Window functions (`pipeline/windowFunctions.ts`)

Spec: `{ fn, field?, partitionBy?: string|string[], orderBy?: {col: 1|-1}, offset?, n?, frame? }` (`:75-142`).
- Allow-list: ROW_NUMBER, RANK, DENSE_RANK, NTILE(n default 4), LAG(field, offset default 1), LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE(field, n default 1), SUM/AVG/COUNT (field or `*`), MIN, MAX (`:109-137`). Also CUME_DIST and PERCENT_RANK through `EXTRA_WINDOW_FUNCTIONS` (`:48, :138-140`). Anything else throws.
- `n`/`offset` must be positive integers (`:56-60, :77-78`).
- Frame grammar (regex, `:51-53`): `ROWS|RANGE <bound>` or `ROWS|RANGE BETWEEN <bound> AND <bound>`, where bound is `UNBOUNDED PRECEDING|FOLLOWING`, `CURRENT ROW`, or `<int> PRECEDING|FOLLOWING`. The frame is upper-cased and whitespace collapsed (`:100-102`). There is no GROUPS, no EXCLUDE, and no `INTERVAL` / expression offsets for RANGE.
- partitionBy: column names only (`:85-90`). orderBy: `{col: -1}` is DESC and anything else ASC; no NULLS FIRST/LAST and no expressions (`:91-99`).
- Not supported: LAG/LEAD default value, IGNORE/RESPECT NULLS, NTH_VALUE FROM LAST, RATIO_TO_REPORT, KEEP, windowed LISTAGG/STDDEV/MEDIAN, and windows outside a pipeline (`find().project()` cannot use `$window`).
- Filtering on a window result is possible only with a following `$match` stage, using the UPPER-CASE alias.

### 5. Joins, set operations, CTEs, subqueries

#### 5a. `$lookup` / `buildJoinSQL` (`joins/joinBuilder.ts:53-96`)
- `joinType`: left (default), right, full, inner, cross, self, natural; unknown types throw (`:99-119`).
- Single condition: `prev."localField" = "as"."foreignField"` (`:91-92`).
- Multi-condition: `on: [{localField, foreignField}, ...]` gives equality conditions ANDed (`:76-83`). There are no non-equi joins and no extra predicates on the joined table.
- `select: [..]` limits the right-side columns to `"as"."c"`; the default is `"as".*` (`:68-73`). The left side is always `prev.*`.
- `cross`: `CROSS JOIN "from" "as"` (`:89-90`). `natural`: `SELECT * FROM prev NATURAL JOIN "from"` (`:87-88`). `self`: `SELECT t1.*, t2.* FROM "from" t1 INNER JOIN "from" t2 ON t1.fk = t2.lk`, which **ignores the previous stages** (Q-J1, `:84-86`).
- Output is a flat row set, not nested arrays.

#### 5b. Set operations (`joins/setOperations.ts`, constructors at `core/OracleCollection.ts:2099-2130`)
- `OracleCollection.union(qb1, qb2, {all})` gives UNION or UNION ALL; `.intersect()` gives INTERSECT; `.minus()` gives MINUS. **Two operands only.**
- SQL: `(sql1)\nOP\n(sql2)`. The second operand's binds are renamed `set2_*` (`:123-141`).
- `.sort({c:±1}) .skip(n) .limit(n)` wraps the result in `SELECT * FROM (...) ORDER BY "c" OFFSET n ROWS FETCH FIRST n ROWS ONLY` (`:143-162`).
- Column-count check only compares the number of `===1` projection keys (`:71-79`).
- Nesting: a SetResultBuilder works as the **second** argument by duck typing. As the first argument `toArray` crashes because it reads `this._qb1.db` (`:179`). Suspected.

#### 5c. CTE builder (`pipeline/cteBuilder.ts`)
- `withCTE(db, {name: QueryBuilder, ...}).from(name).join({from, localField, foreignField, joinType}).sort().skip().limit().toArray()` (`:76, :119-224`).
- SQL: `WITH "a" AS (...), "b" AS (...) SELECT "a".*, "b".* FROM "a" <JT> "b" ON "a"."lf" = "b"."ff" ORDER BY ... OFFSET ... FETCH ...` (`:162-208`).
- Join types: inner (default), left, right, full, cross (`:379-394`). Only **one** join, with a single equality condition (a cross join still emits ON, see Q-C3). There is no select list. CTE bodies can only be `find()` QueryBuilders, not pipelines.
- `withRecursiveCTE(db, name, {anchor: QueryBuilder, recursive: {collection, joinOn: {childCol: "$name.parentCol"}}}).sort().skip().limit().toArray()` (`:102, :235-376`).
  - SQL: `WITH "name" ("C1",...,"LVL") AS (<anchor with t0.cols, 1 AS "LVL"> UNION ALL SELECT e.cols, o."LVL"+1 FROM "coll" e JOIN "name" o ON e."child" = o."parent") SELECT * FROM "name" ...` (`:287-346`).
  - The column list comes from `USER_TAB_COLUMNS WHERE TABLE_NAME = UPPER(anchor.tableName)` (`:351-361`).
  - Not supported: a filter on the recursive member, a depth limit, SEARCH DEPTH/BREADTH FIRST, CYCLE ... SET, extra computed columns (such as a path), and joining to anything other than the same table.

#### 5d. Subquery builders (`pipeline/subqueryBuilder.ts`; these return SQL **fragments** only and are not wired into execution)
- `buildScalarSubquery({collection, fn, field, filter})` gives `(SELECT COUNT(*)|SUM|AVG|MIN|MAX("f") FROM "c" WHERE "k" = t0."col")`. Only `"$col"` filter values are kept; literals are **silently dropped**. An unknown fn becomes COUNT(*) (`:57-96`).
- `buildExistsSubquery` / `buildNotExistsSubquery`: the same, and literals are also dropped (`:108-135`).
- `buildCorrelatedSubquery({collection, field, aggregate, where})`: aggregates allow-listed; only `$outer.` values are kept (`:149-168`).
- `buildInSelectSubquery(qb)`: `IN (<sql>)`, **discards the binds** (`:177-180`).
- `buildAnyAllSubquery({collection, field}, cmp)`: `cmp (SELECT "f" FROM "c")`. `cmp` is spliced in without validation (`:190-193`).
- Executable scalar subquery: `find().project({alias: {$subquery: {collection, fn: count|sum|avg|min|max, field, filter}}})` gives `(SELECT FN("f") FROM "c" WHERE "k" = t0."col" AND "k2" = :sub_..) AS "alias"` (`core/QueryBuilder.ts:288-341`). Literal filter values are bound here.

### 6. Oracle-specific advanced features

#### CONNECT BY (`advanced/oracleAdvanced.ts:65-131`, called from `OracleCollection.connectBy` at `core/OracleCollection.ts:1992`)
- `startWith`: a full `parseFilter` filter, giving `START WITH ...` (`:87-92`).
- `connectBy: {childCol: "$PRIOR parentCol"}` gives `PRIOR "parentCol" = "childCol"` (ANDed). Without `$PRIOR` it gives `"childCol" = "parentCol"` with no PRIOR (Q-A1) (`:96-109`).
- **`NOCYCLE` is always emitted** and cannot be turned off (`:110`). There is no CONNECT_BY_ISCYCLE, CONNECT_BY_ISLEAF or CONNECT_BY_ROOT.
- `maxLevel` gives `AND LEVEL <= n` (`:111-113`).
- `includeLevel` adds a `LEVEL` column (`:78`). `includePath` adds `SYS_CONNECT_BY_PATH("<col>", '/') AS "PATH"`. The column is guessed from a connectBy key containing "name", otherwise `"NAME"`; it cannot be specified and the separator is fixed (`:79-83, :220-228`).
- `orderSiblings: {c: ±1}` gives `ORDER SIBLINGS BY` (`:118-123`).
- There is no post-hierarchy WHERE, no column projection, and no join.

#### PIVOT (`oracleAdvanced.ts:156-183`)
- `{value: {$sum|$avg|$min|$max|$count: "$f"}, pivotOn, pivotValues: [...], groupBy: "col"}` gives `SELECT * FROM (SELECT "groupBy","pivotOn","f" FROM "t") PIVOT (AGG("f") FOR "pivotOn" IN ('v' AS "v", ...))`.
- One aggregate only. `groupBy` is a **single string**, even though the JSDoc at `OracleCollection.ts:2026` says "Column(s)". There is no filter, no PIVOT XML, and no ANY. Values are always quoted as string literals with `'` escaped.

#### UNPIVOT (`oracleAdvanced.ts:207-215`)
- `{valueColumn, nameColumn, columns: [..], includeNulls}` gives `SELECT * FROM "t" UNPIVOT INCLUDE|EXCLUDE NULLS ("val" FOR "name" IN ("c1", ...))`.
- One value column; no aliases in IN; no filter.

#### Flashback and SAMPLE (`core/QueryBuilder.ts`)
- `find(filter, {asOf: {scn}})` gives `"T" AS OF SCN <Number(scn)> t0` (`:356-357`).
- `find(filter, {asOf: {timestamp: "YYYY-MM-DD HH24:MI:SS"}})` gives `AS OF TIMESTAMP TO_TIMESTAMP(:asof_ts_n, 'YYYY-MM-DD HH24:MI:SS')` (`:358-362`).
- `find(filter, {sample: {percentage, seed?}})` gives `"T" SAMPLE(p) [SEED(s)] t0`. There is no SAMPLE BLOCK (`:366-373`).
- `asOf` and `sample` can only be passed as `find` options; there are no chain methods. There is no VERSIONS BETWEEN and no flashback in pipelines.

#### Row locking (`core/QueryBuilder.ts:101-119, :385-399`)
- `forUpdate(true | "nowait" | "skip locked" | {of:[cols], wait:n | nowait | skipLocked})` gives `FOR UPDATE [OF t0."c"] [WAIT n | NOWAIT | SKIP LOCKED]`.
- Combined with limit/skip it becomes `WHERE t0.ROWID IN (SELECT t0.ROWID ... OFFSET/FETCH) ... FOR UPDATE`.

### 7. Collection methods (`core/OracleCollection.ts`)

| Method | SQL / options | Cite |
|---|---|---|
| `find(filter, {sort, limit, skip, projection, forUpdate, sample, asOf})` returns a QueryBuilder | `SELECT <cols> FROM "T" t0 [AS OF/SAMPLE] WHERE .. ORDER BY .. OFFSET .. FETCH ..` | `:243-257`, `QueryBuilder.ts:280-400` |
| QueryBuilder terminals | `toArray`, `next`, `hasNext` (limit 1), `forEach` (queryStream), `count` (`SELECT COUNT(*) AS CNT`, ignores sort/limit/asOf/sample), `explain` (SQL only) | `QueryBuilder.ts:502-672` |
| projection | inclusion `{c:1}`; exclusion `{c:0}` runs `SELECT *` and strips columns in JS; `{a:{$subquery}}` | `utils.ts:232-259`, `QueryBuilder.ts:288-349, 463-473` |
| `findOne(filter)` | `SELECT * ... FETCH FIRST 1 ROW ONLY`. Options are ignored | `:273-289` |
| `findOneAndUpdate(filter, update, {returnDocument, upsert})` | SELECT, then `UPDATE ... <whereClause>` (Q-C1). With upsert, `after` and a scalar-equality filter it uses `MERGE ... USING (SELECT :src AS "c" FROM DUAL)` | `:312-479` |
| `findOneAndDelete` | SELECT with ROWID, then `DELETE WHERE ROWID = :rid` | `:494-529` |
| `findOneAndReplace` | SELECT, then `UPDATE ... SET all except "ID" <whereClause>` (Q-C1) | `:551-601` |
| `countDocuments(filter)` / `estimatedDocumentCount()` | `COUNT(*)` / `USER_TABLES.NUM_ROWS` | `:616-677` |
| `distinct(field, filter)` | `SELECT DISTINCT "f"`: one column only, no ORDER BY | `:695-711` |
| `insertOne(doc, {returning})` | `INSERT INTO "T" (..) VALUES (:v0..) [RETURNING .. INTO :out_..]`. Appends `RETURNING "ID"` when no ID is given (known issue) | `:743-830` |
| `insertMany(docs, {returning=["ID"], batchErrors})` | executeMany of one INSERT. Columns come from the first doc. RETURNING out-binds are typed NUMBER. `batchErrors` is mutually exclusive with `returning` | `:886-1017` |
| `bulkUpdateByKeys(rows, {keys})` | executeMany `UPDATE "T" SET "c"=:s0 .. WHERE "k"=:k0 AND ..` | `:1052-1150` |
| `updateOne(filter, update, {upsert, returning})` | `UPDATE "T" SET .. WHERE ROWID = (SELECT ROWID .. AND ROWNUM = 1) [RETURNING]`. There is no sort to choose which row. Upsert is a separate INSERT of the `$set` fields plus the scalar filter values | `:1177-1257` |
| `updateMany(filter, update, {returning})` | `UPDATE "T" t0 SET .. WHERE .. [RETURNING .. INTO]`, array out-binds | `:1279-1308`, `:122-141` |
| `replaceOne` | ROWID/ROWNUM=1 UPDATE of every column except the literal `"ID"` | `:1328-1363` |
| `bulkWrite([...])` | insertOne, updateOne, updateMany, deleteOne, deleteMany, replaceOne run in one `db.withTransaction` | `:1381-1441` |
| `deleteOne(filter, {returning})` | `DELETE WHERE ROWID = (SELECT .. ROWNUM = 1) [RETURNING]` | `:1467-1517` |
| `deleteMany(filter, {limit, returning})` | `DELETE FROM "T" t0 WHERE .. [AND ROWNUM <= :del_limit] [RETURNING]` | `:1535-1572` |
| `drop()` | `DROP TABLE "T" CASCADE CONSTRAINTS` | `:1582-1594` |
| `aggregate(pipeline)` | section 3. Returns a promise that also carries `_buildSQL` | `:1623-1657` |
| `createIndex(fields, {name, unique, type:"bitmap"})` | `CREATE [UNIQUE] [BITMAP] INDEX "IDX_T_cols" ON "T" ("c" ASC\|DESC, ..)`. No function-based, LOCAL, ONLINE, TABLESPACE, COMPRESS or REVERSE | `:1667-1691` |
| `createIndexes`, `dropIndex`, `dropIndexes` (skips the PK, swallows errors), `getIndexes`, `reIndex` (`ALTER INDEX .. REBUILD`, swallows errors) | | `:1698-1818` |
| `merge(sourceObj, {localField, foreignField}, {whenMatched: <update ops>, whenMatchedDelete: <filter>, whenNotMatched: "insert"})` | `MERGE INTO "T" tgt USING (SELECT :merge_0 AS "c", .. FROM DUAL) src ON (tgt."l" = src."f") WHEN MATCHED THEN UPDATE SET .. [DELETE WHERE ..] [WHEN NOT MATCHED THEN INSERT (all src cols) VALUES (src..)]`. **One row only**, single ON column, no WHERE on update or insert | `:1848-1905` |
| `mergeFrom(sourceTable, {localField, foreignField}, {whenMatched: {$set: {c: "$src.x" \| literal}}})` | `MERGE INTO "T" tgt USING "S" src ON (..) WHEN MATCHED THEN UPDATE SET ..`. The source is a **table only**; there is **no WHEN NOT MATCHED** and no DELETE | `:1925-1965` |
| `connectBy`, `pivot`, `unpivot` | section 6 | `:1992-2078` |
| `union`, `intersect`, `minus` (static) | section 5b | `:2099-2130` |
| `insertFromQuery(target, qb, {columns})` | `INSERT INTO "target" ("c"..) <qb SQL with the SELECT list regex-replaced>`. Without `columns`, it uses the target's non-identity columns from `USER_TAB_COLUMNS` | `:2153-2208` |
| `updateFromJoin({target, join: {table, on: {tCol: jCol}}, set: {c: "x.col" \| literal}, where})` | `UPDATE "target" SET "c" = (SELECT "col" FROM "J" WHERE "target"."l" = "r" AND ROWNUM = 1), .. WHERE EXISTS (SELECT 1 FROM "J" WHERE <on> [AND "w" = :b])`. `where` is equality only and applies inside EXISTS | `:2234-2292, :2301-2312` |

Transaction/session helpers (`Transaction.ts`): `withTransaction(fn(session))` (`:229-234`); `withReadOnlyTransaction` emits `SET TRANSACTION READ ONLY` (`:255-265`); `session.savepoint(name)` emits `SAVEPOINT x` and `rollbackTo` emits `ROLLBACK TO SAVEPOINT x` (`:146-169`); `releaseSavepoint` is a no-op (`:180-182`); `session.execute` is raw passthrough (`:128-130`). There is no SET TRANSACTION ISOLATION LEVEL SERIALIZABLE and no LOCK TABLE helper.

### 8. Schema / DDL / DCL

#### `OracleSchema` (`schema/OracleSchema.ts`)
- `createTable(name, {col: ColumnSpec}, {ifNotExists})` (`:107-154`). ColumnSpec (`:54-62`):
  - `type`: raw SQL type text.
  - `autoIncrement`: always `GENERATED ALWAYS AS IDENTITY`. BY DEFAULT, ON NULL and identity options are not available (`:115-117`).
  - `primaryKey`: column-level `PRIMARY KEY`, so there is no composite PK. A table-level `constraints` array exists but is never filled (`:110`).
  - `notNull`.
  - `default`: raw SQL expression (`:124-126`).
  - `check`: raw SQL condition (`:127-129`).
  - `references: {table, column}` gives `REFERENCES "t"("c")`. There is no ON DELETE CASCADE / SET NULL and no constraint name.
  - `ifNotExists` wraps the DDL in PL/SQL that swallows -955.
  - Not available: tablespace, partitioning, COMMENT, virtual columns, CTAS, global temporary tables, LOB storage, compression.
- `alterTable(name, op)`: **one op per call** (`:175-219`).
  - `addColumn {c: "TYPE ..."}` gives `ADD ("c" TYPE, ..)`.
  - `dropColumn "c"`.
  - `modifyColumn {c: "TYPE"}` gives `MODIFY (..)`.
  - `renameColumn {from, to}`.
  - `addConstraint {type: "UNIQUE"|"PRIMARY KEY"|..., columns, name?}` gives `ADD CONSTRAINT "n" <type> ("c"..)`. FOREIGN KEY (no REFERENCES clause) and CHECK (no condition) cannot be expressed this way.
  - `dropConstraint "n"`.
  - Not available: SET UNUSED, enable/disable constraints, add/drop partitions, MOVE, rename constraint.
- `dropTable(name, {cascade: CASCADE CONSTRAINTS PURGE, ifExists})` (`:233-251`). `truncateTable` (`:258-268`). `renameTable` gives `RENAME a TO b` (`:276-286`).
- `createView(name, QueryBuilder|string, {orReplace, force})` gives `CREATE [OR REPLACE] [FORCE] VIEW "v" AS <sql>` (`:304-335`). There is no WITH CHECK OPTION, WITH READ ONLY or column alias list. Aggregate pipelines are accepted through duck typing (`_buildSQL`). `dropView(name, {ifExists})` (`:343-358`).
- `createSequence(name, {startWith, incrementBy, maxValue, minValue, cycle, cache})` gives `CREATE SEQUENCE .. NOCYCLE|CYCLE ..` (`:376-400`). There is no ORDER, NOCACHE, alter/drop sequence, or ifNotExists.
- `createSchema(name)` gives `CREATE SCHEMA AUTHORIZATION "x"` (`:407-417`), see Q-S3.

#### Materialized views (`advanced/performanceUtils.ts`)
- `createMaterializedView(name, QueryBuilder|string, {refreshMode: fast|complete|force, refreshOn: commit|demand, buildMode: immediate|deferred, orReplace})` gives `CREATE MATERIALIZED VIEW "n" BUILD .. REFRESH .. ON .. AS <sql>`. `orReplace` runs DROP first and swallows any error (`:159-231`). There is no ENABLE QUERY REWRITE, START WITH/NEXT, WITH PRIMARY KEY|ROWID, or MV log creation.
- `refreshMaterializedView(name, mode)` runs `DBMS_MVIEW.REFRESH(UPPER(name), 'F'|'C'|'?')` (`:239-258`). `dropMaterializedView` (`:265-280`).
- `explainPlan(qb|sql)` runs `EXPLAIN PLAN FOR ..` and then `DBMS_XPLAN.DISPLAY('PLAN_TABLE', NULL, 'ALL')` (`:87-129`). `analyze(table)` runs `DBMS_STATS.GATHER_TABLE_STATS(USER, UPPER(:tbl), CASCADE => TRUE)` (`:136-150`).

#### `OracleDCL` (`schema/OracleDCL.ts`)
- `grant(privs[], on, to)` gives `GRANT p1, p2 ON "obj" TO "grantee"` (`:55-71`). `revoke` gives `REVOKE .. ON .. FROM ..` (`:84-100`).
- Object privileges only. There is no WITH GRANT OPTION, no system privileges (no ON-less form), no column-level grants, and no CREATE ROLE/USER. The privilege list is spliced in raw (Q-S4).

### 9. Not supported through the API (needs raw SQL)

| Oracle feature | Status | Evidence / workaround |
|---|---|---|
| ROLLUP / CUBE / GROUPING SETS | **Supported** (plain columns only) | `aggregatePipeline.ts:405-427`. There is no GROUPING()/GROUPING_ID() to tell subtotal NULLs from real NULLs, and no expressions inside |
| COUNT(DISTINCT x) | **Not supported** | `$count` emits `COUNT("x")` (`:514-515`). Partial: `$group {_id:"$x"}` then `$count`, for a single global distinct count only |
| LISTAGG | Not supported | not in `_buildAggExpr`. An unknown op falls through to the bare column (`:587-588`) |
| STDDEV / VARIANCE / MEDIAN / PERCENTILE_CONT/DISC | Not supported | same as above. `$stdDevPop` etc. silently become the bare column (Q-P1) |
| KEEP (DENSE_RANK FIRST/LAST) | Not supported | `$first`/`$last` are MIN/MAX (`:516-519`). Partial: `$window` ROW_NUMBER then `$match {RN:1}` |
| RATIO_TO_REPORT | Not supported | not in the window allow-list (`windowFunctions.ts:48, :109-141`). Partial: `$window SUM` then `$divide` in a later `$addFields` |
| LAG/LEAD with default value | Not supported | `windowFunctions.ts:118-121` emits `LAG("f", n)` only. Partial: wrap with `$ifNull` in a later stage |
| IGNORE NULLS | Not supported | no option in the spec (`:75`) |
| FETCH ... WITH TIES / FETCH PERCENT | Not supported | only `FETCH FIRST n ROWS ONLY` (`QueryBuilder.ts:378`, `aggregatePipeline.ts:187`). Partial: `$window RANK` then `$match` |
| NULLS FIRST / NULLS LAST | Not supported | every ORDER BY builder emits only ASC/DESC (`utils.ts:188-190`, `aggregatePipeline.ts:674`, `windowFunctions.ts:95`) |
| MATCH_RECOGNIZE | Not supported | — |
| MODEL clause | Not supported | — |
| INSERT ALL / INSERT FIRST | Not supported | `insertMany` is executeMany of a single-table INSERT (`OracleCollection.ts:915`) |
| MERGE with a source query | **Partial** | pipeline `$merge` gives `MERGE INTO tgt USING (<pipeline on this collection>)` (`aggregatePipeline.ts:770-792`). It has no DELETE, no conditional WHERE, and target and source columns must share names. `merge()` takes one DUAL row (`OracleCollection.ts:1894`); `mergeFrom()` takes a table and has no NOT MATCHED clause (`:1949`) |
| UPDATE SET (a,b) = (SELECT ...) | Not supported | `updateFromJoin` emits one correlated `(SELECT .. AND ROWNUM = 1)` per column (`OracleCollection.ts:2243-2256`) |
| UPDATE SET col = other column / expression | Not supported | `$set` always binds (`updateParser.ts:123-128`). Only `$inc`, `$mul`, `$min`, `$max` use the column itself |
| ADD_MONTHS / MONTHS_BETWEEN / EXTRACT / TRUNC(date) | Not supported | Partial: in filters, `$now ± days/hours/minutes/seconds` against SYSTIMESTAMP only (`filterParser.ts:154-191`). In projections, `$dateToString` gives TO_CHAR with any format (`aggregatePipeline.ts:563-566`), and `$subtract`/`$add` on DATE columns gives day arithmetic |
| ROUND / TRUNC / MOD / ABS / CEIL / FLOOR | Not supported | — |
| DECODE / multi-branch CASE in projections | Not supported | `$cond` has a single WHEN with a single comparison (`:567-573, :636-664`). The filter `$case` produces an invalid predicate (Q-F1). Partial: `$bucket` for numeric ranges |
| NVL2 | Not supported | Partial: `$cond` + `$ifNull` |
| GREATEST / LEAST | Not in SELECT | update `$min`/`$max` only (`updateParser.ts:149-164`) |
| Partition outer join | Not supported | — |
| CROSS APPLY / OUTER APPLY | **Partial** | `$lateralJoin` gives `, LATERAL (...)`, which is inner/CROSS APPLY semantics (`aggregatePipeline.ts:241-253`). There is no OUTER APPLY or LEFT LATERAL |
| Recursive WITH SEARCH / CYCLE | Not supported | `cteBuilder.ts:346`. There is also no depth limit and no recursive filter. CONNECT BY always has NOCYCLE (`oracleAdvanced.ts:110`) |
| JSON_TABLE / JSON_VALUE / JSON_EXISTS / JSON_QUERY | Not supported | `$size` emits `JSON_ARRAY_LENGTH`, which is suspected not to be an Oracle function (Q-P3) |
| REGEXP_SUBSTR / REGEXP_REPLACE / REGEXP_INSTR / REGEXP_COUNT | Not supported | REGEXP_LIKE in filters only (`filterParser.ts:340-351`) |
| Scalar subquery in `$group` / pipeline | Not supported | the only executable scalar subquery is `find().project({$subquery})` (`QueryBuilder.ts:288-341`) |
| HAVING on expressions | **Partial** | `$having` covers only same-stage aggregate aliases with gt/gte/lt/lte/eq/ne, ANDed (`:458-483`). Workaround: a `$match` after `$group` on the UPPER-CASE alias, which gives full filter operators |
| ORDER BY expression | **Partial** | `$addFields {X: expr}` then `$sort {X: ..}` (two CTEs, see Q-P4). `find().sort()` accepts column names only |
| GROUP BY expression (e.g. TRUNC(d,'MM')) | **Partial** | `$addFields {M: {$dateToString: {format:'YYYY-MM', date:'$D'}}}` then `$group {_id:"$M"}`. Not possible directly (`_id` object values must be columns, `:429-439`) |
| Conditional aggregation SUM(CASE ...) | **Partial** | `$addFields {F: {$cond: {if: {c: {$eq: v}}, then: "$amt", else: 0}}}` then `$group {s: {$sum: "$F"}}`. Single-condition only; nested agg args are not allowed (`:506-507` uses `_fieldRef`) |
| Field-to-field comparison in WHERE (`a > b`) | Not supported | values are always bound (`filterParser.ts:272-274`). Partial: `$addFields` with `$subtract` then `$match` |
| Functions on the filter column (UPPER(col)=, TRUNC(d)=) | Not supported | Partial: `$regex` + `$options:'i'` for case-insensitive matching |
| LIKE ... ESCAPE | Not supported | `filterParser.ts:354-357` |
| DISTINCT on multiple columns / with ORDER BY | Partial | `distinct()` covers one column; otherwise `$group` with an `_id` object |
| SELECT from multiple tables with non-equi or extra ON predicates | Not supported | equality-only ON (`joinBuilder.ts:76-93`) |
| More than two set-operation operands | Partial | nest as the second argument only (5b) |
| Analytic functions in `find()` | Not supported | pipeline only |
| Sequences NEXTVAL / CURRVAL in INSERT | Not supported | values are always binds (`OracleCollection.ts:746-750`). Use IDENTITY or `Session.execute` |
| CTAS, GTT, partitioning, synonyms, triggers, comments, PL/SQL | Not supported | — |
| VERSIONS BETWEEN (flashback query) | Not supported | only AS OF (`QueryBuilder.ts:355-363`) |
| SAMPLE BLOCK | Not supported | `QueryBuilder.ts:372` |
| Composite PK / FK with ON DELETE, FK via alterTable | Not supported | section 8 |
| SET TRANSACTION ISOLATION LEVEL / LOCK TABLE | Not supported | `Session.execute` only |

### 10. Quirks

#### Already known (not re-reported)
- `createView` and `createMaterializedView` with a filtered QueryBuilder send binds to DDL (NJS-098): `OracleSchema.ts:315-317, 329`; `performanceUtils.ts:170-172, 220`.
- `insertOne` on a table without an ID column appends `RETURNING "ID"` (ORA-00904): `OracleCollection.ts:767-779`. The same applies to `bulkWrite.insertOne` (`:1397`, no options passed) and to the `insertMany` default `returning=["ID"]` (`:897`).
- `getIndexes` shows SYS_NC... names for DESC columns: `OracleCollection.ts:1766` (reads `USER_IND_COLUMNS.COLUMN_NAME`, not `USER_IND_EXPRESSIONS`).
- `isHealthy` is true after `closePool`: `db.ts:110, 116`.
- `$now` vs TIMESTAMP column session time zone: `filterParser.ts:168-190` (SYSTIMESTAMP is TIMESTAMP WITH TIME ZONE).
- `Session.execute` default outFormat is arrays. It is a passthrough with no default outFormat at `Transaction.ts:128-130`, while its comment at `:127` claims objects.

#### New: suspected, unverified
**Filters**
- **Q-F1** `$case`, `$coalesce`, `$nullif` and operator-form `$subquery` push a **value expression as a WHERE predicate** (`filterParser.ts:393, 408, 413, 416-418`). The result is `WHERE CASE ... END`, which should fail (ORA-00920). The README shows these as filter and projection features (`README.md:1093-1124`).
- **Q-F2** The README projections `{displayName: {$coalesce: [...]}}` and `{$nullif}` in `find().project()` are not implemented. `buildProjection` treats any object value as a column name (`utils.ts:250-252`), and QueryBuilder only handles `$subquery` (`QueryBuilder.ts:292`). The result is `SELECT "displayName"`, which should give ORA-00904.
- **Q-F3** `$inSelect: QueryBuilder` merges the sub-query binds with `Object.assign` (`filterParser.ts:428-429`). Both parsers name binds `where_<field>_<n>` from their own counters starting at 0. With `{STATUS:'a', ID:{$inSelect: other.find({STATUS:'b'})}}`, the outer `where_STATUS_0` is overwritten with `'b'`, which silently gives wrong results.
- **Q-F4** `{f: {$ne: null}}` / `{f: {$eq: null}}` bind NULL, giving `"f" <> :b`, which never matches. Only the plain `{f: null}` gives IS NULL (`filterParser.ts:236 vs 272-274`).
- **Q-F5** JS boolean values are bound as-is (`filterParser.ts:242`). Against NUMBER(1) or CHAR flag columns on DBs older than 23ai this is likely a bind type error. `insertMany` binds booleans as STRING `"true"` (`OracleCollection.ts:946-949`).

**Pipeline**
- **Q-P1** An unknown pipeline expression operator silently falls through to the bare column (`aggregatePipeline.ts:587-588`). For example `{$round: "$x"}` or `{$stdDevPop: "$x"}` in `$addFields` returns the raw `"x"` with no error.
- **Q-P2** Case handling is inconsistent:
  - `$sort` upper-cases keys (`:674`), so sorting on a lowercase-quoted base column fails.
  - `$group`/`$project`/`$addFields`/`$count` aliases are upper-cased, but `$match` (`:154`), `$project {c:1}` (`:692`) and window `orderBy`/`partitionBy` are not.
  - So `$match {total:..}` after `$group {total:..}` fails, and README examples that mix lowercase column names with `$sort` break.
- **Q-P3** `$size` emits `JSON_ARRAY_LENGTH(...)` (`:581-582`). Oracle has no such function (Oracle uses `JSON_VALUE(col, '$.size()')`), so this is likely ORA-00904.
- **Q-P4** `$sort` produces an ORDER BY **inside a CTE** (`:175-182`). The next stage (`SELECT * FROM "stage_n" ...`) does not re-apply it, so the final order is not guaranteed when `$sort` is not the last stage (e.g. `$sort` then `$project`). `$sort`→`$limit` relies on Oracle preserving the inline-view order.
- **Q-P5** `$replaceRoot {newRoot:"$x"}` gives `SELECT "x".* FROM prev`, which is invalid for a column (`:318-321`). `$unwind` is a silent no-op (`:331-338`).
- **Q-P6** `$mul` output is not parenthesised (`:522-524`), unlike `$add`/`$subtract`/`$divide`. Nested arithmetic is impossible anyway: object args become the literal text `[object Object]` (`:629`).
- **Q-P7** `$having` with an unknown operator (e.g. `$in`) silently becomes `=` (`:475`). The same happens in `$cond` (`:653`). `$cond.if` with several fields or operators uses only the first and ignores the rest (`:639-655`).
- **Q-P8** `OracleCollection.aggregate()` starts executing immediately (`OracleCollection.ts:1635`), even when the caller only wants `_buildSQL` (e.g. passing it to `createMaterializedView` or `createView`). The query runs needlessly, and a failure becomes an unhandled rejection.
- **Q-P9** `$facet` UNION ALLs sub-pipelines with different column lists, giving ORA-01789 unless all facets return the same columns (`:299-306`).
- **Q-P10** `$lookup` without `select` gives `prev.*, "as".*`. When followed by another stage, duplicate column names inside a CTE raise ORA-00918; the README documents this, but it is easy to hit. A `$lookup` with `joinType:"self"` drops all previous stages (`joinBuilder.ts:84-86`).

**CTEs and set operations**
- **Q-C1** In `findOneAndUpdate` (standard path, `OracleCollection.ts:448`) and `findOneAndReplace` (`:573`), the UPDATE uses the full `whereClause`, so **every matching row is updated**, not only the one returned. The SELECT/UPDATE pair is also not locked (no FOR UPDATE), despite the "atomic" doc (`:294`). The `after` re-read uses `ID` or the original filter; if the update changed filter columns and there is no ID, it returns another row or null.
- **Q-C2** `withCTE` merges the binds of each CTE QueryBuilder with `Object.assign` (`cteBuilder.ts:166-170`). Two CTEs filtering on the same field name both produce `where_<f>_0`, so the first CTE gets the second CTE's value.
- **Q-C3** `withCTE`:
  - Without `.from()`, the CTE name is used **unquoted** (`cteBuilder.ts:174`), so a mixed-case CTE name will not resolve.
  - A `joinType:"cross"` still emits `ON ...`, which is invalid (`:186`).
  - Sort keys are unqualified, so they are ambiguous after a join.
- **Q-C4** The recursive CTE rewrites the anchor SQL with a regex (`cteBuilder.ts:295-298`). If the anchor has a projection, the regex does not match, which gives a column-count mismatch with the explicit column list. It also uses `USER_TAB_COLUMNS ... UPPER(:t)` (`:356`), which breaks for mixed-case table names.
- **Q-C5** Set operations:
  - A branch QueryBuilder with `.sort()` but no limit emits `(SELECT ... ORDER BY ..) UNION (...)`, which Oracle likely rejects (ORA-00907) (`setOperations.ts:141`).
  - Exclusion projections (`{c:0}`) are not applied to set-operation results, CTEs or `insertFromQuery`; they get `SELECT *`.

**QueryBuilder**
- **Q-Q1** `asOf` combined with `sample`: the SAMPLE branch overwrites `tableRef` and drops AS OF (`QueryBuilder.ts:366-373`). `count()` ignores asOf and sample (`:633`). `asOf.scn` goes through `Number()` and loses precision above 2^53 (`:357`).
- **Q-Q2** Sort direction values other than `-1` (e.g. `"desc"`, `-1n`) silently become ASC (`utils.ts:189` and all sort builders).

**Collection methods**
- **Q-M1** `bulkWrite` always opens `this.db.withTransaction` (`OracleCollection.ts:1386`), **even on a session-bound collection**. Inside `Transaction.withTransaction` it runs on a different connection and commits on its own, and it can block on rows the session has locked.
- **Q-M2** `updateFromJoin` treats **any string value containing "."** as a column reference (`OracleCollection.ts:2245-2248`). Literals like `"v1.2"` or `"a@b.com"` become `"2"` / `"com"` column references. `join.type` is ignored, and the `target` argument can differ from `this.tableName`. The `SET` subquery picks an arbitrary row (`ROWNUM = 1`).
- **Q-M3** `insertFromQuery` rewrites the first `SELECT ... FROM` with a non-greedy regex (`OracleCollection.ts:2165-2168, 2180-2183`). This breaks with `$subquery` projections (whose text contains FROM) and with the forUpdate ROWID form, and it silently discards the user's projection.
- **Q-M4** `merge()` / the `findOneAndUpdate` MERGE fast path: if `whenMatched.$set` includes the ON or filter column, the result is ORA-38104 (`OracleCollection.ts:1863-1868, 331-378`). The fast-path INSERT only includes the filter and `$set` fields, so `$inc` etc. are ignored on insert.
- **Q-M5** Upsert in `updateOne` and `findOneAndUpdate` (standard path) is UPDATE then INSERT, without MERGE or locking. This is a race under concurrency, and `$inc`/`$currentDate` are dropped on insert (`OracleCollection.ts:1206-1222, 412-428`).
- **Q-M6** Metadata lookups use `UPPER(:name)`, so they break on quoted mixed-case table or MV names: `estimatedDocumentCount` (`:656`), `dropIndexes`/`reIndex`/`getIndexes` (`:1735, 1766, 1797`), `insertFromQuery` (`:2172`), `analyze` and `refreshMaterializedView` (`performanceUtils.ts:138, 246`). `dropIndexes` and `reIndex` swallow every error (`:1752, 1812`).
- **Q-M7** `insertMany` binds Date values as `oracledb.DATE` (`OracleCollection.ts:930-931`), which truncates fractional seconds for TIMESTAMP columns. Keys present only in later documents are silently dropped (`:904`).
- **Q-M8** The default index name `IDX_<table>_<cols>` (`OracleCollection.ts:1675-1677`) and the default constraint name (`OracleSchema.ts:202-203`) have no length cap and can exceed 128 bytes (ORA-00972).

**Advanced, schema and DCL**
- **Q-A1** `connectBy` without `$PRIOR` emits `"child" = "parent"` with no PRIOR operator (`oracleAdvanced.ts:104-107`). The JSDoc example `{ prior: "id", to: "manager_id" }` (`OracleCollection.ts:1977, 1987`) would generate `"prior" = "id" AND "to" = "manager_id"`. `startWith` with a correlated `$exists` references `t0`, but there is no `t0` alias in the CONNECT BY query (`oracleAdvanced.ts:89, 126`).
- **Q-S1** `createTable` interpolates `type`, `default` and `check` as raw SQL (`OracleSchema.ts:113, 125, 128`), and `alterTable` does the same for its add/modify types and constraint type (`:182, 194, 205`). These are developer-only injection surfaces.
- **Q-S2** `createTable autoIncrement` is always `GENERATED ALWAYS`, so any explicit ID insert (including `insertFromQuery` with an explicit `columns` list that includes the ID) gives ORA-32795.
- **Q-S3** `CREATE SCHEMA AUTHORIZATION "x"` with no nested CREATE/GRANT statements is likely a syntax error in Oracle (`OracleSchema.ts:409`).
- **Q-S4** `OracleDCL` splices the privilege list into the SQL without validation (`OracleDCL.ts:57, 86`).
- **Q-S5** `createMaterializedView({orReplace})` swallows every DROP error, including privilege errors (`performanceUtils.ts:205-215`).
- **Q-S6** `buildInSelectSubquery` drops the binds (`subqueryBuilder.ts:177-180`). `buildScalarSubquery`, `buildExistsSubquery` and `buildCorrelatedSubquery` silently drop literal (non-`$`) filter values, which widens the subquery (`subqueryBuilder.ts:63-69, 111-117, 156-162`). `buildAnyAllSubquery` splices `comparison` in without validation (`:192`).

---
