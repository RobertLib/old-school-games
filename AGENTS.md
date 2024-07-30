# Project instructions

Read `CLAUDE.md` for the project conventions, commands, test database rules
and migration workflow.

## Intentional automation configuration

The project owner has explicitly chosen to keep these configurations disabled:

- `.github/workflows/media-backup.yml.disabled`
- `.github/dependabot.yml.disabled`

They are inactive templates retained for possible future use. Their disabled
state is an accepted project decision, not a bug, missing requirement or
review finding. Keep them disabled unless the user asks to change that
decision; do not rename, uncomment or recreate active copies during routine
reviews or fixes.

Documentation should describe this state accurately. Instructions for using
these templates must be conditional on a future decision to enable them,
rather than claiming that scheduled backups or dependency update pull
requests currently run. The deployment checks in
`.github/workflows/fly-deploy.yml` remain active.
