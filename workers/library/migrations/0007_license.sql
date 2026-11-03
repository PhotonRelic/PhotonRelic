-- American spelling throughout (owner's rule, 2026-11-03): the rights column
-- added by 0004 as `licence` is `license` from here on. A rename keeps every
-- value; the form field, the filing preview and the audit diff use the new
-- name in the same change. Nothing else here: additive, nothing rewritten.

ALTER TABLE assets RENAME COLUMN licence TO license;
