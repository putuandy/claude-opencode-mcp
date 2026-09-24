import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SecurityConfigSchema } from "../../src/config/config.js";
import { buildPermissions, PROFILE_CAPABILITIES } from "../../src/security/policy.js";

describe("buildPermissions", () => {
  it("keeps read-only profiles fully read-only", () => {
    for (const profile of ["read", "review", "test"] as const) {
      const permissions = buildPermissions(profile, DEFAULT_CONFIG.security);
      expect(permissions.edit).toBe("deny");
      if (profile === "test") {
        expect(permissions.bash).toEqual(expect.objectContaining({ "*": "allow" }));
      } else {
        expect(permissions.bash).toBe("deny");
      }
      expect(permissions.task).toBe("deny");
      expect(permissions.question).toBe("deny");
      expect(permissions.external_directory).toBe("deny");
    }
  });

  it("gives coder edit and bash but denies git commit/push", () => {
    const permissions = buildPermissions("code", DEFAULT_CONFIG.security);
    expect(permissions.edit).toEqual(expect.objectContaining({ "*": "allow" }));
    const bash = permissions.bash as Record<string, string>;
    expect(bash["*"]).toBe("allow");
    expect(bash["git push*"]).toBe("deny");
    expect(bash["git commit*"]).toBe("deny");
  });

  it("protects env and credential files by default", () => {
    const permissions = buildPermissions("code", DEFAULT_CONFIG.security);
    expect(permissions.read).toEqual(
      expect.objectContaining({ "*.env": "deny", "*.env.*": "deny" }),
    );
    expect(permissions.edit).toEqual(expect.objectContaining({ "*.env": "deny" }));
    expect(permissions.read).toEqual(expect.objectContaining({ "*.env.example": "allow" }));
  });

  it("respects security options", () => {
    const security = SecurityConfigSchema.parse({
      protectEnvFiles: false,
      denyGitPush: false,
      denyGitCommit: false,
      externalDirectory: "allow",
    });
    const permissions = buildPermissions("code", security);
    expect(permissions.read).toBe("allow");
    expect(permissions.external_directory).toBe("allow");
    const bash = permissions.bash as Record<string, string>;
    expect(bash["git push*"]).toBeUndefined();
    expect(bash["git commit*"]).toBeUndefined();
  });

  it("never emits ask rules (headless bridge)", () => {
    const permissions = buildPermissions("code", DEFAULT_CONFIG.security);
    const check = (value: unknown): void => {
      if (value === "ask") throw new Error("ask rule found");
      if (typeof value === "object" && value) {
        for (const nested of Object.values(value)) check(nested);
      }
    };
    check(permissions);
  });
});

describe("profile capabilities", () => {
  it("matches the PRD agent matrix", () => {
    expect(PROFILE_CAPABILITIES.read).toEqual({
      readOnly: true,
      canEdit: false,
      canRunBash: false,
    });
    expect(PROFILE_CAPABILITIES.review).toEqual({
      readOnly: true,
      canEdit: false,
      canRunBash: false,
    });
    expect(PROFILE_CAPABILITIES.code).toEqual({ readOnly: false, canEdit: true, canRunBash: true });
    expect(PROFILE_CAPABILITIES.test).toEqual({ readOnly: true, canEdit: false, canRunBash: true });
  });
});
