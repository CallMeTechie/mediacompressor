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
  app.get('/upload', { preHandler: app.requireSession }, async (req, reply) => {
    reply.header('cache-control', 'no-store, max-age=0');
    // Plan 8e Task 5: page-title resolved via req.t with explicit
    // `ns: 'jobs'` (typed Namespace). defaultNS is still `'admin'`
    // (Task 7 cleanup), so the namespace MUST be passed explicitly.
    //
    // `profiles` is mapped to `[{ value, label }]` so the template can
    // render `<option value="{{value}}">{{label}}</option>` —
    // Translation-Discipline (Plan 8e Sektion "Translation Discipline"):
    // the option VALUE stays canonical English (matches tusd's strict
    // pre-create-hook allowlist; see apps/api/src/uploads/pre-create-hook.ts
    // and PROFILES in packages/compression/src/types.ts); only the inner
    // LABEL is translated. A leaked translated value would be rejected by
    // tusd with a 400 (WC-i18n-8 PFLICHT-Test asserts this contract).
    return reply.view('upload-wizard', {
      title: req.t('page_title_upload', undefined, 'jobs'),
      profiles: PROFILES.map((value) => ({
        value,
        label: req.t(`profile_${value.replaceAll('-', '_')}`, undefined, 'jobs'),
      })),
      _csrfField: reply.renderCsrfField(),
    });
  });
};
