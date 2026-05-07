import type { FastifyPluginAsync } from 'fastify';
import { PROFILES } from '@mediacompressor/compression/types';

/**
 * GET /upload — renders the resumable-upload wizard.
 *
 * The page itself is a thin Handlebars shell; the heavy lifting happens
 * client-side via tus-js-client (vendored at /static/vendor/tus.min.js).
 * Form-submit is hijacked by /static/js/upload-wizard.js, which starts a
 * resumable upload to /uploads/ and on success redirects to /jobs/<id>.
 *
 * Plan-8b Rev. 2 C4-LI + Rev. 2.1 C7-LI: a `<noscript>` block above the form
 * carries (1) human-readable text pointing JS-disabled users at the JSON API
 * docs and (2) a `<style>#upload-form { display: none; }</style>` rule. The
 * style rule is parsed only when JS is disabled (browsers ignore noscript
 * children when scripting is enabled), so JS-disabled users cannot submit a
 * multipart/form-data POST to /upload that would silently 404.
 */
export const uploadWizardPagePlugin: FastifyPluginAsync = async (app) => {
  app.get('/upload', { preHandler: app.requireSession }, async (_req, reply) => {
    reply.header('cache-control', 'no-store, max-age=0');
    return reply.view('upload-wizard', {
      title: 'Upload',
      profiles: PROFILES,
      _csrfField: reply.renderCsrfField(),
    });
  });
};
