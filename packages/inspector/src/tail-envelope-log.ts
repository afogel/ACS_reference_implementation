/**
 * tailEnvelopeLog (N50) streams S6 -- the Guardian's JSONL envelope log --
 * as it grows, the way `tail -f` does.
 *
 * This package deliberately imports nothing from `guardian` or from any of
 * its dependencies (global constraint 10). The Inspector reads a file that
 * the Guardian happens to write; it holds no compile-time knowledge of the
 * process that produced it, which is the point of R5.1 -- envelopes are
 * inspectable *on the wire*, not through our own type graph. TapEntry is
 * therefore re-declared here rather than imported. The round-trip test at
 * test/envelope-tap-roundtrip.test.ts is what keeps the two declarations in
 * agreement; if they drift, it fails.
 *
 * Polling rather than fs.watch: appends to a growing file are exactly the
 * case where watch semantics differ most across platforms, and a 120ms poll
 * on a local demo log costs nothing.
 *
 * The poll runs on its own timer once started, independent of whether
 * anything is actively pulling values from the returned generator. That
 * independence is load-bearing, not incidental: a consumer can read one
 * entry and then pause before asking for the next one, and the file can be
 * truncated and rewritten entirely within that pause. A poll folded into
 * the generator's own suspend/resume points only ever inspects the file at
 * the instant the consumer resumes it -- by then a truncate-and-rewrite can
 * look exactly like ordinary growth (a same-length-or-longer rewrite makes
 * the new size come out >= the old offset, so a size-only check never
 * fires). A timer that keeps ticking regardless of consumption catches the
 * file while it is still sitting at zero.
 *
 * The timer itself, though, only starts on the first `next()` -- inside the
 * returned generator's body, not inside this function. A caller that builds
 * a tail and never iterates it (and never aborts) should not leave a timer
 * running forever; tying its start to first consumption means an unused
 * tail costs nothing.
 *
 * The starting offset is a separate concern from the timer, and is captured
 * synchronously right here, when this function is called -- not lazily
 * inside the generator body, which would not run at all until the caller's
 * first `next()`. "Start at the current end" has to mean the moment
 * `tailEnvelopeLog` was called, not the moment someone first asked it for a
 * value; the truncation scenario above still works even though the timer
 * itself starts later, because by the time a consumer has read anything at
 * all, `next()` has already been called once and the timer is already
 * running.
 *
 * `poll()` runs as a bare timer callback with nothing awaiting it, so
 * nothing is in a position to catch a thrown error the way a rejected
 * promise would be caught by a consumer's `for await`. A file that
 * disappears between the size check and the read -- rotation schemes that
 * unlink-and-recreate rather than truncate-in-place can do this -- must
 * therefore be handled inside `poll()` itself; letting it throw out of a
 * timer callback would crash the whole process instead of merely losing a
 * line.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export type TapDirection = "request" | "response";

/** One line of S6, as written by the Guardian's envelope tap. */
export type TapEntry = {
  seq: number;
  recorded_at: string;
  direction: TapDirection;
  method: string | null;
  rpc_id: string | number | null;
  envelope: unknown;
};

export type TailOptions = {
  path: string;
  /** Replay everything already in the file before following. Default false:
   * start at the current end, like `tail -f`. */
  fromStart?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called per unparseable line. Defaults to one stderr warning. Streaming
   * continues either way -- a corrupt line is not a reason to stop showing
   * the ones after it. */
  onMalformedLine?: (line: string, error: unknown) => void;
};

const NEWLINE = 0x0a;

export function tailEnvelopeLog({
  path,
  fromStart = false,
  pollMs = 120,
  signal,
  onMalformedLine = warnMalformedLine,
}: TailOptions): AsyncGenerator<TapEntry, void, void> {
  let offset = fromStart ? 0 : sizeOf(path);
  // Bytes, not a string: a poll can land mid-line and, worse, mid-codepoint.
  // Decoding only complete lines keeps multi-byte UTF-8 intact.
  let pending = Buffer.alloc(0);

  // Entries the timer has parsed but nobody has consumed yet, and the
  // wake-up the drain loop below is currently parked on while that queue is
  // empty. The timer and the generator only communicate through these two.
  const ready: TapEntry[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function poll(): void {
    if (stopped) {
      return;
    }
    try {
      const size = sizeOf(path);

      if (size < offset) {
        // Truncated or rotated underneath us (`: > .acs/envelopes.jsonl`).
        offset = 0;
        pending = Buffer.alloc(0);
      }

      if (size > offset) {
        pending = Buffer.concat([pending, readRange(path, offset, size - offset)]);
        offset = size;

        let added = false;
        let newline = pending.indexOf(NEWLINE);
        while (newline !== -1) {
          const line = pending.subarray(0, newline).toString("utf8");
          pending = pending.subarray(newline + 1);
          newline = pending.indexOf(NEWLINE);

          if (line.trim() === "") {
            continue;
          }
          try {
            ready.push(JSON.parse(line) as TapEntry);
            added = true;
          } catch (error) {
            onMalformedLine(line, error);
          }
        }
        if (added) {
          wake?.();
        }
      }
    } catch (error) {
      // A read can lose a race against a file that vanished between the
      // size check above and the read itself. There is no promise here for
      // that to reject into -- this is a timer callback, not a step inside
      // the generator's own call stack -- so an uncaught throw would take
      // the whole process down. Skip this tick instead: the next one's
      // sizeOf() sees the gap (or the file's return) and resyncs on its
      // own.
      warnPollError(error);
    }
  }

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
    signal?.removeEventListener("abort", stop);
    wake?.();
  }

  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) {
    stop();
  }

  return drain();

  async function* drain(): AsyncGenerator<TapEntry, void, void> {
    // Starting the timer here, not above, means a tail nobody ever iterates
    // (and nobody ever aborts) never ticks at all.
    if (!stopped) {
      timer = setInterval(poll, pollMs);
    }
    try {
      while (true) {
        while (ready.length === 0 && !stopped) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        if (ready.length === 0) {
          return;
        }
        const entry = ready.shift();
        if (entry !== undefined) {
          yield entry;
        }
      }
    } finally {
      stop();
    }
  }
}

function sizeOf(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readRange(path: string, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function warnMalformedLine(line: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skipping unparseable envelope-log line (${message}): ${line.slice(0, 120)}`);
}

function warnPollError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`envelope log poll failed, retrying next tick (${message})`);
}
