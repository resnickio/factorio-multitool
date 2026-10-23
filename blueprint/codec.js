// Encoding and decoding of Factorio blueprint strings: a version byte ("0"),
// followed by the base64 of the zlib-compressed JSON.
//
// The compression functions are passed in, so that the same code works with
// pako in the browser and zlib under Node.

const VERSION_MAJOR = 2
const VERSION_MINOR = 1
const VERSION_PATCH = 23

// Blueprints carry the game version as four packed 16-bit numbers.
export function gameVersion() {
    return Number((BigInt(VERSION_MAJOR) << 48n) | (BigInt(VERSION_MINOR) << 32n) | (BigInt(VERSION_PATCH) << 16n))
}

function toBase64(bytes) {
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(s)
}

function fromBase64(text) {
    let s = atob(text)
    let bytes = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) {
        bytes[i] = s.charCodeAt(i)
    }
    return bytes
}

// deflate: function from Uint8Array to Uint8Array.
export function encodeBlueprint(blueprint, deflate) {
    let json = JSON.stringify({blueprint})
    let bytes = deflate(new TextEncoder().encode(json))
    return "0" + toBase64(bytes)
}

// inflate: function from Uint8Array to Uint8Array. Returns the parsed object
// (with a top-level "blueprint" or "blueprint_book" key).
export function decodeBlueprint(text, inflate) {
    text = text.trim()
    if (text[0] !== "0") {
        throw new Error("not a blueprint string (unknown version byte)")
    }
    let bytes = inflate(fromBase64(text.slice(1)))
    return JSON.parse(new TextDecoder().decode(bytes))
}
