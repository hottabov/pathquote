import { describe, it, expect } from "vitest";
import {
  userEmailSchema,
  userNameSchema,
  userPhoneSchema,
  userRoleSchema,
  userRegionCodeSchema,
  userPasswordSchema,
  requiredPasswordSchema,
  createUserSchema,
  updateUserSchema,
  setUserPasswordSchema,
  canModifyUser,
  canSetAvatar,
  type ModifiableUser,
} from "../src/lib/validation/users";
import { accepts, rejects } from "./helpers/schema";

describe("userEmailSchema", () => {
  accepts(userEmailSchema, [["a valid email, trimmed and lowercased", "  Foo@Bar.COM  ", "foo@bar.com"]]);

  rejects(userEmailSchema, [
    ["an invalid email", "not-an-email"],
    // > 200 chars total
    ["an email over 200 characters", `${"a".repeat(195)}@x.com`],
  ]);
});

describe("userNameSchema", () => {
  accepts(userNameSchema, [
    ["a missing name, collapsed to undefined", undefined, undefined],
    ["a null name, collapsed to undefined", null, undefined],
    ["a blank name, collapsed to undefined", "", undefined],
    ["a whitespace-only name, collapsed to undefined", "   ", undefined],
    ["a normal name", "Jane Smith"],
    ["a name at exactly the 120 character bound", "A".repeat(120)],
  ]);

  rejects(userNameSchema, [["a name over 120 characters", "A".repeat(121)]]);
});

describe("userPhoneSchema", () => {
  accepts(userPhoneSchema, [
    ["a missing phone, collapsed to undefined", undefined, undefined],
    ["a null phone, collapsed to undefined", null, undefined],
    ["a blank phone, collapsed to undefined", "", undefined],
    ["a whitespace-only phone, collapsed to undefined", "   ", undefined],
    ["a normal phone number, trimmed", "  0400 000 000  ", "0400 000 000"],
    ["a phone at exactly the 40 character bound", "1".repeat(40)],
  ]);

  rejects(userPhoneSchema, [["a phone over 40 characters", "1".repeat(41)]]);
});

describe("userRoleSchema", () => {
  accepts(userRoleSchema, [
    ["ADMIN", "ADMIN"],
    ["MANAGER", "MANAGER"],
    ["DEVELOPER", "DEVELOPER"],
  ]);

  rejects(userRoleSchema, [
    ["a role that isn't one of the known ones", "SUPERADMIN"],
    ["a blank role", ""],
  ]);
});

describe("userRegionCodeSchema", () => {
  accepts(userRegionCodeSchema, [
    ["a missing code, collapsed to null", undefined, null],
    ["a null code, collapsed to null", null, null],
    ["a blank code, collapsed to null", "", null],
    ["a whitespace-only code, collapsed to null", "   ", null],
    ["a lowercase code, normalized to uppercase", "au", "AU"],
    ["a 2-letter code", "AU"],
    ["a 3-letter code", "USA"],
  ]);

  rejects(userRegionCodeSchema, [["a code with digits", "A1"]]);
});

describe("userPasswordSchema (optional)", () => {
  accepts(userPasswordSchema, [
    ["a missing password, collapsed to undefined", undefined, undefined],
    ["a null password, collapsed to undefined", null, undefined],
    ["a blank password, collapsed to undefined", "", undefined],
    ["a whitespace-only password, collapsed to undefined", "   ", undefined],
    ["a password at exactly 10 characters", "1234567890"],
    ["a password at exactly 200 characters", "a".repeat(200)],
  ]);

  rejects(userPasswordSchema, [
    ["a password shorter than 10 characters", "short1234"],
    ["a password over 200 characters", "a".repeat(201)],
  ]);
});

describe("requiredPasswordSchema", () => {
  accepts(requiredPasswordSchema, [["a valid password", "a-long-enough-password"]]);

  rejects(requiredPasswordSchema, [
    ["a missing password", undefined],
    ["a blank password", ""],
    ["a password shorter than 10 characters", "short1234"],
  ]);
});

