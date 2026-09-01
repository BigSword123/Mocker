import { randomUUID } from 'node:crypto';
import { faker as fakerEn, type Faker } from '@faker-js/faker';
import { faker as fakerZhCn } from '@faker-js/faker/locale/zh_CN';
import { faker as fakerJa } from '@faker-js/faker/locale/ja';
import { faker as fakerKo } from '@faker-js/faker/locale/ko';
import { faker as fakerDe } from '@faker-js/faker/locale/de';
import { faker as fakerFr } from '@faker-js/faker/locale/fr';
import type { RenderContext } from '../../shared/types';

export type { RenderContext };

const FAKERS: Record<string, Faker> = {
  en: fakerEn,
  zh_CN: fakerZhCn,
  ja: fakerJa,
  ko: fakerKo,
  de: fakerDe,
  fr: fakerFr,
};

// Trim happens in resolve(); the tight [^{}]+ avoids catastrophic backtracking
// on unclosed tokens that the \s* variants exhibited.
const TOKEN_RE = /\{\{([^{}]+)\}\}/g;
const FAKER_BLOCKLIST = new Set(['helpers.fake']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const UNKNOWN = Symbol('unknown-token');

export function renderTemplate(
  text: string,
  ctx: RenderContext,
  locale?: string,
  warnings: string[] = [],
): string {
  return text.replace(TOKEN_RE, (match, raw: string) => {
    try {
      const [token, ...argParts] = raw.split(':');
      const args = argParts.map((a) => a.trim());
      const resolved = resolve(token.trim(), args, ctx, locale, warnings);
      return resolved === UNKNOWN ? match : resolved;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`template_warn: ${raw}: ${message}`);
      return match;
    }
  });
}

function resolve(
  token: string,
  args: string[],
  ctx: RenderContext,
  locale: string | undefined,
  warnings: string[],
): string | typeof UNKNOWN {
  if (token === 'now') return renderNow(args.join(':') || undefined);
  if (token === 'uuid') return randomUUID();
  if (token.startsWith('random.')) return renderRandom(token.slice('random.'.length), args);
  if (token === 'req.body' || token.startsWith('req.body.')) return renderReqBody(token, ctx);
  if (token.startsWith('req.')) return renderReqField(token, ctx);
  if (token.startsWith('faker.')) return renderFaker(token.slice('faker.'.length), args, locale);

  warnings.push(`template_warn: ${token}: unknown token`);
  return UNKNOWN;
}

function renderNow(fmt: string | undefined): string {
  const d = new Date();
  if (!fmt || fmt === 'iso') return d.toISOString();
  if (fmt === 'ms') return String(d.getTime());
  const pad = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
}

function renderRandom(kind: string, args: string[]): string {
  if (kind === 'int') {
    const [min, max] = args.map(Number);
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('random.int 需要 min/max');
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }
  if (kind === 'float') {
    const [min, max, precision = 2] = args.map(Number);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error('random.float 需要 min/max');
    }
    const v = Math.random() * (max - min) + min;
    return v.toFixed(Number.isFinite(precision) ? precision : 2);
  }
  if (kind === 'choice') {
    if (args.length === 0) throw new Error('random.choice 至少需要一个选项');
    return args[Math.floor(Math.random() * args.length)];
  }
  if (kind === 'string') {
    const len = Number(args[0]) || 16;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }
  throw new Error(`未知 random.${kind}`);
}

function renderReqField(token: string, ctx: RenderContext): string {
  const rest = token.slice('req.'.length);
  if (rest === 'method') return ctx.method;
  if (rest === 'url') return ctx.url;
  if (rest === 'host') return ctx.host;
  if (rest === 'path') return ctx.path;
  if (rest.startsWith('query.')) return ctx.query[rest.slice('query.'.length)] ?? '';
  if (rest.startsWith('header.')) {
    const name = rest.slice('header.'.length).toLowerCase();
    const entry = Object.entries(ctx.headers).find(([k]) => k.toLowerCase() === name);
    return entry?.[1] ?? '';
  }
  throw new Error(`未知 req.${rest}`);
}

function renderReqBody(token: string, ctx: RenderContext): string {
  if (token === 'req.body') return ctx.body;
  if (!token.startsWith('req.body.json.')) throw new Error(`未知 ${token}`);
  const path = token.slice('req.body.json.'.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return '';
  }
  const segments = path.split('.');
  let cur: unknown = parsed;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return '';
    if (DANGEROUS_KEYS.has(seg)) return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur == null ? '' : String(cur);
}

function renderFaker(path: string, args: string[], locale: string | undefined): string {
  const parts = path.split('.');
  if (parts.length < 2) throw new Error(`faker 路径不完整: ${path}`);
  const moduleKey = parts[0];
  const methodKey = parts.slice(1).join('.');
  if (FAKER_BLOCKLIST.has(`${moduleKey}.${methodKey}`)) {
    throw new Error(`${moduleKey}.${methodKey} 已禁用`);
  }
  if (parts.some((p) => DANGEROUS_KEYS.has(p))) throw new Error(`faker.${path} 已禁用`);
  const faker = (locale && FAKERS[locale]) || FAKERS.en;
  const mod = (faker as unknown as Record<string, unknown>)[moduleKey];
  if (!mod || typeof mod !== 'object') throw new Error(`faker.${moduleKey} 不存在`);
  const fn = (mod as Record<string, unknown>)[methodKey];
  if (typeof fn !== 'function') throw new Error(`faker.${moduleKey}.${methodKey} 不是函数`);
  const coerced = args.map(coerceArg);
  const result = (fn as (...a: unknown[]) => unknown).apply(faker, adaptArgs(moduleKey, coerced));
  return result == null ? '' : String(result);
}

/**
 * faker v10 的部分方法只接收单个 options 对象（如 number.int({ min, max })），
 * 这里把模板里的位置参数映射为对应的 options 对象。
 */
function adaptArgs(moduleKey: string, coerced: unknown[]): unknown[] {
  if (moduleKey === 'number' && coerced.length >= 2) {
    const [min, max, ...rest] = coerced;
    return [{ min, max, ...spreadRest(rest) }];
  }
  if (moduleKey === 'string' && coerced.length === 1 && typeof coerced[0] === 'number') {
    return [{ length: coerced[0] }];
  }
  return coerced;
}

function spreadRest(rest: unknown[]): Record<string, unknown> {
  // number.float 的第三个参数按约定映射为 fractionDigits
  if (rest.length > 0 && typeof rest[0] === 'number') return { fractionDigits: rest[0] };
  return {};
}

function coerceArg(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (v !== '' && Number.isFinite(n)) return n;
  return v;
}
