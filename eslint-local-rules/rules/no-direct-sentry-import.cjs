const ALLOWED_FILES = ['sentry.ts', 'AuthContext.tsx', 'useOCRProcessor.ts'];

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct import from @sentry/react — use lib/sentry wrapper instead',
    },
    messages: {
      noDirectImport:
        "Import Sentry from '../lib/sentry' (or appropriate relative path) instead of " +
        "'@sentry/react'. The wrapper ensures consistent initialization and re-export.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== '@sentry/react') return;

        const filename = context.getFilename();
        const isAllowed = ALLOWED_FILES.some((f) => filename.endsWith(f));
        if (isAllowed) return;

        context.report({ node, messageId: 'noDirectImport' });
      },
    };
  },
};
