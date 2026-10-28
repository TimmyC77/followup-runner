# followup-runner

When a Vikunja task is marked done and has an **On completion** section, Vikunja sends a webhook. This service then runs a locked-down headless Claude Code session to carry out the follow-up. It runs on claude-ops (CT 119).

Full docs, safety design and install steps: Outline → Proxmox › claude-ops (CT 119) › **Follow-up runner (CT 119)**.

## Install on claude-ops (as tim, with sudo)

The checkout is owned by tim, who holds the read-only deploy key (`~/.ssh/followup-runner_deploy`, ssh alias `github-followup`). Only `.env` is readable by the service user.

```bash
sudo install -d -o tim -g tim /opt/followup-runner
git clone git@github-followup:TimmyC77/followup-runner.git /opt/followup-runner
sudo useradd --system --no-create-home --shell /usr/sbin/nologin followup
# The service can't see /home (ProtectHome=true), so Claude Code must live outside it.
# This is a copy: re-run after upgrading Claude Code.
sudo install -o root -g root -m 755 "$(readlink -f "$(which claude)")" /usr/local/bin/claude
cd /opt/followup-runner
sudo cp .env.example .env && sudo chown root:followup .env && sudo chmod 640 .env
# Fill in .env yourself (sudoedit .env); never commit it.
sudo cp deploy/followup-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now followup-runner
curl -s http://192.168.20.20:8790/health
```

Update (as tim): `cd /opt/followup-runner && git pull && sudo systemctl restart followup-runner`

Test locally (fake Claude, no network): `node test.mjs`
