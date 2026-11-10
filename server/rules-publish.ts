/**
 * Rule publication (G15): propuesta → aprobada ("pendiente de publicar") → publicada, and Revertir.
 *
 * Publishing is the ONLY runtime path that writes rules/. It is human-only (HTTP route with CSRF;
 * no MCP tool exists) and, under one file lock:
 *  1. requires a rule_change proposal in state `approved` whose stored patch still hashes to the
 *     proposed `patchHash` (what the human reviewed is what gets written);
 *  2. applies the patch to a temp copy of the CURRENT rules/ and re-runs evaluate_ruleset
 *     (scenarios + feedback replay): no schema error, no field regression, no worse unsafe-closure
 *     rate, critical false negatives, exact matches or macro-F1;
 *  3. re-verifies the human with the existing WebAuthn passkey ceremony, over a challenge bound to
 *     the exact before/after file hashes (fixtures mode: labelled demo approval only);
 *  4. backs up the touched files, writes them atomically, checks that rules/ still loads (else
 *     restores the backup), records the publication and appends an HMAC-chained audit event.
 * Revertir restores the backup under the same lock and proof, only if rules/ still holds exactly
 * what was published (an edit made since then must be resolved by a human in git).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Coordinator } from "./coordinator";
import { clearRulesCache, loadRules } from "./engine";
import { DEFAULT_RULES_DIR } from "./rules-loader";
import { readJsonFile, withFileLock, writeFileAtomic, writeJsonAtomic } from "./store/fs";
import type { ProposalRecord } from "./store/types";
import { CoordError, hashOf, nowIso, sha256 } from "./util";

export interface RulePublication {
  id: string;
  proposalId: string;
  publishedAt: string;
  publishedBy: { id: string; name: string };
  proof: "webauthn" | "demo";
  credentialId?: string;
  patchHash: string;
  files: Array<{ file: string; beforeHash: string; afterHash: string }>;
  rulesetHashBefore: string;
  rulesetHashAfter: string;
  evaluation: { baseline: Record<string, number>; candidate: Record<string, number> };
  reverted?: { at: string; by: { id: string; name: string }; proof: "webauthn" | "demo" };
}

export interface PublishProof {
  webauthn?: { nonce: string; origin: string; response: unknown };
  demo?: boolean;
}

interface Prepared {
  p: ProposalRecord;
  files: Array<{ file: string; before: string; after: string }>;
  payloadHash: string;
  patch: string;
}

const EPS = 1e-9;

/** The rule-publication service of one coordinator (rules dir injectable for tests). */
export class RulePublisher {
  readonly rulesDir: string;

  constructor(
    private readonly coord: Coordinator,
    opts: { rulesDir?: string } = {},
  ) {
    this.rulesDir = opts.rulesDir ?? DEFAULT_RULES_DIR;
  }

