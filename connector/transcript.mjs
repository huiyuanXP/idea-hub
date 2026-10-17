import { redact } from './common.mjs';

// Live Run transcript emitter. Entries are redacted and size-bounded locally,
// batched to the service and never allowed to fail the Run: every delivery
// problem is reported on stderr only.
export const TRANSCRIPT_BODY_LIMIT = 30000;
const FIELD_LIMIT = 200000, MARK = '…[truncated]';

function redactBody(value, config, root) {
  if (typeof value === 'string') return redact(root ? value.split(root + '/').join('').split(root).join('.') : value, config, FIELD_LIMIT);
  if (Array.isArray(value)) return value.map(item => redactBody(item, config, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, redactBody(item, config, root)]));
  return value;
}
function longest(value, found = { holder: null, key: null, length: -1 }) {
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length > found.length) Object.assign(found, { holder: value, key, length: item.length });
    else if (item && typeof item === 'object') longest(item, found);
  }
  return found;
}
// Redact every string, then cut the longest strings until the serialized body fits.
export function boundBody(body, config, { limit = TRANSCRIPT_BODY_LIMIT, root } = {}) {
  const value = redactBody(body && typeof body === 'object' && !Array.isArray(body) ? body : { text: String(body ?? '') }, config, root);
  let truncated = false, size = JSON.stringify(value).length;
  while (size > limit) {
    const found = longest(value);
    if (!found.holder || found.length <= MARK.length) break;
    const text = found.holder[found.key];
    // JSON escaping can expand characters; cut by the excess and re-measure.
    found.holder[found.key] = text.slice(0, Math.max(0, text.length - (size - limit) - MARK.length - 16)) + MARK;
    truncated = true;
    size = JSON.stringify(value).length;
  }
  return { body: value, truncated };
}

