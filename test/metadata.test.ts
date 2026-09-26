import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

type Node = { key: string; indent: number; children: Map<string, Node> };

function parseKeys(path: string): Node {
  const root: Node = { key: '', indent: -1, children: new Map() };
  const stack = [root];
  let scalarIndent: number | undefined;
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const indent = line.length - line.trimStart().length;
      if (scalarIndent !== undefined) {
        if (line.trim() === '' || indent > scalarIndent) return;
        scalarIndent = undefined;
      }
      const match = /^( *)([A-Za-z0-9_-]+):(.*)$/.exec(line);
      if (!match || line.trimStart().startsWith('#')) return;
      while (stack.at(-1)!.indent >= indent) stack.pop();
      const parent = stack.at(-1)!;
      const key = match[2]!;
      assert.ok(!parent.children.has(key), `${path}:${index + 1} defines ${key} twice under ${parent.key || 'the root'}`);
      const node: Node = { key, indent, children: new Map() };
      parent.children.set(key, node);
      stack.push(node);
      if (/^\s*[|>][-+]?\s*$/.test(match[3]!)) scalarIndent = indent;
    });
  return root;
}

function namesIn(source: string, call: string): string[] {
  return [...new Set([...readFileSync(source, 'utf8').matchAll(new RegExp(`\\b${call}\\('([a-z-]+)'`, 'g'))].map((match) => match[1]!))].sort();
}

const actions = [
  { metadata: 'action.yml', source: 'src/main.ts' },
  { metadata: 'sign/action.yml', source: 'sign/main.ts' },
];

describe('action metadata', () => {
  for (const { metadata, source } of actions) {
    it(`${metadata} declares each key once and every input and output ${source} uses`, () => {
      const root = parseKeys(metadata);
      const declared = (section: string) => [...(root.children.get(section)?.children.keys() ?? [])].sort();
      assert.deepEqual(declared('inputs'), [...new Set([...namesIn(source, 'getInput'), ...namesIn(source, 'getBooleanInput')])].sort());
      assert.deepEqual(declared('outputs'), namesIn(source, 'setOutput'));
      for (const input of root.children.get('inputs')!.children.values()) {
        assert.ok(input.children.has('description'), `${metadata} input ${input.key} has no description`);
      }
    });
  }
});