describe("createUserSchema", () => {
  const base = {
    email: "new.user@example.com",
    name: "New User",
    phone: "0400 000 000",
    role: "MANAGER",
    regionCode: "AU",
    password: "a-valid-password",
  };

  it("accepts a fully populated valid submission", () => {
    const result = createUserSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe("0400 000 000");
  });

  it("accepts an omitted phone", () => {
    const result = createUserSchema.safeParse({ ...base, phone: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBeUndefined();
  });

  it("rejects a too-long phone", () => {
    expect(createUserSchema.safeParse({ ...base, phone: "1".repeat(41) }).success).toBe(false);
  });

  it("accepts an omitted password and region (magic-link-only, no region)", () => {
    const result = createUserSchema.safeParse({
      email: base.email,
      name: base.name,
      role: base.role,
      regionCode: "",
      password: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.password).toBeUndefined();
      expect(result.data.regionCode).toBeNull();
    }
  });

  it("rejects an invalid email", () => {
    expect(createUserSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });

  it("rejects an invalid role", () => {
    expect(createUserSchema.safeParse({ ...base, role: "OWNER" }).success).toBe(false);
  });

  it("rejects a too-short password when one is provided", () => {
    expect(createUserSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
  });
});

describe("updateUserSchema", () => {
  const base = { name: "Jane", phone: "0400 000 000", role: "ADMIN", regionCode: "US" };

  it("accepts a fully populated valid submission", () => {
    const result = updateUserSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe("0400 000 000");
    }
  });

  // The details form no longer carries the active flag — it has its own action
  // and button (`setUserActive`). This is the regression that mattered: an
  // absent checkbox and an unticked one submit the same nothing, so while the
  // field lived here, any caller that stopped sending it revoked access on
  // every save. Now the schema has no such field to misread.
  it("ignores an active flag a stale caller still sends", () => {
    const result = updateUserSchema.safeParse({ ...base, active: "on" });
    expect(result.success).toBe(true);
    if (result.success) expect("active" in result.data).toBe(false);
  });

  it("rejects an invalid role", () => {
    expect(updateUserSchema.safeParse({ ...base, role: "OWNER" }).success).toBe(false);
  });
});

describe("setUserPasswordSchema", () => {
  accepts(setUserPasswordSchema, [["a valid password", { password: "a-valid-password" }]]);

  rejects(setUserPasswordSchema, [
    ["a missing password", {}],
    ["a too-short password", { password: "short" }],
  ]);
});

describe("canModifyUser", () => {
  function admin(overrides: Partial<ModifiableUser> = {}): ModifiableUser {
    return { id: "user-admin", role: "ADMIN", active: true, ...overrides };
  }
  function manager(overrides: Partial<ModifiableUser> = {}): ModifiableUser {
    return { id: "user-manager", role: "MANAGER", active: true, ...overrides };
  }

  it("blocks an admin from deactivating their own account", () => {
    const target = admin();
    const result = canModifyUser(target.id, target, { active: false }, 3);
    expect(result).toBe("You can't deactivate your own account");
  });

  it("blocks an admin from demoting themselves", () => {
    const target = admin();
    const result = canModifyUser(target.id, target, { role: "MANAGER" }, 3);
    expect(result).toBe("You can't remove your own admin role");
  });

  it("allows an admin to edit their own name/region without touching role/active", () => {
    const target = admin();
    // No `role`/`active` key at all — e.g. a name-only change.
    const result = canModifyUser(target.id, target, {}, 3);
    expect(result).toBeNull();
  });

  it("allows an admin to keep their own role/active unchanged explicitly", () => {
    const target = admin();
    const result = canModifyUser(target.id, target, { role: "ADMIN", active: true }, 3);
    expect(result).toBeNull();
  });

  it("blocks deactivating the last active admin, even by a different actor", () => {
    const target = admin();
    const result = canModifyUser("some-other-admin", target, { active: false }, 1);
    expect(result).toBe("Can't deactivate the last active admin");
  });

  it("blocks demoting the last active admin, even by a different actor", () => {
    const target = admin();
    const result = canModifyUser("some-other-admin", target, { role: "MANAGER" }, 1);
    expect(result).toBe("Can't demote the last active admin");
  });

  it("allows deactivating an admin when other active admins exist", () => {
    const target = admin();
    const result = canModifyUser("some-other-admin", target, { active: false }, 2);
    expect(result).toBeNull();
  });

  it("allows demoting an admin when other active admins exist", () => {
    const target = admin();
    const result = canModifyUser("some-other-admin", target, { role: "MANAGER" }, 2);
    expect(result).toBeNull();
  });

  it("does not apply the last-admin guard to an already-inactive admin", () => {
    const target = admin({ active: false });
    // activeAdminCount counts *active* admins, so an inactive target isn't
    // counted here — nothing blocks re-activating or role-changing it.
    const result = canModifyUser("some-other-admin", target, { role: "MANAGER" }, 0);
    expect(result).toBeNull();
  });

  it("does not apply the last-admin guard to a manager", () => {
    const target = manager();
    const result = canModifyUser("some-other-admin", target, { active: false }, 1);
    expect(result).toBeNull();
  });

  it("allows a normal deactivation of a manager by an admin", () => {
    const target = manager();
    const result = canModifyUser("some-other-admin", target, { active: false }, 3);
    expect(result).toBeNull();
  });

  it("allows promoting a manager to admin", () => {
    const target = manager();
    const result = canModifyUser("some-other-admin", target, { role: "ADMIN" }, 3);
    expect(result).toBeNull();
  });

  it("prioritizes the self-deactivation message over the last-admin message when both apply", () => {
    const target = admin();
    const result = canModifyUser(target.id, target, { active: false }, 1);
    expect(result).toBe("You can't deactivate your own account");
  });

  // DEVELOPER carries the same admin rights as ADMIN (see isAdminRole),
  // so every safeguard above must treat it identically.
  function developer(overrides: Partial<ModifiableUser> = {}): ModifiableUser {
    return { id: "user-developer", role: "DEVELOPER", active: true, ...overrides };
  }

  it("blocks a developer from demoting themselves", () => {
    const target = developer();
    const result = canModifyUser(target.id, target, { role: "MANAGER" }, 3);
    expect(result).toBe("You can't remove your own admin role");
  });

  it("blocks deactivating the last active admin-rights user when they're a developer", () => {
    const target = developer();
    const result = canModifyUser("some-other-admin", target, { active: false }, 1);
    expect(result).toBe("Can't deactivate the last active admin");
  });

  it("blocks demoting the last active admin-rights user when they're a developer", () => {
    const target = developer();
    const result = canModifyUser("some-other-admin", target, { role: "MANAGER" }, 1);
    expect(result).toBe("Can't demote the last active admin");
  });

  it("counts a developer and an admin as interchangeable for the last-admin guard", () => {
    // One active admin left (the developer isn't it) — demoting the admin is
    // still allowed because a developer with the same rights remains.
    const target = admin();
    const result = canModifyUser("some-other-admin", target, { role: "MANAGER" }, 2);
    expect(result).toBeNull();
  });

  it("allows promoting a manager to developer", () => {
    const target = manager();
    const result = canModifyUser("some-other-admin", target, { role: "DEVELOPER" }, 3);
    expect(result).toBeNull();
  });
});

describe("canSetAvatar", () => {
  it("allows an ADMIN to set anyone's avatar", () => {
    expect(canSetAvatar("admin-1", "ADMIN", "other-user")).toBe(true);
  });

  it("allows an ADMIN to set their own avatar", () => {
    expect(canSetAvatar("admin-1", "ADMIN", "admin-1")).toBe(true);
  });

  it("allows a MANAGER to set their own avatar", () => {
    expect(canSetAvatar("manager-1", "MANAGER", "manager-1")).toBe(true);
  });

  it("refuses a MANAGER setting someone else's avatar", () => {
    expect(canSetAvatar("manager-1", "MANAGER", "other-user")).toBe(false);
  });

  it("allows a DEVELOPER to set anyone's avatar, same as an ADMIN", () => {
    expect(canSetAvatar("dev-1", "DEVELOPER", "other-user")).toBe(true);
  });
});
