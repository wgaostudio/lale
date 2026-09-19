import assert from 'node:assert/strict';
import test from 'node:test';
import { readSse } from '@lale/protocol';

test('SSE handles split UTF-8, CRLF, heartbeats and multiline data', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: provision_event\r\ndata: α\r\ndata: β\r\n\r\nevent: complete\ndata: {}\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readSse(stream)) frames.push(frame);
  assert.deepEqual(frames, [
    { event: 'provision_event', data: 'α\nβ' },
    { event: 'complete', data: '{}' },
  ]);
  assert.equal(stream.locked, false);
});

test('leaving an SSE stream early cancels it and releases the reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: complete\ndata: {}\n\n')); },
    cancel() { cancelled = true; },
  });
  for await (const frame of readSse(stream)) {
    assert.equal(frame.event, 'complete');
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
