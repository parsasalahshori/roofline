import { Router } from 'express';
import { addNote, NOTE_MAX, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { assertKnownFields, noNul, UUID } from '../validate.ts';

const NOTE_MESSAGE = 'Write a note, up to 2,000 characters.';
const NOTE_FIELDS = ['subjectType', 'subjectId', 'body'] as const;

/** The note's text, trimmed: 1 to NOTE_MAX characters, no NUL. Missing or not text is the same refusal. */
function noteText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || [...text].length > NOTE_MAX || !noNul(text)) throw new AppError(400, NOTE_MESSAGE, 'body');
  return text;
}

/**
 * `/api/notes`: a note on a customer's or a job's timeline (C1 Task 7). Anyone who may see the
 * subject may post; a subject they may not see is a 404.
 */
export function noteRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    const { ctx } = req;
    const { subjectType, subjectId, body } = assertKnownFields(req.body, NOTE_FIELDS, { allowEmpty: true });
    if (subjectType !== 'customer' && subjectType !== 'job') throw new AppError(400, MESSAGES.checkField, 'subjectType');
    const text = noteText(body);
    const id = typeof subjectId === 'string' ? subjectId.toLowerCase() : '';
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);

    const item = await withTenant(pools, ctx, (tx) =>
      addNote(tx, ctx, { subjectType, subjectId: id, body: text }, clock.now()),
    );
    if (item === null) throw new AppError(404, MESSAGES.notFound);
    res.status(201).json(item);
  });

  return router;
}
