const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-panel.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);

const { createResourceBudget, browserFrameCsp, browserResourceCacheLifetime, browserResourceCacheKey, waitForSharedResource } = loaded.exports;

async function main() {
  assert.match(browserFrameCsp(), /form-action 'none'/, 'Proxy iframe CSP must disable native form submissions');
  assert.doesNotMatch(browserFrameCsp(), /navigate-to/, 'Proxy iframe must not rely on the unsupported navigate-to directive');
  const budget = createResourceBudget({ maxConcurrent: 1, maxBytes: 10 });
  const releaseFirst = await budget.acquire();
  let secondAcquired = false;
  const secondPromise = budget.acquire().then(release => { secondAcquired = true; return release; });
  await Promise.resolve();
  assert.equal(budget.active, 1);
  assert.equal(budget.queued, 1);
  assert.equal(secondAcquired, false, 'concurrent materializations must respect the slot cap');
  releaseFirst();
  const releaseSecond = await secondPromise;
  assert.equal(secondAcquired, true, 'releasing a slot must wake the oldest waiter');
  releaseSecond();
  assert.equal(budget.active, 0);

  const priorityBudget = createResourceBudget({ maxConcurrent: 2, maxBytes: 10 });
  const releaseLowPriority = await priorityBudget.acquire();
  let lowPriorityStarted = false;
  const lowPriorityWaiter = priorityBudget.acquire().then(release => { lowPriorityStarted = true; return release; });
  await Promise.resolve();
  assert.equal(lowPriorityStarted, false, 'one asset slot stays available for render-critical resources');
  const releasePriority = await priorityBudget.acquire(undefined, { priority: true });
  assert.equal(priorityBudget.active, 2, 'render-critical assets can use the reserved slot');
  releasePriority();
  assert.equal(lowPriorityStarted, false, 'low-priority assets cannot consume the reserved slot');
  releaseLowPriority();
  const releaseLowPriorityWaiter = await lowPriorityWaiter;
  assert.equal(lowPriorityStarted, true);
  releaseLowPriorityWaiter();
  assert.equal(priorityBudget.active, 0);

  const releaseHighA = await priorityBudget.acquire(undefined, { priority: true });
  const releaseHighB = await priorityBudget.acquire(undefined, { priority: true });
  const startOrder = [];
  const queuedLow = priorityBudget.acquire().then(release => { startOrder.push('low'); return release; });
  const queuedHigh = priorityBudget.acquire(undefined, { priority: true }).then(release => { startOrder.push('high'); return release; });
  releaseHighA();
  const releaseQueuedHigh = await queuedHigh;
  assert.deepEqual(startOrder, ['high'], 'a queued critical request moves ahead of queued images');
  releaseHighB();
  const releaseQueuedLow = await queuedLow;
  assert.deepEqual(startOrder, ['high', 'low']);
  releaseQueuedHigh(); releaseQueuedLow();

  const abort = new AbortController();
  const releaseThird = await budget.acquire();
  const cancelled = budget.acquire(abort.signal);
  abort.abort(Error('test cancellation'));
  await assert.rejects(cancelled, /test cancellation/);
  assert.equal(budget.queued, 0, 'aborted waiters must leave the queue');
  releaseThird();

  const releaseBytes = budget.retain(7);
  assert.equal(budget.retainedBytes, 7);
  assert.throws(() => budget.retain(4), /memory limit/);
  const reservation = budget.reserve();
  reservation.add(3);
  assert.equal(budget.reservedBytes, 3);
  assert.throws(() => budget.retain(1), /memory limit/, 'in-flight bytes and retained blobs share the same cap');
  assert.throws(() => reservation.add(1), /memory limit/);
  const releaseReservedBytes = reservation.commit();
  assert.equal(budget.reservedBytes, 0);
  assert.equal(budget.retainedBytes, 10, 'completed buffers transfer their reservation into retained accounting');
  releaseReservedBytes();
  assert.equal(budget.retainedBytes, 7);
  releaseBytes();
  assert.equal(budget.retainedBytes, 0, 'revoked blobs must return their reserved bytes');
  const copyingReservation = budget.reserve();
  copyingReservation.add(4);
  copyingReservation.add(4);
  const releaseTransferred = copyingReservation.commit(4);
  assert.equal(budget.reservedBytes, 0);
  assert.equal(budget.retainedBytes, 4, 'temporary duplicate copies are charged during materialization, then reduced to the retained blob size');
  releaseTransferred();
  assert.equal(budget.retainedBytes, 0);
  const releaseAll = budget.retain(10);
  releaseAll();
  assert.throws(() => createResourceBudget({ maxConcurrent: 0 }), /limits/);

  assert.equal(browserResourceCacheLifetime({ 'cache-control': 'public, max-age=120', age: '30', vary: 'Accept, Accept-Encoding' }), 90_000,
    'static resource cache freshness must account for upstream Age');
  assert.equal(browserResourceCacheLifetime({ 'cache-control': 'public, max-age=120', 'set-cookie': 'sid=secret' }), 0,
    'responses that set cookies must not enter the panel resource cache');
  assert.equal(browserResourceCacheLifetime({ 'cache-control': 'max-age=60, no-store' }), 0);
  assert.equal(browserResourceCacheLifetime({ 'cache-control': 'max-age=60', vary: 'Accept-Language' }), 0,
    'unknown Vary dimensions must prevent reuse');
  assert.equal(browserResourceCacheLifetime({ 'cache-control': 'public, max-age=999999' }), 30 * 60 * 1000,
    'client resource cache freshness must remain capped');
  assert.equal(browserResourceCacheKey('https://assets.example/a.png#first', 'image', '*/*', 'sid=1'),
    browserResourceCacheKey('https://assets.example/a.png#second', 'image', '*/*', 'sid=1'),
    'fragments do not distinguish HTTP resource cache entries');
  assert.notEqual(browserResourceCacheKey('https://assets.example/a.png', 'image', '*/*', 'sid=1'),
    browserResourceCacheKey('https://assets.example/a.png', 'image', '*/*', 'sid=2'),
    'cookie variants must have separate cache entries');
  assert.notEqual(browserResourceCacheKey('https://assets.example/a.png', 'image', '*/*'),
    browserResourceCacheKey('https://assets.example/a.png', 'script', '*/*'),
    'resource processing types must have separate cache entries');

  const sharedController = new AbortController();
  let resolveShared;
  const sharedEntry = { controller: sharedController, waiters: 0, settled: false, promise: null };
  sharedEntry.promise = new Promise(resolve => { resolveShared = resolve; }).finally(() => { sharedEntry.settled = true; });
  const abortingWaiter = new AbortController(), survivingWaiter = new AbortController();
  const abortedResult = waitForSharedResource(sharedEntry, abortingWaiter.signal);
  const survivingResult = waitForSharedResource(sharedEntry, survivingWaiter.signal);
  abortingWaiter.abort(Error('one image was removed'));
  await assert.rejects(abortedResult, /one image was removed/);
  assert.equal(sharedController.signal.aborted, false, 'one cancelled consumer must not cancel other resource waiters');
  resolveShared('blob:shared-resource');
  assert.equal(await survivingResult, 'blob:shared-resource');
  assert.equal(sharedController.signal.aborted, false, 'settled shared loads must not be aborted during waiter cleanup');

  const orphanController = new AbortController(), orphanWaiter = new AbortController();
  const orphanEntry = { controller: orphanController, waiters: 0, settled: false, promise: new Promise(() => {}) };
  const orphanResult = waitForSharedResource(orphanEntry, orphanWaiter.signal);
  orphanWaiter.abort();
  await assert.rejects(orphanResult, /aborted/i);
  assert.equal(orphanController.signal.aborted, true, 'the shared request must stop when its last consumer cancels');

  console.log('Browser resource budget rules passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
