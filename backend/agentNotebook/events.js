'use strict';

const { Client } = require('pg');
const config = require('../config');
const { MANAGE_ROLES, READ_ROLES } = require('../policy/agentCapabilities');

const CHANNEL = 'traceomics_agent_notebook';
const HEARTBEAT_MS = 15000;
const INVALIDATION = 'event: notebook-changed\ndata: {}\n\n';

// Share one database listener across the open streams in this process.
function createAgentNotebookEvents() {
  const viewers = new Set();
  let listener = null;
  let closed = false;

  function disconnect(current) {
    if (listener !== current) return;
    listener = null;
    if (current?.client) void current.client.end().catch(() => {});
    const previous = [...viewers];
    viewers.clear();
    for (const viewer of previous) viewer.close();
  }

  function subscribe(projectId, change, close) {
    if (closed) throw new Error('The notebook event stream is unavailable.');
    const viewer = { projectId, change, close };
    viewers.add(viewer);
    if (!listener) {
      const current = {};
      listener = current;
      current.ready = (async () => {
        // LISTEN needs a stable session. Keep normal request pool slots free.
        const client = new Client(config.postgresConfig());
        current.client = client;
        client.on('error', () => disconnect(current));
        client.once('end', () => disconnect(current));
        client.on('notification', ({ channel, payload }) => {
          if (channel !== CHANNEL || listener !== current) return;
          let event;
          try { event = JSON.parse(payload); } catch { return; }
          for (const subscriber of viewers) {
            if (subscriber.projectId === event?.projectId) subscriber.change(event.sandboxOwner);
          }
        });
        await client.connect();
        if (listener !== current) throw new Error('The notebook event listener was closed.');
        await client.query(`LISTEN ${CHANNEL}`);
      })().catch(error => {
        disconnect(current);
        throw error;
      });
    }
    const current = listener;
    return {
      ready: current.ready,
      unsubscribe() {
        viewers.delete(viewer);
        if (viewers.size === 0) disconnect(current);
      },
    };
  }

  return {
    subscribe,
    close() {
      closed = true;
      disconnect(listener);
    },
  };
}

function notebookEventStream({ db, events, resolveSessionUser }) {
  return async (req, res) => {
    if (req.method !== 'GET') return res.status(405).end();
    const { projectId } = req.params;
    const userId = req.user.id;
    const sandboxOwners = new Set();
    let allViewersChanged = false;
    let heartbeat = false;
    let checking = false;
    let stopped = false;
    let timer;
    let subscription;

    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      subscription?.unsubscribe();
    }

    function end() {
      stop();
      if (!res.writableEnded && !res.destroyed) res.end();
    }

    function write(message) {
      if (!res.write(message)) end();
    }

    async function flush() {
      if (!res.headersSent || stopped || checking) return;
      checking = true;
      try {
        const session = await resolveSessionUser(req);
        if (session.user?.id !== userId) return end();
        const { role } = await db.requireProjectRole(userId, projectId, READ_ROLES);
        if (stopped) return;
        const canSeeSandbox = sandboxOwners.has(String(userId))
          || (sandboxOwners.size > 0 && MANAGE_ROLES.includes(role));
        const changed = allViewersChanged || canSeeSandbox;
        const sendHeartbeat = heartbeat;
        sandboxOwners.clear();
        allViewersChanged = false;
        heartbeat = false;
        if (changed) write(INVALIDATION);
        else if (sendHeartbeat) write(': keepalive\n\n');
      } catch {
        end();
      } finally {
        checking = false;
      }
    }

    res.once('close', stop);
    try {
      await db.requireProjectRole(userId, projectId, READ_ROLES);
      if (stopped) return;
      subscription = events.subscribe(projectId, (sandboxOwner) => {
        if (sandboxOwner == null) allViewersChanged = true;
        else sandboxOwners.add(sandboxOwner);
        void flush();
      }, () => {
        if (res.headersSent) end();
        else if (!stopped) {
          stop();
          res.status(503).json({ error: 'Notebook events are unavailable.' });
        }
      });
      await subscription.ready;
      if (stopped) return;
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'private, no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      // Re-read after subscribing to cover changes during initial load or a reconnect.
      allViewersChanged = true;
      write('retry: 3000\n\n');
      if (stopped) return;
      timer = setInterval(() => { heartbeat = true; void flush(); }, HEARTBEAT_MS);
      void flush();
    } catch (error) {
      stop();
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.end();
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 503;
      return res.status(status).json({ error: status === 503 ? 'Notebook events are unavailable.' : error.message });
    }
  };
}

module.exports = { createAgentNotebookEvents, notebookEventStream };