  private get file(): string {
    return this.coord.store.path("rule-publications", "publications.json");
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.coord.store.path("state", "rules-publish.lock"), fn, { staleMs: 60_000, timeoutMs: 120_000 });
  }

  async list(): Promise<RulePublication[]> {
    return (await readJsonFile<RulePublication[]>(this.file)) ?? [];
  }

  /** Latest publication of a proposal (reverted or not). */
  async latest(proposalId: string): Promise<RulePublication | undefined> {
    return (await this.list()).filter((x) => x.proposalId === proposalId).pop();
  }

  /** Stage of a rule_change proposal for the UI / MCP (aprobada · pendiente de publicar, publicada, revertida). */
  async stage(p: ProposalRecord): Promise<"pending" | "approved" | "published" | "reverted" | "rejected"> {
    if (p.state === "rejected" || p.state === "withdrawn") return "rejected";
    if (p.state === "draft" || p.state === "pending_review") return "pending";
    const pub = await this.latest(p.id);
    if (pub) return pub.reverted ? "reverted" : "published";
    return "approved";
  }

  private async proposal(id: string): Promise<ProposalRecord> {
    const p = await this.coord.store.getProposal(id);
    if (!p || p.kind !== "rule_change" || p.payload.kind !== "rule_change") throw new CoordError("not_found", `Sugerencia de regla ${id} no existe`);
    return p;
  }

  /** Patch + candidate files + the payload hash the passkey signs. */
  private async prepare(id: string): Promise<Prepared> {
    const p = await this.proposal(id);
    const stage = await this.stage(p);
    if (stage !== "approved" && stage !== "reverted") {
      throw new CoordError("invalid_state", stage === "published" ? "La regla ya está publicada." : "Solo se publica una sugerencia aprobada (Aprobar regla primero).");
    }
    if (p.payload.kind !== "rule_change") throw new CoordError("internal", "kind");
    const patch = await readFile(p.payload.patchFile, "utf8").catch(() => {
      throw new CoordError("not_found", "No se encontró el patch de la sugerencia.");
    });
    if (sha256(patch) !== p.payload.patchHash) throw new CoordError("approval_invalid", "El patch cambió desde que se propuso: no se publica. Pide una sugerencia nueva.");
    let candidateDir: string;
    try {
      candidateDir = await this.coord.candidateRulesDir(Promise.resolve(patch), this.rulesDir);
    } catch (err) {
      throw new CoordError("conflict", `El patch ya no aplica sobre las reglas actuales: ${(err as Error).message}`, "Pide al curador (/curar-reglas) una versión nueva de la sugerencia.");
    }
    const { patchTargets } = await import("./coordinator");
    const rels = [...new Set(patchTargets(patch).map((f) => f.replace(/^rules\//, "")))];
    const files: Prepared["files"] = [];
    for (const rel of rels) {
      if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(rel)) throw new CoordError("validation_error", `Archivo de reglas no permitido: ${rel}`);
      files.push({ file: rel, before: await readFile(join(this.rulesDir, rel), "utf8").catch(() => ""), after: await readFile(join(candidateDir, rel), "utf8") });
    }
    const payloadHash = hashOf({ op: "publish", proposalId: id, patchHash: p.payload.patchHash, files: files.map((f) => ({ file: f.file, before: sha256(f.before), after: sha256(f.after) })) });
    return { p, files, payloadHash, patch };
  }

  private async revertPlan(id: string): Promise<{ pub: RulePublication; payloadHash: string; restore: Array<{ file: string; content: string }> }> {
    const p = await this.proposal(id);
    const pub = await this.latest(p.id);
    if (!pub || pub.reverted) throw new CoordError("invalid_state", "No hay una publicación vigente de esta regla para revertir.");
    const restore: Array<{ file: string; content: string }> = [];
    for (const f of pub.files) {
      const cur = await readFile(join(this.rulesDir, f.file), "utf8").catch(() => "");
      if (sha256(cur) !== f.afterHash) throw new CoordError("conflict", `rules/${f.file} cambió después de publicar: revierte a mano con git.`);
      restore.push({ file: f.file, content: await readFile(this.coord.store.path("rule-publications", pub.id, "before", f.file), "utf8") });
    }
    return { pub, restore, payloadHash: hashOf({ op: "revert", publicationId: pub.id, files: pub.files }) };
  }

  /** Rules directories to compare for the plain-language effect (before → after of this suggestion). */
  async effectDirs(p: ProposalRecord, patch: string): Promise<{ baseDir: string; candDir: string } | undefined> {
    const pub = await this.latest(p.id);
    if (pub && !pub.reverted) {
      const { mkdtemp, readdir, copyFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const baseDir = await mkdtemp(join(tmpdir(), "coord-rules-before-"));
      for (const f of await readdir(this.rulesDir)) if (/\.ya?ml$/.test(f)) await copyFile(join(this.rulesDir, f), join(baseDir, f));
      for (const f of pub.files) await copyFile(this.coord.store.path("rule-publications", pub.id, "before", f.file), join(baseDir, f.file));
      return { baseDir, candDir: this.rulesDir };
    }
    if (!patch) return undefined;
    return { baseDir: this.rulesDir, candDir: await this.coord.candidateRulesDir(Promise.resolve(patch), this.rulesDir) };
  }

  /** WebAuthn options whose challenge is bound to exactly what will be written. */
  async options(id: string, op: "publish" | "revert"): Promise<{ nonce: string; options: unknown; payloadHash: string }> {
    const payloadHash = op === "publish" ? (await this.prepare(id)).payloadHash : (await this.revertPlan(id)).payloadHash;
    const { nonce, options } = await this.coord.webauthn.approvalOptions(`rules-${op}-${id}`, payloadHash, 0);
    return { nonce, options, payloadHash };
  }

  private async verify(op: "publish" | "revert", id: string, payloadHash: string, proof: PublishProof): Promise<{ kind: "webauthn" | "demo"; credentialId?: string }> {
    if (proof.webauthn) {
      const a = await this.coord.webauthn.verifyApproval({ batchId: `rules-${op}-${id}`, payloadHash, testVersion: 0, nonce: proof.webauthn.nonce, origin: proof.webauthn.origin, response: proof.webauthn.response as never });
      return { kind: "webauthn", credentialId: a.credentialId };
    }
    if (proof.demo && this.coord.source.kind === "fixtures") return { kind: "demo" };
    if (this.coord.source.kind === "fixtures") throw new CoordError("approval_missing", "Modo fixtures: indica demo=true (publicación de demostración) o firma con passkey.");
    throw new CoordError("approval_missing", "Publicar reglas requiere confirmar con tu passkey (Windows Hello).");
  }

  /** Re-run the evaluation; throws when the candidate regresses anything. */
  private async gate(patch: string): Promise<RulePublication["evaluation"]> {
    const ev = await this.coord.evaluateRuleset({ candidatePatch: patch, suites: ["eval_scenarios", "feedback_replay"] }, { rulesDir: this.rulesDir });
    const b = ev.baseline as Record<string, number>;
    const c = (ev.candidate ?? {}) as Record<string, number>;
    const why: string[] = [];
    if (ev.schemaErrors.length) why.push(`las reglas no cargan (${ev.schemaErrors[0]!.slice(0, 200)})`);
    if (!ev.candidate) why.push("sin evaluación del candidato");
    if (ev.regressions.length) why.push(`${ev.regressions.length} regresión(es), p. ej. ${ev.regressions[0]!.scenario}/${ev.regressions[0]!.field}`);
    if ((c.unsafeClosureRate ?? 0) > (b.unsafeClosureRate ?? 0) + EPS) why.push("cierra más conflictos reales");
    if ((c.criticalFalseNegatives ?? 0) > (b.criticalFalseNegatives ?? 0)) why.push("pierde casos críticos");
    if ((c.scenariosExactMatch ?? 0) < (b.scenariosExactMatch ?? 0)) why.push("menos escenarios exactos");
    if ((c.macroF1 ?? 0) < (b.macroF1 ?? 0) - EPS) why.push("baja el macro-F1");
    if (why.length) throw new CoordError("validation_error", `No se publica: la evaluación con las reglas actuales detecta ${why.join("; ")}.`);
    return { baseline: b, candidate: c };
  }

  async publish(id: string, proof: PublishProof, user: { id: string; name: string }): Promise<RulePublication> {
    return this.lock(async () => {
      const prep = await this.prepare(id);
      const evaluation = await this.gate(prep.patch);
      const ok = await this.verify("publish", id, prep.payloadHash, proof);
      const pubId = `RP-${nowIso(this.coord.now()).replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
      const dir = this.coord.store.path("rule-publications", pubId);
      for (const f of prep.files) {
        await mkdir(join(dir, "before"), { recursive: true });
        await mkdir(join(dir, "after"), { recursive: true });
        await writeFileAtomic(join(dir, "before", f.file), f.before);
        await writeFileAtomic(join(dir, "after", f.file), f.after);
      }
      const hashBefore = this.rulesetHash();
      for (const f of prep.files) await writeFileAtomic(join(this.rulesDir, f.file), f.after);
      clearRulesCache();
      let hashAfter: string;
      try {
        hashAfter = this.rulesetHash();
      } catch (err) {
        for (const f of prep.files) await writeFileAtomic(join(this.rulesDir, f.file), f.before);
        clearRulesCache();
        throw new CoordError("validation_error", `Las reglas publicadas no cargan; se restauró la copia: ${(err as Error).message.slice(0, 300)}`);
      }
      const pub: RulePublication = {
        id: pubId,
        proposalId: id,
        publishedAt: nowIso(this.coord.now()),
        publishedBy: { id: user.id, name: user.name },
        proof: ok.kind,
        ...(ok.credentialId ? { credentialId: ok.credentialId } : {}),
        patchHash: prep.p.payload.kind === "rule_change" ? prep.p.payload.patchHash : "",
        files: prep.files.map((f) => ({ file: f.file, beforeHash: sha256(f.before), afterHash: sha256(f.after) })),
        rulesetHashBefore: hashBefore,
        rulesetHashAfter: hashAfter,
        evaluation,
      };
      await writeJsonAtomic(this.file, [...(await this.list()), pub]);
      if (prep.p.state === "approved") await this.coord.store.transitionProposal(id, "applied", user.name, `publicada ${pubId}`);
      await this.coord.store.audit({
        actor: { type: "user", id: user.id, name: user.name },
        action: "rule.published",
        targetIds: [id, pubId],
        details: { files: pub.files.map((f) => f.file).join(","), rulesetHashBefore: hashBefore, rulesetHashAfter: hashAfter, proof: ok.kind, credentialId: ok.credentialId ?? null, payloadHash: prep.payloadHash },
      });
      return pub;
    });
  }

  async revert(id: string, proof: PublishProof, user: { id: string; name: string }): Promise<RulePublication> {
    return this.lock(async () => {
      const plan = await this.revertPlan(id);
      const ok = await this.verify("revert", id, plan.payloadHash, proof);
      for (const f of plan.restore) await writeFileAtomic(join(this.rulesDir, f.file), f.content);
      clearRulesCache();
      const hash = this.rulesetHash();
      const all = await this.list();
      const pub = all.find((x) => x.id === plan.pub.id)!;
      pub.reverted = { at: nowIso(this.coord.now()), by: { id: user.id, name: user.name }, proof: ok.kind };
      await writeJsonAtomic(this.file, all);
      await this.coord.store.audit({
        actor: { type: "user", id: user.id, name: user.name },
        action: "rule.reverted",
        targetIds: [id, pub.id],
        details: { files: pub.files.map((f) => f.file).join(","), rulesetHash: hash, proof: ok.kind, credentialId: ok.credentialId ?? null },
      });
      return pub;
    });
  }

  private rulesetHash(): string {
    return loadRules(this.rulesDir === DEFAULT_RULES_DIR ? undefined : this.rulesDir).hash;
  }
}
