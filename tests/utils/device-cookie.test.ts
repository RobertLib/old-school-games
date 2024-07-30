import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_TERM_MS,
  issueDeviceCookie,
  presentsDeviceCookie,
  recognisedDevice,
} from "../../utils/device-cookie.ts";

/**
 * The device cookie on its own: what it hands out, and what it will accept
 * back. routes/auth.ts decides what a recognised device is allowed to skip;
 * tests/routes/auth.test.ts holds that side.
 */

const ACCOUNT = "a".repeat(64);
const OTHER_ACCOUNT = "b".repeat(64);
/** credentialOf the account's stored hash, as routes/auth.ts passes it. */
const CREDENTIAL = "c".repeat(64);
/** The same account after its password was reset: a new hash, a new credential. */
const RESET_CREDENTIAL = "d".repeat(64);
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

interface Issued {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function issue(
  account = ACCOUNT,
  now = NOW,
  issueCookie = issueDeviceCookie,
): Issued {
  const cookie = vi.fn();

  issueCookie({ cookie } as unknown as Response, account, CREDENTIAL, now);

  expect(cookie).toHaveBeenCalledTimes(1);

  const [name, value, options] = cookie.mock.calls[0]!;

  return { name, value, options };
}

function presenting(value: string, name = DEVICE_COOKIE): Request {
  return {
    headers: { cookie: `osg_csrf=${"c".repeat(64)}; ${name}=${value}` },
  } as unknown as Request;
}

describe("issueDeviceCookie", () => {
  it("sets a nonce, the issue time and a MAC — and nothing naming anyone", () => {
    const { name, value } = issue();

    expect(name).toBe(DEVICE_COOKIE);
    expect(value).toMatch(/^[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/);
    expect(value.split(".")[1]).toBe(String(Math.floor(NOW / 1000)));
    expect(value).not.toContain(ACCOUNT);
  });

  it("scopes it to the login, keeps it from scripts and other sites, for a year", () => {
    const { options } = issue();

    expect(options).toEqual({
      httpOnly: true,
      // The suite runs outside production; see the case below for Secure.
      secure: false,
      sameSite: "strict",
      path: "/login",
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    expect(DEVICE_COOKIE_TERM_MS).toBe(options.maxAge);
  });

  it("draws a new nonce every time", () => {
    const nonces = new Set(
      Array.from({ length: 20 }, () => issue().value.split(".")[0]),
    );

    expect(nonces.size).toBe(20);
  });
});

describe("recognisedDevice", () => {
  it("returns the nonce of a cookie it issued for this account", () => {
    const { value } = issue();

    expect(recognisedDevice(presenting(value), ACCOUNT, CREDENTIAL, NOW)).toBe(
      value.split(".")[0],
    );
  });

  /**
   * A "__Secure-" cookie can still be set for the whole domain from a sibling
   * subdomain, and an older one with Path=/login is sent ahead of the real
   * one. Reading only the first, the planted value hid the cookie that would
   * have verified, and the owner lost the device's exemption from the
   * account lockout — exactly what someone locking the account out wants.
   */
  it("recognises its own cookie behind one it did not issue", () => {
    const { value } = issue();
    const req = {
      headers: {
        cookie: `${DEVICE_COOKIE}=planted; ${DEVICE_COOKIE}=${value}`,
      },
    } as unknown as Request;

    expect(recognisedDevice(req, ACCOUNT, CREDENTIAL, NOW)).toBe(
      value.split(".")[0],
    );
  });

  /**
   * The same plant, spelled so that it does not decode. The gate in front of
   * recognisedDevice read only the first cookie, and a "%" there made the
   * request look as if it carried none — so the real cookie behind it was
   * never checked at all.
   */
  it.each(["%", "%E0%A4%A"])(
    "still sees its own cookie behind an undecodable %s",
    (planted) => {
      const { value } = issue();
      const req = {
        headers: {
          cookie: `${DEVICE_COOKIE}=${planted}; ${DEVICE_COOKIE}=${value}`,
        },
      } as unknown as Request;

      expect(presentsDeviceCookie(req)).toBe(true);
      expect(recognisedDevice(req, ACCOUNT, CREDENTIAL, NOW)).toBe(
        value.split(".")[0],
      );
    },
  );

  it("sees no device cookie where there is none", () => {
    expect(presentsDeviceCookie(presenting("x", "other"))).toBe(false);
    expect(presentsDeviceCookie({ headers: {} } as unknown as Request)).toBe(false);
  });

  // Bound through the MAC: a cookie for one account says nothing about
  // another, which is what stops one login lifting every account's backstop.
  it("does not recognise it for a different account", () => {
    const { value } = issue();

    expect(recognisedDevice(presenting(value), OTHER_ACCOUNT, CREDENTIAL, NOW)).toBeNull();
  });

  /**
   * The credential is inside the MAC, and a password reset always stores a
   * new hash, so the reset revokes every device cookie issued before it — the
   * same way it ends every session. Without that, a login made once with a
   * phished password kept skipping the account-wide backstop for a year.
   */
  it("does not recognise it once the account's password has been reset", () => {
    const { value } = issue();

    expect(
      recognisedDevice(presenting(value), ACCOUNT, RESET_CREDENTIAL, NOW),
    ).toBeNull();
  });

  it("refuses a value with any part altered", () => {
    const { value } = issue();
    const [nonce, issuedAt, mac] = value.split(".") as [string, string, string];
    const flip = (hex: string) =>
      `${hex.slice(0, -1)}${hex.at(-1) === "0" ? "1" : "0"}`;

    for (const altered of [
      `${flip(nonce)}.${issuedAt}.${mac}`,
      `${nonce}.${Number(issuedAt) - 1}.${mac}`,
      `${nonce}.${issuedAt}.${flip(mac)}`,
    ]) {
      expect(recognisedDevice(presenting(altered), ACCOUNT, CREDENTIAL, NOW)).toBeNull();
    }
  });

  /**
   * The issue time is inside the MAC, so the year is enforced here rather
   * than only asked of the browser: a cookie something kept past its Max-Age
   * still stops counting.
   */
  it("stops recognising it a year after it was issued", () => {
    const { value } = issue();

    expect(
      recognisedDevice(presenting(value), ACCOUNT, CREDENTIAL, NOW + DEVICE_COOKIE_TERM_MS - 1000),
    ).not.toBeNull();
    expect(
      recognisedDevice(presenting(value), ACCOUNT, CREDENTIAL, NOW + DEVICE_COOKIE_TERM_MS),
    ).toBeNull();
  });

  // One machine's clock running a little ahead of another's must not refuse
  // a cookie issued a moment ago; one from the far future is not ours.
  it("allows a few minutes of clock skew, and no more", () => {
    const { value: slightlyAhead } = issue(ACCOUNT, NOW + 4 * 60 * 1000);
    const { value: farAhead } = issue(ACCOUNT, NOW + 10 * 60 * 1000);

    expect(recognisedDevice(presenting(slightlyAhead), ACCOUNT, CREDENTIAL, NOW)).not.toBeNull();
    expect(recognisedDevice(presenting(farAhead), ACCOUNT, CREDENTIAL, NOW)).toBeNull();
  });

  // Every one of these is a failed recognition, not a throw: the value comes
  // from the browser, and a login must not answer 500 for a mangled cookie.
  it.each([
    ["no cookie at all", undefined],
    ["an empty value", ""],
    ["a value in the wrong shape", "not-a-device-cookie"],
    ["an extra part", `${"a".repeat(32)}.1700000000.${"b".repeat(64)}.x`],
    ["a short MAC", `${"a".repeat(32)}.1700000000.${"b".repeat(62)}`],
    ["a zero issue time", `${"a".repeat(32)}.0.${"b".repeat(64)}`],
    ["an undecodable value", "%E0%A4%A"],
  ])("refuses %s without throwing", (_label, value) => {
    const req =
      value === undefined
        ? ({ headers: {} } as unknown as Request)
        : presenting(value);

    expect(() => recognisedDevice(req, ACCOUNT, CREDENTIAL, NOW)).not.toThrow();
    expect(recognisedDevice(req, ACCOUNT, CREDENTIAL, NOW)).toBeNull();
  });

  // Only the exact form it was issued in: the pattern is lower-case hex, and
  // a value that merely decodes to the same bytes is not one this minted.
  it("refuses its own value in upper case", () => {
    const { value } = issue();

    expect(recognisedDevice(presenting(value.toUpperCase()), ACCOUNT, CREDENTIAL, NOW)).toBeNull();
  });
});

/**
 * Production's half, which has to be loaded under NODE_ENV=production: the
 * name and Secure are decided when the module is first read, the same way the
 * CSRF cookie's are.
 */
describe("in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the __Secure- name and sets Secure", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const production = await import("../../utils/device-cookie.ts");
    const { name, options } = issue(ACCOUNT, NOW, production.issueDeviceCookie);

    expect(production.DEVICE_COOKIE).toBe("__Secure-osg_device");
    expect(name).toBe("__Secure-osg_device");
    expect(options.secure).toBe(true);
  });
});

/**
 * The key is derived from SESSION_SECRET, so a cookie minted under one secret
 * means nothing under another — rotating the secret retires every device
 * cookie along with every session.
 */
describe("under a different SESSION_SECRET", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not recognise a cookie issued under the old one", async () => {
    vi.stubEnv("SESSION_SECRET", "x".repeat(64));
    vi.resetModules();

    const before = await import("../../utils/device-cookie.ts");
    const { value } = issue(ACCOUNT, NOW, before.issueDeviceCookie);

    expect(before.recognisedDevice(presenting(value), ACCOUNT, CREDENTIAL, NOW)).not.toBeNull();

    vi.stubEnv("SESSION_SECRET", "y".repeat(64));
    vi.resetModules();

    const after = await import("../../utils/device-cookie.ts");

    expect(after.recognisedDevice(presenting(value), ACCOUNT, CREDENTIAL, NOW)).toBeNull();
  });
});
