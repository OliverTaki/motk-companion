// SPDX-License-Identifier: AGPL-3.0-or-later

export async function hashToken(token) {
  const bytes = new TextEncoder().encode(String(token || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export class D1ControlStore {
  constructor(db) { this.db = db; }

  async upsertProject(project, tokenHash, scopes) {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(`INSERT INTO projects (project_id, spreadsheet_ref, allowed_origins_json, active_recipes_json, recovery_mode, recovery_note, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET spreadsheet_ref=excluded.spreadsheet_ref, allowed_origins_json=excluded.allowed_origins_json, active_recipes_json=excluded.active_recipes_json, recovery_mode=excluded.recovery_mode, recovery_note=excluded.recovery_note, active=1, updated_at=excluded.updated_at`)
        .bind(project.projectId, project.spreadsheetRef, JSON.stringify(project.allowedOrigins || []), JSON.stringify(project.activeRecipes || []), project.recoveryMode || 'normal', project.recoveryNote || '', now, now),
      this.db.prepare(`INSERT INTO project_tokens (token_hash, project_id, token_label, scopes_json, created_at, revoked_at)
        VALUES (?, ?, 'companion', ?, ?, NULL)
        ON CONFLICT(token_hash) DO UPDATE SET project_id=excluded.project_id, token_label=excluded.token_label, scopes_json=excluded.scopes_json, revoked_at=NULL`)
        .bind(tokenHash, project.projectId, JSON.stringify(scopes), now),
    ]);
    return this.project(project.projectId);
  }

  async project(projectId) {
    const row = await this.db.prepare('SELECT project_id, spreadsheet_ref, allowed_origins_json, active_recipes_json, recovery_mode, recovery_note, active, created_at, updated_at FROM projects WHERE project_id=?').bind(projectId).first();
    if (!row) return null;
    return { projectId: row.project_id, spreadsheetRef: row.spreadsheet_ref, allowedOrigins: JSON.parse(row.allowed_origins_json || '[]'), activeRecipes: JSON.parse(row.active_recipes_json || '[]'), recoveryMode: row.recovery_mode || 'normal', recoveryNote: row.recovery_note || '', active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async updateProject(projectId, patch) {
    const current = await this.project(projectId);
    if (!current) return null;
    const next = { spreadsheetRef: patch.spreadsheetRef ?? current.spreadsheetRef, allowedOrigins: patch.allowedOrigins ?? current.allowedOrigins, activeRecipes: patch.activeRecipes ?? current.activeRecipes, recoveryMode: patch.recoveryMode ?? current.recoveryMode, recoveryNote: patch.recoveryNote ?? current.recoveryNote };
    const now = new Date().toISOString();
    await this.db.prepare('UPDATE projects SET spreadsheet_ref=?, allowed_origins_json=?, active_recipes_json=?, recovery_mode=?, recovery_note=?, updated_at=? WHERE project_id=?')
      .bind(next.spreadsheetRef, JSON.stringify(next.allowedOrigins), JSON.stringify(next.activeRecipes), next.recoveryMode, next.recoveryNote, now, projectId).run();
    return this.project(projectId);
  }

  async authenticate(projectId, tokenHash, requiredScope) {
    const row = await this.db.prepare(`SELECT t.scopes_json, p.active FROM project_tokens t JOIN projects p ON p.project_id=t.project_id
      WHERE t.token_hash=? AND t.project_id=? AND t.revoked_at IS NULL`).bind(tokenHash, projectId).first();
    if (!row || !row.active) return false;
    return JSON.parse(row.scopes_json || '[]').includes(requiredScope);
  }

  async rotateProjectToken(projectId, tokenHash, scopes, revokeExisting = true) {
    const now = new Date().toISOString();
    const statements = [];
    if (revokeExisting) statements.push(this.db.prepare('UPDATE project_tokens SET revoked_at=? WHERE project_id=? AND revoked_at IS NULL').bind(now, projectId));
    statements.push(this.db.prepare(`INSERT INTO project_tokens (token_hash, project_id, token_label, scopes_json, created_at, revoked_at)
      VALUES (?, ?, 'companion', ?, ?, NULL) ON CONFLICT(token_hash) DO UPDATE SET project_id=excluded.project_id, token_label=excluded.token_label, scopes_json=excluded.scopes_json, created_at=excluded.created_at, revoked_at=NULL`)
      .bind(tokenHash, projectId, JSON.stringify(scopes), now));
    await this.db.batch(statements);
  }

  async addProjectToken(projectId, tokenHash, label, scopes) {
    const now = new Date().toISOString();
    await this.db.prepare(`INSERT INTO project_tokens (token_hash, project_id, token_label, scopes_json, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(token_hash) DO UPDATE SET project_id=excluded.project_id, token_label=excluded.token_label, scopes_json=excluded.scopes_json, created_at=excluded.created_at, revoked_at=NULL`)
      .bind(tokenHash, projectId, label, JSON.stringify(scopes), now).run();
  }

  async upsertUser(user) {
    const now = new Date().toISOString();
    await this.db.prepare(`INSERT INTO users (member_id, display_name, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(member_id) DO UPDATE SET display_name=excluded.display_name, email=excluded.email, updated_at=excluded.updated_at`)
      .bind(user.memberId, user.displayName || '', user.email || '', now, now).run();
    return this.db.prepare('SELECT member_id, display_name, email, created_at, updated_at FROM users WHERE member_id=?').bind(user.memberId).first();
  }

  async upsertProjectMember(member) {
    const now = new Date().toISOString();
    await this.db.prepare(`INSERT INTO project_members (project_id, member_id, role, capabilities_json, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(project_id, member_id) DO UPDATE SET role=excluded.role, capabilities_json=excluded.capabilities_json, active=1, updated_at=excluded.updated_at`)
      .bind(member.projectId, member.memberId, member.role, JSON.stringify(member.capabilities || []), now, now).run();
    return (await this.listProjectMembers(member.projectId)).find((item) => item.memberId === member.memberId);
  }

  async removeProjectMember(projectId, memberId) {
    await this.db.prepare('UPDATE project_members SET active=0, updated_at=? WHERE project_id=? AND member_id=?')
      .bind(new Date().toISOString(), projectId, memberId).run();
  }

  async listProjectMembers(projectId) {
    const result = await this.db.prepare(`SELECT m.project_id, m.member_id, u.display_name, u.email, m.role, m.capabilities_json, m.active, m.created_at, m.updated_at
      FROM project_members m JOIN users u ON u.member_id=m.member_id
      WHERE m.project_id=? AND m.active=1 ORDER BY m.updated_at DESC`).bind(projectId).all();
    return (result.results || []).map((row) => ({ projectId: row.project_id, memberId: row.member_id, displayName: row.display_name, email: row.email, role: row.role, capabilities: JSON.parse(row.capabilities_json || '[]'), active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async addAudit(entry) {
    await this.db.prepare('INSERT INTO audit_log (audit_id, project_id, action, outcome, detail_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(entry.auditId, entry.projectId || null, entry.action, entry.outcome, JSON.stringify(entry.detail || {}), entry.occurredAt).run();
  }

  async listAudit(projectId, limit = 50) {
    const query = projectId
      ? this.db.prepare('SELECT audit_id, project_id, action, outcome, detail_json, occurred_at FROM audit_log WHERE project_id=? ORDER BY occurred_at DESC LIMIT ?').bind(projectId, limit)
      : this.db.prepare('SELECT audit_id, project_id, action, outcome, detail_json, occurred_at FROM audit_log ORDER BY occurred_at DESC LIMIT ?').bind(limit);
    const result = await query.all();
    return (result.results || []).map((row) => ({ auditId: row.audit_id, projectId: row.project_id || undefined, action: row.action, outcome: row.outcome, detail: JSON.parse(row.detail_json || '{}'), occurredAt: row.occurred_at }));
  }

  async consumeRate(projectId, windowStart, limit) {
    await this.db.prepare(`INSERT INTO rate_windows (project_id, window_start, request_count) VALUES (?, ?, 1)
      ON CONFLICT(project_id, window_start) DO UPDATE SET request_count=request_count+1`).bind(projectId, windowStart).run();
    const row = await this.db.prepare('SELECT request_count FROM rate_windows WHERE project_id=? AND window_start=?').bind(projectId, windowStart).first();
    return Number(row?.request_count || 0) <= limit;
  }

  async insertEvent(event) {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO events (event_id, project_id, event_name, occurred_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(event.eventId, event.projectId, event.event, event.occurredAt, JSON.stringify(event.payload), new Date().toISOString()).run();
    return { inserted: Number(result.meta?.changes || 0) > 0, eventId: event.eventId };
  }

  async listEvents(projectId, limit) {
    const result = await this.db.prepare(`SELECT event_id, event_name, occurred_at, payload_json, created_at FROM events
      WHERE project_id=? ORDER BY created_at DESC LIMIT ?`).bind(projectId, limit).all();
    return (result.results || []).map((row) => ({ eventId: row.event_id, event: row.event_name, occurredAt: row.occurred_at, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  async insertCommand(command) {
    const now = new Date().toISOString();
    const result = await this.db.prepare(`INSERT OR IGNORE INTO commands (command_id, project_id, action, context_json, payload_json, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`).bind(command.commandId, command.projectId, command.action, JSON.stringify(command.context), JSON.stringify(command.payload), command.idempotencyKey, now).run();
    if (Number(result.meta?.changes || 0) > 0) return { inserted: true, commandId: command.commandId, status: 'queued' };
    const existing = await this.db.prepare('SELECT command_id, status FROM commands WHERE project_id=? AND idempotency_key=?').bind(command.projectId, command.idempotencyKey).first();
    return { inserted: false, commandId: existing.command_id, status: existing.status };
  }

  async command(projectId, commandId) {
    const row = await this.db.prepare(`SELECT command_id, action, context_json, payload_json, status, runtime_id, result_json, error, created_at, claimed_at, completed_at
      FROM commands WHERE project_id=? AND command_id=?`).bind(projectId, commandId).first();
    if (!row) return null;
    return { commandId: row.command_id, action: row.action, context: JSON.parse(row.context_json), payload: JSON.parse(row.payload_json), status: row.status, runtimeId: row.runtime_id || '', result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error || '', createdAt: row.created_at, claimedAt: row.claimed_at || undefined, completedAt: row.completed_at || undefined };
  }

  async claimCommand(projectId, runtimeId, leaseSeconds = 300) {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - (Math.max(30, Number(leaseSeconds || 300)) * 1000)).toISOString();
    const row = await this.db.prepare(`UPDATE commands SET status='claimed', runtime_id=?, claimed_at=?
      WHERE command_id=(SELECT command_id FROM commands WHERE project_id=? AND (status='queued' OR (status='claimed' AND claimed_at<=?)) ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at ASC LIMIT 1)
      AND (status='queued' OR (status='claimed' AND claimed_at<=?))
      RETURNING command_id, project_id, action, context_json, payload_json, status, created_at`).bind(runtimeId, now, projectId, staleBefore, staleBefore).first();
    if (!row) return null;
    return { commandId: row.command_id, projectId: row.project_id, action: row.action, context: JSON.parse(row.context_json), payload: JSON.parse(row.payload_json), status: row.status, createdAt: row.created_at };
  }

  async acknowledgeCommand(projectId, commandId, runtimeId, status, result, error = '') {
    const completedAt = new Date().toISOString();
    const update = await this.db.prepare(`UPDATE commands SET status=?, result_json=?, error=?, completed_at=?
      WHERE command_id=? AND project_id=? AND status='claimed' AND runtime_id=?`).bind(status, JSON.stringify(result || {}), error || null, completedAt, commandId, projectId, runtimeId).run();
    return Number(update.meta?.changes || 0) > 0;
  }

  async listCommands(projectId, limit = 50) {
    const result = await this.db.prepare(`SELECT command_id, action, context_json, payload_json, status, runtime_id, result_json, error, created_at, claimed_at, completed_at
      FROM commands WHERE project_id=? ORDER BY created_at DESC LIMIT ?`).bind(projectId, limit).all();
    return (result.results || []).map((row) => ({ commandId: row.command_id, action: row.action, context: JSON.parse(row.context_json), payload: JSON.parse(row.payload_json), status: row.status, runtimeId: row.runtime_id || '', result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error || '', createdAt: row.created_at, claimedAt: row.claimed_at || undefined, completedAt: row.completed_at || undefined }));
  }

  async queueDelivery(eventId, projectId, target = 'google-sheets') {
    const now = new Date().toISOString();
    await this.db.prepare(`INSERT OR IGNORE INTO event_deliveries (event_id, project_id, target, status, attempts, next_attempt_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)`).bind(eventId, projectId, target, now, now).run();
  }

  async markDelivery(eventId, status, error = '') {
    const now = new Date().toISOString();
    const retryAt = new Date(Date.now() + 60000).toISOString();
    await this.db.prepare(`UPDATE event_deliveries SET status=?, attempts=attempts+1, last_error=?, next_attempt_at=?, updated_at=? WHERE event_id=?`)
      .bind(status, error || null, status === 'delivered' ? now : retryAt, now, eventId).run();
  }

  async pendingDeliveries(limit = 25) {
    const result = await this.db.prepare(`SELECT d.event_id, d.project_id, d.attempts, e.payload_json, p.spreadsheet_ref
      FROM event_deliveries d JOIN events e ON e.event_id=d.event_id JOIN projects p ON p.project_id=d.project_id
      WHERE d.status!='delivered' AND d.next_attempt_at<=? AND p.active=1 ORDER BY d.updated_at ASC LIMIT ?`)
      .bind(new Date().toISOString(), limit).all();
    return (result.results || []).map((row) => ({ eventId: row.event_id, projectId: row.project_id, attempts: Number(row.attempts || 0), event: JSON.parse(row.payload_json), project: { projectId: row.project_id, spreadsheetRef: row.spreadsheet_ref } }));
  }
}

export class MemoryControlStore {
  constructor() { this.projects = new Map(); this.tokens = new Map(); this.events = new Map(); this.commands = new Map(); this.rates = new Map(); this.deliveries = new Map(); this.audit = []; }
  async upsertProject(project, tokenHash, scopes) { const now = new Date().toISOString(); const value = { ...project, active: true, createdAt: this.projects.get(project.projectId)?.createdAt || now, updatedAt: now }; this.projects.set(project.projectId, value); this.tokens.set(tokenHash, { projectId: project.projectId, scopes }); return value; }
  async project(projectId) { return this.projects.get(projectId) || null; }
  async updateProject(projectId, patch) { const current = this.projects.get(projectId); if (!current) return null; const next = { ...current, ...structuredClone(patch), projectId, updatedAt: new Date().toISOString() }; this.projects.set(projectId, next); return next; }
  async authenticate(projectId, tokenHash, requiredScope) { const token = this.tokens.get(tokenHash); return Boolean(this.projects.get(projectId)?.active && token?.projectId === projectId && token.scopes.includes(requiredScope)); }
  async rotateProjectToken(projectId, tokenHash, scopes, revokeExisting = true) { if (revokeExisting) for (const [hash, token] of this.tokens) if (token.projectId === projectId) this.tokens.delete(hash); this.tokens.set(tokenHash, { projectId, scopes }); }
  async addProjectToken(projectId, tokenHash, label, scopes) { this.tokens.set(tokenHash, { projectId, label, scopes }); }
  async upsertUser(user) { const now = new Date().toISOString(); const current = this.users?.get(user.memberId); if (!this.users) this.users = new Map(); const saved = { ...current, ...structuredClone(user), createdAt: current?.createdAt || now, updatedAt: now }; this.users.set(user.memberId, saved); return saved; }
  async upsertProjectMember(member) { if (!this.members) this.members = new Map(); const now = new Date().toISOString(); const key = `${member.projectId}:${member.memberId}`; const current = this.members.get(key); const saved = { ...structuredClone(member), active: true, createdAt: current?.createdAt || now, updatedAt: now }; this.members.set(key, saved); return saved; }
  async removeProjectMember(projectId, memberId) { if (!this.members) return; const key = `${projectId}:${memberId}`; const current = this.members.get(key); if (current) this.members.set(key, { ...current, active: false, updatedAt: new Date().toISOString() }); }
  async listProjectMembers(projectId) { if (!this.members) return []; return [...this.members.values()].filter((member) => member.projectId === projectId && member.active !== false).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((member) => structuredClone(member)); }
  async addAudit(entry) { this.audit.push(structuredClone(entry)); }
  async listAudit(projectId, limit = 50) { return this.audit.filter((entry) => !projectId || entry.projectId === projectId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit); }
  async consumeRate(projectId, windowStart, limit) { const key = `${projectId}:${windowStart}`; const count = (this.rates.get(key) || 0) + 1; this.rates.set(key, count); return count <= limit; }
  async insertEvent(event) { if (this.events.has(event.eventId)) return { inserted: false, eventId: event.eventId }; this.events.set(event.eventId, { ...event, createdAt: new Date().toISOString() }); return { inserted: true, eventId: event.eventId }; }
  async listEvents(projectId, limit) { return [...this.events.values()].filter((event) => event.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(({ projectId: _projectId, ...event }) => event); }
  async insertCommand(command) { const existing = [...this.commands.values()].find((item) => item.projectId === command.projectId && item.idempotencyKey === command.idempotencyKey); if (existing) return { inserted: false, commandId: existing.commandId, status: existing.status }; const value = { ...structuredClone(command), status: 'queued', createdAt: new Date().toISOString() }; this.commands.set(value.commandId, value); return { inserted: true, commandId: value.commandId, status: value.status }; }
  async command(projectId, commandId) { const item = this.commands.get(commandId); return item?.projectId === projectId ? structuredClone(item) : null; }
  async claimCommand(projectId, runtimeId, leaseSeconds = 300) { const staleBefore = new Date(Date.now() - (Math.max(30, Number(leaseSeconds || 300)) * 1000)).toISOString(); const command = [...this.commands.values()].filter((item) => item.projectId === projectId && (item.status === 'queued' || (item.status === 'claimed' && item.claimedAt <= staleBefore))).sort((a, b) => (a.status === b.status ? a.createdAt.localeCompare(b.createdAt) : a.status === 'queued' ? -1 : 1))[0]; if (!command) return null; Object.assign(command, { status: 'claimed', runtimeId, claimedAt: new Date().toISOString() }); return structuredClone(command); }
  async acknowledgeCommand(projectId, commandId, runtimeId, status, result, error = '') { const command = this.commands.get(commandId); if (!command || command.projectId !== projectId || command.status !== 'claimed' || command.runtimeId !== runtimeId) return false; Object.assign(command, { status, result: structuredClone(result || {}), error, completedAt: new Date().toISOString() }); return true; }
  async listCommands(projectId, limit = 50) { return [...this.commands.values()].filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((item) => structuredClone(item)); }
  async queueDelivery(eventId, projectId, target = 'google-sheets') { if (!this.deliveries.has(eventId)) this.deliveries.set(eventId, { eventId, projectId, target, status: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
  async markDelivery(eventId, status, error = '') { const current = this.deliveries.get(eventId); if (!current) return; this.deliveries.set(eventId, { ...current, status, attempts: current.attempts + 1, lastError: error, nextAttemptAt: status === 'delivered' ? new Date().toISOString() : new Date(Date.now() + 60000).toISOString(), updatedAt: new Date().toISOString() }); }
  async pendingDeliveries(limit = 25) { const now = new Date().toISOString(); return [...this.deliveries.values()].filter((item) => item.status !== 'delivered' && item.nextAttemptAt <= now && this.projects.get(item.projectId)?.active).slice(0, limit).map((item) => ({ ...item, event: this.events.get(item.eventId)?.payload, project: this.projects.get(item.projectId) })); }
}
