/* Fibonacci Streamer — Web Worker
 * Browser port of the Node.js worker_threads engine:
 *   1) Iterative fast-doubling Fibonacci (BigInt)
 *   2) Divide-and-conquer base-10 conversion in 2000-digit chunks
 * Posts progress and digit chunks so the page can build a downloadable file
 * without freezing Safari. Cancel by posting { type: "cancel" } or terminating.
 */

const MAX_SAFE_FIB_INDEX = 1000000000;
const BASE_CASE_DIGITS = 2000;
const BASE_CASE_DIVISOR = 10n ** BigInt(BASE_CASE_DIGITS);
const CHUNK_SIZE = 65536;

let cancelled = false;

class CancelledError extends Error {
    constructor() {
        super("Cancelled");
        this.name = "CancelledError";
    }
}

function throwIfCancelled() {
    if (cancelled) throw new CancelledError();
}

function validateFibInput(num) {
    if (typeof num !== "number" || !Number.isInteger(num)) {
        throw new TypeError("Expected an integer, received " + typeof num + " (" + num + ")");
    }
    if (num < 0) {
        throw new RangeError("Fibonacci index must be non-negative, received " + num);
    }
    if (num > MAX_SAFE_FIB_INDEX) {
        throw new RangeError(
            "Fibonacci index " + num.toLocaleString() +
            " exceeds maximum safe limit (" + MAX_SAFE_FIB_INDEX.toLocaleString() + ")"
        );
    }
}

function fibFastDoublingIterative(num, onProgress) {
    validateFibInput(num);
    if (num === 0) return 0n;

    let highestBit = 1;
    while (highestBit <= num >> 1) {
        highestBit <<= 1;
    }

    let totalBits = 0;
    for (let bit = highestBit; bit > 0; bit >>= 1) totalBits++;

    let a = 0n;
    let b = 1n;
    let step = 0;

    for (let bit = highestBit; bit > 0; bit >>= 1) {
        throwIfCancelled();
        const c = a * ((b << 1n) - a);
        const d = a * a + b * b;

        if ((num & bit) !== 0) {
            a = d;
            b = c + d;
        } else {
            a = c;
            b = d;
        }

        step++;
        if (onProgress) onProgress(step / totalBits);
    }

    return a;
}

/**
 * Lazily yields base-10 digit strings from most-significant to least-significant
 * in O(M(n) log n) time without allocating the full decimal string in one shot.
 */
function* streamBigIntDigits(n) {
    if (n === 0n) {
        yield "0";
        return;
    }
    if (n < BASE_CASE_DIVISOR) {
        yield n.toString(10);
        return;
    }

    const bitLen = n.toString(2).length;
    const approxDigits = Math.floor(bitLen * 0.3010299956639812);

    const powers = [BASE_CASE_DIVISOR];
    const digitCounts = [BASE_CASE_DIGITS];

    while (digitCounts[digitCounts.length - 1] * 2 <= approxDigits) {
        const lastPow = powers[powers.length - 1];
        powers.push(lastPow * lastPow);
        digitCounts.push(digitCounts[digitCounts.length - 1] * 2);
    }

    function* walk(val, level, padDigits) {
        if (level < 0) {
            const s = val.toString(10);
            yield padDigits > 0 ? s.padStart(padDigits, "0") : s;
            return;
        }

        const divisor = powers[level];
        const halfDigits = digitCounts[level];

        if (val < divisor) {
            if (padDigits > halfDigits) {
                yield "0".repeat(padDigits - halfDigits);
                yield* walk(val, level - 1, halfDigits);
            } else {
                yield* walk(val, level - 1, padDigits);
            }
            return;
        }

        const high = val / divisor;
        const low = val % divisor;

        const highPad = padDigits > halfDigits ? padDigits - halfDigits : 0;
        yield* walk(high, level - 1, highPad);
        yield* walk(low, level - 1, halfDigits);
    }

    yield* walk(n, powers.length - 1, 0);
}

function estimateFibDigits(n) {
    if (n <= 1) return 1;
    const log10Phi = Math.log10((1 + Math.sqrt(5)) / 2);
    const log10Sqrt5 = Math.log10(5) / 2;
    return Math.floor(n * log10Phi - log10Sqrt5) + 1;
}

function postProgress(phase, percent, message) {
    self.postMessage({ type: "progress", phase: phase, percent: percent, message: message });
}

function compute(num) {
    const label = "F(" + num.toLocaleString() + ")";
    postProgress("compute", 1, "Computing " + label + "…");

    const result = fibFastDoublingIterative(num, function (p) {
        postProgress("compute", Math.round(p * 60), "Computing " + label + "…");
    });

    throwIfCancelled();

    const estimated = estimateFibDigits(num);
    postProgress("convert", 60, "Converting " + label + " to decimal digits…");

    const gen = streamBigIntDigits(result);
    let buffer = "";
    let emitted = 0;

    function flush(flushAll) {
        while (buffer.length >= CHUNK_SIZE || (flushAll && buffer.length > 0)) {
            throwIfCancelled();
            const take = flushAll && buffer.length <= CHUNK_SIZE ? buffer.length : CHUNK_SIZE;
            const chunk = buffer.slice(0, take);
            buffer = buffer.slice(take);
            emitted += chunk.length;
            self.postMessage({ type: "chunk", data: chunk });
            const convertPct = estimated > 0 ? Math.min(1, emitted / estimated) : 1;
            postProgress(
                "convert",
                60 + Math.round(convertPct * 40),
                "Writing digits… " + emitted.toLocaleString()
            );
        }
    }

    for (const part of gen) {
        throwIfCancelled();
        buffer += part;
        if (buffer.length >= CHUNK_SIZE) flush(false);
    }
    flush(true);

    self.postMessage({
        type: "done",
        digitCount: emitted,
        index: num
    });
}

self.onmessage = function (event) {
    const msg = event.data || {};
    if (msg.type === "cancel") {
        cancelled = true;
        return;
    }
    if (msg.type === "start") {
        cancelled = false;
        try {
            compute(msg.n);
        } catch (err) {
            if (err && err.name === "CancelledError") {
                self.postMessage({ type: "cancelled" });
            } else {
                self.postMessage({
                    type: "error",
                    message: err && err.message ? err.message : String(err)
                });
            }
        }
    }
};

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        fibFastDoublingIterative: fibFastDoublingIterative,
        streamBigIntDigits: streamBigIntDigits,
        estimateFibDigits: estimateFibDigits
    };
}
