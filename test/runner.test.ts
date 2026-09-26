import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainLine } from '../src/runner.ts';

describe('plainLine', () => {
  it('keeps an ordinary line as it is', () => {
    assert.equal(plainLine('Uploaded version 1.0.1.'), 'Uploaded version 1.0.1.');
  });

  it('joins lines, so no text can start a line of its own', () => {
    assert.equal(plainLine('first\n::add-mask::x\r\nsecond'), 'first ::add-mask::x second');
  });

  for (const text of ['::warning::spoof', '  ::stop-commands::token', '\u0085::stop-commands::token', '\u2028::error::spoof']) {
    it(`defuses a workflow command at the start: ${JSON.stringify(text)}`, () => {
      assert.match(plainLine(text), /^> /);
    });
  }

  it('defuses the legacy ##[command] form anywhere in the line', () => {
    const line = plainLine('dist/##[stop-commands]x.zip and ##[warning]spoof');
    assert.ok(!line.includes('##[s') && !line.includes('##[w'));
    assert.equal(line, 'dist/##[\\stop-commands]x.zip and ##[\\warning]spoof');
  });
});
