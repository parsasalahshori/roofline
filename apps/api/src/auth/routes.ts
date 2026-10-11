import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { insertDefaultSettings, withTenant } from '@roofline/db';
import {
  type AuthCompany,
  type AuthUser,
  createAccount,
  deleteSession,
  deleteSessionForUser,
  EmailInUseError,
  findUserByEmail,
  findUserById,
  getAccountSummary,
  listActiveMemberships,
  listSessions,
  removeAccount,
} from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import type { MailMessage } from '../mailer.ts';
import {
  loginRateLimit,
  resendVerificationRateLimit,
  resetRequestRateLimit,
  signupRateLimit,
} from '../rate-limit.ts';
import { MAX_EMAIL_LENGTH, parse } from '../validate.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.ts';
import { clearSessionCookie, createSession, type SessionInfo, setSessionCookie } from './sessions.ts';
import {
  confirmEmail,
  isResetTokenLive,
  issueToken,
  RESET_PASSWORD_TTL_MS,
  resetPassword,
  VERIFY_EMAIL_TTL_MS,
} from './tokens.ts';

const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 200;

const EMAIL_MESSAGE = 'Please enter a valid email address.';
const PASSWORD_MESSAGE = 'Use at least 10 characters for your password.';
const NAME_MESSAGE = 'Please enter a name.';
const COMPANY_NAME_MESSAGE = 'Please enter your company name.';

/** Emails are stored trimmed and lowercased, at most 254 characters; the same rule is applied wherever one is asked for. */
const email = z
  .string({ error: EMAIL_MESSAGE })
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH, EMAIL_MESSAGE)
  .pipe(z.email(EMAIL_MESSAGE));

const SignupBody = z.object({
  email,
  password: z.string({ error: PASSWORD_MESSAGE }).min(10, PASSWORD_MESSAGE),
  name: z.string({ error: NAME_MESSAGE }).trim().min(1, NAME_MESSAGE).max(MAX_NAME_LENGTH, 'That name is too long.'),
  companyName: z
    .string({ error: COMPANY_NAME_MESSAGE })
    .trim()
    .min(1, COMPANY_NAME_MESSAGE)
    .max(MAX_NAME_LENGTH, 'That company name is too long.'),
});

/** Login only needs something to look up; a malformed address is just an account that does not exist. */
const LoginBody = z.object({
  email: z
    .string({ error: EMAIL_MESSAGE })
    .trim()
    .toLowerCase()
    .min(1, EMAIL_MESSAGE)
    .max(MAX_EMAIL_LENGTH, EMAIL_MESSAGE),
  password: z.string({ error: 'Please enter your password.' }).min(1, 'Please enter your password.'),
});

/** The token from the link in an email. Whether it is any good is decided against the database. */
const linkToken = z.string({ error: MESSAGES.linkIncomplete }).min(1, MESSAGES.linkIncomplete);

const VerifyEmailBody = z.object({ token: linkToken });
const ResetRequestBody = z.object({ email });
const ResetBody = z.object({
  token: linkToken,
  password: z.string({ error: PASSWORD_MESSAGE }).min(10, PASSWORD_MESSAGE),
});

function confirmEmailText(link: string): string {
  return [
    'Welcome to Roofline.',
    '',
    'Please confirm your email address by opening this link:',
    link,
    '',
    "The link works for 7 days. If you didn't create a Roofline account, you can ignore this email.",
  ].join('\n');
}

