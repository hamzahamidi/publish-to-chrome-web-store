import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { ActionError } from './errors.ts';

export function getInput(name: string, { required = false }: { required?: boolean } = {}): string {
  const value = (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
  if (required && !value) throw new ActionError(`Input ${name} is required.`);
  return value;
}

export function getBooleanInput(name: string, fallback: boolean): boolean {
  const value = getInput(name);
  if (!value) return fallback;
  if (['true', 'True', 'TRUE'].includes(value)) return true;
  if (['false', 'False', 'FALSE'].includes(value)) return false;
  throw new ActionError(`Input ${name} must be true or false, got ${JSON.stringify(value)}.`);
}

export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
}

export function mask(value: string): void {
  if (value) process.stdout.write(`::add-mask::${escapeData(value)}${EOL}`);
}

export function info(message: string): void {
  process.stdout.write(`${plainLine(message)}${EOL}`);
}

export function warning(message: string): void {
  process.stdout.write(`::warning::${escapeData(message)}${EOL}`);
}

export function error(message: string): void {
  process.stdout.write(`::error::${escapeData(message)}${EOL}`);
}

function escapeData(value: string): string {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function plainLine(message: string): string {
  const text = String(message)
    .replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
    .replaceAll('##[', '##[\\');
  return /^[\s\u0085]*::/.test(text) ? `> ${text}` : text;
}
