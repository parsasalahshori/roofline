import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { insertDefaultSettings, withTenant } from '@roofline/db';
import {
  type AuthCompany,
  type AuthUser,
  createAccount,
  type CreatedAccount,
  deleteSession,
  deleteSessionForUser,
  EmailInUseError,
  findUserByEmail,
  findUserByGoogleSub,
  findUserById,
  getAccountSummary,
  GoogleSubInUseError,
  linkGoogleAccount,
  listActiveMemberships,
  listSessions,
  type NewAccount,
  removeAccount,
} from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import type { MailMessage } from '../mailer.ts';
import {
  googleRateLimit,
  loginRateLimit,
  resendVerificationRateLimit,
  resetRequestRateLimit,
  signupRateLimit,
} from '../rate-limit.ts';
import { MAX_EMAIL_LENGTH, parse } from '../validate.ts';
import { type GoogleClaims, GoogleUnavailableError } from './google.ts';
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

const companyName = z
  .string({ error: COMPANY_NAME_MESSAGE })
  .trim()
  .min(1, COMPANY_NAME_MESSAGE)
  .max(MAX_NAME_LENGTH, 'That company name is too long.');

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
  companyName,
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

/**
 * Google sign-in. The company name is only needed when the person turns out to be new, which is
 * not known until the credential has been checked, so it is validated then (see `googleAccount`),
 * with the same rule and message as sign-up.
 */
