import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.14";
import {
  fetchSignedBlendImage,
  MAX_BLEND_IMAGE_BYTES,
  readBodyWithLimit,
  startSerializedLeaseHeartbeat,
  validateBlendImageRecords,
} from "./guards.ts";
import { requireActiveProfile } from "../_shared/auth.ts";

const TICKET = "11111111-1111-4111-8111-111111111111";
const validImage = {
  id: "img-1",
  file_size: 128,
  mime_type: "image/jpeg",
  storage_path: `${TICKET}/1.jpg`,
};

function controlledHeartbeatWait() {
  const releases: Array<() => void> = [];
  let aborted = 0;
  return {
    wait: (_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          aborted += 1;
          finish();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        releases.push(finish);
      }),
    tick: () => {
      const release = releases.shift();
      if (!release) throw new Error("No heartbeat wait is pending");
      release();
    },
    pending: () => releases.length,
    aborted: () => aborted,
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

Deno.test("image metadata accepts one canonical ticket-scoped image", () => {
  validateBlendImageRecords([validImage], TICKET);
  validateBlendImageRecords([{
    ...validImage,
    storage_path: `2026/07/${TICKET}/1.jpg`,
  }], TICKET);
});

Deno.test("image metadata rejects empty, over-20, bad MIME, and foreign paths", () => {
  assertThrows(() => validateBlendImageRecords([], TICKET));
  assertThrows(() =>
    validateBlendImageRecords(Array(21).fill(validImage), TICKET)
  );
  assertThrows(() =>
    validateBlendImageRecords(
      [{ ...validImage, mime_type: "image/svg+xml" }],
      TICKET,
    )
  );
  assertThrows(() =>
    validateBlendImageRecords([{
      ...validImage,
      storage_path: "https://internal/admin",
    }], TICKET)
  );
});

Deno.test("bounded reader rejects declared and streamed oversize bodies", async () => {
  await assertRejects(() =>
    readBodyWithLimit(
      new Response(new Uint8Array(1), {
        headers: { "content-length": String(MAX_BLEND_IMAGE_BYTES + 1) },
      }),
      MAX_BLEND_IMAGE_BYTES,
    )
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  await assertRejects(() => readBodyWithLimit(new Response(stream), 10));
});

Deno.test("bounded reader returns allowed bytes", async () => {
  const bytes = await readBodyWithLimit(
    new Response(new Uint8Array([1, 2, 3])),
    3,
  );
  assertEquals([...bytes], [1, 2, 3]);
});

Deno.test("signed image fetch fails closed on signing, response, and MIME errors", async () => {
  await assertRejects(() =>
    fetchSignedBlendImage(
      validImage,
      () => Promise.resolve({ data: null, error: { message: "sign failed" } }),
    )
  );
  await assertRejects(() =>
    fetchSignedBlendImage(
      validImage,
      () =>
        Promise.resolve({
          data: { signedUrl: "https://signed.invalid" },
          error: null,
        }),
      () => Promise.resolve(new Response("missing", { status: 404 })),
    )
  );
  await assertRejects(() =>
    fetchSignedBlendImage(
      validImage,
      () =>
        Promise.resolve({
          data: { signedUrl: "https://signed.invalid" },
          error: null,
        }),
      () =>
        Promise.resolve(
          new Response("svg", { headers: { "content-type": "image/svg+xml" } }),
        ),
    )
  );
});

Deno.test("signed image fetch times out a stalled Storage signer", async () => {
  let fetchCalled = false;
  await assertRejects(
    () =>
      fetchSignedBlendImage(
        validImage,
        () => new Promise(() => {}),
        (() => {
          fetchCalled = true;
          return Promise.resolve(
            new Response(new Uint8Array([1]), {
              headers: { "content-type": "image/jpeg" },
            }),
          );
        }) as typeof fetch,
        45_000,
        5,
      ),
    Error,
    "Timed out signing blend ticket image img-1 after 5ms",
  );
  assertEquals(fetchCalled, false);
});

Deno.test("active-profile gate allows office and rejects non-office/deactivated", async () => {
  const client = (profile: { role: string; is_active: boolean }) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: profile, error: null }),
        }),
      }),
    }),
  });
  assertEquals(
    await requireActiveProfile(
      client({ role: "sales_rep", is_active: true }),
      "u",
      ["admin", "sales_rep"],
    ),
    {
      profile: { role: "sales_rep", is_active: true },
    },
  );
  assertEquals(
    await requireActiveProfile(
      client({ role: "applicator", is_active: true }),
      "u",
      ["admin", "sales_rep"],
    ),
    {
      error: "Forbidden",
      status: 403,
    },
  );
  assertEquals(
    await requireActiveProfile(
      client({ role: "admin", is_active: false }),
      "u",
      ["admin", "sales_rep"],
    ),
    {
      error: "Account is deactivated",
      status: 403,
    },
  );
});

