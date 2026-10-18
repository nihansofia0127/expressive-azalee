const eventTypes = new Set([
  'connection.state', 'connection.failed', 'session.started', 'turn.started',
  'turn.completed', 'turn.failed', 'tool.started', 'tool.completed',
  'approval.required', 'user_input.required', 'request.resolved', 'item.started', 'item.completed', 'agent.event',
  'activity.intent',
  'activity.reporter.unavailable',
]);

const safeCategories = new Set(['image_generation', 'document_generation', 'email_draft', 'email_send', 'file_delete']);
const safeActivityLabels = new Set(['IDLE', 'WORKING', 'CODING', 'PAINTING', 'WRITING', 'EMAILING', 'DELETING', 'WAITING', 'REVIEW', 'FAILED']);
const safeEvidenceSources = new Set(['app_server_plan', 'agent_report']);
const safeEvidenceStrengths = new Set(['reported']);
const safeExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'md', 'txt', 'rtf', 'doc', 'docx', 'odt']);
const safeCommandKinds = new Set(['rm', 'unlink', 'rmdir', 'git', 'apply_patch', 'read', 'listFiles', 'search', 'unknown']);

function sanitizeActivity(value) {
  if (!value || typeof value !== 'object') return undefined;
  const operationCategory = safeCategories.has(value.operationCategory) ? value.operationCategory : null;
  const artifactExtensions = Array.isArray(value.artifactExtensions)
    ? [...new Set(value.artifactExtensions.filter((extension) => typeof extension === 'string' && safeExtensions.has(extension.toLowerCase())).map((extension) => extension.toLowerCase()))].slice(0, 12)
    : [];
  const changeKinds = Array.isArray(value.changeKinds)
    ? [...new Set(value.changeKinds.filter((kind) => ['add', 'update', 'delete'].includes(kind)))].slice(0, 8)
    : [];
  const commandKinds = Array.isArray(value.commandKinds)
    ? [...new Set(value.commandKinds.filter((kind) => safeCommandKinds.has(kind)))].slice(0, 8)
    : [];
  const category = safeActivityLabels.has(value.category) ? value.category : null;
  const evidenceSource = safeEvidenceSources.has(value.evidenceSource) ? value.evidenceSource : null;
  const evidenceStrength = safeEvidenceStrengths.has(value.evidenceStrength) ? value.evidenceStrength : null;
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : null;
  const stage = value.stage === 'intended' || value.stage === 'executing' || value.stage === 'completed' || value.stage === 'failed'
    ? value.stage
    : null;
  const acceptedCategory = category && evidenceSource
    && (evidenceSource !== 'agent_report' || ['CODING', 'WRITING', 'DELETING'].includes(category))
    ? category
    : null;
  return Object.freeze({
    operationCategory, artifactExtensions, changeKinds, commandKinds,
    ...(acceptedCategory ? { category: acceptedCategory } : {}),
    ...(evidenceSource ? { evidenceSource } : {}),
    ...(evidenceStrength ? { evidenceStrength } : {}),
    ...(confidence !== null && evidenceSource !== 'agent_report' ? { confidence } : {}),
    ...(stage ? { stage } : {}),
    ...(value.predicted === true ? { predicted: true } : {}),
  });
}

/** Validates and distributes normalized agent events; contains no agent protocol handling. */
export function createEventCollector() {
  const listeners = new Set();
  const seen = new Set();
  const recent = [];
  let latest = null;
  return {
    accept(input) {
      if (!input || typeof input !== 'object' || !eventTypes.has(input.eventType)) return false;
      if (typeof input.eventId !== 'string' || typeof input.agentType !== 'string') return false;
      if (seen.has(input.eventId)) return false;
      seen.add(input.eventId);
      recent.push(input.eventId);
      if (recent.length > 512) seen.delete(recent.shift());
      const metadataInput = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
      const activity = sanitizeActivity(metadataInput.activity);
      latest = Object.freeze({
        eventId: input.eventId,
        timestamp: input.timestamp,
        agentType: input.agentType,
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
        turnId: typeof input.turnId === 'string' ? input.turnId : null,
        eventType: input.eventType,
        lifecycleStatus: typeof input.lifecycleStatus === 'string' ? input.lifecycleStatus : null,
        toolName: typeof input.toolName === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(input.toolName) ? input.toolName : null,
        requestId: typeof input.requestId === 'string' ? input.requestId : null,
        metadata: Object.freeze({
          sourceMethod: typeof metadataInput.sourceMethod === 'string' ? metadataInput.sourceMethod.slice(0, 80) : null,
          itemType: typeof metadataInput.itemType === 'string' ? metadataInput.itemType.slice(0, 40) : null,
          status: typeof metadataInput.status === 'string' ? metadataInput.status.slice(0, 40) : null,
          reason: typeof metadataInput.reason === 'string' ? metadataInput.reason.slice(0, 40) : null,
          synthetic: metadataInput.synthetic === true,
          ...(activity ? { activity } : {}),
        }),
      });
      for (const listener of listeners) listener(latest);
      return true;
    },
    getLatest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
