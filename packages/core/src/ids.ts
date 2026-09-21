/** ULIDs (26 chars, Crockford base32, time-sortable), monotonic within a process. Web Crypto only. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom = new Uint8Array(10);

export function ulid(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  if (time === lastTime) {
    // Same millisecond: increment the random part so ids stay ordered.
    for (let i = 9; i >= 0; i--) {
      const v = lastRandom[i] ?? 0;
      if (v < 255) {
        lastRandom[i] = v + 1;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    time = time > lastTime ? time : lastTime;
    lastTime = time;
    lastRandom = crypto.getRandomValues(new Uint8Array(10));
  }
  let out = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    out = (ALPHABET[t % 32] ?? "0") + out;
    t = Math.floor(t / 32);
  }
  // 80 random bits → 16 chars of 5 bits.
  let bits = 0;
  let acc = 0;
  let rand = "";
  for (const byte of lastRandom) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      rand += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out + rand;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** 32 bytes of randomness as base64url, for tokens and secrets. */
export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