const GoogleBody = z.object({
  credential: z.string({ error: MESSAGES.googleFailed }).min(1, MESSAGES.googleFailed),
  companyName: z.unknown().optional(),
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
 * `/api/auth/*`: sign-up, login, Google sign-in, logout, who-am-i, the user's own sessions, email
 * verification and password reset. A later task adds invites to this router.
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
   * Runs `work` after the request has been answered: the caller does not await it. A failure is
   * logged and goes no further (it would otherwise be an unhandled rejection, which ends the
   * process). `deps.onBackgroundTask` lets tests wait for it.
   */
  function background(path: string, work: () => Promise<void>): void {
    const task = (async () => {
      try {
        await work();
      } catch (err) {
        try {
          logError(err, path);
        } catch {
          // A failing logger must not turn into an unhandled rejection.
        }
      }
    })();
    deps.onBackgroundTask?.(task);
  }

  /**
   * Hands an email to the mailer in the background. A failure is logged and never shown: the
   * account (or the "if that address has an account" answer) does not depend on the mail provider
   * being up, and the person can ask for another.
   */
  function queueMail(msg: MailMessage, path: string): void {
    background(path, () => deps.mailer.send(msg));
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

  /**
   * Makes a user and their own new company, with everything a company starts with, and signs
   * nobody in. Used by sign-up and by Google sign-in, so slugs, the trial and the cleanup are the
   * same for both.
   * - Step 1, one system transaction: the user, the company and the owner membership. The company's
   *   time zone stays at the column default; F3 sets it from the geocoded address.
   * - Step 2, in the new company's own tenant transaction: its default settings. If this fails the
   *   account from step 1 is deleted again, so no half-made account is left to block a retry.
   * Throws EmailInUseError / GoogleSubInUseError when the email / Google account already has a user.
   */
  async function createCompanyAccount(input: Omit<NewAccount, 'trialEndsAt'>, path: string): Promise<CreatedAccount> {
    const account = await createAccount(system, {
      ...input,
      trialEndsAt: new Date(clock.now().getTime() + TRIAL_DAYS * DAY_MS),
    });
    try {
      await withTenant(
        pools,
        { companyId: account.company.id, userId: null, role: 'system', canApproveSpend: false },
        (tx) => insertDefaultSettings(tx, account.company.id),
      );
    } catch (err) {
      await removeAccount(system, account).catch((cleanupErr: unknown) => {
        logError(cleanupErr, path);
      });
      throw err;
    }
    return account;
  }

  router.post('/signup', signupRateLimit(), async (req, res) => {
    const body = parse(SignupBody, req.body);
    const passwordHash = await hashPassword(body.password);

    let account;
    try {
      account = await createCompanyAccount(
        { email: body.email, name: body.name, passwordHash, companyName: body.companyName },
        req.path,
      );
    } catch (err) {
      if (err instanceof EmailInUseError) throw new AppError(409, MESSAGES.emailTaken, 'email');
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

  /** The company a user signs in to: their oldest active membership, as in password login. None means no access. */
  async function firstActiveCompany(userId: string): Promise<AuthCompany> {
    const [company] = await listActiveMemberships(system, userId);
    if (!company) throw new AppError(403, MESSAGES.noAccess);
    return company;
  }

  /**
   * Decides who a verified Google credential is, in this order:
   * 1. A user already connected to this Google account (`sub`) → that user. Their stored email is
   *    left alone even if the Google email has changed: the sub is the identity, the email is not.
   * 2. Google has not confirmed the email → refused. This comes before any email lookup, so an
   *    unconfirmed address can never be linked to (or used to probe for) an existing account.
   * 3. A user with this email (case-insensitive) → connect this Google account to them. If their
   *    email was never confirmed, the account is also handed over (password, sessions and unused
   *    links removed; see `linkGoogleAccount`), because Google has shown the address is the
   *    caller's and the account may have been made by someone else. A confirmed account keeps its
   *    password. Refused when they are already connected to a different
   *    Google account: a second Google account that merely shares the address does not take over.
   *    (Already connected to this very account means another copy of this request just did it.)
   * 4. Otherwise a new person → a new verified user with no password, and their own company
   *    (`companyName` required).
   * Someone with no active membership is a 403 before anything is written. The two races
   * (the same credential sent twice at once, or another request connecting the account first)
   * show up as GoogleSubInUseError / EmailInUseError / a link that did not apply; the answer is to
   * look again, once, and the second look finds what the winner made.
   */
  async function googleAccount(
    claims: GoogleClaims,
    rawCompanyName: unknown,
    path: string,
    retry = true,
  ): Promise<{ user: AuthUser; company: AuthCompany }> {
    const bySub = await findUserByGoogleSub(system, claims.sub);
    if (bySub) return { user: bySub, company: await firstActiveCompany(bySub.id) };

    if (!claims.emailVerified) throw new AppError(400, MESSAGES.googleUnverified);

    const googleEmail = claims.email.trim().toLowerCase();
    try {
      const byEmail = await findUserByEmail(system, googleEmail);
      if (byEmail) {
        // Connected to this very Google account a moment ago, by another copy of this request.
        if (byEmail.googleSub === claims.sub) return { user: byEmail, company: await firstActiveCompany(byEmail.id) };
        if (byEmail.googleSub !== null) throw new AppError(409, MESSAGES.googleOtherAccount, 'email');
        const company = await firstActiveCompany(byEmail.id);
        const linked = await linkGoogleAccount(system, byEmail.id, claims.sub, clock.now());
        if (linked) return { user: linked, company };
        // Connected to a Google account between our lookup and the link.
      } else {
        const { companyName: name } = parse(z.object({ companyName }), { companyName: rawCompanyName });
        const account = await createCompanyAccount(
          {
            email: googleEmail,
            name: claims.name.trim().slice(0, MAX_NAME_LENGTH) || googleEmail,
            passwordHash: null,
            googleSub: claims.sub,
            emailVerifiedAt: clock.now(),
            companyName: name,
          },
          path,
        );
        return { user: account.user, company: account.company };
      }
    } catch (err) {
      if (!(err instanceof EmailInUseError || err instanceof GoogleSubInUseError)) throw err;
    }
    if (!retry) throw new Error('Google sign-in kept racing with another request.');
    return googleAccount(claims, rawCompanyName, path, false);
  }

  router.post('/google', googleRateLimit(), async (req, res) => {
    if (!config.GOOGLE_CLIENT_ID) throw new AppError(503, MESSAGES.googleNotSetUp);
    const body = parse(GoogleBody, req.body);
    let claims: GoogleClaims;
    try {
      claims = await deps.google.verify(body.credential);
    } catch (err) {
      // Google being unreachable is not the caller's doing: the response is the plain 503, and the
      // real cause (a timeout, a network error) goes to the log.
      if (err instanceof GoogleUnavailableError) logError(err.cause ?? err, req.path);
      throw err;
    }
    const { user, company } = await googleAccount(claims, body.companyName, req.path);
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

  router.post('/reset-request', ...resetRequestRateLimit(), (req, res) => {
    // Only the input is checked before answering, so a malformed email is a 400 whoever it names.
    const body = parse(ResetRequestBody, req.body);
    // Then the answer goes out at once, and everything that depends on whether the address has an
    // account (the lookup, the token, the email, and any failure of them) happens afterwards.
    // Known and unknown addresses therefore take the same path to the same response, with the same
    // timing; nothing here can make one of them slower or fail where the other does not.
    res.json({ ok: true });
    background(req.path, async () => {
      const user = await findUserByEmail(system, body.email);
      if (!user) return;
      const token = await issueToken(system, user.id, 'reset_password', RESET_PASSWORD_TTL_MS, clock.now());
      queueMail(
        {
          to: user.email,
          subject: 'Reset your Roofline password',
          text: resetPasswordText(`${config.APP_ORIGIN}/reset?token=${token}`),
        },
        req.path,
      );
    });
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