Deno.test("serialized heartbeat refreshes repeatedly during long work", async () => {
  const clock = controlledHeartbeatWait();
  let refreshCount = 0;
  const heartbeat = startSerializedLeaseHeartbeat(
    () => {
      refreshCount += 1;
      return Promise.resolve();
    },
    30_000,
    clock.wait,
  );

  assertEquals(clock.pending(), 1);
  clock.tick();
  await flushMicrotasks();
  assertEquals(refreshCount, 1);
  assertEquals(clock.pending(), 1);
  clock.tick();
  await flushMicrotasks();
  assertEquals(refreshCount, 2);

  await heartbeat.stop();
  assertEquals(clock.aborted(), 1);
});

Deno.test("serialized heartbeat never overlaps periodic and explicit refreshes", async () => {
  const clock = controlledHeartbeatWait();
  const refreshReleases: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let refreshCount = 0;
  const heartbeat = startSerializedLeaseHeartbeat(
    async () => {
      refreshCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => refreshReleases.push(resolve));
      inFlight -= 1;
    },
    30_000,
    clock.wait,
  );

  clock.tick();
  await flushMicrotasks();
  const explicitRefresh = heartbeat.refreshNow();
  await flushMicrotasks();
  assertEquals(refreshCount, 1);
  assertEquals(maxInFlight, 1);

  refreshReleases.shift()?.();
  await flushMicrotasks();
  assertEquals(refreshCount, 2);
  assertEquals(maxInFlight, 1);
  refreshReleases.shift()?.();
  await explicitRefresh;
  await heartbeat.stop();
});

Deno.test("serialized heartbeat retains and propagates lease loss", async () => {
  const clock = controlledHeartbeatWait();
  const heartbeat = startSerializedLeaseHeartbeat(
    () => Promise.reject(new Error("OCR queue lease lost")),
    30_000,
    clock.wait,
  );

  clock.tick();
  await flushMicrotasks();
  assertThrows(() => heartbeat.throwIfFailed(), Error, "OCR queue lease lost");
  await assertRejects(
    () => heartbeat.refreshNow(),
    Error,
    "OCR queue lease lost",
  );
  await heartbeat.stop();
});

Deno.test("serialized heartbeat stop aborts timers and awaits an in-flight refresh", async () => {
  const clock = controlledHeartbeatWait();
  let finishRefresh = () => {};
  let refreshStarted = false;
  let stopFinished = false;
  const heartbeat = startSerializedLeaseHeartbeat(
    () =>
      new Promise<void>((resolve) => {
        refreshStarted = true;
        finishRefresh = resolve;
      }),
    30_000,
    clock.wait,
  );

  clock.tick();
  await flushMicrotasks();
  assert(refreshStarted);
  const stopping = heartbeat.stop().then(() => {
    stopFinished = true;
  });
  await flushMicrotasks();
  assertEquals(stopFinished, false);
  finishRefresh();
  await stopping;
  assertEquals(stopFinished, true);
  assertEquals(clock.pending(), 0);
  await assertRejects(() => heartbeat.refreshNow(), Error, "stopped");
});
