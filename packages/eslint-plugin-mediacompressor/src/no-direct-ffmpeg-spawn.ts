import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://example.com/eslint-plugin-mediacompressor/${name}`,
);

export const rule = createRule({
  name: 'no-direct-ffmpeg-spawn',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Verbiete direkte spawn/exec-Aufrufe von ffmpeg ausserhalb des zentralen Argument-Builders. Spec C2.',
    },
    schema: [],
    messages: {
      noDirectSpawn:
        'Direkter ffmpeg-Aufruf verboten. Nutze buildFfmpegArgs() in packages/compression/src/ffmpeg-args.ts.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    if (filename.endsWith('ffmpeg-args.ts')) return {};

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (callee.type !== 'Identifier') return;

        const name = callee.name;
        if (name !== 'spawn' && name !== 'exec' && name !== 'execFile' && name !== 'spawnSync')
          return;

        const firstArg = node.arguments[0];
        if (!firstArg) return;

        const isFfmpegStringArg =
          firstArg.type === 'Literal' &&
          typeof firstArg.value === 'string' &&
          (firstArg.value === 'ffmpeg' ||
            firstArg.value.startsWith('ffmpeg ') ||
            firstArg.value.includes(' ffmpeg ') ||
            firstArg.value.startsWith('ffmpeg -'));

        if (!isFfmpegStringArg) return;

        const secondArg = node.arguments[1];
        if (
          name !== 'exec' &&
          secondArg &&
          (secondArg.type === 'Identifier' || secondArg.type === 'CallExpression')
        ) {
          return;
        }

        context.report({ node, messageId: 'noDirectSpawn' });
      },
    };
  },
});
