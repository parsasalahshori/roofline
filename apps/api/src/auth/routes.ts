import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { audit, insertDefaultSettings, withTenant } from '@roofline/db';
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
  switchSessionCompany,
} from '@roofline/db/system';
import type { AppDeps } from '../app.ts';
import { createBackground } from '../background.ts';
import { AppError, MESSAGES } from '../errors.ts';
import {
  acceptInviteRateLimit,
  googleRateLimit,
  loginRateLimit,
  resendVerificationRateLimit,
  resetRequestRateLimit,
  signupRateLimit,
} from '../rate-limit.ts';
import { EMAIL_MESSAGE, emailField as email, MAX_EMAIL_LENGTH, parse } from '../validate.ts';
import { type GoogleClaims, GoogleUnavailableError, isGoogleAuthoritative } from './google.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.ts';
import {
  clearSessionCookie,
  createSession,
  createSessionIfPasswordUnchanged,
  type SessionInfo,
  setSessionCookie,
} from './sessions.ts';
import {
  type AcceptedInvite,
  type AcceptProof,
  acceptInvite,
  AlreadyMemberError,
  type InviteToAccept,
  InviteUnavailableError,
  lookUpInvite,
  SignInRequiredError,
} from './team-store.ts';
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

const PASSWORD_MESSAGE = 'Use at least 10 characters for your password.';
const NAME_MESSAGE = 'Please enter a name.';
const COMPANY_NAME_MESSAGE = 'Please enter your company name.';

const companyName = z
  .string({ error: COMPANY_NAME_MESSAGE })
  .trim()
  .min(1, COMPANY_NAME_MESSAGE)
  .max(MAX_NAME_LENGTH, 'That company name is too long.');

const passwordField = z.string({ error: PASSWORD_MESSAGE }).min(10, PASSWORD_MESSAGE);
const nameField = z
  .string({ error: NAME_MESSAGE })
  .trim()
  .min(1, NAME_MESSAGE)
  .max(MAX_NAME_LENGTH, 'That name is too long.');

const SignupBody = z.object({
  email,
  password: passwordField,
  name: nameField,
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
  password: passwordField,
});

/**
 * Accepting an invite. Only the token is checked up front. Name and password are only needed to
 * make a NEW account (checked then, with the same rules as sign-up), and a person who is already
 * signed in, or who has an account, needs neither. `googleCredential` replaces both.
 */
const AcceptInviteBody = z.object({
  token: linkToken,
  googleCredential: z.string({ error: MESSAGES.googleFailed }).min(1, MESSAGES.googleFailed).optional(),
  name: z.unknown().optional(),
  password: z.unknown().optional(),
});

const NewInviteeBody = z.object({ name: nameField, password: passwordField });

const SwitchCompanyBody = z.object({ companyId: z.string({ error: MESSAGES.checkField }) });

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
 * verification, password reset, invite acceptance and the company switcher.
 */
