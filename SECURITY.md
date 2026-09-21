# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.** An issue is the one channel that tells
everybody at once, including whoever would use the finding — and this is a
public site with a database and an admin login behind it, so the window
between a report and a fix is the only thing worth protecting here.

Two private channels, either is fine:

- **GitHub Security Advisories** — preferred. Open the repository's
  **Security** tab and choose **Report a vulnerability**. The thread is
  private to you and the maintainer, it keeps the discussion attached to the
  code, and a fix can be prepared in a private fork from the same place.
- **Email** — [contact@oldschoolgames.eu](mailto:contact@oldschoolgames.eu),
  the address the site's own footer carries. Use it if you would rather not
  have a GitHub account involved.

What helps, in rough order of how much:

- what an attacker gets out of it, in one sentence;
- the steps to reproduce it — a request, a URL, a payload;
- the commit or the deployed page you saw it on;
- anything you already know about the fix.

A proof of concept against `oldschoolgames.eu` itself is fine as long as it is
the smallest one that demonstrates the issue. Please stay away from anything
that costs other people their data or their access: no brute-forcing the login
(there are rate limits, and tripping them locks real visitors out), no
denial-of-service testing, no reading or changing other people's comments,
ratings or accounts, and no social engineering. A local checkout is usually
enough — `README.md` has it running against a fresh Postgres in five steps.

## What to expect

This is a one-person project, not a company with a rota, so the honest answer
is "as soon as it is read" rather than a service level:

- an acknowledgement, with whether it is understood or needs more from you;
- a fix on a branch that goes through the same CI as everything else — lint,
  typecheck, the suite under its coverage floors, and a Docker build that is
  started and asked for `/healthz`;
- a deploy, and credit in the release note if you would like it, or none if
  you would not.

## Supported versions

The deployed site, and `main`. Nothing older is patched: there are no
releases, no tags and no supported branches — `main` is what runs, and a fix
lands there and deploys.

## Out of scope

Not because they do not matter, but because they are already decided and
written down:

- **Missing security headers on the game player page.** `public/js-dos.html`
  is a deliberately narrow document; what it does and does not allow is
  argued out in the file itself.
- **The emulator running third-party code.** js-dos executes DOS binaries by
  design. The bundles come from one origin only (`MEDIA_ORIGIN`), which the
  player enforces and the Content-Security-Policy names.
- **A cookie without `Secure` in development.** Production sets it; the local
  server is plain HTTP on purpose.
- **Anything behind `npm audit --omit=dev --audit-level=high`.** CI already
  runs it on every push and pull request. An advisory it passes over on
  purpose — low severity, or in a dev-only dependency that is never shipped in
  the image — is a known trade-off rather than a finding. A *reachable* one is
  very much a finding; say how it is reached.
