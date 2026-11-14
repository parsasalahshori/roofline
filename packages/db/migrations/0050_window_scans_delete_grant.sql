-- A homeowner who deletes a window deletes its scans with it, so the scans' photos stop counting against the request's
-- photo cap and no orphan scan is left in the review queue (0046 granted no DELETE; this is the one use of it:
-- deleteWindowScansForWindow). app_system still gets nothing.
GRANT DELETE ON window_scans TO app_tenant;
