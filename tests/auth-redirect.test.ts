import { describe, expect, it } from "vitest";
import { waitForAuthCode } from "../server/aps/auth";

const port = () => 20000 + Math.floor(Math.random() * 20000);

describe("loopback callback: web login returns to the app", () => {
  it("redirects back to the app with login=ok and resolves the code", async () => {
    const p = port();
    const w = waitForAuthCode(p, "st4te", 10_000, "http://localhost:3000/coordinacion/x?view=a");
    await w.ready;
    const res = await fetch(`http://127.0.0.1:${p}/callback?code=abc&state=st4te`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/coordinacion/x?view=a&login=ok");
    await expect(w.code).resolves.toBe("abc");
  });

  it("redirects with login=error when Autodesk returns an error", async () => {
    const p = port();
    const w = waitForAuthCode(p, "st4te", 10_000, "http://localhost:3000/");
    await w.ready;
    const codeP = w.code.catch((e: Error) => e);
    const res = await fetch(`http://127.0.0.1:${p}/callback?error=access_denied&state=st4te`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/?login=error");
    expect(await codeP).toBeInstanceOf(Error);
  });

  it("CLI login (no redirect target) keeps the 'close this window' page", async () => {
    const p = port();
    const w = waitForAuthCode(p, "st4te", 10_000);
    await w.ready;
    const res = await fetch(`http://127.0.0.1:${p}/callback?code=abc&state=st4te`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sesión iniciada");
    await expect(w.code).resolves.toBe("abc");
  });

  it("a wrong state neither redirects nor completes the login", async () => {
    const p = port();
    const w = waitForAuthCode(p, "st4te", 10_000, "http://localhost:3000/");
    await w.ready;
    const res = await fetch(`http://127.0.0.1:${p}/callback?code=abc&state=other`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    w.code.catch(() => undefined);
    w.close();
  });
});