export function createTranscript({ config, job, send, root, batchMs = 400, maxBatch = 50, maxQueue = 2000, retries = 3, retryMs = 500, log = message => process.stderr.write(`Transcript: ${message}\n`) }) {
  const queue = [];
  let sequence = 0, dropped = 0, inflight = 0, timer = null, sending = null, stopped = false, closed = false;
  const nextId = () => `${config.installationId}:${job.id}:t${++sequence}`;
  const report = error => log(redact(error, config, 500));
  function schedule() {
    if (stopped || sending || timer || !queue.length) return;
    if (queue.length >= maxBatch) { sending = deliver(); return; }
    timer = setTimeout(() => { timer = null; if (!sending) sending = deliver(); }, batchMs);
    timer.unref?.();
  }
  async function deliver() {
    try {
      while (queue.length && !stopped) {
        if (dropped) {
          queue.unshift({ id: nextId(), kind: 'system', stepId: null, body: { text: `${dropped} transcript entries were dropped because the local queue was full` }, truncated: true });
          dropped = 0;
        }
        const batch = queue.slice(0, maxBatch);
        let attempt = 0;
        while (true) {
          inflight = batch.length;
          try {
            const response = await send(batch);
            queue.splice(0, batch.length);
            if (response?.limited) { stopped = true; queue.length = 0; log('Service transcript limit reached; later output omitted'); }
            break;
          } catch (error) {
            if (error?.status) {
              report(`delivery rejected (${error.status}${error.code ? ` ${error.code}` : ''}): ${error.message}`);
              queue.splice(0, batch.length);
              // Lost authorization or lease stops delivery; a conflicting entry only skips itself.
              if ([401, 403, 404, 410].includes(error.status) || error.code === 'LEASE_CONFLICT' || /lease/i.test(error.message || '')) { stopped = true; queue.length = 0; }
              else if (batch.length > 1) for (const entry of batch) {
                try { const response = await send([entry]); if (response?.limited) { stopped = true; queue.length = 0; break; } }
                catch (single) { if (!single?.status) { report(single?.message || single); break; } }
              }
              break;
            }
            if (++attempt > retries) { report(`delivery failed after ${retries} retries: ${error?.message || error}`); queue.splice(0, batch.length); break; }
            await new Promise(accept => setTimeout(accept, retryMs * attempt));
          } finally { inflight = 0; }
        }
        if (queue.length < maxBatch && !closed) break;
      }
    } catch (error) { report(error); }
    finally { sending = null; schedule(); }
  }
  return {
    emit(kind, body, { stepId = null, truncated = false } = {}) {
      if (stopped || closed) return null;
      try {
        const bounded = boundBody(body, config, { root });
        const entry = { id: nextId(), kind, stepId: stepId == null ? null : String(stepId).slice(0, 200), body: bounded.body, truncated: Boolean(truncated || bounded.truncated) };
        queue.push(entry);
        // Keep the queue bounded; one system entry later reports what was lost.
        while (queue.length > maxQueue) { queue.splice(inflight, 1); dropped++; }
        schedule();
        return entry.id;
      } catch (error) { report(error); return null; }
    },
    // Bounded wait: an unreachable service must not delay the Run's own completion.
    async flush(timeoutMs = 15000) {
      if (timer) { clearTimeout(timer); timer = null; }
      const deadline = Date.now() + timeoutMs;
      while (!stopped && (queue.length || sending) && Date.now() < deadline) {
        if (!sending) sending = deliver();
        let wait;
        await Promise.race([sending, new Promise(accept => { wait = setTimeout(accept, Math.max(0, deadline - Date.now())); })]);
        clearTimeout(wait);
      }
      if (queue.length && !stopped) report(`${queue.length} transcript entries were not delivered before the flush deadline`);
    },
    async close(timeoutMs) {
      try { await this.flush(timeoutMs); } finally { closed = true; if (timer) clearTimeout(timer); timer = null; }
    },
  };
}
// Owner guide/interrupt inputs, polled while a development Run is active.
export function createInputs({ config, job, bound, transcript, log = message => process.stderr.write(`Inputs: ${message}\n`) }) {
  const seen = new Set(), unacked = new Map(), waiting = [];
  let handler = null, polling = false, active = true, unsupported = false, timer;
  const report = error => log(redact(error, config, 500));
  async function poll() {
    if (polling || !active || unsupported) return;
    polling = true;
    try {
      const response = await bound(config, job, 'inputs');
      for (const input of Array.isArray(response?.inputs) ? response.inputs : []) {
        if (!input?.id || seen.has(input.id) || !['guide', 'interrupt'].includes(input.mode)) continue;
        seen.add(input.id); unacked.set(input.id, input);
        if (handler) dispatch(input); else waiting.push(input);
      }
    } catch (error) {
      if ([400, 404].includes(error.status)) unsupported = true;
      report(`poll failed: ${error.message || error}`);
    } finally { polling = false; }
  }
  function dispatch(input) {
    try { handler(input); } catch (error) { channel.ack(input.id, 'rejected', `Runner could not accept the input: ${redact(error, config, 300)}`); }
  }
  const channel = {
    start(intervalMs = 1000) { timer = setInterval(poll, intervalMs); timer.unref?.(); poll(); },
    poll,
    onInput(fn) { handler = fn; for (const input of waiting.splice(0)) dispatch(input); },
    async capabilities(capabilities) {
      try { await bound(config, job, 'capabilities', { capabilities }); } catch (error) { report(`capabilities report failed: ${error.message || error}`); }
    },
    async ack(inputId, state, reason) {
      if (!unacked.has(inputId)) return;
      unacked.delete(inputId);
      if (state === 'rejected' && reason) transcript?.emit('system', { text: `Owner input not applied: ${reason}` });
      try { await bound(config, job, 'input-ack', { inputId, state, ...(reason ? { reason: String(reason).slice(0, 500) } : {}) }); }
      catch (error) { report(`ack failed: ${error.message || error}`); }
    },
    async close(reason) {
      active = false; clearInterval(timer);
      handler = null;
      await Promise.all([...unacked.keys()].map(id => channel.ack(id, 'rejected', reason)));
    },
  };
  return channel;
}
