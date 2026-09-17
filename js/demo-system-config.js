/* Shared in-memory system configuration simulator. Does not alter the host. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, detail: { code, message } }); };
  const defaults = { reader: { stale_threshold_sec: 30 }, processor: { max_queue_size: 10000, queue_policy: 'drop_oldest' }, camera: { enabled: false }, can_db_file: 'data/can0.json' };
  const fields = [
    { path: 'reader.stale_threshold_sec', reload: 'live', type: 'number', min: 1 },
    { path: 'processor.max_queue_size', reload: 'live', type: 'integer', min: 1 },
    { path: 'processor.queue_policy', reload: 'live', type: 'string', options: ['drop_oldest', 'reject'] },
    { path: 'camera.enabled', reload: 'reboot', type: 'boolean' },
    { path: 'can_db_file', reload: 'immutable', type: 'string' },
  ];
  function create() {
    let config = copy(defaults), sequence = 0;
    const backups = new Map(), pending = new Set();
    function snapshot() {
      return { config: copy(config), fields_schema_version: 1, fields: copy(fields), reload_levels: { live: 'Applied in demo memory', reboot: 'Pending simulated reboot', immutable: 'Cannot be changed through API' }, paths: { config: 'demo://system', reset_template: 'demo://defaults', backup_directory: 'demo://backups' }, pending_reboot_paths: [...pending], reboot_required: pending.size > 0, simulated: true };
    }
    function backup() {
      const data = copy(config);
      const meta = { id: `demo-${Date.now()}-${++sequence}`, created_at: new Date().toISOString(), size_bytes: new TextEncoder().encode(JSON.stringify(data)).length };
      backups.set(meta.id, { data, meta });
      return copy(meta);
    }
    function apply(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(422, 'invalid_config', 'Expected a JSON object');
      const changes = [];
      function visit(object, prefix = '') {
        for (const [key, value] of Object.entries(object)) {
          const path = prefix ? `${prefix}.${key}` : key;
          const field = fields.find(f => f.path === path);
          if (!field && value && typeof value === 'object' && !Array.isArray(value) && fields.some(f => f.path.startsWith(`${path}.`))) { visit(value, path); continue; }
          if (!field) fail(422, 'unsupported_field', `Unsupported demo field: ${path}`);
          if (field.reload === 'immutable') fail(422, 'immutable_field', `Immutable field: ${path}`);
          if (typeof value !== (field.type === 'integer' ? 'number' : field.type) || (typeof value === 'number' && !Number.isFinite(value)) || (field.type === 'integer' && !Number.isInteger(value)) || (field.min !== undefined && value < field.min) || (field.options && !field.options.includes(value))) fail(422, 'invalid_value', `Invalid value: ${path}`);
          const parts = path.split('.');
          const current = parts.reduce((obj, part) => obj[part], config);
          if (current !== value) changes.push({ field, parts, value });
        }
      }
      visit(patch);
      const saved = changes.length ? backup() : undefined;
      const reload = { live: [], reboot: [], immutable: [] };
      for (const { field, parts, value } of changes) {
        const parent = parts.slice(0, -1).reduce((obj, part) => obj[part], config);
        parent[parts.at(-1)] = value;
        reload[field.reload].push(field.path);
        if (field.reload === 'reboot') pending.add(field.path);
      }
      return { ...snapshot(), ok: true, changed_paths: changes.map(c => c.field.path), reload, runtime: { applied: reload.live, unavailable: [] }, ...(saved ? { backup: saved } : {}) };
    }
    return {
      snapshot, apply, reboot() { pending.clear(); },
      request(method, path) {
        if (method === 'GET' && path === '/config/system') return { status: 200, body: snapshot() };
        if (method === 'GET' && path === '/config/system/backups') return { status: 200, body: { backups: [...backups.values()].map(b => copy(b.meta)), simulated: true } };
        if (method === 'POST' && path === '/config/system/backups') return { status: 201, body: { ok: true, backup: backup(), simulated: true } };
        if (method === 'POST' && path.endsWith('/restore')) {
          const id = decodeURIComponent(path.split('/').at(-2));
          const saved = backups.get(id);
          if (!saved) fail(404, 'backup_not_found', 'Backup not found');
          const patch = copy(saved.data); delete patch.can_db_file;
          return { status: 200, body: apply(patch) };
        }
        if (method === 'POST' && path === '/config/system/reset') { const patch = copy(defaults); delete patch.can_db_file; return { status: 200, body: apply(patch) }; }
        if (method === 'POST' && path === '/config/system/reload') return { status: 200, body: { ...snapshot(), ok: true, changed_paths: [], reload: { live: fields.filter(f => f.reload === 'live').map(f => f.path), reboot: [], immutable: [] }, runtime: { applied: fields.filter(f => f.reload === 'live').map(f => f.path), unavailable: [] } } };
        fail(404, 'route_not_found', 'Unknown system configuration operation');
      },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.DemoSystemConfig = { create };
})(globalThis);