export function authRoutes(deps: AppDeps, logError: (err: unknown, path: string) => void): Router {
  const { pools, config, clock } = deps;
  const { system } = pools;
  const router = Router();

  /**
   * Starts a session for the user and puts its cookie on the response. If the request already
   * carries a live session, that session is deleted too: its cookie is being replaced, so it
   * would otherwise live on for 30 days where nobody can reach it or see it in their device list.
   * `passwordChecked` is for password login only: the hash the password was verified against. The
   * session is then saved only if the user still has that hash (a Google hand-over or a password
   * reset that committed since has changed it), else this is the ordinary bad-login 401, and the
   * session the browser already had is left alone.
   */
  async function signIn(
    req: Request,
    res: Response,
    userId: string,
    companyId: string,
    passwordChecked?: string,
  ): Promise<void> {
    const input = { userId, companyId, ua: req.get('user-agent') ?? null, ip: req.ip ?? null, now: clock.now() };
    const created =
      passwordChecked === undefined
        ? await createSession(system, input)
        : await createSessionIfPasswordUnchanged(system, input, passwordChecked);
    if (!created) throw new AppError(401, MESSAGES.badLogin);
    const current = req.session as SessionInfo | undefined;
    if (current) await deleteSession(system, current.sessionId);
    setSessionCookie(res, created.token, config);
  }

  const { background, queueMail } = createBackground(deps, logError);

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

    await signIn(req, res, user.id, company.id, user.passwordHash);
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
   * 3. A user with this email (case-insensitive) → only if Google is the authority for the address
   *    (Gmail, or the caller's Workspace domain is the email's domain; see `isGoogleAuthoritative`),
   *    connect this Google account to them; otherwise 409 and nothing changes. If their
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
        // Linking (and the hand-over of an unconfirmed account) is only for an address Google is the
        // authority for. For any other, "email_verified" does not show the caller owns it, so the
        // existing account is left exactly as it is.
        if (!isGoogleAuthoritative(claims)) throw new AppError(409, MESSAGES.googleEmailInUse);
        if (byEmail.googleSub !== null) throw new AppError(409, MESSAGES.googleOtherAccount);
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

  /**
   * Who the person accepting an invite is, as `acceptInvite` needs it. Checks everything that is
   * slow or can be refused before the transaction (which only re-checks what it must).
   * - A user with the invite's address exists: the caller must show they are that user, in this
   *   order: a live session of theirs; a Google account connected to them; their password. Else 401.
   *   A Google credential for another address (and not connected to them) is a 400 instead: wrong address.
   * - No such user: a new account is made. With Google, the verified Google email must be the invited one.
   *   With a password, name and password are validated like sign-up's.
   */
  async function inviteIdentity(
    req: Request,
    invite: InviteToAccept,
    body: z.infer<typeof AcceptInviteBody>,
    claims: GoogleClaims | undefined,
  ): Promise<{ newUser: { name: string; passwordHash: string | null; googleSub: string | null } | null; proof: AcceptProof | null }> {
    const existing = await findUserByEmail(system, invite.email);
    const current = req.session as SessionInfo | undefined;
    const claimedEmail = claims?.email.trim().toLowerCase();

    if (existing) {
      if (current?.userId === existing.id) {
        return { newUser: null, proof: { via: 'session', sessionId: current.sessionId } };
      }
      if (claims) {
        if (existing.googleSub !== null && existing.googleSub === claims.sub) {
          return { newUser: null, proof: { via: 'google', googleSub: claims.sub } };
        }
        throw new AppError(
          claimedEmail === invite.email ? 401 : 400,
          claimedEmail === invite.email ? MESSAGES.inviteSignIn : MESSAGES.inviteWrongGoogle,
        );
      }
      if (typeof body.password === 'string' && body.password !== '' && existing.passwordHash) {
        if (await verifyPassword(body.password, existing.passwordHash)) {
          return { newUser: null, proof: { via: 'password', passwordHash: existing.passwordHash } };
        }
      }
      throw new AppError(401, MESSAGES.inviteSignIn);
    }

    if (claims) {
      if (claimedEmail !== invite.email) throw new AppError(400, MESSAGES.inviteWrongGoogle);
      if (!claims.emailVerified) throw new AppError(400, MESSAGES.googleUnverified);
      if (await findUserByGoogleSub(system, claims.sub)) throw new AppError(409, MESSAGES.googleAlreadyUsed);
      return {
        newUser: {
          name: claims.name.trim().slice(0, MAX_NAME_LENGTH) || invite.email,
          passwordHash: null,
          googleSub: claims.sub,
        },
        proof: null,
      };
    }
    const person = parse(NewInviteeBody, { name: body.name, password: body.password });
    return { newUser: { name: person.name, passwordHash: await hashPassword(person.password), googleSub: null }, proof: null };
  }

  /** Accepts the invite, looking again once if someone made the account since we looked (a race). */
  async function acceptWithIdentity(
    req: Request,
    invite: InviteToAccept,
    body: z.infer<typeof AcceptInviteBody>,
    claims: GoogleClaims | undefined,
    retry = true,
  ): Promise<AcceptedInvite & { sessionToken: string | null }> {
    const identity = await inviteIdentity(req, invite, body, claims);
    try {
      return await acceptInvite(system, {
        token: body.token,
        now: clock.now(),
        ...identity,
        request: {
          ua: req.get('user-agent') ?? null,
          ip: req.ip ?? null,
          carriedSessionId: (req.session as SessionInfo | undefined)?.sessionId ?? null,
        },
      });
    } catch (err) {
      if (err instanceof InviteUnavailableError) throw new AppError(400, MESSAGES.inviteGone);
      if (err instanceof AlreadyMemberError) throw new AppError(409, MESSAGES.alreadyMember);
      if (err instanceof SignInRequiredError) throw new AppError(401, MESSAGES.inviteSignIn);
      if (err instanceof GoogleSubInUseError) throw new AppError(409, MESSAGES.googleAlreadyUsed);
      if (err instanceof EmailInUseError && retry) return acceptWithIdentity(req, invite, body, claims, false);
      throw err;
    }
  }

  router.post('/accept-invite', ...acceptInviteRateLimit(), async (req, res) => {
    const body = parse(AcceptInviteBody, req.body);
    // A dead link is refused before anything is spent on it (a Google check, a password hash).
    const invite = await lookUpInvite(system, body.token, clock.now());
    if (!invite) throw new AppError(400, MESSAGES.inviteGone);

    let claims: GoogleClaims | undefined;
    if (body.googleCredential !== undefined) {
      if (!config.GOOGLE_CLIENT_ID) throw new AppError(503, MESSAGES.googleNotSetUp);
      try {
        claims = await deps.google.verify(body.googleCredential);
      } catch (err) {
        if (err instanceof GoogleUnavailableError) logError(err.cause ?? err, req.path);
        throw err;
      }
    }

    const accepted = await acceptWithIdentity(req, invite, body, claims);
    const { user, company, role } = accepted;

    // The membership is saved; the audit row goes in the invited company's own tenant context,
    // after the system transaction. If it cannot be written the person is still in (telling them
    // it failed would be wrong, and the link is already used), so it is logged.
    const ctx = { companyId: company.id, userId: user.id, role, canApproveSpend: false } as const;
    await withTenant(deps.pools, ctx, (tx) =>
      audit(tx, ctx, {
        action: 'invite.accept',
        targetType: 'invite',
        targetId: accepted.inviteId,
        after: { email: accepted.email, role, membershipId: accepted.membershipId },
        ip: req.ip ?? null,
        at: clock.now(),
      }),
    ).catch((err: unknown) => {
      logError(err, req.path);
    });

    // The session was saved by the acceptance itself, in its transaction (see `acceptInvite`).
    // All that is left is the cookie: a new one, unless the person's own live session was moved to
    // the invited company, in which case the browser already has it.
    if (accepted.sessionToken !== null) setSessionCookie(res, accepted.sessionToken, config);
    res.json(await accountBody(user.id, company.id));
  });

  router.post('/logout', async (req, res) => {
    await deleteSession(system, signedIn(req).sessionId);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  /** What `/me`, accepting an invite and switching company all answer: who, where, in which role, and every company they can switch to. */
  async function accountBody(userId: string, companyId: string) {
    const summary = await getAccountSummary(system, userId, companyId);
    if (!summary) throw new AppError(401, MESSAGES.signIn);
    return {
      user: userBody(summary.user),
      company: companyBody(summary.company),
      role: summary.role,
      companies: summary.companies,
    };
  }

  router.get('/me', async (req, res) => {
    const session = signedIn(req);
    res.json(await accountBody(session.userId, session.companyId));
  });

  router.post('/switch-company', async (req, res) => {
    const session = signedIn(req);
    const body = parse(SwitchCompanyBody, req.body);
    const companyId = body.companyId.toLowerCase();
    // A company the user is not an active member of, one that does not exist and a malformed id all look the same.
    const moved =
      UUID.test(companyId) &&
      (await switchSessionCompany(system, { sessionId: session.sessionId, userId: session.userId, companyId }));
    if (!moved) throw new AppError(404, MESSAGES.notFound);
    res.json(await accountBody(session.userId, companyId));
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
