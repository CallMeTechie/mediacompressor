import { RuleTester } from '@typescript-eslint/utils/ts-eslint';
import { describe, it } from 'vitest';
import { rule } from './no-direct-ffmpeg-spawn.js';

const ruleTester = new RuleTester();

describe('no-direct-ffmpeg-spawn', () => {
  it('flagged and clean cases', () => {
    ruleTester.run('no-direct-ffmpeg-spawn', rule, {
      valid: [
        // erlaubt: zweites Arg ist ein Identifier (z. B. buildFfmpegArgs(...))
        {
          code: `import { spawn } from 'node:child_process'; const args = []; spawn('ffmpeg', args);`,
        },
        // erlaubt: kein 'ffmpeg' als String
        {
          code: `import { spawn } from 'node:child_process'; spawn('foo', ['-bar']);`,
        },
        // Datei selbst, in der buildFfmpegArgs definiert ist, ist whitelisted
        {
          code: `import { spawn } from 'node:child_process'; export function buildFfmpegArgs() { return spawn('ffmpeg', ['-y']); }`,
          filename: '/repo/packages/compression/src/ffmpeg-args.ts',
        },
        // video-engine.ts ist whitelisted
        {
          code: `import { spawn } from 'node:child_process'; spawn('ffmpeg', ['-y']);`,
          filename: '/repo/packages/compression/src/video-engine.ts',
        },
        // video-probe.ts ist whitelisted für ffprobe
        {
          code: `import { spawn } from 'node:child_process'; spawn('ffprobe', ['-v', 'error']);`,
          filename: '/repo/packages/compression/src/video-probe.ts',
        },
      ],
      invalid: [
        // verboten: spawn('ffmpeg', [...]) mit Array-Literal als zweitem Arg
        {
          code: `import { spawn } from 'node:child_process'; spawn('ffmpeg', ['-y', '-i', 'in.mp4']);`,
          errors: [{ messageId: 'noDirectSpawn' }],
        },
        // verboten: exec-String mit ffmpeg
        {
          code: `import { exec } from 'node:child_process'; exec('ffmpeg -y -i in.mp4');`,
          errors: [{ messageId: 'noDirectSpawn' }],
        },
        // verboten: ffprobe ausserhalb der Whitelist
        {
          code: `import { spawn } from 'node:child_process'; spawn('ffprobe', ['-v', 'error']);`,
          errors: [{ messageId: 'noDirectSpawn' }],
        },
      ],
    });
  });
});
