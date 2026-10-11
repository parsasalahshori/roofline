/*
 * Source text for boundaries.test.ts: the test lints this file's contents as if it lived at several
 * different paths in the repo, to prove which folders may import @roofline/db/system and which may
 * not. It sits under test/, where the rule is off, so linting it where it really is stays clean.
 */
import { findCompanyBySlug } from '@roofline/db/system';

export const probe = findCompanyBySlug;
