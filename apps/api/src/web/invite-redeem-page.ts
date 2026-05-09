import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  Argon2Semaphore,
  generateSessionToken,
  hashInviteToken,
  hashPassword,
  hashSessionToken,
} from '@mediacompressor/auth';

const TokenParams = z.object({ token: z.string().min(8) });
const InviteForm = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  _csrf: z.string().min(1),
});

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const inviteRedeemPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma, config } = app.deps;
  const invitePepper = Buffer.from(config.SESSION_SECRET);
  const sessionPepper = Buffer.from(config.SESSION_SECRET);
  // WC2: argon2 hashes are 100+ MB / ~200 ms each; without a semaphore N
  // concurrent invite-redeems crash the API. Mirror Plan-3's loginRoutes pattern.
  const argonSem = new Argon2Semaphore(config.ARGON2_MAX_CONCURRENCY);

  app.get('/invites/:token', { schema: { params: TokenParams } }, async (req, reply) => {
    // WC7: form page must not be cached — stale CSRF would 403 on browser-back,
    // and CSRF tokens shouldn't persist on shared workstations.
    reply.header('cache-control', 'no-store, max-age=0');
    const { token } = req.params as z.infer<typeof TokenParams>;
    const tokenHash = hashInviteToken(token, invitePepper);
    const invite = await prisma.invite.findUnique({ where: { token: tokenHash } });
    if (!invite) {
      // 404 stays in the `common` namespace — the 404 template (Task 2) renders
      // its own title/body via i18n; the title prop is overridden by the
      // template if absent, but we keep an EN fallback for layout consistency.
      return reply.code(404).view('404', { title: 'Not found', path: req.url });
    }
    if (invite.consumedAt) {
      return reply.code(410).view('invite-redeem', {
        title: req.t('invite_redeem_title', undefined, 'auth'),
        consumed: true,
      });
    }
    if (invite.expiresAt < new Date()) {
      return reply.code(410).view('invite-redeem', {
        title: req.t('invite_redeem_title', undefined, 'auth'),
        expired: true,
      });
    }
    return reply.view('invite-redeem', {
      title: req.t('invite_redeem_title', undefined, 'auth'),
      token,
      email: invite.email ?? '',
      _csrfField: reply.renderCsrfField(),
    });
  });

  app.post(
    '/invites/:token',
    { schema: { params: TokenParams }, preHandler: app.csrfProtection },
    async (req, reply) => {
      const { token } = req.params as z.infer<typeof TokenParams>;
      const parsed = InviteForm.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).view('invite-redeem', {
          title: req.t('invite_redeem_title', undefined, 'auth'),
          token,
          flash: {
            level: 'error',
            message: req.t('invite_redeem_flash_password_too_short', undefined, 'auth'),
          },
          _csrfField: reply.renderCsrfField(),
          email:
            typeof (req.body as Record<string, unknown> | undefined)?.email === 'string'
              ? ((req.body as Record<string, string>).email)
              : '',
        });
      }
      const tokenHash = hashInviteToken(token, invitePepper);
      const { email, password } = parsed.data;

      // WC3 — atomic claim phase: try to mark the invite consumed in ONE
      // updateMany so two racing POSTs cannot both observe consumedAt=null.
      // Email-binding check happens via a follow-up `findUnique` AFTER claim
      // success; if the binding fails, we revert the claim. This narrows the
      // race window to "claim succeeded but email-mismatch" — single-actor,
      // not exploitable for hijack.
      const claimedAt = new Date();
      const claim = await prisma.invite.updateMany({
        where: {
          token: tokenHash,
          consumedAt: null,
          expiresAt: { gt: claimedAt },
        },
        data: { consumedAt: claimedAt },
      });
      if (claim.count === 0) {
        // Either token unknown OR already consumed OR expired — distinguish via
        // a follow-up lookup.
        const probe = await prisma.invite.findUnique({ where: { token: tokenHash } });
        if (!probe) {
          return reply.code(404).view('404', { title: 'Not found', path: req.url });
        }
        return reply.code(410).view('invite-redeem', {
          title: req.t('invite_redeem_title', undefined, 'auth'),
          consumed: probe.consumedAt != null,
          expired: probe.consumedAt == null && probe.expiresAt < new Date(),
        });
      }

      // Claim succeeded — fetch the row to validate email-binding.
      const invite = await prisma.invite.findUnique({ where: { token: tokenHash } });
      if (!invite) {
        // Should not happen — the row exists since updateMany hit it. Treat as 500.
        throw new Error('invite vanished after successful updateMany');
      }
      if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
        // Revert the claim: undo the consumedAt write so the legitimate
        // recipient can still redeem.
        await prisma.invite.update({
          where: { id: invite.id },
          data: { consumedAt: null },
        });
        // Email-mismatch flash is OUTSIDE the plan's 16-key list; per WC-i18n-19
        // (Plan 8e Rev. 2.1) only listed keys are migrated this task. The
        // English literal stays — Plan-8f follow-up will add this key.
        return reply.code(400).view('invite-redeem', {
          title: req.t('invite_redeem_title', undefined, 'auth'),
          token,
          flash: { level: 'error', message: 'This invite is bound to a different email' },
          _csrfField: reply.renderCsrfField(),
          email,
        });
      }

      // WC2: hash password OUTSIDE the transaction, behind the semaphore.
      // Argon2 is 200ms+ CPU-bound — keeping it out of $transaction prevents
      // Prisma-pool exhaustion when many redeems land at once.
      const passwordHash = await argonSem.run(() => hashPassword(password));
      const sessionToken = generateSessionToken();
      const sessionHash = hashSessionToken(sessionToken, sessionPepper);

      try {
        await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { email, passwordHash, invitedById: invite.createdById },
            select: { id: true },
          });
          await tx.invite.update({
            where: { id: invite.id },
            data: { consumedById: user.id },
          });
          await tx.session.create({
            data: {
              userId: user.id,
              tokenHash: sessionHash,
              userAgent: req.headers['user-agent'] ?? '',
              ip: req.ip,
              expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
          });
        });
      } catch (err) {
        // Revert the claim on any DB failure (e.g. P2002 email-already-registered)
        // so the legitimate recipient can retry with a different email.
        // C3-Rev2: log explicitly on revert-failure — silent-swallow leaves the
        // invite stuck-consumed and the legitimate recipient locked out without
        // any log trail. Plan 10 alerts on this Pino line + provides an admin
        // tool to manually re-set consumedAt=null on stuck invites.
        await prisma.invite
          .update({ where: { id: invite.id }, data: { consumedAt: null } })
          .catch((revertErr: unknown) => {
            app.log.error(
              { inviteId: invite.id, originalErr: err, revertErr },
              'invite-redeem revert failed — invite consumedAt stuck non-null; legitimate recipient locked out',
            );
          });
        if ((err as { code?: string }).code === 'P2002') {
          // Email-already-registered flash is OUTSIDE the plan's 16-key list;
          // per WC-i18n-19 only listed keys are migrated this task. EN literal
          // stays — Plan-8f follow-up will add this key.
          return reply.code(409).view('invite-redeem', {
            title: req.t('invite_redeem_title', undefined, 'auth'),
            token,
            flash: { level: 'error', message: 'Email is already registered' },
            _csrfField: reply.renderCsrfField(),
            email,
          });
        }
        throw err;
      }

      reply.setCookie('mc_session', sessionToken, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      });
      // WC4: rotate mc_csrf after successful auth-state transition. MUST be
      // called BEFORE reply.send() — send() commits the response.
      reply.generateCsrf();
      return reply.code(303).header('location', '/').send();
    },
  );
};
