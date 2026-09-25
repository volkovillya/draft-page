import { describe, expect, it } from "vitest";
import { databaseConfigFromEnv, sslModeFromEnv } from "@/server/db/env-config";

describe("sslModeFromEnv", () => {
  it("maps the documented values and rejects anything else", () => {
    expect(sslModeFromEnv(undefined)).toBe(false);
    expect(sslModeFromEnv("")).toBe(false);
    expect(sslModeFromEnv("false")).toBe(false);
    expect(sslModeFromEnv("true")).toBe("require");
    expect(sslModeFromEnv("require")).toBe("require");
    expect(sslModeFromEnv("verify-full")).toBe("verify-full");
    expect(() => sslModeFromEnv("yes")).toThrow(/DRAFTPAGE_DATABASE_SSL/);
  });
});

describe("databaseConfigFromEnv", () => {
  it("uses the URL when it is set (local development)", () => {
    expect(databaseConfigFromEnv({ DRAFTPAGE_DATABASE_URL: "postgres://u:p@h:5/d" })).toEqual({
      connection: "postgres://u:p@h:5/d",
      ssl: false,
    });
  });

  it("builds fields from separate variables (AWS), without ever composing a URL", () => {
    const config = databaseConfigFromEnv({
      DRAFTPAGE_DB_HOST: "db.example.eu-north-1.rds.amazonaws.com",
      DRAFTPAGE_DB_NAME: "draftpage",
      DRAFTPAGE_DB_USER: "draftpage_admin",
      DRAFTPAGE_DB_PASSWORD: "p@ss:/word?",
      DRAFTPAGE_DATABASE_SSL: "verify-full",
    });
    expect(config).toEqual({
      connection: {
        host: "db.example.eu-north-1.rds.amazonaws.com",
        port: 5432,
        database: "draftpage",
        username: "draftpage_admin",
        password: "p@ss:/word?",
      },
      ssl: "verify-full",
    });
  });

  it("names every missing variable, and never includes values in the message", () => {
    expect(() => databaseConfigFromEnv({ DRAFTPAGE_DB_HOST: "h", DRAFTPAGE_DB_PASSWORD: "secret" })).toThrow(
      "Database is not configured: set DRAFTPAGE_DATABASE_URL, or DRAFTPAGE_DB_NAME, DRAFTPAGE_DB_USER",
    );
    try {
      databaseConfigFromEnv({ DRAFTPAGE_DB_PASSWORD: "secret" });
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });

  it("validates the port", () => {
    const base = { DRAFTPAGE_DB_HOST: "h", DRAFTPAGE_DB_NAME: "d", DRAFTPAGE_DB_USER: "u", DRAFTPAGE_DB_PASSWORD: "p" };
    expect(databaseConfigFromEnv({ ...base, DRAFTPAGE_DB_PORT: "6543" }).connection).toMatchObject({ port: 6543 });
    for (const bad of ["0", "70000", "54x", "-1"]) {
      expect(() => databaseConfigFromEnv({ ...base, DRAFTPAGE_DB_PORT: bad })).toThrow(/DRAFTPAGE_DB_PORT/);
    }
  });

  it("IAM auth needs no password, and insists on TLS", () => {
    const base = { DRAFTPAGE_DB_HOST: "h", DRAFTPAGE_DB_NAME: "d", DRAFTPAGE_DB_USER: "draftpage_app", DRAFTPAGE_DB_IAM_AUTH: "true" };
    expect(databaseConfigFromEnv({ ...base, DRAFTPAGE_DATABASE_SSL: "verify-full" })).toEqual({
      connection: { host: "h", port: 5432, database: "d", username: "draftpage_app" },
      ssl: "verify-full",
      iamAuth: true,
    });
    expect(() => databaseConfigFromEnv(base)).toThrow(/requires DRAFTPAGE_DATABASE_SSL/);
    // Without IAM auth the password is still required.
    expect(() => databaseConfigFromEnv({ ...base, DRAFTPAGE_DB_IAM_AUTH: "false" })).toThrow(/DRAFTPAGE_DB_PASSWORD/);
  });
});
