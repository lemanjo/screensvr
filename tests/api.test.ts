import { afterEach, expect, it, vi } from "vitest";
import { api, setCSRF } from "../web/src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setCSRF("");
});

it("only sends a JSON content type when there is a JSON request body", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  setCSRF("test-csrf");
  for (const options of [
    {},
    { method: "POST" },
    { method: "DELETE" },
    { method: "POST", body: "" },
    { method: "POST", body: null },
  ]) {
    await api("/api/example", options);
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/example",
      expect.objectContaining({
        headers: { "X-CSRF-Token": "test-csrf" },
      }),
    );
  }
  await api("/api/example", {
    method: "POST",
    body: JSON.stringify({ name: "Olohuone" }),
  });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/example",
    expect.objectContaining({
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "test-csrf",
      },
    }),
  );
  await api("/api/example", { method: "POST", body: new FormData() });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/example",
    expect.objectContaining({
      headers: { "X-CSRF-Token": "test-csrf" },
    }),
  );
});
