import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://example.com/eslint-plugin-mediacompressor/${name}`,
);

const RESTRICTED_PROGRAMS = new Set(['ffmpeg', 'ffprobe']);

const ALLOWED_FILES = ['ffmpeg-args.ts', 'video-engine.ts', 'video-probe.ts'];

export const rule = createRule({
  name: 'no-direct-ffmpeg-spawn',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Verbiete direkte spawn/exec-Aufrufe von ffmpeg/ffprobe ausserhalb der zentralen Wrapper. Spec C2.',
    },
    schema: [],
    messages: {
      noDirectSpawn:
        'Direkter ffmpeg/ffprobe-Aufruf verboten. Nutze buildFfmpegArgs() in ffmpeg-args.ts oder probeVideo() in video-probe.ts.',
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    if (ALLOWED_FILES.some((f) => filename.endsWith(f))) return {};

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        if (callee.type !== 'Identifier') return;

        const name = callee.name;
        if (name !== 'spawn' && name !== 'exec' && name !== 'execFile' && name !== 'spawnSync')
          return;

        const firstArg = node.arguments[0];
        if (!firstArg) return;

        const isRestrictedProgramArg =
          firstArg.type === 'Literal' &&
          typeof firstArg.value === 'string' &&
          [...RESTRICTED_PROGRAMS].some(
            (p) =>
              firstArg.value === p ||
              (firstArg.value as string).startsWith(`${p} `) ||
              (firstArg.value as string).includes(` ${p} `) ||
              (firstArg.value as string).startsWith(`${p} -`),
          );

        if (!isRestrictedProgramArg) return;

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
