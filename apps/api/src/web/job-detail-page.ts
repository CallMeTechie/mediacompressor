import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { redactErrorMessage } from './error-redact.js';

/**
 * Plan 8b Task 3: GET /jobs/:id — single-job HTML detail page.
 *
 * Rendered ONCE per request — no SSE in this task (Task 4 layers it on top via
 * htmx-ext-sse + a 30s-watchdog → polling fallback).
 *
 * - 404 NOT FOUND on foreign jobs (no existence-leak; mirrors the JSON GET
 *   /api/v1/jobs/:id behaviour).
 * - Cache-Control: no-store — post-login HTML carries user-bound data.
 * - Cancel-form rendered iff `status NOT IN terminal[]`.
 * - Download link rendered iff `status === 'succeeded'`.
 * - C1-LI: errorMessage is passed through `redactErrorMessage()` so worker
 *   internals (paths, ffmpeg-stderr) never reach the user.
 * - C6-LI: optional `?cancelflash=<key>` query param surfaces a flash banner
 *   via a FLASH_MAP allowlist. Unknown keys are dropped (allowlist-gate
 *   prevents arbitrary text injection through the URL).
 *
 * Task 4: when `?fragment=1` is set, render only the `job-detail-status`
 * partial via `reply.viewFragment(...)` — the HTMX-polling fallback path swaps
 * this fragment back into the SSE-target div without the global base.hbs
 * layout. Per Rev. 2.2, `reply.view(..., { layout: undefined })` is silently
 * broken with a globally-configured layout; the standalone-handlebars
 * `viewFragment` decorator is the supported workaround.
 */

const Params = z.object({ id: z.string().uuid() });

const QuerySchema = z.object({
  fragment: z.coerce.boolean().default(false),
  cancelflash: z.string().optional(),
});

const TERMINAL: ReadonlyArray<string> = ['succeeded', 'failed', 'canceled', 'expired'];

// C6-LI: cancelflash allowlist. Only keys present here render a flash banner;
// any other value (including attacker-supplied strings via URL) is dropped.
// Implemented as a Map so eslint's `security/detect-object-injection` rule
// doesn't flag the lookup (Map.get() doesn't expose prototype properties to
// arbitrary string keys the way bracket-indexing a plain object does).
const FLASH_MAP = new Map<string, { level: 'error' | 'info'; message: string }>([
  [
    'csrf-stale',
    {
      level: 'error',
      message: 'Your session token had to be refreshed. Please try again.',
    },
  ],
]);

export const jobDetailPagePlugin: FastifyPluginAsync = async (app) => {
  const { prisma } = app.deps;

  app.get(
    '/jobs/:id',
    {
      preHandler: app.requireSession,
      schema: { params: Params, querystring: QuerySchema },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store, max-age=0');

      const userId = req.auth!.userId;
      const { id } = req.params as z.infer<typeof Params>;
      const { fragment, cancelflash } = req.query as z.infer<typeof QuerySchema>;

      const job = await prisma.job.findFirst({
        where: { id, userId },
        select: {
          id: true,
          status: true,
          kind: true,
          profile: true,
          inputFilename: true,
          inputBytes: true,
          outputBytes: true,
          progress: true,
          createdAt: true,
          finishedAt: true,
          errorMessage: true,
        },
      });
      if (!job) {
        return reply.code(404).view('404', { title: 'Not found', path: req.url });
      }

      const jobView = {
        ...job,
        inputBytes: job.inputBytes === null ? null : job.inputBytes.toString(),
        outputBytes: job.outputBytes === null ? null : job.outputBytes.toString(),
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
        // C1-LI: redact errorMessage at view-time so server-internals (paths,
        // ffmpeg-stderr) never reach the user.
        errorMessage: redactErrorMessage(job.errorMessage),
      };

      // Task 4: HTMX-polling fallback path — render ONLY the inner status
      // partial. Uses reply.viewFragment (Task-2 decorator); reply.view with
      // `{ layout: undefined }` is a no-op when a global layout is configured
      // (Rev. 2.2 — @fastify/view 11.x limitation).
      if (fragment) {
        return reply.viewFragment('job-detail-status', jobView);
      }

      const flash = cancelflash ? (FLASH_MAP.get(cancelflash) ?? null) : null;

      return reply.view('job-detail', {
        title: `Job ${job.id.slice(0, 8)}`,
        job: jobView,
        canCancel: !TERMINAL.includes(job.status),
        canDownload: job.status === 'succeeded',
        _csrfField: reply.renderCsrfField(),
        flash,
      });
    },
  );
};
