/**
 * X3 coordinator questions (docs/PLAN-core-features-simplified.md §3, M2).
 *
 *   .coordinator/questions.json   { version, questions: CoordinatorQuestion[] }
 *
 * The agent asks (MCP ask_coordinator); the coordinator answers in the UI
 * (POST /questions/:id/answer, human-only). A validity/action answer becomes
 * human decisions on the question's groups; an "other" answer is stored for
 * the next agent run. Open questions whose clashes changed in a newer version
 * become "stale".
 */
import { randomBytes } from "node:crypto";
import type { CoordinatorQuestion } from "./api/contract";
import type { Store } from "./store";
import { readJsonFile, writeJsonAtomic } from "./store/fs";
import { bareProjectId, CoordError } from "./util";

export interface StoredQuestion extends CoordinatorQuestion {
  projectId: string;
  modelSetId: string;
}

interface QuestionsFile {
  version: number;
  questions: StoredQuestion[];
}

export class QuestionStore {
  constructor(private readonly store: Store) {}

  private get file(): string {
    return this.store.path("questions.json");
  }

  async all(): Promise<StoredQuestion[]> {
    return (await readJsonFile<QuestionsFile>(this.file))?.questions ?? [];
  }

  async get(id: string): Promise<StoredQuestion | undefined> {
    return (await this.all()).find((q) => q.id === id);
  }

  /** Questions of one model set. */
  async forModelSet(projectId: string, modelSetId: string): Promise<StoredQuestion[]> {
    return (await this.all()).filter((q) => bareProjectId(q.projectId) === bareProjectId(projectId) && q.modelSetId === modelSetId);
  }

  async create(q: Omit<StoredQuestion, "id">): Promise<StoredQuestion> {
    return this.mutate((qs) => {
      const created: StoredQuestion = { id: `Q-${randomBytes(5).toString("hex")}`, ...q };
      qs.push(created);
      return created;
    });
  }

  async update(id: string, fn: (q: StoredQuestion) => void): Promise<StoredQuestion> {
    return this.mutate((qs) => {
      const q = qs.find((x) => x.id === id);
      if (!q) throw new CoordError("not_found", `Pregunta ${id} no existe`);
      fn(q);
      return q;
    });
  }

  /** Apply fn to many questions in one write; returns the ids it changed. */
  async updateMany(pick: (q: StoredQuestion) => boolean, fn: (q: StoredQuestion) => void): Promise<string[]> {
    return this.mutate((qs) => {
      const changed: string[] = [];
      for (const q of qs) if (pick(q)) {
        fn(q);
        changed.push(q.id);
      }
      return changed;
    });
  }

  private async mutate<T>(fn: (qs: StoredQuestion[]) => T): Promise<T> {
    return this.store.withLock(async () => {
      const cur = (await readJsonFile<QuestionsFile>(this.file)) ?? { version: 0, questions: [] };
      const result = fn(cur.questions);
      await writeJsonAtomic(this.file, { version: cur.version + 1, questions: cur.questions });
      return result;
    });
  }
}

/** Public projection (no store fields). */
export function questionView(q: StoredQuestion): CoordinatorQuestion {
  const { projectId: _p, modelSetId: _m, ...rest } = q;
  void _p;
  void _m;
  return rest;
}
