import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identityFromSeed } from './crypto/keys';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { sealBody } from './sealed-body';
import { normalizeNickname, sealedNicknameColumns } from './nicknames';
import { roomReactionSeal, sealedReactionColumns } from './reaction-seal';

const ME = '11111111-1111-1111-1111-111111111111';
const PEER = '22222222-2222-2222-2222-222222222222';
const SECRET = 'the quick brown fox jumps over the lazy dog';

/** Columns whose value would be something a person wrote or chose to name. */
const PLAINTEXT_KEY =
  /(?:^|[\s{,])(text|content|body|emoji|caption|label|title|display_name|bio|nickname)\s*:(?!\s*null\b)/m;
/** The same columns as `{ text }` shorthand, which carries the variable's value. */
const PLAINTEXT_SHORTHAND =
  /[{,]\s*(text|content|body|emoji|caption|label|title|display_name|bio|nickname)\s*[,}]/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The argument text of every Supabase write call, by bracket matching. */
function writePayloads(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\.(insert|update|upsert)\(/g)) {
    let depth = 1;
    let at = match.index + match[0].length;
    const start = at;
    while (at < source.length && depth > 0) {
      const c = source[at];
      if (c === '(' || c === '{' || c === '[') depth += 1;
      else if (c === ')' || c === '}' || c === ']') depth -= 1;
      at += 1;
    }
    out.push(source.slice(start, at - 1));
  }
  return out;
}

async function identity() {
  return identityFromSeed(await seedFromMnemonic(generateMnemonic()));
}

describe('no plaintext on the wire', () => {
  // Spec §13: if this passes, the product's headline claim is true. If someone
  // breaks it later, CI says so rather than a security researcher.
  it('never puts a message body into an insert payload', async () => {
    const me = await identity();
    const them = await identity();

    for (const [peer, key] of [
      [PEER, them.boxPublic],
      [ME, null],
    ] as const) {
      const columns = await sealBody(me, key, ME, peer, SECRET);
      const serialized = JSON.stringify(columns);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain('quick brown');
      expect(Object.keys(columns).sort()).toEqual(['ciphertext', 'nonce']);
    }
  });

  it('never puts a friend nickname into an insert payload', async () => {
    // 0041. Built by the same function both nickname writers call, so this
    // reads the payload the app sends rather than one written out here.
    const me = await identity();
    const nickname = normalizeNickname('Bobby Tables') as string;
    const payload = await sealedNicknameColumns(me, nickname);

    expect(JSON.stringify(payload)).not.toContain('Bobby');
    // Explicitly null rather than absent: an upsert that omitted the column
    // would leave a pre-0041 plaintext name sitting beside the new ciphertext.
    expect(payload.nickname).toBeNull();
    expect(Object.keys(payload).sort()).toEqual(['nickname', 'nickname_ciphertext', 'nickname_nonce']);
  });

  it('never puts a reaction emoji into an insert payload', async () => {
    // 0059. The columns `useReactions` inserts, from the builder it calls.
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const sealer = roomReactionSeal(roomKey);
    const payload = await sealedReactionColumns(sealer, '🤮');

    expect(JSON.stringify(payload)).not.toContain('🤮');
    expect(Object.keys(payload).sort()).toEqual(['emoji_ciphertext', 'emoji_nonce']);
    expect(
      await sealer.open({ ciphertext: payload.emoji_ciphertext, nonce: payload.emoji_nonce })
    ).toBe('🤮');
  });

  it('has no write in the app that names a plaintext column', () => {
    // The tests above prove the builders seal. This is what proves the call
    // sites use them: every `.insert(` / `.update(` / `.upsert(` argument in
    // the source, checked for a column that would carry readable content. A
    // literal `null` is allowed — that is how a legacy plaintext column is
    // cleared. A new write that needs one of these names is the moment to
    // stop and seal it.
    const offenders: string[] = [];
    for (const file of sources('src')) {
      for (const payload of writePayloads(readFileSync(file, 'utf8'))) {
        const hit = PLAINTEXT_KEY.exec(payload) ?? PLAINTEXT_SHORTHAND.exec(payload);
        if (hit) offenders.push(`${file}: ${hit[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
