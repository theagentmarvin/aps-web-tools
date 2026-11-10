/**
 * Chat sessions of the coordination panel — one per (user, project, model set, test):
 *
 *   .coordinator/chat/<projectId>/<modelSetId>/<testKey>/<sha(userId)>.json
 *
 * Messages (ChatHistoryMessage), the Claude session UUID (for `--resume`) and timestamps.
 * User ids only, never names, tokens or the Claude login.
 */
import { createHash } from "node:crypto";
import type * as C from "../api/contract";
import { pathSegment, type Store } from "../store";
import { readJsonFile, writeJsonAtomic } from "../store/fs";
import { bareProjectId } from "../util";

export interface StoredChatSession {
  /** Our session id (also the Claude session UUID passed with --session-id / --resume). */
  sessionId: string;
  /** True once Claude Code has created that session (first message finished). */
  started?: boolean;
  userId: string;
  projectId: string;
  modelSetId: string;
  testKey: string;
  createdAt: string;
  updatedAt: string;
  messages: C.ChatHistoryMessage[];
}

export const CHAT_HISTORY_MAX = 200;

export class ChatStore {
  constructor(private readonly store: Store) {}

  path(projectId: string, modelSetId: string, testKey: string, userId: string): string {
    const user = createHash("sha256").update(userId).digest("hex").slice(0, 24);
    return this.store.path("chat", pathSegment(bareProjectId(projectId), "projectId"), pathSegment(modelSetId, "modelSetId"), pathSegment(testKey, "testKey"), `${user}.json`);
  }

  async get(projectId: string, modelSetId: string, testKey: string, userId: string): Promise<StoredChatSession | undefined> {
    return readJsonFile<StoredChatSession>(this.path(projectId, modelSetId, testKey, userId));
  }

  async put(s: StoredChatSession): Promise<void> {
    if (s.messages.length > CHAT_HISTORY_MAX) s.messages = s.messages.slice(-CHAT_HISTORY_MAX);
    await this.store.withLock(() => writeJsonAtomic(this.path(s.projectId, s.modelSetId, s.testKey, s.userId), s));
  }
}