function resetPasswordText(link: string): string {
  return [
    'We got a request to reset your Roofline password.',
    '',
    'Open this link to choose a new one:',
    link,
    '',
    "The link works for 1 hour and only once. If you didn't ask for this, you can ignore this email and your password will stay the same.",
  ].join('\n');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userBody(user: AuthUser) {
  return { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerifiedAt !== null };
}

function companyBody(company: AuthCompany) {
  return { id: company.id, name: company.name, slug: company.slug, status: company.status };
}

/** The signed-in session, from the sign-in gate. Reaching a handler without one is a wiring bug, answered as a 401. */
function signedIn(req: Request) {
  const session = req.session as Request['session'] | undefined;
  if (!session) throw new AppError(401, MESSAGES.signIn);
  return session;
}

/**
 * `/api/auth/*`: sign-up, login, logout, who-am-i, the user's own sessions, email verification and
 * password reset. Later tasks add Google sign-in and invites to this router.
 */
export function authRoutes(deps: AppDeps, logError: (err: unknown, path: string) => void): Router {
  const { pools, config, clock } = deps;
  const { system } = pools;
  const router = Router();

  /**
   * Starts a session for the user and puts its cookie on the response. If the request already
   * carries a live session, that session is deleted first: its cookie is being replaced, so it
   * would otherwise live on for 30 days where nobody can reach it or see it in their device list.
   */
  async function signIn(req: Request, res: Response, userId: string, companyId: string): Promise<void> {
    const current = req.session as SessionInfo | undefined;
    if (current) await deleteSession(system, current.sessionId);
    const { token } = await createSession(system, {
      userId,
      companyId,
      ua: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
      now: clock.now(),
    });
    setSessionCookie(res, token, config);
  }

  /**
   * Hands an email to the mailer without making the person wait for it. A failure is logged and
   * never shown: the account (or the "if that address has an account" answer) does not depend on
   * the mail provider being up, and the person can ask for another.
   */
  function queueMail(msg: MailMessage, path: string): void {
    const report = (err: unknown) => {
      logError(err, path);
    };
    try {
      deps.mailer.send(msg).catch(report);
    } catch (err) {
      report(err);
    }
  }

  /** Makes a verification link good for 7 days and emails it. Throws if the link cannot be saved. */
  async function sendVerificationEmail(user: Pick<AuthUser, 'id' | 'email'>, path: string): Promise<void> {
    const token = await issueToken(system, user.id, 'verify_email', VERIFY_EMAIL_TTL_MS, clock.now());
    queueMail(
      {
        to: user.email,
        subject: 'Confirm your email for Roofline',
        text: confirmEmailText(`${config.APP_ORIGIN}/verify?token=${token}`),
      },
      path,
    );
  }

  router.post('/signup', signupRateLimit(), async (req, res) => {
    const body = parse(SignupBody, req.body);
    const now = clock.now();
    const passwordHash = await hashPassword(body.password);

    // Step 1, one system transaction: the user, the company and the owner membership.
    // The company's time zone stays at the column default; F3 sets it from the geocoded address.
    let account;
    try {
      account = await createAccount(system, {
        email: body.email,
        name: body.name,
        passwordHash,
        companyName: body.companyName,
        trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS),
      });
    } catch (err) {
      if (err instanceof EmailInUseError) throw new AppError(409, MESSAGES.emailTaken, 'email');
      throw err;
    }

    // Step 2, in the new company's own tenant transaction: its default settings. If this fails the
    // account from step 1 is deleted again, so no half-made account is left to block a retry.
    try {
      await withTenant(
        pools,
        { companyId: account.company.id, userId: null, role: 'system', canApproveSpend: false },
        (tx) => insertDefaultSettings(tx, account.company.id),
      );
    } catch (err) {
      await removeAccount(system, account).catch((cleanupErr: unknown) => {
        logError(cleanupErr, req.path);
      });
      throw err;
    }

    await signIn(req, res, account.user.id, account.company.id);

    // The account exists and they are signed in; a verification email that cannot be made or sent
    // must not undo that. They can ask for another from the app (resend-verification).
    await sendVerificationEmail(account.user, req.path).catch((err: unknown) => {
      logError(err, req.path);
    });
    res.status(201).json({ user: userBody(account.user), company: companyBody(account.company) });
  });

  router.post('/login', loginRateLimit(), async (req, res) => {
    const body = parse(LoginBody, req.body);
    const user = await findUserByEmail(system, body.email);
    // Always spend one scrypt, even for an unknown email or an account with no password, so the
    // response time does not tell a caller which emails have accounts.
    const matches = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user?.passwordHash || !matches) throw new AppError(401, MESSAGES.badLogin);

    const [company] = await listActiveMemberships(system, user.id);
    if (!company) throw new AppError(403, MESSAGES.noAccess);

    await signIn(req, res, user.id, company.id);
    res.json({ user: userBody(user), company: companyBody(company) });
  });

  router.post('/verify-email', async (req, res) => {
    const body = parse(VerifyEmailBody, req.body);
    if (!(await confirmEmail(system, body.token, clock.now()))) throw new AppError(400, MESSAGES.linkUsed);
    res.json({ ok: true });
  });

  router.post('/resend-verification', resendVerificationRateLimit(), async (req, res) => {
    const session = signedIn(req);
    if (!session.emailVerified) {
      const user = await findUserById(system, session.userId);
      if (user && user.emailVerifiedAt === null) await sendVerificationEmail(user, req.path);
    }
    res.json({ ok: true });
  });

  router.post('/reset-request', ...resetRequestRateLimit(), async (req, res) => {
    const body = parse(ResetRequestBody, req.body);
    const user = await findUserByEmail(system, body.email);
    // The same answer whether or not the address has an account (and the mail goes out in the
    // background), so neither the response nor its timing says which addresses are registered.
    if (user) {
      const token = await issueToken(system, user.id, 'reset_password', RESET_PASSWORD_TTL_MS, clock.now());
      queueMail(
        {
          to: user.email,
          subject: 'Reset your Roofline password',
          text: resetPasswordText(`${config.APP_ORIGIN}/reset?token=${token}`),
        },
        req.path,
      );
    }
    res.json({ ok: true });
  });

  router.post('/reset', async (req, res) => {
    // Checked before anything is spent: a short password does not use the link up, and a dead
    // link does not cost a password hash.
    const body = parse(ResetBody, req.body);
    if (!(await isResetTokenLive(system, body.token, clock.now()))) throw new AppError(400, MESSAGES.linkUsed);
    const passwordHash = await hashPassword(body.password);
    const userId = await resetPassword(system, body.token, passwordHash, clock.now());
    if (userId === null) throw new AppError(400, MESSAGES.linkUsed);

    // The reset deleted every session of that user. If this request carried one of them, the
    // browser's cookie is dead now: clear it. Someone signed in as another user keeps theirs.
    const current = req.session as SessionInfo | undefined;
    if (current?.userId === userId) clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.post('/logout', async (req, res) => {
    await deleteSession(system, signedIn(req).sessionId);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => {
    const session = signedIn(req);
    const summary = await getAccountSummary(system, session.userId, session.companyId);
    if (!summary) throw new AppError(401, MESSAGES.signIn);
    res.json({
      user: userBody(summary.user),
      company: companyBody(summary.company),
      role: summary.role,
      companies: summary.companies,
    });
  });

  router.get('/sessions', async (req, res) => {
    const session = signedIn(req);
    const rows = await listSessions(system, session.userId, clock.now());
    res.json({
      sessions: rows.map((s) => ({
        id: s.id,
        current: s.id === session.sessionId,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
      })),
    });
  });

  router.delete('/sessions/:id', async (req, res) => {
    const session = signedIn(req);
    const id = req.params.id?.toLowerCase();
    // Someone else's session, an unknown one and a malformed id all look the same.
    const removed = typeof id === 'string' && UUID.test(id) && (await deleteSessionForUser(system, session.userId, id));
    if (!removed) throw new AppError(404, MESSAGES.notFound);
    if (id === session.sessionId) clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  return router;
}
