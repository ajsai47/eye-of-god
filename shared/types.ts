// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  agent_type: string; // e.g. "claude-code", "codex", "cursor", "custom"
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  agent_type?: string; // e.g. "claude-code", "codex", "cursor" — defaults to "unknown"
}

export interface RegisterResponse {
  id: PeerId;
  channels?: string[]; // Channel IDs the peer was auto-joined to
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Collaboration types ---

// Compound agent ID: "instanceId:agentName"
export type AgentId = string;

export interface Agent {
  id: AgentId;
  instance_id: PeerId;
  name: string;
  role: string;
  registered_at: string;
  last_seen: string;
}

export interface Channel {
  id: string;
  name: string;
  created_at: string;
}

export interface ChannelMember {
  channel_id: string;
  agent_id: string; // PeerId or AgentId
  joined_at: string;
}

export interface ChannelMessage {
  id: number;
  channel_id: string;
  from_id: string;
  tag: string; // [FINDING], [PROPOSAL], [CHALLENGE], [QUESTION]
  text: string;
  sent_at: string;
}

export interface SharedTask {
  id: number;
  channel_id: string;
  subject: string;
  description: string;
  status: "open" | "claimed" | "done";
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
}

// --- Collaboration broker API types ---

export interface RegisterAgentRequest {
  instance_id: PeerId;
  name: string;
  role?: string;
}

export interface RegisterAgentResponse {
  id: AgentId;
}

export interface UnregisterAgentRequest {
  id: AgentId;
}

export interface CreateChannelRequest {
  name: string;
}

export interface CreateChannelResponse {
  id: string;
}

export interface JoinChannelRequest {
  channel_id: string;
  agent_id: string; // PeerId or AgentId
}

export interface LeaveChannelRequest {
  channel_id: string;
  agent_id: string;
}

export interface ChannelBroadcastRequest {
  channel_id: string;
  from_id: string;
  tag?: string;
  text: string;
}

export interface ChannelMessagesRequest {
  channel_id: string;
  since?: string; // ISO timestamp for polling
  limit?: number;
}

export interface ChannelMessagesResponse {
  messages: ChannelMessage[];
}

export interface ChannelMembersRequest {
  channel_id: string;
}

export interface ChannelMembersResponse {
  members: ChannelMember[];
}

export interface CreateSharedTaskRequest {
  channel_id: string;
  subject: string;
  description?: string;
}

export interface CreateSharedTaskResponse {
  id: number;
}

export interface ClaimSharedTaskRequest {
  task_id: number;
  agent_id: string;
}

export interface UpdateSharedTaskRequest {
  task_id: number;
  status?: "open" | "claimed" | "done";
  description?: string;
}

export interface ListSharedTasksRequest {
  channel_id: string;
  status?: "open" | "claimed" | "done";
}

// --- SSE Event types ---

export interface BrokerEvent {
  type:
    | "peer:join"
    | "peer:leave"
    | "message:dm"
    | "message:channel"
    | "task:create"
    | "task:claim"
    | "task:done"
    | "init"
    | "keepalive";
  data: unknown;
  timestamp: string;
}
