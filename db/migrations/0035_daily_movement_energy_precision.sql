-- Daily movement: refuse, never round, active energy with more than one decimal (ADR-0078, ADR-0079).
--
-- Migration 0033 declared active_energy_kcal as numeric(6,1). PostgreSQL applies a column's type modifier when it forms
-- the row, BEFORE any CHECK constraint is evaluated, so a direct write of 412.55 was stored as 412.6 and -0.01 as 0.0,
-- and both passed the range check. The API already refused such values (at most one decimal, 0 to 20,000), so the
-- database and the API disagreed on what a valid value is.
--
-- Fix: the column becomes an unconstrained numeric, which keeps exactly the value written, and two CHECK constraints
-- state the rules the contract states:
--   - daily_movement_active_energy_range (unchanged from 0033): 0 to 20,000 inclusive. numeric orders NaN above every
--     value and Infinity above every finite one, so the upper bound refuses both; -Infinity fails the lower bound.
--   - daily_movement_active_energy_precision (new): the value equals itself rounded to 0.1 kcal, i.e. it has no
--     meaningful digit after the first decimal. 412.5 and 412.50 pass (the same number); 412.55 and -0.01 fail.
--     round() is used only inside the comparison; nothing stored is ever rounded.
--
-- What does not change: stored values (numeric(6,1) -> numeric is binary-coercible, so PostgreSQL keeps every stored
-- value and its scale and does not rewrite the table; existing rows already satisfy both constraints, which ALTER
-- verifies), column privileges (the runtime role's INSERT and UPDATE on the column are kept by ALTER COLUMN TYPE),
-- row-level security, the updated_at trigger (ALTER is not an UPDATE), the erasure trigger and replay, which do not read
-- the column. Wider precision is not stored: a value is still at most 20,000 with one meaningful decimal.
ALTER TABLE daily_movement ALTER COLUMN active_energy_kcal TYPE numeric;

ALTER TABLE daily_movement
  ADD CONSTRAINT daily_movement_active_energy_precision CHECK (
    active_energy_kcal IS NULL OR active_energy_kcal = round(active_energy_kcal, 1)
  );

COMMENT ON COLUMN daily_movement.active_energy_kcal IS
  'Active energy the person reported, in kcal: 0 to 20,000 with at most one meaningful decimal, refused (never rounded) otherwise. Not resting energy, total expenditure or food intake; never estimated from steps.';
