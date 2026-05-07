import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyReply {
    /**
     * Issues a fresh CSRF token (via @fastify/csrf-protection's
     * reply.generateCsrf()) and returns the HTML for a hidden input field
     * suitable for embedding in a form. Use as `{{{_csrfField}}}` in a template
     * (triple-mustache to avoid Handlebars HTML-escaping the input tag).
     */
    renderCsrfField(): string;
  }
}

const csrfHelperPluginImpl: FastifyPluginAsync = async (app) => {
  app.decorateReply('renderCsrfField', function (this: FastifyReply): string {
    // generateCsrf() also sets the mc_csrf cookie via the plugin's machinery.
    const token = this.generateCsrf();
    // Static, no user content interpolated.
    return `<input type="hidden" name="_csrf" value="${token}">`;
  });
};

// Wrap with fastify-plugin so the renderCsrfField reply decorator bubbles up to
// the parent FastifyInstance. Without fp(), the decorator is encapsulated in
// the inner plugin scope and any handler outside that scope (incl. test routes
// registered directly on the app) sees `reply.renderCsrfField is not a function`.
export const csrfHelperPlugin = fp(csrfHelperPluginImpl, {
  name: 'web-csrf-helper-plugin',
  fastify: '5.x',
});
