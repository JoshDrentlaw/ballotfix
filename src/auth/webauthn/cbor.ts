/**
 * A CBOR decoder covering exactly the subset WebAuthn uses.
 *
 * Two structures need decoding and no others: the attestation object (a map of
 * three keys) and the COSE key inside it (a map of small integer keys). CTAP2
 * mandates canonical CBOR, which means definite lengths only and no tags, so
 * everything outside that subset is rejected rather than tolerated — a decoder
 * that quietly accepts more than the format allows is a decoder that will one
 * day accept something an authenticator did not send.
 *
 * Decoding reports how many bytes it consumed, because the COSE key sits at an
 * unknown offset inside authenticator data with optional extensions after it:
 * you cannot find the end of the key without parsing it.
 */

export class CborError extends Error {
  override readonly name = "CborError";
}

/** Text keys come from maps like the attestation object; integer keys from COSE. */
export type CborMap = Map<string | number, CborValue>;
export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | CborMap;

interface Read<T> {
  readonly value: T;
  readonly next: number;
}

const MAJOR_UNSIGNED = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_SIMPLE = 7;

const decoder = new TextDecoder("utf-8", { fatal: true });

function need(bytes: Uint8Array, offset: number, count: number): void {
  if (offset + count > bytes.length) {
    throw new CborError(`Truncated CBOR: wanted ${count} bytes at ${offset}`);
  }
}

/**
 * The argument encoded in the low five bits of the initial byte, plus however
 * many following bytes it names. Indefinite length (31) is refused outright.
 */
function readArgument(bytes: Uint8Array, offset: number): Read<number> {
  const info = bytes[offset]! & 0x1f;
  if (info < 24) return { value: info, next: offset + 1 };
  if (info === 24) {
    need(bytes, offset + 1, 1);
    return { value: bytes[offset + 1]!, next: offset + 2 };
  }
  if (info === 25) {
    need(bytes, offset + 1, 2);
    return { value: (bytes[offset + 1]! << 8) | bytes[offset + 2]!, next: offset + 3 };
  }
  if (info === 26) {
    need(bytes, offset + 1, 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4);
    return { value: view.getUint32(0), next: offset + 5 };
  }
  if (info === 27) {
    need(bytes, offset + 1, 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 8);
    const value = view.getBigUint64(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CborError("CBOR integer beyond safe range");
    }
    return { value: Number(value), next: offset + 9 };
  }
  throw new CborError(
    info === 31 ? "Indefinite-length CBOR is not canonical" : `Reserved CBOR argument ${info}`,
  );
}

function decodeAt(bytes: Uint8Array, offset: number, depth: number): Read<CborValue> {
  if (depth > 8) throw new CborError("CBOR nested too deeply");
  need(bytes, offset, 1);
  const major = bytes[offset]! >> 5;
  const argument = readArgument(bytes, offset);

  switch (major) {
    case MAJOR_UNSIGNED:
      return { value: argument.value, next: argument.next };

    case MAJOR_NEGATIVE:
      // -1 - n. COSE labels are small negatives (-1, -2, -3), never large.
      return { value: -1 - argument.value, next: argument.next };

    case MAJOR_BYTES: {
      need(bytes, argument.next, argument.value);
      const slice = bytes.slice(argument.next, argument.next + argument.value);
      return { value: slice, next: argument.next + argument.value };
    }

    case MAJOR_TEXT: {
      need(bytes, argument.next, argument.value);
      const slice = bytes.subarray(argument.next, argument.next + argument.value);
      let text: string;
      try {
        text = decoder.decode(slice);
      } catch {
        throw new CborError("CBOR text string is not valid UTF-8");
      }
      return { value: text, next: argument.next + argument.value };
    }

    case MAJOR_ARRAY: {
      const items: CborValue[] = [];
      let cursor = argument.next;
      for (let i = 0; i < argument.value; i++) {
        const item = decodeAt(bytes, cursor, depth + 1);
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }

    case MAJOR_MAP: {
      const map: CborMap = new Map();
      let cursor = argument.next;
      for (let i = 0; i < argument.value; i++) {
        const key = decodeAt(bytes, cursor, depth + 1);
        if (typeof key.value !== "string" && typeof key.value !== "number") {
          throw new CborError("CBOR map keys must be text or integers here");
        }
        // A repeated key is not merely redundant: it lets one encoding carry two
        // different answers to the same question.
        if (map.has(key.value)) throw new CborError(`Duplicate CBOR map key ${key.value}`);
        const value = decodeAt(bytes, key.next, depth + 1);
        map.set(key.value, value.value);
        cursor = value.next;
      }
      return { value: map, next: cursor };
    }

    case MAJOR_SIMPLE: {
      const info = bytes[offset]! & 0x1f;
      if (info === 20) return { value: false, next: argument.next };
      if (info === 21) return { value: true, next: argument.next };
      if (info === 22) return { value: null, next: argument.next };
      throw new CborError(`Unsupported CBOR simple value ${info}`);
    }

    default:
      throw new CborError(`Unsupported CBOR major type ${major}`);
  }
}

/** Decode one item and report where it ended. */
export function decodeCborItem(bytes: Uint8Array, offset = 0): Read<CborValue> {
  return decodeAt(bytes, offset, 0);
}

/** Decode one item that must account for every byte given. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, next } = decodeAt(bytes, 0, 0);
  if (next !== bytes.length) {
    throw new CborError(`${bytes.length - next} trailing byte(s) after the CBOR item`);
  }
  return value;
}

export function asMap(value: CborValue, what: string): CborMap {
  if (!(value instanceof Map)) throw new CborError(`${what} is not a CBOR map`);
  return value;
}

export function asBytes(value: CborValue | undefined, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new CborError(`${what} is not a CBOR byte string`);
  return value;
}

export function asText(value: CborValue | undefined, what: string): string {
  if (typeof value !== "string") throw new CborError(`${what} is not a CBOR text string`);
  return value;
}
